package agent

import (
	"context"
	"crypto/hmac"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	agentadaptor "github.com/agent-dance/agent-adaptor"
	"github.com/agent-dance/agent-adaptor/codex"
	"github.com/buthim/alsniper-os/sidecar/internal/config"
	"github.com/buthim/alsniper-os/sidecar/internal/protocol"
	"github.com/gofrs/flock"
)

type CodexRunner struct {
	sdk               agentadaptor.SDK
	profileDir        string
	sourceAuth        string
	filesystemGuard   *codexFilesystemGuard
	readyMu           sync.Mutex
	authState         codexAuthState
	authGeneration    [sha256.Size]byte
	hasAuthGeneration bool
	authCompletion    atomic.Uint64
	authApplied       uint64
	profileLease      *flock.Flock
	closeOnce         sync.Once
	closeErr          error
}

type codexFilesystemGuard struct {
	mu                 sync.RWMutex
	profileDir         string
	sourceHome         string
	sourceAuth         string
	expectedArgs       []string
	workspaceRoot      string
	workspaceDir       string
	canonicalSource    string
	profileLease       *flock.Flock
	codexCommand       string
	authGenerationKey  [sha256.Size]byte
	settingsGeneration [sha256.Size]byte
}

type credentialObservationContextKey struct{}

type credentialObservation struct {
	mu         sync.Mutex
	generation [sha256.Size]byte
	present    bool
}

func (o *credentialObservation) capture(generation [sha256.Size]byte, present bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.generation = generation
	o.present = present
}

func (o *credentialObservation) snapshot() ([sha256.Size]byte, bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.generation, o.present
}

func (g *codexFilesystemGuard) prepareProfile() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	return prepareDedicatedProfile(g.profileDir, g.sourceAuth)
}

func (g *codexFilesystemGuard) prepareProfileForSDKClone() error {
	if err := prepareDedicatedProfile(g.profileDir, g.sourceAuth); err != nil {
		return err
	}
	if err := removeSidecarOwnedAuthIfSourceMissing(g.profileDir, g.sourceAuth); err != nil {
		return err
	}
	if err := validateClonedCodexSettings(g.sourceHome, g.profileDir); err != nil {
		return refreshSidecarOwnedCodexSettings(g.sourceHome, g.profileDir)
	}
	return nil
}

func (g *codexFilesystemGuard) preflightSourceSettings() error {
	generation, err := codexSettingsGeneration(g.sourceHome)
	if err != nil {
		return err
	}
	if generation != g.settingsGeneration {
		return errors.New("native Codex settings changed after sidecar startup; restart the sidecar to rebuild host safety overrides")
	}
	return nil
}

func (g *codexFilesystemGuard) preflightRunUnlocked(cwd string, requireCurrentAuth bool) error {
	if err := validateProfileLease(g.profileLease, g.profileDir, g.canonicalSource); err != nil {
		return err
	}
	if !strings.EqualFold(filepath.Clean(cwd), filepath.Clean(g.workspaceDir)) {
		return errors.New("Codex runtime workspace differs from the guarded run directory")
	}
	if err := preflightNativeCodexHome(g.sourceHome); err != nil {
		return err
	}
	if err := g.preflightSourceSettings(); err != nil {
		return err
	}
	if requireCurrentAuth {
		if err := preflightRuntimeProfile(g.profileDir, g.sourceAuth); err != nil {
			return err
		}
	} else if err := preflightDedicatedProfile(g.profileDir, g.sourceAuth, false); err != nil {
		return err
	}
	return preflightRuntimeWorkspace(g.workspaceRoot, g.workspaceDir)
}

func (g *codexFilesystemGuard) cloneSelectionValid(profile *agentadaptor.ProfileSelection) bool {
	return profile != nil && profile.Mode == agentadaptor.ProfileModeClone &&
		strings.EqualFold(filepath.Clean(profile.From), filepath.Clean(g.sourceHome)) &&
		strings.EqualFold(filepath.Clean(profile.Dir), filepath.Clean(g.profileDir)) &&
		profile.Clone != nil && profile.Clone.IncludeSettings && !profile.Clone.IncludeMCP &&
		!profile.Clone.IncludeSkills && profile.Clone.IncludeAuth &&
		profile.Clone.AuthMode == agentadaptor.CloneProfileAuthLink
}

func dedicatedProfileSelection(dir string) *agentadaptor.ProfileSelection {
	return &agentadaptor.ProfileSelection{Mode: agentadaptor.ProfileModeDedicated, Dir: dir}
}

type denyDecisionAdapter struct {
	agentadaptor.DriverAdapter
	filesystemGuard *codexFilesystemGuard
}

var codexRuntimeDatabase = regexp.MustCompile(`^(?:goals|logs|memories|state)_[1-9][0-9]*\.sqlite(?:-(?:shm|wal))?$`)
var codexAuthenticationFailurePattern = regexp.MustCompile(`(?i)(?:\b401\s+unauthorized\b|\bhttp(?:\s+status)?\s*401\b|\bstatus(?:\s+code)?\s*[:=]?\s*401\b|\bunauthori[sz]ed\b|\binvalid[_ -]?api[_ -]?key\b|\binvalid[_ -]?grant\b|\b(?:login|authentication|reauthentication)[_ -]?(?:is[_ -]?)?required\b|\bnot[_ -]?logged[_ -]?in\b|\btoken[_ -]?(?:expired|revoked)\b)`)

const (
	profileOwnershipMarker   = ".alsniper-sidecar-profile-v1"
	workspaceOwnershipMarker = ".alsniper-sidecar-workspace-v1"
	workspaceRunPrefix       = "run-"
)

type codexAuthState uint8

const (
	codexAuthUnverified codexAuthState = iota
	codexAuthVerified
	codexAuthRejected
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
	if a.filesystemGuard != nil && !slices.Equal(config.CommonConfig.ExtraArgs, a.filesystemGuard.expectedArgs) {
		return agentadaptor.DriverRunResult{}, errors.New("Codex runtime arguments differ from the host-owned safety projection")
	}
	if a.filesystemGuard != nil {
		if config.CommonConfig.Command != a.filesystemGuard.codexCommand {
			return agentadaptor.DriverRunResult{}, errors.New("Codex runtime command differs from the audited executable")
		}
		if err := validateCodexCLIVersion(ctx, a.filesystemGuard.codexCommand); err != nil {
			return agentadaptor.DriverRunResult{}, err
		}
	}
	if len(req.MCP.Servers) != 0 || len(req.ProfilePayload.MCP.Servers) != 0 ||
		len(req.Skills.Entries) != 0 || len(req.ProfilePayload.Skills.Entries) != 0 ||
		len(req.Runtime.Requested) != 0 || len(req.Runtime.Ensured) != 0 || len(req.Runtime.SecretEnv) != 0 ||
		len(req.ProfilePayload.Agents.Agents) != 0 || len(req.ProfilePayload.Hooks.Hooks) != 0 || len(req.ProfilePayload.Config.Patches) != 0 ||
		req.Instructions != nil || req.ProfilePayload.Instructions != nil || req.Session != nil || req.Streaming ||
		req.ProfilePayload.Declared.Config || req.ProfilePayload.Declared.Instructions || req.ProfilePayload.Declared.Agents || req.ProfilePayload.Declared.Hooks {
		return agentadaptor.DriverRunResult{}, errors.New("Codex runtime received undeclared profile resources")
	}
	// Refresh immediately before every spawn so secrets added by another host
	// library after sidecar construction are still excluded.
	config.CommonConfig.Env = codexChildEnvironmentBindings()
	req.Config = config
	if a.filesystemGuard != nil {
		guard := a.filesystemGuard
		if err := validateProfileLease(guard.profileLease, guard.profileDir, guard.canonicalSource); err != nil {
			return agentadaptor.DriverRunResult{}, err
		}
		if !guard.cloneSelectionValid(req.Profile) {
			return agentadaptor.DriverRunResult{}, errors.New("Codex runtime profile differs from the host-owned authentication clone")
		}
		profileDriver, ok := a.DriverAdapter.(agentadaptor.ProfileAwareDriver)
		if !ok {
			return agentadaptor.DriverRunResult{}, errors.New("Codex adapter lacks profile support")
		}
		// Stable generations take the shared path immediately, so independent
		// game seats infer concurrently. CloneProfileAuthLink reconciliation is
		// remove-then-link upstream and is entered only when strict validation
		// proves the current generation is absent or stale.
		guard.mu.RLock()
		strictErr := guard.preflightRunUnlocked(config.CommonConfig.CWD, true)
		if strictErr != nil {
			guard.mu.RUnlock()
			guard.mu.Lock()
			if err := guard.preflightRunUnlocked(config.CommonConfig.CWD, false); err != nil {
				guard.mu.Unlock()
				return agentadaptor.DriverRunResult{}, fmt.Errorf("preflight Codex runtime filesystem: %w", err)
			}
			if err := guard.prepareProfileForSDKClone(); err != nil {
				guard.mu.Unlock()
				return agentadaptor.DriverRunResult{}, fmt.Errorf("prepare Codex settings clone: %w", err)
			}
			profile, profileErr := profileDriver.GetProfile(ctx, req.Config, req.Agent, req.Profile)
			if profileErr == nil && strings.TrimSpace(profile.Error) != "" {
				profileErr = errors.New("Codex SDK could not reconcile the authentication profile")
			}
			if profileErr == nil {
				profileErr = guard.preflightRunUnlocked(config.CommonConfig.CWD, true)
			}
			guard.mu.Unlock()
			if profileErr != nil {
				return agentadaptor.DriverRunResult{}, fmt.Errorf("reconcile Codex authentication profile: %w", profileErr)
			}
			guard.mu.RLock()
			if err := guard.preflightRunUnlocked(config.CommonConfig.CWD, true); err != nil {
				guard.mu.RUnlock()
				return agentadaptor.DriverRunResult{}, fmt.Errorf("preflight Codex runtime filesystem: %w", err)
			}
		}
		defer guard.mu.RUnlock()
		// Reconciliation is complete and protected by the read lease. Execute
		// as a dedicated profile so the SDK cannot remove/relink auth.json again
		// between the host's strict SameFile check and process creation.
		req.Profile = dedicatedProfileSelection(guard.profileDir)
		if observation, ok := ctx.Value(credentialObservationContextKey{}).(*credentialObservation); ok && observation != nil {
			// Observe the credential file held by the actual spawn lease. On
			// Windows AuthLink may be a hardlink, so an atomic native auth
			// replacement must not attribute the old run to the new generation.
			generation, present := codexAuthGeneration(filepath.Join(guard.profileDir, "auth.json"), guard.authGenerationKey, true)
			observation.capture(generation, present)
		}
	}
	result, err := a.DriverAdapter.Run(ctx, req, sink)
	if a.filesystemGuard != nil {
		if postflightErr := a.filesystemGuard.preflightRunUnlocked(config.CommonConfig.CWD, true); postflightErr != nil {
			return agentadaptor.DriverRunResult{}, fmt.Errorf("postflight Codex runtime filesystem: %w", postflightErr)
		}
	}
	return result, err
}

func (a denyDecisionAdapter) CheckEnvironment(ctx context.Context, cfg any) (agentadaptor.EnvironmentReport, error) {
	driver, ok := a.DriverAdapter.(agentadaptor.EnvironmentAwareDriver)
	if !ok {
		return agentadaptor.EnvironmentReport{}, errors.New("Codex adapter lacks environment diagnostics")
	}
	if a.filesystemGuard != nil {
		guard := a.filesystemGuard
		guard.mu.RLock()
		defer guard.mu.RUnlock()
		if err := validateProfileLease(guard.profileLease, guard.profileDir, guard.canonicalSource); err != nil {
			return agentadaptor.EnvironmentReport{}, err
		}
		config, valid := cfg.(agentadaptor.CodexConfig)
		if !valid {
			if pointer, pointerOK := cfg.(*agentadaptor.CodexConfig); pointerOK && pointer != nil {
				config = *pointer
				valid = true
			}
		}
		if !valid {
			return agentadaptor.EnvironmentReport{}, errors.New("Codex diagnostics received invalid runtime configuration")
		}
		if config.CommonConfig.Command != a.filesystemGuard.codexCommand {
			return agentadaptor.EnvironmentReport{}, errors.New("Codex diagnostics command differs from the audited executable")
		}
		if err := validateCodexCLIVersion(ctx, a.filesystemGuard.codexCommand); err != nil {
			return agentadaptor.EnvironmentReport{}, err
		}
		// CheckEnvironment does not accept ProfileSelection in the pinned SDK.
		// Bind it explicitly to the isolated profile so diagnostics never inspect
		// or report resources from the operator's native CODEX_HOME.
		config.CommonConfig.Env = append(codexChildEnvironmentBindings(), agentadaptor.EnvBinding{Name: "CODEX_HOME", Value: a.filesystemGuard.profileDir})
		cfg = config
	}
	return driver.CheckEnvironment(ctx, cfg)
}

func (a denyDecisionAdapter) GetProfile(ctx context.Context, cfg any, identity agentadaptor.AgentIdentity, profile *agentadaptor.ProfileSelection) (agentadaptor.AgentProfile, error) {
	driver, ok := a.DriverAdapter.(agentadaptor.ProfileAwareDriver)
	if !ok {
		return agentadaptor.AgentProfile{}, errors.New("Codex adapter lacks profile support")
	}
	if a.filesystemGuard != nil {
		guard := a.filesystemGuard
		if err := validateProfileLease(guard.profileLease, guard.profileDir, guard.canonicalSource); err != nil {
			return agentadaptor.AgentProfile{}, err
		}
		if !guard.cloneSelectionValid(profile) {
			return agentadaptor.AgentProfile{}, errors.New("Codex profile selection differs from the host-owned authentication clone")
		}
		// Health polling is read-mostly. A stable or logged-out profile can be
		// inspected under a shared lease and must not wait behind long-running
		// game seats. Only a credential generation that actually needs relinking
		// takes the exclusive reconciliation lease.
		guard.mu.RLock()
		stableErr := validateProfileLease(guard.profileLease, guard.profileDir, guard.canonicalSource)
		if stableErr == nil {
			stableErr = preflightNativeCodexHome(guard.sourceHome)
		}
		if stableErr == nil {
			stableErr = guard.preflightSourceSettings()
		}
		if stableErr == nil {
			stableErr = postflightReconciledProfile(guard.sourceHome, guard.profileDir, guard.sourceAuth, false)
		}
		if stableErr == nil {
			resolved, err := driver.GetProfile(ctx, cfg, identity, dedicatedProfileSelection(guard.profileDir))
			guard.mu.RUnlock()
			if err != nil {
				return agentadaptor.AgentProfile{}, err
			}
			if strings.TrimSpace(resolved.Error) != "" {
				return agentadaptor.AgentProfile{}, errors.New("Codex SDK could not inspect the isolated authentication profile")
			}
			return resolved, nil
		}
		guard.mu.RUnlock()

		if !guard.mu.TryLock() {
			return agentadaptor.AgentProfile{}, errors.New("Codex authentication reconciliation is waiting for active Agent runs")
		}
		defer guard.mu.Unlock()
		if err := validateProfileLease(guard.profileLease, guard.profileDir, guard.canonicalSource); err != nil {
			return agentadaptor.AgentProfile{}, err
		}
		if err := preflightNativeCodexHome(guard.sourceHome); err != nil {
			return agentadaptor.AgentProfile{}, fmt.Errorf("preflight native Codex profile: %w", err)
		}
		if err := guard.preflightSourceSettings(); err != nil {
			return agentadaptor.AgentProfile{}, fmt.Errorf("preflight native Codex settings generation: %w", err)
		}
		if err := guard.prepareProfileForSDKClone(); err != nil {
			return agentadaptor.AgentProfile{}, fmt.Errorf("preflight isolated Codex profile: %w", err)
		}
		resolved, err := driver.GetProfile(ctx, cfg, identity, profile)
		if err != nil {
			return agentadaptor.AgentProfile{}, err
		}
		if strings.TrimSpace(resolved.Error) != "" {
			return agentadaptor.AgentProfile{}, errors.New("Codex SDK could not reconcile the authentication profile")
		}
		if err := preflightNativeCodexHome(guard.sourceHome); err != nil {
			return agentadaptor.AgentProfile{}, fmt.Errorf("postflight native Codex profile: %w", err)
		}
		if err := guard.preflightSourceSettings(); err != nil {
			return agentadaptor.AgentProfile{}, fmt.Errorf("postflight native Codex settings generation: %w", err)
		}
		if err := postflightReconciledProfile(guard.sourceHome, guard.profileDir, guard.sourceAuth, false); err != nil {
			return agentadaptor.AgentProfile{}, fmt.Errorf("validate reconciled Codex profile: %w", err)
		}
		return resolved, nil
	}
	return driver.GetProfile(ctx, cfg, identity, profile)
}

func NewCodexRunner(cfg config.Config) (runner *CodexRunner, err error) {
	var profileLease *flock.Flock
	defer func() {
		if err != nil && profileLease != nil {
			_ = profileLease.Close()
		}
	}()
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
	sourceHome, err = filepath.Abs(sourceHome)
	if err != nil {
		return nil, fmt.Errorf("normalize Codex home: %w", err)
	}
	if err := preflightNativeCodexHome(sourceHome); err != nil {
		return nil, err
	}
	if err := validateCodexCLIVersion(context.Background(), cfg.CodexCommand); err != nil {
		return nil, err
	}
	settingsSnapshot, err := captureNativeCodexSettingsSnapshot(sourceHome)
	if err != nil {
		return nil, err
	}
	mcpDisableArgs, err := codexMCPDisableArgsFromIDs(settingsSnapshot.mcpServerIDs)
	if err != nil {
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
	safetyArgs := codexSafetyArgs(mcpDisableArgs...)
	filesystemGuard := &codexFilesystemGuard{
		profileDir: profileDir, sourceHome: sourceHome, sourceAuth: sourceAuth,
		expectedArgs: append([]string(nil), safetyArgs...), workspaceRoot: workspaceRoot,
		settingsGeneration: settingsSnapshot.generation, codexCommand: cfg.CodexCommand,
	}
	if _, err := cryptorand.Read(filesystemGuard.authGenerationKey[:]); err != nil {
		return nil, errors.New("initialize credential generation tracker")
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
	if err := claimDedicatedProfileForLease(profileDir); err != nil {
		return nil, fmt.Errorf("claim isolated Codex profile: %w", err)
	}
	profileLease, err = acquireExclusiveProfileLease(profileDir, canonicalSource)
	if err != nil {
		return nil, err
	}
	filesystemGuard.profileLease = profileLease
	filesystemGuard.canonicalSource = canonicalSource
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
		ExtraArgs:   safetyArgs,
	}
	codexConfig := agentadaptor.CodexConfig{CommonConfig: common, Model: cfg.Model, ReasoningEffort: agentadaptor.ReasoningEffort(cfg.ReasoningEffort), SkipGitRepoCheck: true}
	cloneOptions := agentadaptor.CloneProfileOptions{
		IncludeSettings: true,
		IncludeMCP:      false,
		IncludeSkills:   false,
		IncludeAuth:     true,
		AuthMode:        agentadaptor.CloneProfileAuthLink,
	}
	profileOption := agentadaptor.WithCloneProfileFrom(sourceHome, profileDir, cloneOptions)
	base := codex.New(codexConfig, profileOption)
	binding := agentadaptor.BindTyped(denyDecisionAdapter{DriverAdapter: base.Adapter(), filesystemGuard: filesystemGuard}, codexConfig, profileOption)
	sdk, err := agentadaptor.Build(agentadaptor.WithDefaultAgent(binding))
	if err != nil {
		return nil, fmt.Errorf("build agent-adaptor SDK: %w", err)
	}
	return &CodexRunner{sdk: sdk, profileDir: profileDir, sourceAuth: sourceAuth, filesystemGuard: filesystemGuard, profileLease: profileLease}, nil
}

// Close drains active shared run/readiness leases, prevents later entrants
// from passing preflight, and then releases cross-process profile authority.
func (r *CodexRunner) Close() error {
	if r == nil {
		return nil
	}
	r.closeOnce.Do(func() {
		if r.filesystemGuard != nil {
			r.filesystemGuard.mu.Lock()
			defer r.filesystemGuard.mu.Unlock()
		}
		if r.profileLease != nil {
			r.closeErr = r.profileLease.Close()
		}
	})
	return r.closeErr
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
		if err := validateExactProfileMarker(marker, workspaceOwnershipMarker+"\n", "isolated workspace ownership marker"); err != nil {
			return err
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

func codexSafetyArgs(mcpDisableArgs ...string) []string {
	args := []string{
		"--sandbox", "read-only",
		"--ignore-rules",
		"--disable", "shell_tool",
		"--disable", "unified_exec",
		"--disable", "shell_zsh_fork",
		"--disable", "unified_exec_zsh_fork",
		"--disable", "shell_snapshot",
		"--disable", "deferred_executor",
		"--disable", "code_mode",
		"--disable", "code_mode_host",
		"--disable", "code_mode_buffered_exec",
		"--disable", "code_mode_only",
		"--disable", "executor_capability_discovery",
		"--disable", "web_search_request",
		"--disable", "web_search_cached",
		"--disable", "standalone_web_search",
		"--disable", "search_tool",
		"--disable", "browser_use",
		"--disable", "browser_use_external",
		"--disable", "browser_use_full_cdp_access",
		"--disable", "computer_use",
		"--disable", "image_generation",
		"--disable", "in_app_browser",
		"--disable", "apps",
		"--disable", "enable_mcp_apps",
		"--disable", "apps_mcp_path_override",
		"--disable", "plugins",
		"--disable", "plugin_sharing",
		"--disable", "remote_plugin",
		"--disable", "plugin_hooks",
		"--disable", "multi_agent",
		"--disable", "multi_agent_v2",
		"--disable", "multi_agent_mode",
		"--disable", "enable_fanout",
		"--disable", "collaboration_modes",
		"--disable", "hooks",
		"--disable", "skill_mcp_dependency_install",
		"--disable", "chronicle",
		"--disable", "memories",
		"--disable", "external_agent_memory_import",
		"--disable", "goals",
		"--disable", "artifact",
		"--disable", "realtime_conversation",
		"--disable", "network_proxy",
		"--disable", "request_permissions_tool",
		"--disable", "workspace_dependencies",
		"--disable", "skill_search",
		"--disable", "tool_suggest",
		"--disable", "auth_elicitation",
		"--disable", "tool_call_mcp_elicitation",
		"--disable", "prevent_idle_sleep",
		"-c", `web_search="disabled"`,
		"-c", "notify=[]",
		"--ephemeral",
	}
	return append(args, mcpDisableArgs...)
}

func (r *CodexRunner) Run(ctx context.Context, req RunRequest) (RunResult, error) {
	observation := &credentialObservation{}
	runContext := context.WithValue(ctx, credentialObservationContextKey{}, observation)
	result, err := r.sdk.Run(runContext, req.Prompt,
		agentadaptor.WithRunPolicy(denyPolicy()),
		// Complete native settings can select an OpenAI-compatible provider that
		// does not implement Codex's --output-schema transport. Keep the schema as
		// an SDK-owned authority boundary: prompt for exact JSON, then validate it
		// locally before any OS intent or game action can escape this runner.
		agentadaptor.WithJSONSchemaOutput(req.Schema, agentadaptor.PromptValidateOutput(), agentadaptor.StructuredOutputName(req.SchemaName)),
		agentadaptor.WithMetadata("surface", "alsniper-os-sidecar"),
	)
	completion := r.authCompletion.Add(1)
	// The adapter can return a parsed structured value together with process
	// termination metadata. Cancellation is an authority boundary: once the
	// caller has revoked the turn, no previously buffered model output may be
	// promoted into an OS response or game action.
	if err := validateCodexRunCompletion(ctx, result, err); err != nil {
		if errors.Is(err, ErrAuthentication) {
			authGeneration, hasAuthGeneration := observation.snapshot()
			r.recordAuthOutcome(codexAuthRejected, authGeneration, hasAuthGeneration, completion)
		}
		return RunResult{}, err
	}
	structuredJSON, err := r.acceptCompletedCodexRun(result, observation, completion)
	if err != nil {
		return RunResult{}, err
	}
	var usage *protocol.Usage
	if result.Usage != nil {
		usage = &protocol.Usage{InputTokens: result.Usage.InputTokens, OutputTokens: result.Usage.OutputTokens, CachedInputTokens: result.Usage.CachedInputTokens, EstimatedCostMilli: result.Usage.EstimatedCostMilli}
	}
	return RunResult{RunID: result.RunID, Model: result.Model, JSON: structuredJSON, Usage: usage}, nil
}

func (r *CodexRunner) acceptCompletedCodexRun(result agentadaptor.RunResult, observation *credentialObservation, completion uint64) ([]byte, error) {
	authGeneration, hasAuthGeneration := observation.snapshot()
	r.recordAuthOutcome(codexAuthVerified, authGeneration, hasAuthGeneration, completion)
	return validatedCodexStructuredJSON(result)
}

func validateCodexRunCompletion(ctx context.Context, result agentadaptor.RunResult, runErr error) error {
	if ctxErr := ctx.Err(); ctxErr != nil {
		return ctxErr
	}
	if runErr != nil {
		return runErr
	}
	if result.TimedOut {
		return context.DeadlineExceeded
	}
	if strings.TrimSpace(result.Signal) != "" {
		return errors.New("Codex process was terminated by a signal")
	}
	if result.Failure != nil {
		classified := classifyCodexFailure(result.Failure)
		if errors.Is(classified, ErrAuthentication) {
			return classified
		}
		// PromptValidateOutput reports locally rejected model JSON alongside a
		// generic adapter failure. Preserve that closed schema boundary as a
		// stable product error without allowing it to mask authentication.
		if result.Failure.Code == agentadaptor.FailurePolicyError && result.StructuredOutput != nil && !result.StructuredOutput.Valid {
			return ErrInvalidAI
		}
		return classified
	}
	if result.ExitCode != 0 {
		return ErrAgent
	}
	return nil
}

func classifyCodexFailure(failure *agentadaptor.RunFailure) error {
	if failure == nil {
		return nil
	}
	if failure.Code == agentadaptor.FailureAgentError && codexAuthenticationFailurePattern.MatchString(failure.Message) {
		return ErrAuthentication
	}
	return ErrAgent
}

func validatedCodexStructuredJSON(result agentadaptor.RunResult) ([]byte, error) {
	if result.StructuredOutput == nil || !result.StructuredOutput.Valid || len(result.StructuredOutput.RawJSON) == 0 {
		return nil, ErrInvalidAI
	}
	return append([]byte(nil), result.StructuredOutput.RawJSON...), nil
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
	checks := make([]protocol.HealthCheck, 0, 7)
	ready := true
	settingsChecked := false
	profile, err := r.sdk.Admin().Default().GetProfile(ctx)
	if err != nil {
		ready = false
		checks = append(checks, protocol.HealthCheck{Code: "profile_link", Status: "fail", Message: "The isolated Codex profile could not be initialized."})
	} else if !profile.Supported || !strings.EqualFold(filepath.Clean(profile.Dir), filepath.Clean(r.profileDir)) {
		ready = false
		checks = append(checks, protocol.HealthCheck{Code: "profile_isolation", Status: "fail", Message: "Codex did not select the dedicated sidecar profile."})
	} else {
		guard := r.filesystemGuard
		guard.mu.RLock()
		leaseErr := validateProfileLease(guard.profileLease, guard.profileDir, guard.canonicalSource)
		if leaseErr != nil {
			ready = false
			checks = append(checks, protocol.HealthCheck{Code: "profile_isolation", Status: "fail", Message: "The dedicated Codex profile process lease is unavailable."})
		} else {
			checks = append(checks, protocol.HealthCheck{Code: "profile_isolation", Status: "pass", Message: "Codex uses a dedicated sidecar profile."})
			if !sameFile(r.sourceAuth, filepath.Join(r.profileDir, "auth.json")) {
				ready = false
				checks = append(checks, protocol.HealthCheck{Code: "auth_link", Status: "fail", Message: "The native Codex authentication link is unavailable."})
			} else {
				checks = append(checks, protocol.HealthCheck{Code: "auth_link", Status: "pass", Message: "Codex authentication is linked without copying credentials."})
			}
			if err := isolatedProfileContentsQuiescent(r.profileDir); err != nil {
				ready = false
				checks = append(checks, protocol.HealthCheck{Code: "profile_contents", Status: "fail", Message: "The dedicated profile contains resources outside the closed Codex clone allowlist."})
			} else {
				checks = append(checks, protocol.HealthCheck{Code: "profile_contents", Status: "pass", Message: "The dedicated profile contains only SDK-cloned settings, linked authentication, and allowed runtime state."})
			}
			settingsErr := guard.preflightSourceSettings()
			if settingsErr == nil {
				settingsErr = validateCodexSettingsProjection(guard.sourceHome, r.profileDir)
			}
			settingsChecked = true
			if settingsErr != nil {
				ready = false
				checks = append(checks, protocol.HealthCheck{Code: "profile_settings", Status: "fail", Message: "The SDK-cloned native Codex settings failed validation."})
			} else {
				checks = append(checks, protocol.HealthCheck{Code: "profile_settings", Status: "pass", Message: "Native Codex settings and instructions are cloned as complete files behind host safety overrides."})
			}
		}
		guard.mu.RUnlock()
	}
	r.refreshAuthStateForCurrentGeneration()
	if !settingsChecked {
		ready = false
		checks = append(checks, protocol.HealthCheck{Code: "profile_settings", Status: "fail", Message: "The SDK-cloned native Codex settings failed validation."})
	}
	report, envErr := r.sdk.Admin().Default().CheckEnvironment(ctx)
	if envErr != nil || report.Status == agentadaptor.EnvironmentFail {
		ready = false
		checks = append(checks, protocol.HealthCheck{Code: "codex_cli", Status: "fail", Message: "The Codex CLI environment is unavailable."})
	} else {
		checks = append(checks, protocol.HealthCheck{Code: "codex_cli", Status: "pass", Message: "The Codex CLI environment is available."})
	}
	authCheck, authReady := codexAuthHealth(r.authState)
	checks = append(checks, authCheck)
	if !authReady {
		ready = false
	}
	return Readiness{Ready: ready, Checks: checks}
}

func codexAuthHealth(state codexAuthState) (protocol.HealthCheck, bool) {
	switch state {
	case codexAuthVerified:
		return protocol.HealthCheck{Code: "auth_provider", Status: "pass", Message: "The selected Codex provider accepted the linked authentication."}, true
	case codexAuthRejected:
		return protocol.HealthCheck{Code: "auth_provider", Status: "fail", Message: "The selected Codex provider rejected the linked authentication."}, false
	default:
		return protocol.HealthCheck{Code: "auth_provider", Status: "warn", Message: "Authentication is present but has not yet been verified by a successful Agent run."}, true
	}
}

func validateCodexSettingsProjection(sourceHome, profileDir string) error {
	return validateClonedCodexSettings(sourceHome, profileDir)
}

const maxCodexAuthBytes = 8 << 20

func (r *CodexRunner) currentAuthGeneration() ([sha256.Size]byte, bool) {
	return codexAuthGeneration(r.sourceAuth, r.filesystemGuard.authGenerationKey, false)
}

func codexAuthGeneration(authPath string, key [sha256.Size]byte, allowLink bool) ([sha256.Size]byte, bool) {
	var empty [sha256.Size]byte
	pathInfo, err := os.Lstat(authPath)
	if err != nil {
		return empty, false
	}
	linked := pathInfo.Mode()&os.ModeSymlink != 0 || profileEntryHasReparsePoint(pathInfo)
	if (linked && !allowLink) || (!linked && !pathInfo.Mode().IsRegular()) {
		return empty, false
	}
	file, err := os.Open(authPath)
	if err != nil {
		return empty, false
	}
	defer file.Close()
	openedInfo, err := file.Stat()
	if err != nil || !openedInfo.Mode().IsRegular() || openedInfo.Size() < 1 || openedInfo.Size() > maxCodexAuthBytes || (!linked && !os.SameFile(pathInfo, openedInfo)) {
		return empty, false
	}
	mac := hmac.New(sha256.New, key[:])
	written, err := io.Copy(mac, io.LimitReader(file, maxCodexAuthBytes+1))
	if err != nil || written < 1 || written > maxCodexAuthBytes {
		return empty, false
	}
	closedInfo, err := file.Stat()
	if err != nil || !os.SameFile(openedInfo, closedInfo) || openedInfo.Size() != closedInfo.Size() || !openedInfo.ModTime().Equal(closedInfo.ModTime()) {
		return empty, false
	}
	var generation [sha256.Size]byte
	copy(generation[:], mac.Sum(nil))
	return generation, true
}

func (r *CodexRunner) recordAuthOutcome(state codexAuthState, started [sha256.Size]byte, startedOK bool, completion uint64) {
	current, currentOK := r.currentAuthGeneration()
	r.readyMu.Lock()
	defer r.readyMu.Unlock()
	if completion <= r.authApplied {
		return
	}
	r.authApplied = completion
	if !startedOK || !currentOK || !hmac.Equal(started[:], current[:]) {
		r.authState = codexAuthUnverified
		r.hasAuthGeneration = false
	} else {
		r.authState = state
		r.authGeneration = current
		r.hasAuthGeneration = true
	}
}

func (r *CodexRunner) refreshAuthStateForCurrentGeneration() {
	current, ok := r.currentAuthGeneration()
	if !ok {
		r.authState = codexAuthUnverified
		r.hasAuthGeneration = false
		return
	}
	if r.authState == codexAuthUnverified {
		return
	}
	if !r.hasAuthGeneration || !hmac.Equal(r.authGeneration[:], current[:]) {
		r.authState = codexAuthUnverified
		r.hasAuthGeneration = false
	}
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
			if err := validateExactProfileMarker(path, profileOwnershipMarker+"\n", "isolated profile ownership marker"); err != nil {
				return err
			}
		case profileProcessLockName, profileSourceBindingMarker:
			if err := validateProfileEntry(path, false, false); err != nil {
				return err
			}
		case ".agent-adaptor-profile-manifest.json", "installation_id":
			if err := validateProfileEntry(path, false, false); err != nil {
				return err
			}
		case "config.json", "config.toml", "instructions.md":
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
