package config

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func validConfig(t *testing.T) Config {
	t.Helper()
	return Config{ListenAddress: "127.0.0.1:4317", Token: strings.Repeat("x", 32), AllowedOrigin: "http://localhost:5173", ProfileDir: filepath.Join(t.TempDir(), "profile"), WorkspaceDir: filepath.Join(t.TempDir(), "workspace"), CodexCommand: "codex", MaxBodyBytes: 1024, MaxConcurrentRuns: 2, ChatTimeout: time.Second, GameTimeout: time.Second, ReadinessTimeout: time.Second}
}

func TestConfigRejectsUnsafeNetworkAndCredentials(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Config)
	}{
		{"non-loopback", func(c *Config) { c.ListenAddress = "0.0.0.0:4317" }},
		{"hostname-not-explicit", func(c *Config) { c.ListenAddress = "localhost:4317" }},
		{"ipv6-not-browser-csp-authorized", func(c *Config) { c.ListenAddress = "[::1]:4317" }},
		{"short-token", func(c *Config) { c.Token = "short" }},
		{"oversized-token", func(c *Config) { c.Token = strings.Repeat("x", 513) }},
		{"origin-path", func(c *Config) { c.AllowedOrigin = "http://localhost:5173/app" }},
		{"same-profile-workspace", func(c *Config) { c.WorkspaceDir = c.ProfileDir }},
		{"workspace-inside-profile", func(c *Config) { c.WorkspaceDir = filepath.Join(c.ProfileDir, "workspace") }},
		{"profile-inside-workspace", func(c *Config) { c.ProfileDir = filepath.Join(c.WorkspaceDir, "profile") }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg := validConfig(t)
			test.mutate(&cfg)
			if err := cfg.Validate(); err == nil {
				t.Fatal("expected validation failure")
			}
		})
	}
}

func TestConfigAcceptsCSPAuthorizedIPv4Loopback(t *testing.T) {
	cfg := validConfig(t)
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
}
