package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	ListenAddress     string
	Token             string
	AllowedOrigin     string
	ProfileDir        string
	WorkspaceDir      string
	CodexCommand      string
	Model             string
	ReasoningEffort   string
	MaxBodyBytes      int64
	MaxConcurrentRuns int
	ChatTimeout       time.Duration
	GameTimeout       time.Duration
	ReadinessTimeout  time.Duration
}

func Load() (Config, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return Config{}, fmt.Errorf("resolve user config directory: %w", err)
	}
	cfg := Config{
		ListenAddress:     "127.0.0.1:4317",
		AllowedOrigin:     "http://localhost:5173",
		ProfileDir:        filepath.Join(base, "AlSniperOS", "agent-sidecar", "codex-profile"),
		WorkspaceDir:      filepath.Join(base, "AlSniperOS", "agent-sidecar", "workspace"),
		CodexCommand:      "codex",
		MaxBodyBytes:      262144,
		MaxConcurrentRuns: 8,
		ChatTimeout:       90 * time.Second,
		GameTimeout:       30 * time.Second,
		ReadinessTimeout:  5 * time.Second,
	}
	cfg.ListenAddress = env("AIOS_SIDECAR_LISTEN", cfg.ListenAddress)
	cfg.Token = strings.TrimSpace(os.Getenv("AIOS_SIDECAR_TOKEN"))
	cfg.AllowedOrigin = env("AIOS_SIDECAR_ORIGIN", cfg.AllowedOrigin)
	cfg.ProfileDir = env("AIOS_SIDECAR_PROFILE_DIR", cfg.ProfileDir)
	cfg.WorkspaceDir = env("AIOS_SIDECAR_WORKSPACE_DIR", cfg.WorkspaceDir)
	cfg.CodexCommand = env("AIOS_CODEX_COMMAND", cfg.CodexCommand)
	cfg.Model = strings.TrimSpace(os.Getenv("AIOS_AGENT_MODEL"))
	cfg.ReasoningEffort = strings.TrimSpace(os.Getenv("AIOS_AGENT_REASONING_EFFORT"))
	if cfg.MaxConcurrentRuns, err = envInt("AIOS_SIDECAR_MAX_CONCURRENT", cfg.MaxConcurrentRuns); err != nil {
		return Config{}, err
	}
	if cfg.MaxBodyBytes, err = envInt64("AIOS_SIDECAR_MAX_BODY_BYTES", cfg.MaxBodyBytes); err != nil {
		return Config{}, err
	}
	if cfg.ChatTimeout, err = envDuration("AIOS_SIDECAR_CHAT_TIMEOUT", cfg.ChatTimeout); err != nil {
		return Config{}, err
	}
	if cfg.GameTimeout, err = envDuration("AIOS_SIDECAR_GAME_TIMEOUT", cfg.GameTimeout); err != nil {
		return Config{}, err
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) Validate() error {
	host, port, err := net.SplitHostPort(c.ListenAddress)
	if err != nil {
		return fmt.Errorf("AIOS_SIDECAR_LISTEN must be host:port: %w", err)
	}
	if host != "127.0.0.1" {
		return errors.New("AIOS_SIDECAR_LISTEN must use 127.0.0.1 to match the browser CSP transport boundary")
	}
	if parsed, err := strconv.Atoi(port); err != nil || parsed < 1 || parsed > 65535 {
		return errors.New("AIOS_SIDECAR_LISTEN has an invalid port")
	}
	if len(c.Token) < 32 || len(c.Token) > 512 {
		return errors.New("AIOS_SIDECAR_TOKEN must contain between 32 and 512 bytes")
	}
	origin, err := url.Parse(c.AllowedOrigin)
	if err != nil || (origin.Scheme != "http" && origin.Scheme != "https") || origin.Host == "" || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" {
		return errors.New("AIOS_SIDECAR_ORIGIN must be one exact HTTP(S) origin")
	}
	if strings.TrimSpace(c.ProfileDir) == "" || strings.TrimSpace(c.WorkspaceDir) == "" {
		return errors.New("profile and workspace directories are required")
	}
	profile, err := filepath.Abs(c.ProfileDir)
	if err != nil {
		return err
	}
	workspace, err := filepath.Abs(c.WorkspaceDir)
	if err != nil {
		return err
	}
	if pathsOverlap(profile, workspace) {
		return errors.New("profile and workspace directories must not overlap")
	}
	if strings.TrimSpace(c.CodexCommand) == "" {
		return errors.New("Codex command is required")
	}
	switch c.ReasoningEffort {
	case "", "low", "medium", "high", "xhigh":
	default:
		return errors.New("AIOS_AGENT_REASONING_EFFORT is invalid")
	}
	if c.MaxBodyBytes < 1024 || c.MaxBodyBytes > 4*1024*1024 {
		return errors.New("max body bytes must be between 1 KiB and 4 MiB")
	}
	if c.MaxConcurrentRuns < 1 || c.MaxConcurrentRuns > 64 {
		return errors.New("max concurrent runs must be between 1 and 64")
	}
	if c.ChatTimeout < time.Second || c.ChatTimeout > 10*time.Minute || c.GameTimeout < time.Second || c.GameTimeout > 10*time.Minute {
		return errors.New("run timeouts must be between 1 second and 10 minutes")
	}
	return nil
}

func env(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}
func envInt(name string, fallback int) (int, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer", name)
	}
	return parsed, nil
}
func envInt64(name string, fallback int64) (int64, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer", name)
	}
	return parsed, nil
}
func envDuration(name string, fallback time.Duration) (time.Duration, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return 0, fmt.Errorf("%s must be a duration", name)
	}
	return parsed, nil
}
func samePath(left, right string) bool {
	return strings.EqualFold(filepath.Clean(left), filepath.Clean(right))
}

func pathsOverlap(left, right string) bool {
	return pathContains(left, right) || pathContains(right, left)
}

func pathContains(parent, child string) bool {
	relative, err := filepath.Rel(filepath.Clean(parent), filepath.Clean(child))
	if err != nil {
		return false
	}
	return samePath(relative, ".") || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)))
}
