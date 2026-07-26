package agent

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	agentadaptor "github.com/agent-dance/agent-adaptor"
	"github.com/agent-dance/agent-adaptor/codex"
	"github.com/buthim/alsniper-os/sidecar/internal/config"
	"github.com/buthim/alsniper-os/sidecar/internal/protocol"
)

type CodexRunner struct {
	sdk             agentadaptor.SDK
	profileDir      string
	sourceAuth      string
	filesystemGuard *codexFilesystemGuard
	readyMu         sync.Mutex
	readyUntil      time.Time
	readyResult     Readiness
}

type codexFilesystemGuard struct {
	mu            sync.Mutex
	profileDir    string
	sourceAuth    string
	workspaceRoot string
	workspaceDir  string
}

func (g *codexFilesystemGuard) prepareProfile() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	return prepareDedicatedProfile(g.profileDir, g.sourceAuth)
}

func (g *codexFilesystemGuard) preflightRun(cwd string) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !strings.EqualFold(filepath.Clean(cwd), filepath.Clean(g.workspaceDir)) {
		return errors.New("Codex runtime workspace differs from the guarded run directory")
	}
	if err := preflightNativeCodexHome(filepath.Dir(g.sourceAuth)); err != nil {
		return err
	}
	if err := preflightRuntimeProfile(g.profileDir, g.sourceAuth); err != nil {
		return err
	}
	return preflightRuntimeWorkspace(g.workspaceRoot, g.workspaceDir)
}

type denyDecisionAdapter struct {
	agentadaptor.DriverAdapter
	filesystemGuard *codexFilesystemGuard
}

var codexRuntimeDatabase = regexp.MustCompile(`^(?:goals|logs|memories|state)_[1-9][0-9]*\.sqlite(?:-(?:shm|wal))?$`)

const (
	profileOwnershipMarker   = ".alsniper-sidecar-profile-v1"
	workspaceOwnershipMarker = ".alsniper-sidecar-workspace-v1"
	workspaceRunPrefix       = "run-"
)

func (a denyDecisionAdapter) Descriptor() agentadaptor.DriverDescriptor {
	descriptor := a.DriverAdapter.Descriptor()
	descriptor.RunPolicyCaps.Permission.AutoReject = true
	descriptor.RunPolicyCaps.PlanReview.AutoReject = true
	return descriptor
}

func (a denyDecisionAdapter) Run(ctx context.Context, req agentadaptor.DriverRunRequest, sink agentadaptor.EventSink) (agentadaptor.DriverRunResult, error) {
	if err := validateCodexHomeEnvironment(os.Environ()); err != nil {
		return agentadaptor.DriverRunResult{}, err
	}
	config, ok := req.Config.(agentadaptor.CodexConfig)
	if !ok {
		if pointer, pointerOK := req.Config.(*agentadaptor.CodexConfig); pointerOK && pointer != nil {
			config = *pointer
			ok = true
		}
	}
	if !ok {
		return agentadaptor.DriverRunResult{}, errors.New("Codex adapter received invalid runtime configuration")
	}
	// Refresh immediately before every spawn so secrets added by another host
	// library after sidecar construction are still excluded.
	config.CommonConfig.Env = codexChildEnvironmentBindings()
	req.Config = config
	if a.filesystemGuard != nil {
		if err := a.filesystemGuard.preflightRun(config.CommonConfig.CWD); err != nil {
			return agentadaptor.DriverRunResult{}, fmt.Errorf("preflight Codex runtime filesystem: %w", err)
		}
	}
	return a.DriverAdapter.Run(ctx, req, sink)
}

func (a denyDecisionAdapter) CheckEnvironment(ctx context.Context, cfg any) (agentadaptor.EnvironmentReport, error) {
	driver, ok := a.DriverAdapter.(agentadaptor.EnvironmentAwareDriver)
	if !ok {
		return agentadaptor.EnvironmentReport{}, errors.New("Codex adapter lacks environment diagnostics")
	}
	return driver.CheckEnvironment(ctx, cfg)
}

func (a denyDecisionAdapter) GetProfile(ctx context.Context, cfg any, identity agentadaptor.AgentIdentity, profile *agentadaptor.ProfileSelection) (agentadaptor.AgentProfile, error) {
	driver, ok := a.DriverAdapter.(agentadaptor.ProfileAwareDriver)
	if !ok {
		return agentadaptor.AgentProfile{}, errors.New("Codex adapter lacks profile support")
	}
	if a.filesystemGuard != nil {
		a.filesystemGuard.mu.Lock()
		defer a.filesystemGuard.mu.Unlock()
		if err := prepareDedicatedProfile(a.filesystemGuard.profileDir, a.filesystemGuard.sourceAuth); err != nil {
			return agentadaptor.AgentProfile{}, fmt.Errorf("preflight isolated Codex profile: %w", err)
		}
	}
	return driver.GetProfile(ctx, cfg, identity, profile)
}

func NewCodexRunner(cfg config.Config) (*CodexRunner, error) {
	if err := validateCodexHomeEnvironment(os.Environ()); err != nil {
		return nil, err
	}
	sourceHome := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	if sourceHome == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("resolve Codex home: %w", err)
		}
		sourceHome = filepath.Join(home, ".codex")
	}
	sourceHome, err := filepath.Abs(sourceHome)
	if err != nil {
		return nil, fmt.Errorf("normalize Codex home: %w", err)
	}
	if err := preflightNativeCodexHome(sourceHome); err != nil {
		return nil, err
	}
	profileDir, err := filepath.Abs(cfg.ProfileDir)
	if err != nil {
		return nil, fmt.Errorf("normalize isolated profile: %w", err)
	}
	if pathsOverlap(sourceHome, profileDir) {
		return nil, errors.New("isolated profile must not overlap native CODEX_HOME")
	}
	workspaceRoot, err := filepath.Abs(cfg.WorkspaceDir)
	if err != nil {
		return nil, fmt.Errorf("normalize isolated workspace root: %w", err)
	}
	if pathsOverlap(workspaceRoot, sourceHome) || pathsOverlap(workspaceRoot, profileDir) {
		return nil, errors.New("isolated workspace root must not overlap Codex authentication or profile directories")
	}
	sourceAuth := filepath.Join(sourceHome, "auth.json")
	filesystemGuard := &codexFilesystemGuard{profileDir: profileDir, sourceAuth: sourceAuth, workspaceRoot: workspaceRoot}
	if err := preflightDedicatedProfile(profileDir, sourceAuth, false); err != nil {
		return nil, fmt.Errorf("preflight isolated Codex profile: %w", err)
	}
	if err := preflightDedicatedWorkspace(workspaceRoot); err != nil {
		return nil, fmt.Errorf("preflight isolated Codex workspace: %w", err)
	}
	canonicalSource, err := canonicalPathForOverlap(sourceHome)
	if err != nil {
		return nil, fmt.Errorf("resolve native Codex home identity: %w", err)
	}
	canonicalProfile, err := canonicalPathForOverlap(profileDir)
	if err != nil {
		return nil, fmt.Errorf("resolve isolated profile identity: %w", err)
	}
	canonicalWorkspace, err := canonicalPathForOverlap(workspaceRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve isolated workspace identity: %w", err)
	}
	if pathsOverlap(canonicalSource, canonicalProfile) || pathsOverlap(canonicalSource, canonicalWorkspace) || pathsOverlap(canonicalProfile, canonicalWorkspace) {
		return nil, errors.New("native Codex home, isolated profile, and workspace must not overlap by filesystem identity")
	}
	if err := filesystemGuard.prepareProfile(); err != nil {
		return nil, fmt.Errorf("prepare isolated Codex profile: %w", err)
	}
	workspaceDir, err := prepareDedicatedWorkspace(workspaceRoot)
	if err != nil {
		return nil, err
	}
	filesystemGuard.workspaceDir = workspaceDir
	common := agentadaptor.CommonConfig{
		Command:     cfg.CodexCommand,
		CWD:         workspaceDir,
		Env:         codexChildEnvironmentBindings(),
		Timeout:     max(cfg.ChatTimeout, cfg.GameTimeout),
		GracePeriod: 3 * time.Second,
		ExtraArgs:   codexSafetyArgs(),
	}
	codexConfig := agentadaptor.CodexConfig{CommonConfig: common, Model: cfg.Model, ReasoningEffort: agentadaptor.ReasoningEffort(cfg.ReasoningEffort), SkipGitRepoCheck: true}
	base := codex.New(codexConfig, agentadaptor.WithDedicatedProfile(profileDir))
	binding := agentadaptor.BindTyped(denyDecisionAdapter{DriverAdapter: base.Adapter(), filesystemGuard: filesystemGuard}, codexConfig, agentadaptor.WithDedicatedProfile(profileDir))
	sdk, err := agentadaptor.Build(agentadaptor.WithDefaultAgent(binding))
	if err != nil {
		return nil, fmt.Errorf("build agent-adaptor SDK: %w", err)
	}
	return &CodexRunner{sdk: sdk, profileDir: profileDir, sourceAuth: sourceAuth, filesystemGuard: filesystemGuard}, nil
}

func codexChildEnvironmentBindings() []agentadaptor.EnvBinding {
	return credentialEnvironmentBindings(os.Environ())
}

func credentialEnvironmentBindings(environment []string) []agentadaptor.EnvBinding {
	// The child must authenticate only through the linked CODEX_HOME/auth.json.
	// Empty explicit bindings override inherited process variables in the SDK's
	// environment merge without removing the profile binding added by the clone.
	names := []string{
		"AIOS_SIDECAR_TOKEN",
		"OPENAI_API_KEY",
		"OPENAI_ACCESS_TOKEN",
		"OPENAI_ORG_ID",
		"OPENAI_ORGANIZATION",
		"OPENAI_PROJECT",
		"OPENAI_PROJECT_ID",
		"OPENAI_BASE_URL",
		"OPENAI_API_BASE",
		"AZURE_OPENAI_API_KEY",
		"AZURE_OPENAI_AD_TOKEN",
		"AZURE_OPENAI_ENDPOINT",
		"AZURE_CLIENT_SECRET",
		"CODEX_API_KEY",
	}
	bindings := make([]agentadaptor.EnvBinding, 0, len(environment)+len(names))
	bound := make(map[string]struct{}, len(environment)+len(names))
	for _, name := range names {
		bindings = append(bindings, agentadaptor.EnvBinding{Name: name, Value: ""})
		bound[name] = struct{}{}
	}
	// The pinned SDK intentionally inherits the full host environment before
	// applying EnvBinding. A fail-closed allowlist is the only way to cover
	// unknown providers, credential brokers, and nonstandard secret names.
	for _, item := range environment {
		name, value, ok := strings.Cut(item, "=")
		// cmd.exe parents can inject hidden drive-current-directory entries such
		// as "=C:=C:\\path". They are not ordinary environment variables; an
		// empty-name EnvBinding makes the next CreateProcess call fail with
		// ERROR_INVALID_PARAMETER.
		if !ok || name == "" || name == "CODEX_HOME" || safeCodexChildEnvironment(name, value) {
			continue
		}
		if _, exists := bound[name]; exists {
			continue
		}
		bindings = append(bindings, agentadaptor.EnvBinding{Name: name, Value: ""})
		bound[name] = struct{}{}
	}
	return bindings
}

func validateCodexHomeEnvironment(environment []string) error {
	for _, item := range environment {
		name, _, ok := strings.Cut(item, "=")
		if ok && name != "CODEX_HOME" && strings.EqualFold(name, "CODEX_HOME") {
			return fmt.Errorf("non-canonical CODEX_HOME environment key %q is not allowed", name)
		}
	}
	return nil
}

func safeCodexChildEnvironment(name, value string) bool {
	upper := strings.ToUpper(strings.TrimSpace(name))
	switch upper {
	case "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
		"HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
		"LANG", "LANGUAGE", "TZ", "TERM", "COLORTERM", "NO_COLOR", "NO_PROXY",
		"SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "NODE_EXTRA_CA_CERTS":
		return true
	}
	if strings.HasPrefix(upper, "LC_") {
		return true
	}
	switch upper {
	case "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY":
		proxy, err := url.Parse(strings.TrimSpace(value))
		return err == nil && proxy.Scheme != "" && proxy.Host != "" && proxy.User == nil && proxy.RawQuery == "" && proxy.Fragment == ""
	}
	return false
}

func pathsOverlap(left, right string) bool {
	return pathContains(left, right) || pathContains(right, left)
}

func pathContains(parent, child string) bool {
	relative, err := filepath.Rel(filepath.Clean(parent), filepath.Clean(child))
	if err != nil {
		return false
	}
	return relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)))
}

func prepareDedicatedWorkspace(root string) (string, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("normalize isolated workspace root: %w", err)
	}
	existed, err := inspectRealDirectoryPath(root, "isolated workspace root", true)
	if err != nil {
		return "", err
	}
	if existed {
		if err := validateDedicatedWorkspaceContents(root, true); err != nil {
			return "", err
		}
	}

	marker := filepath.Join(root, workspaceOwnershipMarker)
	if err := ensureWorkspaceOwnership(root, marker); err != nil {
		return "", err
	}
	if err := validateDedicatedWorkspaceContents(root, true); err != nil {
		return "", err
	}
	workspace, err := os.MkdirTemp(root, workspaceRunPrefix)
	if err != nil {
		return "", fmt.Errorf("create isolated run workspace: %w", err)
	}
	if _, err := inspectRealDirectoryPath(workspace, "isolated run workspace", false); err != nil {
		return "", err
	}
	return workspace, nil
}

func ensureWorkspaceOwnership(root, marker string) error {
	if _, err := os.Lstat(marker); err == nil {
		if err := validateProfileEntry(marker, false, false); err != nil {
			return errors.New("isolated workspace ownership marker must be a regular file")
		}
		contents, err := os.ReadFile(marker)
		if err != nil {
			return fmt.Errorf("read isolated workspace ownership marker: %w", err)
		}
		if string(contents) != workspaceOwnershipMarker+"\n" {
			return errors.New("isolated workspace ownership marker is invalid")
		}
		return nil
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("read isolated workspace ownership marker: %w", err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return fmt.Errorf("inspect unclaimed workspace root: %w", err)
	}
	if len(entries) != 0 {
		return errors.New("isolated workspace root is unclaimed and not empty")
	}
	file, err := os.OpenFile(marker, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if os.IsExist(err) {
			return ensureWorkspaceOwnership(root, marker)
		}
		return fmt.Errorf("claim isolated workspace root: %w", err)
	}
	if _, err := file.WriteString(workspaceOwnershipMarker + "\n"); err != nil {
		_ = file.Close()
		return fmt.Errorf("write isolated workspace ownership marker: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close isolated workspace ownership marker: %w", err)
	}
	return nil
}

func codexSafetyArgs() []string {
	return []string{
		"--sandbox", "read-only",
		"--ignore-user-config",
		"--ignore-rules",
		"--strict-config",
		"--disable", "shell_tool",
		"--disable", "code_mode_host",
		"--disable", "browser_use",
		"--disable", "computer_use",
		"--disable", "image_generation",
		"--disable", "in_app_browser",
		"--disable", "apps",
		"--disable", "plugins",
		"--disable", "multi_agent",
		"--ephemeral",
	}
}

func (r *CodexRunner) Run(ctx context.Context, req RunRequest) (RunResult, error) {
	result, err := r.sdk.Run(ctx, req.Prompt,
		agentadaptor.WithRunPolicy(denyPolicy()),
		agentadaptor.WithJSONSchemaOutput(req.Schema, agentadaptor.NativeStrictOutput(), agentadaptor.StructuredOutputName(req.SchemaName)),
		agentadaptor.WithMetadata("surface", "alsniper-os-sidecar"),
	)
	if err != nil {
		return RunResult{}, err
	}
	if result.Failure != nil {
		return RunResult{}, fmt.Errorf("%s: %s", result.Failure.Code, result.Failure.Message)
	}
	if result.StructuredOutput == nil || !result.StructuredOutput.Valid || len(result.StructuredOutput.RawJSON) == 0 {
		return RunResult{}, errors.New("Codex returned no valid structured output")
	}
	var usage *protocol.Usage
	if result.Usage != nil {
		usage = &protocol.Usage{InputTokens: result.Usage.InputTokens, OutputTokens: result.Usage.OutputTokens, CachedInputTokens: result.Usage.CachedInputTokens, EstimatedCostMilli: result.Usage.EstimatedCostMilli}
	}
	return RunResult{RunID: result.RunID, Model: result.Model, JSON: append([]byte(nil), result.StructuredOutput.RawJSON...), Usage: usage}, nil
}

func denyPolicy() agentadaptor.RunPolicy {
	return agentadaptor.RunPolicy{
		Isolation: agentadaptor.IsolationReadOnly,
		WebSearch: agentadaptor.FeatureDeny,
		Browser:   agentadaptor.FeatureDeny,
		HumanDecision: agentadaptor.HumanDecisionPolicy{
			Permission: agentadaptor.HumanDecisionAutoReject,
			PlanReview: agentadaptor.HumanDecisionAutoReject,
			Question:   agentadaptor.QuestionAutoReject,
			OnReject:   agentadaptor.FailureAbort,
			OnTimeout:  agentadaptor.FailureAbort,
		},
	}
}

func (r *CodexRunner) Readiness(ctx context.Context) Readiness {
	r.readyMu.Lock()
	defer r.readyMu.Unlock()
	if time.Now().Before(r.readyUntil) {
		return cloneReadiness(r.readyResult)
	}
	checks := make([]protocol.HealthCheck, 0, 5)
	ready := true
	profile, err := r.sdk.Admin().Default().GetProfile(ctx)
	if err != nil {
		ready = false
		checks = append(checks, protocol.HealthCheck{Code: "profile_link", Status: "fail", Message: "The isolated Codex profile could not be initialized."})
	} else if !profile.Supported || !strings.EqualFold(filepath.Clean(profile.Dir), filepath.Clean(r.profileDir)) {
		ready = false
		checks = append(checks, protocol.HealthCheck{Code: "profile_isolation", Status: "fail", Message: "Codex did not select the dedicated sidecar profile."})
	} else {
		checks = append(checks, protocol.HealthCheck{Code: "profile_isolation", Status: "pass", Message: "Codex uses a dedicated sidecar profile."})
		if !sameFile(r.sourceAuth, filepath.Join(r.profileDir, "auth.json")) {
			ready = false
			checks = append(checks, protocol.HealthCheck{Code: "auth_link", Status: "fail", Message: "The native Codex authentication link is unavailable."})
		} else {
			checks = append(checks, protocol.HealthCheck{Code: "auth_link", Status: "pass", Message: "Codex authentication is linked without copying credentials."})
		}
		if err := isolatedProfileContents(r.profileDir); err != nil {
			ready = false
			checks = append(checks, protocol.HealthCheck{Code: "profile_contents", Status: "fail", Message: "The dedicated profile contains resources outside the allowed authentication link."})
		} else {
			checks = append(checks, protocol.HealthCheck{Code: "profile_contents", Status: "pass", Message: "Settings, MCP servers, and skills are not inherited."})
		}
	}
	report, envErr := r.sdk.Admin().Default().CheckEnvironment(ctx)
	if envErr != nil || report.Status == agentadaptor.EnvironmentFail {
		ready = false
		checks = append(checks, protocol.HealthCheck{Code: "codex_cli", Status: "fail", Message: "The Codex CLI environment is unavailable."})
	} else {
		checks = append(checks, protocol.HealthCheck{Code: "codex_cli", Status: "pass", Message: "The Codex CLI environment is available."})
	}
	r.readyResult = Readiness{Ready: ready, Checks: checks}
	r.readyUntil = time.Now().Add(5 * time.Second)
	return cloneReadiness(r.readyResult)
}

func sameFile(left, right string) bool {
	leftInfo, err := os.Stat(left)
	if err != nil {
		return false
	}
	rightInfo, err := os.Stat(right)
	if err != nil {
		return false
	}
	return os.SameFile(leftInfo, rightInfo)
}

func isolatedProfileContents(dir string) error {
	if err := validateProfileEntry(dir, true, false); err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		path := filepath.Join(dir, entry.Name())
		switch entry.Name() {
		case "auth.json":
			// The only permitted link is the host-managed authentication link.
			// Readiness separately proves it is SameFile as sourceAuth.
			if err := validateProfileEntry(path, false, true); err != nil {
				return err
			}
		case profileOwnershipMarker:
			if err := validateProfileEntry(path, false, false); err != nil {
				return err
			}
			contents, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			if string(contents) != profileOwnershipMarker+"\n" {
				return errors.New("isolated profile ownership marker is invalid")
			}
		case ".agent-adaptor-profile-manifest.json", "installation_id":
			if err := validateProfileEntry(path, false, false); err != nil {
				return err
			}
		case "tmp":
			if err := validateProfileEntry(path, true, false); err != nil {
				return err
			}
			children, err := os.ReadDir(path)
			if err != nil {
				return err
			}
			if len(children) != 0 {
				return errors.New("profile tmp directory must be empty")
			}
		case "skills":
			if err := validateProfileEntry(path, true, false); err != nil {
				return err
			}
			children, err := os.ReadDir(path)
			if err != nil {
				return err
			}
			for _, child := range children {
				if child.Name() != ".system" {
					return errors.New("skills directory contains non-system resources")
				}
				if err := validateProfileEntry(filepath.Join(path, child.Name()), true, false); err != nil {
					return err
				}
				count := 0
				if err := validateProfileDirectoryTree(filepath.Join(path, child.Name()), 0, &count); err != nil {
					return err
				}
			}
		default:
			if codexRuntimeDatabase.MatchString(entry.Name()) {
				if err := validateProfileEntry(path, false, false); err != nil {
					return err
				}
				continue
			}
			return fmt.Errorf("unexpected profile resource %q", entry.Name())
		}
	}
	return nil
}

func validateProfileDirectoryTree(dir string, depth int, count *int) error {
	if depth > 32 {
		return errors.New("profile system skills tree is too deep")
	}
	if err := validateProfileEntry(dir, true, false); err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("inspect profile directory %q: %w", filepath.Base(dir), err)
	}
	for _, entry := range entries {
		*count++
		if *count > 4096 {
			return errors.New("profile system skills tree is too large")
		}
		path := filepath.Join(dir, entry.Name())
		info, err := os.Lstat(path)
		if err != nil {
			return fmt.Errorf("inspect profile resource %q: %w", entry.Name(), err)
		}
		if info.Mode()&os.ModeSymlink != 0 || profileEntryHasReparsePoint(info) {
			return fmt.Errorf("profile resource %q must not be a link or reparse point", entry.Name())
		}
		if info.IsDir() {
			if err := validateProfileDirectoryTree(path, depth+1, count); err != nil {
				return err
			}
			continue
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("profile resource %q must be a regular file or directory", entry.Name())
		}
	}
	return nil
}

func validateProfileEntry(path string, wantDirectory, allowLink bool) error {
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect profile resource %q: %w", filepath.Base(path), err)
	}
	linked := info.Mode()&os.ModeSymlink != 0 || profileEntryHasReparsePoint(info)
	if linked && !allowLink {
		return fmt.Errorf("profile resource %q must not be a link or reparse point", filepath.Base(path))
	}
	if linked {
		return nil
	}
	if wantDirectory && !info.IsDir() {
		return fmt.Errorf("profile resource %q must be a directory", filepath.Base(path))
	}
	if !wantDirectory && !info.Mode().IsRegular() {
		return fmt.Errorf("profile resource %q must be a regular file", filepath.Base(path))
	}
	return nil
}

func cloneReadiness(value Readiness) Readiness {
	value.Checks = append([]protocol.HealthCheck(nil), value.Checks...)
	return value
}
