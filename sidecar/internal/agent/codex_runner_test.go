package agent

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	agentadaptor "github.com/agent-dance/agent-adaptor"
	"github.com/agent-dance/agent-adaptor/codex"
	"github.com/buthim/alsniper-os/sidecar/internal/config"
)

type concurrentLeaseAdapter struct {
	entered        chan struct{}
	release        chan struct{}
	clearTransient chan struct{}
	cleanupResult  chan error
	profileDir     string
	transientOnce  sync.Once
	transientErr   error
}

func (a *concurrentLeaseAdapter) Descriptor() agentadaptor.DriverDescriptor {
	return agentadaptor.DriverDescriptor{Type: "codex"}
}

func (a *concurrentLeaseAdapter) ValidateConfig(any) error { return nil }

func (a *concurrentLeaseAdapter) GetProfile(_ context.Context, _ any, _ agentadaptor.AgentIdentity, profile *agentadaptor.ProfileSelection) (agentadaptor.AgentProfile, error) {
	return agentadaptor.AgentProfile{DriverType: "codex", Supported: true, Dir: profile.Dir, EnvVar: "CODEX_HOME"}, nil
}

func (a *concurrentLeaseAdapter) Run(_ context.Context, _ agentadaptor.DriverRunRequest, _ agentadaptor.EventSink) (agentadaptor.DriverRunResult, error) {
	a.transientOnce.Do(func() {
		lock := filepath.Join(a.profileDir, sdkProfileLockName)
		temporary := filepath.Join(a.profileDir, "."+sdkProfileManifestName+".tmp-123456789")
		if err := os.WriteFile(lock, []byte("test transaction"), 0o600); err != nil {
			a.transientErr = err
			return
		}
		if err := os.WriteFile(temporary, []byte("test transaction"), 0o600); err != nil {
			a.transientErr = err
			return
		}
		go func() {
			<-a.clearTransient
			var cleanupErr error
			for _, path := range []string{temporary, lock} {
				deadline := time.Now().Add(time.Second)
				for {
					err := os.Remove(path)
					if err == nil || os.IsNotExist(err) {
						break
					}
					if time.Now().After(deadline) {
						cleanupErr = fmt.Errorf("remove test transaction %q: %w", path, err)
						break
					}
					time.Sleep(5 * time.Millisecond)
				}
				if cleanupErr != nil {
					break
				}
			}
			a.cleanupResult <- cleanupErr
		}()
	})
	if a.transientErr != nil {
		return agentadaptor.DriverRunResult{}, a.transientErr
	}
	a.entered <- struct{}{}
	<-a.release
	return agentadaptor.DriverRunResult{}, nil
}

func TestCodexRunCompletionRejectsBufferedOutputAfterAbnormalTermination(t *testing.T) {
	structured := &agentadaptor.StructuredOutput{Valid: true, RawJSON: []byte(`{"ok":true}`)}
	tests := []struct {
		name   string
		result agentadaptor.RunResult
		want   error
	}{
		{name: "success", result: agentadaptor.RunResult{StructuredOutput: structured}},
		{name: "timeout", result: agentadaptor.RunResult{TimedOut: true, StructuredOutput: structured}, want: context.DeadlineExceeded},
		{name: "nonzero exit", result: agentadaptor.RunResult{ExitCode: 9, StructuredOutput: structured}, want: errors.New("failure")},
		{name: "signal", result: agentadaptor.RunResult{Signal: "SIGKILL", StructuredOutput: structured}, want: errors.New("failure")},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateCodexRunCompletion(context.Background(), test.result, nil)
			if test.want == nil && err != nil {
				t.Fatalf("successful process was rejected: %v", err)
			}
			if test.want != nil && err == nil {
				t.Fatal("abnormal process result with valid buffered JSON was accepted")
			}
			if errors.Is(test.want, context.DeadlineExceeded) && !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("timeout error = %v", err)
			}
		})
	}
}

func TestCodexRunCompletionRejectsBufferedOutputAfterContextRevocation(t *testing.T) {
	structured := &agentadaptor.StructuredOutput{Valid: true, RawJSON: []byte(`{"ok":true}`)}
	result := agentadaptor.RunResult{StructuredOutput: structured}

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := validateCodexRunCompletion(cancelled, result, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled run returned %v", err)
	}

	deadline, stop := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer stop()
	if err := validateCodexRunCompletion(deadline, result, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expired run returned %v", err)
	}

	sdkErr := errors.New("sdk failure")
	if err := validateCodexRunCompletion(context.Background(), result, sdkErr); !errors.Is(err, sdkErr) {
		t.Fatalf("SDK error was not preserved: %v", err)
	}
}

func TestCodexRunCompletionClassifiesFailuresWithoutLeakingProviderText(t *testing.T) {
	canary := "provider-canary-must-not-leak"
	for _, test := range []struct {
		name   string
		result agentadaptor.RunResult
		want   error
	}{
		{name: "unauthorized before generic exit", result: agentadaptor.RunResult{ExitCode: 1, Failure: &agentadaptor.RunFailure{Code: agentadaptor.FailureAgentError, Message: "401 unauthorized " + canary}}, want: ErrAuthentication},
		{name: "invalid key", result: agentadaptor.RunResult{Failure: &agentadaptor.RunFailure{Code: agentadaptor.FailureAgentError, Message: "invalid_api_key " + canary}}, want: ErrAuthentication},
		{name: "oauth grant expired", result: agentadaptor.RunResult{Failure: &agentadaptor.RunFailure{Code: agentadaptor.FailureAgentError, Message: "invalid_grant: reauthentication required " + canary}}, want: ErrAuthentication},
		{name: "numeric request id is not auth", result: agentadaptor.RunResult{Failure: &agentadaptor.RunFailure{Code: agentadaptor.FailureAgentError, Message: "request item-401 failed " + canary}}, want: ErrAgent},
		{name: "non-agent failure cannot become auth", result: agentadaptor.RunResult{Failure: &agentadaptor.RunFailure{Code: agentadaptor.FailureReject, Message: "unauthorized " + canary}}, want: ErrAgent},
		{name: "local schema rejection", result: agentadaptor.RunResult{Failure: &agentadaptor.RunFailure{Code: agentadaptor.FailurePolicyError, Message: canary}, StructuredOutput: &agentadaptor.StructuredOutput{Valid: false, RawJSON: []byte(`{"ok":"not-a-boolean"}`)}}, want: ErrInvalidAI},
		{name: "provider failure with invalid structured candidate", result: agentadaptor.RunResult{Failure: &agentadaptor.RunFailure{Code: agentadaptor.FailureAgentError, Message: canary}, StructuredOutput: &agentadaptor.StructuredOutput{Valid: false, RawJSON: []byte(`{"ok":"not-a-boolean"}`)}}, want: ErrAgent},
		{name: "generic failure before generic exit", result: agentadaptor.RunResult{ExitCode: 1, Failure: &agentadaptor.RunFailure{Code: agentadaptor.FailureAgentError, Message: canary}}, want: ErrAgent},
		{name: "timeout has priority", result: agentadaptor.RunResult{TimedOut: true, Failure: &agentadaptor.RunFailure{Message: "401 " + canary}}, want: context.DeadlineExceeded},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := validateCodexRunCompletion(context.Background(), test.result, nil)
			if !errors.Is(err, test.want) {
				t.Fatalf("failure classification = %v, want %v", err, test.want)
			}
			if strings.Contains(err.Error(), canary) {
				t.Fatalf("provider failure text leaked: %v", err)
			}
		})
	}
}

func TestValidatedCodexStructuredJSONFailsClosed(t *testing.T) {
	for _, result := range []agentadaptor.RunResult{
		{},
		{StructuredOutput: &agentadaptor.StructuredOutput{}},
		{StructuredOutput: &agentadaptor.StructuredOutput{Valid: true}},
		{StructuredOutput: &agentadaptor.StructuredOutput{Valid: false, RawJSON: []byte(`{"unsafe":true}`)}},
	} {
		if _, err := validatedCodexStructuredJSON(result); !errors.Is(err, ErrInvalidAI) {
			t.Fatalf("invalid structured output returned %v", err)
		}
	}
	raw := []byte(`{"ok":true}`)
	got, err := validatedCodexStructuredJSON(agentadaptor.RunResult{StructuredOutput: &agentadaptor.StructuredOutput{Valid: true, RawJSON: raw}})
	if err != nil || !bytes.Equal(got, raw) {
		t.Fatalf("valid structured output rejected: got=%s err=%v", got, err)
	}
	raw[0] = '['
	if string(got) != `{"ok":true}` {
		t.Fatal("validated structured output was not defensively copied")
	}
}

func TestCompletedProviderRunVerifiesAuthenticationBeforeOutputValidation(t *testing.T) {
	source := t.TempDir()
	authPath := writeTestNativeAuth(t, source)
	runner := &CodexRunner{sourceAuth: authPath, filesystemGuard: &codexFilesystemGuard{}}
	generation, ok := runner.currentAuthGeneration()
	if !ok {
		t.Fatal("test credential generation was unavailable")
	}
	observation := &credentialObservation{}
	observation.capture(generation, true)
	if _, err := runner.acceptCompletedCodexRun(agentadaptor.RunResult{}, observation, 1); !errors.Is(err, ErrInvalidAI) {
		t.Fatalf("invalid output returned %v", err)
	}
	if runner.authState != codexAuthVerified || !runner.hasAuthGeneration {
		t.Fatal("provider acceptance was lost when structured output validation failed")
	}
}

func TestCodexAuthenticationHealthTransitionsAreConcurrentSafe(t *testing.T) {
	source := t.TempDir()
	authPath := writeTestNativeAuth(t, source)
	runner := &CodexRunner{
		sourceAuth: authPath, filesystemGuard: &codexFilesystemGuard{},
	}
	check, ready := codexAuthHealth(runner.authState)
	if !ready || check.Status != "warn" {
		t.Fatalf("initial auth health = %+v ready=%v", check, ready)
	}
	generation, ok := runner.currentAuthGeneration()
	if !ok {
		t.Fatal("test credential generation was unavailable")
	}

	var workers sync.WaitGroup
	for sequence := uint64(1); sequence <= 32; sequence++ {
		workers.Add(1)
		go func(completion uint64) {
			defer workers.Done()
			state := codexAuthVerified
			if completion == 32 {
				state = codexAuthRejected
			}
			runner.recordAuthOutcome(state, generation, true, completion)
		}(sequence)
	}
	workers.Wait()
	check, ready = codexAuthHealth(runner.authState)
	if ready || check.Status != "fail" || runner.authApplied != 32 {
		t.Fatalf("latest auth completion was not retained: check=%+v ready=%v applied=%d", check, ready, runner.authApplied)
	}

	runner.recordAuthOutcome(codexAuthVerified, generation, true, 7)
	check, ready = codexAuthHealth(runner.authState)
	if ready || check.Status != "fail" {
		t.Fatalf("older completion overwrote newer result: %+v ready=%v", check, ready)
	}
}

func TestCodexAuthenticationStateIsBoundToCredentialGeneration(t *testing.T) {
	source := t.TempDir()
	authPath := writeTestNativeAuth(t, source)
	runner := &CodexRunner{sourceAuth: authPath, filesystemGuard: &codexFilesystemGuard{}}
	started, ok := runner.currentAuthGeneration()
	if !ok {
		t.Fatal("test credential generation was unavailable")
	}
	runner.recordAuthOutcome(codexAuthRejected, started, true, 1)
	if runner.authState != codexAuthRejected || !runner.hasAuthGeneration {
		t.Fatal("authentication rejection was not bound to its credential generation")
	}

	if err := os.Remove(authPath); err != nil {
		t.Fatal(err)
	}
	runner.refreshAuthStateForCurrentGeneration()
	if runner.authState != codexAuthUnverified || runner.hasAuthGeneration {
		t.Fatal("missing authentication retained a stale provider acceptance state")
	}
	if err := os.WriteFile(authPath, []byte(`{"OPENAI_API_KEY":"rotated-test-only"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	rotated, ok := runner.currentAuthGeneration()
	if !ok {
		t.Fatal("rotated credential generation was unavailable")
	}
	if err := os.WriteFile(authPath, []byte(`{"OPENAI_API_KEY":"changed-during-run"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	runner.recordAuthOutcome(codexAuthVerified, rotated, true, 2)
	if runner.authState != codexAuthUnverified {
		t.Fatal("a result from an obsolete credential generation was promoted")
	}
}

func testRunnerConfig(t *testing.T, profile, workspace, command string) config.Config {
	t.Helper()
	if command == "go" {
		command = writeVersionedFakeCodex(t, "codex-cli "+auditedCodexCLIVersion, "")
	}
	return config.Config{
		ListenAddress: "127.0.0.1:4317", Token: strings.Repeat("x", 32), AllowedOrigin: "http://localhost:5173",
		ProfileDir: profile, WorkspaceDir: workspace, CodexCommand: command, MaxBodyBytes: 1024, MaxConcurrentRuns: 1,
		ChatTimeout: time.Second, GameTimeout: time.Second, ReadinessTimeout: time.Second,
	}
}

func writeTestNativeAuth(t *testing.T, source string) string {
	t.Helper()
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	auth := filepath.Join(source, "auth.json")
	if err := os.WriteFile(auth, []byte(`{"OPENAI_API_KEY":"test-only"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	return auth
}

func TestCodexProfileLinksAuthenticationAndClonesNativeSettings(t *testing.T) {
	source := t.TempDir()
	profile := filepath.Join(t.TempDir(), "profile")
	workspace := filepath.Join(t.TempDir(), "workspace")
	if err := os.WriteFile(filepath.Join(source, "auth.json"), []byte(`{"OPENAI_API_KEY":"test-only"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	configTOML := []byte("model = \"must-not-copy\"\n[mcp_servers.\"whole.file\"]\ncommand = \"MCP_CANARY_MUST_NOT_START\"\n")
	if err := os.WriteFile(filepath.Join(source, "config.toml"), configTOML, 0o600); err != nil {
		t.Fatal(err)
	}
	configJSON := []byte(`{"nativeSetting":"copied-whole"}`)
	if err := os.WriteFile(filepath.Join(source, "config.json"), configJSON, 0o600); err != nil {
		t.Fatal(err)
	}
	instructions := []byte("operator-approved native instructions")
	if err := os.WriteFile(filepath.Join(source, "instructions.md"), instructions, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(source, "skills"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "skills", "must-not-copy"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_HOME", source)
	cfg := testRunnerConfig(t, profile, workspace, "go")
	runner, err := NewCodexRunner(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runner.Close() })
	readiness := runner.Readiness(t.Context())
	statuses := map[string]string{}
	for _, check := range readiness.Checks {
		statuses[check.Code] = check.Status
	}
	if statuses["profile_isolation"] != "pass" || statuses["auth_link"] != "pass" || statuses["profile_contents"] != "pass" || statuses["profile_settings"] != "pass" || statuses["auth_provider"] != "warn" {
		t.Fatalf("profile checks failed: %+v", readiness.Checks)
	}
	if !sameFile(filepath.Join(source, "auth.json"), filepath.Join(profile, "auth.json")) {
		t.Fatal("authentication was not linked")
	}
	clonedConfig, err := os.ReadFile(filepath.Join(profile, "config.toml"))
	if err != nil || !bytes.Equal(clonedConfig, configTOML) {
		t.Fatalf("native configuration was not cloned as a complete file: contents=%q err=%v", clonedConfig, err)
	}
	for name, want := range map[string][]byte{"config.json": configJSON, "instructions.md": instructions} {
		got, err := os.ReadFile(filepath.Join(profile, name))
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("native %s was not cloned exactly: contents=%q err=%v", name, got, err)
		}
	}
	if !bytes.Contains(clonedConfig, []byte("MCP_CANARY_MUST_NOT_START")) {
		t.Fatal("IncludeSettings did not retain the config.toml MCP section despite IncludeMCP=false")
	}
	joinedArgs := strings.Join(runner.filesystemGuard.expectedArgs, " ")
	if strings.Contains(joinedArgs, "model=") || strings.Contains(joinedArgs, "must-not-copy") || strings.Contains(joinedArgs, "MCP_CANARY_MUST_NOT_START") {
		t.Fatalf("provider/model routing was redundantly projected into host-owned arguments: %q", joinedArgs)
	}
	if children, err := os.ReadDir(filepath.Join(profile, "skills")); err != nil || len(children) != 0 {
		t.Fatalf("skills were inherited: %v %v", children, err)
	}
}

func TestDenyDecisionAdapterAccuratelyExposesHostDenial(t *testing.T) {
	descriptor := denyDecisionAdapter{DriverAdapter: codex.NewAdapter()}.Descriptor()
	if !descriptor.RunPolicyCaps.Permission.AutoReject || !descriptor.RunPolicyCaps.PlanReview.AutoReject {
		t.Fatal("host denial capability is not exposed")
	}
	policy := denyPolicy()
	if policy.HumanDecision.Permission != agentadaptor.HumanDecisionAutoReject || policy.Isolation != agentadaptor.IsolationReadOnly {
		t.Fatalf("unexpected policy: %+v", policy)
	}
}

func TestCodexCloneSelectionUsesExactNativeProfileContract(t *testing.T) {
	guard := &codexFilesystemGuard{sourceHome: filepath.Clean(`C:\native-codex`), profileDir: filepath.Clean(`C:\isolated-codex`)}
	selection := &agentadaptor.ProfileSelection{
		Mode: agentadaptor.ProfileModeClone,
		From: guard.sourceHome,
		Dir:  guard.profileDir,
		Clone: &agentadaptor.CloneProfileOptions{
			IncludeSettings: true,
			IncludeMCP:      false,
			IncludeSkills:   false,
			IncludeAuth:     true,
			AuthMode:        agentadaptor.CloneProfileAuthLink,
		},
	}
	if !guard.cloneSelectionValid(selection) {
		t.Fatal("the exact SDK native-profile clone selection was rejected")
	}
	for _, mutate := range []func(*agentadaptor.CloneProfileOptions){
		func(options *agentadaptor.CloneProfileOptions) { options.IncludeSettings = false },
		func(options *agentadaptor.CloneProfileOptions) { options.IncludeMCP = true },
		func(options *agentadaptor.CloneProfileOptions) { options.IncludeSkills = true },
		func(options *agentadaptor.CloneProfileOptions) { options.IncludeAuth = false },
		func(options *agentadaptor.CloneProfileOptions) { options.AuthMode = agentadaptor.CloneProfileAuthCopy },
	} {
		copySelection := *selection
		copyOptions := *selection.Clone
		mutate(&copyOptions)
		copySelection.Clone = &copyOptions
		if guard.cloneSelectionValid(&copySelection) {
			t.Fatal("a clone selection outside the exact native-profile contract was accepted")
		}
	}
}

func TestPinnedSDKCloneIsCopyIfMissingAndAuthModeOverridesIncludeAuth(t *testing.T) {
	source := t.TempDir()
	auth := writeTestNativeAuth(t, source)
	profileDir := filepath.Join(t.TempDir(), "profile")
	configPath := filepath.Join(source, "config.toml")
	instructionsPath := filepath.Join(source, "instructions.md")
	if err := os.WriteFile(configPath, []byte("model = 'first'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(instructionsPath, []byte("first instructions"), 0o600); err != nil {
		t.Fatal(err)
	}
	selection := &agentadaptor.ProfileSelection{
		Mode: agentadaptor.ProfileModeClone, From: source, Dir: profileDir,
		Clone: &agentadaptor.CloneProfileOptions{
			IncludeSettings: true,
			IncludeMCP:      false,
			IncludeSkills:   false,
			IncludeAuth:     true,
			AuthMode:        agentadaptor.CloneProfileAuthLink,
		},
	}
	base := codex.New(agentadaptor.CodexConfig{})
	driver, ok := base.Adapter().(agentadaptor.ProfileAwareDriver)
	if !ok {
		t.Fatal("pinned Codex adapter no longer exposes profile materialization")
	}
	clone := func() {
		t.Helper()
		resolved, err := driver.GetProfile(t.Context(), agentadaptor.CodexConfig{}, agentadaptor.AgentIdentity{}, selection)
		if err != nil || strings.TrimSpace(resolved.Error) != "" {
			t.Fatalf("pinned SDK clone failed: profile=%+v err=%v", resolved, err)
		}
	}
	clone()
	if !sameFile(auth, filepath.Join(profileDir, "auth.json")) {
		t.Fatal("IncludeAuth+AuthMode=Link did not retain shared auth identity")
	}
	if err := os.WriteFile(configPath, []byte("model = 'second'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(profileDir, "instructions.md"), []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	clone()
	clonedConfig, err := os.ReadFile(filepath.Join(profileDir, "config.toml"))
	if err != nil || string(clonedConfig) != "model = 'first'\n" {
		t.Fatalf("pinned SDK unexpectedly refreshed an existing setting: contents=%q err=%v", clonedConfig, err)
	}
	clonedInstructions, err := os.ReadFile(filepath.Join(profileDir, "instructions.md"))
	if err != nil || string(clonedInstructions) != "partial" {
		t.Fatalf("pinned SDK unexpectedly repaired a partial copy: contents=%q err=%v", clonedInstructions, err)
	}
}

func TestRunnerRepairsSidecarOwnedPartialSettingsThroughPinnedSDK(t *testing.T) {
	source := t.TempDir()
	writeTestNativeAuth(t, source)
	wantConfig := []byte("model = 'native'\n")
	wantInstructions := []byte("native instructions")
	if err := os.WriteFile(filepath.Join(source, "config.toml"), wantConfig, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "instructions.md"), wantInstructions, 0o600); err != nil {
		t.Fatal(err)
	}
	profile := filepath.Join(t.TempDir(), "profile")
	t.Setenv("CODEX_HOME", source)
	runner, err := NewCodexRunner(testRunnerConfig(t, profile, filepath.Join(t.TempDir(), "workspace"), "go"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runner.Close() })
	if readiness := runner.Readiness(t.Context()); !readiness.Ready {
		t.Fatalf("initial SDK clone was not ready: %+v", readiness.Checks)
	}
	if err := os.WriteFile(filepath.Join(profile, "config.toml"), []byte("model='partial'"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(profile, "instructions.md"), []byte("truncated"), 0o600); err != nil {
		t.Fatal(err)
	}
	if readiness := runner.Readiness(t.Context()); !readiness.Ready {
		t.Fatalf("sidecar-owned partial settings were not rebuilt: %+v", readiness.Checks)
	}
	if err := validateClonedCodexSettings(source, profile); err != nil {
		t.Fatalf("pinned SDK did not perform the final repaired clone: %v", err)
	}
}

func TestRunnerFailsClosedWhenNativeSettingsGenerationChanges(t *testing.T) {
	source := t.TempDir()
	writeTestNativeAuth(t, source)
	configPath := filepath.Join(source, "config.toml")
	if err := os.WriteFile(configPath, []byte("[mcp_servers.initial]\ncommand='initial'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	started := filepath.Join(t.TempDir(), "command-started")
	command := filepath.Join(t.TempDir(), "must-not-start")
	script := "#!/bin/sh\nset -eu\nif [ \"${1-}\" = \"--version\" ]; then echo 'codex-cli " + auditedCodexCLIVersion + "'; exit 0; fi\necho started > '" + strings.ReplaceAll(started, "'", "'\"'\"'") + "'\n"
	if runtime.GOOS == "windows" {
		command += ".cmd"
		script = "@echo off\r\nif \"%~1\"==\"--version\" (echo codex-cli " + auditedCodexCLIVersion + "& exit /b 0)\r\n> \"" + started + "\" echo started\r\n"
	}
	if err := os.WriteFile(command, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	profile := filepath.Join(t.TempDir(), "profile")
	t.Setenv("CODEX_HOME", source)
	runner, err := NewCodexRunner(testRunnerConfig(t, profile, filepath.Join(t.TempDir(), "workspace"), command))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runner.Close() })
	if readiness := runner.Readiness(t.Context()); !readiness.Ready {
		t.Fatalf("initial runner was not ready: %+v", readiness.Checks)
	}
	updated := []byte("[mcp_servers.initial]\ncommand='initial'\n[mcp_servers.\"new.server\"]\ncommand='MUST_NOT_START'\n")
	if err := os.WriteFile(configPath, updated, 0o600); err != nil {
		t.Fatal(err)
	}
	if readiness := runner.Readiness(t.Context()); readiness.Ready {
		t.Fatal("readiness accepted native settings changed after safety args were pinned")
	}
	_, err = runner.Run(t.Context(), RunRequest{Prompt: "must not start", Schema: []byte(`{"type":"object"}`), SchemaName: "settings_generation"})
	if err == nil || !strings.Contains(err.Error(), "restart the sidecar") {
		t.Fatalf("changed native settings did not fail closed with restart guidance: %v", err)
	}
	if _, err := os.Lstat(started); !os.IsNotExist(err) {
		t.Fatalf("Codex command started after native settings generation changed: %v", err)
	}
	cloned, err := os.ReadFile(filepath.Join(profile, "config.toml"))
	if err != nil || bytes.Contains(cloned, []byte("new.server")) {
		t.Fatalf("old runner hot-cloned newly added MCP settings: contents=%q err=%v", cloned, err)
	}
	if strings.Contains(strings.Join(runner.filesystemGuard.expectedArgs, " "), "new.server") {
		t.Fatal("old runner silently updated its pinned host safety projection")
	}
}

func TestRunnerRejectsCodexCLIUpgradeBeforeModelSpawn(t *testing.T) {
	source := t.TempDir()
	writeTestNativeAuth(t, source)
	profile := filepath.Join(t.TempDir(), "profile")
	workspace := filepath.Join(t.TempDir(), "workspace")
	started := filepath.Join(t.TempDir(), "model-started")
	command := writeVersionedFakeCodex(t, "codex-cli "+auditedCodexCLIVersion, "")
	t.Setenv("CODEX_HOME", source)
	runner, err := NewCodexRunner(testRunnerConfig(t, profile, workspace, command))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runner.Close() })

	var script string
	if runtime.GOOS == "windows" {
		script = "@echo off\r\nif \"%~1\"==\"--version\" (echo codex-cli 0.146.0& exit /b 0)\r\n> \"" + started + "\" echo started\r\n"
	} else {
		script = "#!/bin/sh\nset -eu\nif [ \"${1-}\" = \"--version\" ]; then echo 'codex-cli 0.146.0'; exit 0; fi\necho started > '" + strings.ReplaceAll(started, "'", "'\"'\"'") + "'\n"
	}
	if err := os.WriteFile(command, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	_, err = runner.Run(t.Context(), RunRequest{Prompt: "must not start", Schema: []byte(`{"type":"object"}`), SchemaName: "version_drift"})
	if err == nil || !strings.Contains(err.Error(), "unsupported Codex CLI version") {
		t.Fatalf("unaudited replacement was not rejected: %v", err)
	}
	if _, err := os.Lstat(started); !os.IsNotExist(err) {
		t.Fatalf("model command started after an unaudited CLI replacement: %v", err)
	}
}

func TestStableCredentialLeaseAllowsParallelAgentRuns(t *testing.T) {
	source := t.TempDir()
	sourceAuth := writeTestNativeAuth(t, source)
	profile := filepath.Join(t.TempDir(), "profile")
	if _, err := inspectRealDirectoryPath(profile, "test profile", true); err != nil {
		t.Fatal(err)
	}
	if err := ensureProfileOwnership(profile); err != nil {
		t.Fatal(err)
	}
	canonicalSource, err := canonicalPathForOverlap(source)
	if err != nil {
		t.Fatal(err)
	}
	profileLease, err := acquireExclusiveProfileLease(profile, canonicalSource)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = profileLease.Close() })
	if err := os.Link(sourceAuth, filepath.Join(profile, "auth.json")); err != nil {
		t.Fatal(err)
	}
	workspaceRoot := filepath.Join(t.TempDir(), "workspace")
	workspace, err := prepareDedicatedWorkspace(workspaceRoot)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_HOME", source)

	args := codexSafetyArgs()
	command := writeVersionedFakeCodex(t, "codex-cli "+auditedCodexCLIVersion, "")
	settingsGeneration, err := codexSettingsGeneration(source)
	if err != nil {
		t.Fatal(err)
	}
	guard := &codexFilesystemGuard{
		profileDir: profile, sourceHome: source, sourceAuth: sourceAuth,
		expectedArgs: args, workspaceRoot: workspaceRoot, workspaceDir: workspace,
		settingsGeneration: settingsGeneration, canonicalSource: canonicalSource, profileLease: profileLease, codexCommand: command,
	}
	base := &concurrentLeaseAdapter{
		entered: make(chan struct{}, 2), release: make(chan struct{}),
		clearTransient: make(chan struct{}), cleanupResult: make(chan error, 1),
		profileDir: profile,
	}
	adapter := denyDecisionAdapter{DriverAdapter: base, filesystemGuard: guard}
	selection := &agentadaptor.ProfileSelection{
		Mode: agentadaptor.ProfileModeClone, From: source, Dir: profile,
		Clone: &agentadaptor.CloneProfileOptions{IncludeSettings: true, IncludeMCP: false, IncludeSkills: false, IncludeAuth: true, AuthMode: agentadaptor.CloneProfileAuthLink},
	}
	request := agentadaptor.DriverRunRequest{
		Config:  agentadaptor.CodexConfig{CommonConfig: agentadaptor.CommonConfig{Command: command, CWD: workspace, ExtraArgs: args}},
		Profile: selection,
	}

	errorsByRun := make(chan error, 2)
	start := func() {
		go func() {
			_, runErr := adapter.Run(t.Context(), request, nil)
			errorsByRun <- runErr
		}()
	}
	start()
	select {
	case <-base.entered:
	case <-time.After(time.Second):
		close(base.release)
		t.Fatal("first stable-generation run did not enter")
	}
	start()
	select {
	case <-base.entered:
		close(base.clearTransient)
		close(base.release)
		t.Fatal("second run entered while the pinned SDK transaction was active")
	case runErr := <-errorsByRun:
		close(base.clearTransient)
		close(base.release)
		t.Fatalf("second stable-generation run failed before entering: %v", runErr)
	case <-time.After(25 * time.Millisecond):
	}
	close(base.clearTransient)
	if cleanupErr := <-base.cleanupResult; cleanupErr != nil {
		close(base.release)
		t.Fatal(cleanupErr)
	}
	select {
	case <-base.entered:
	case runErr := <-errorsByRun:
		close(base.release)
		t.Fatalf("second stable-generation run failed after transaction cleanup: %v", runErr)
	case <-time.After(time.Second):
		close(base.release)
		t.Fatal("second stable-generation run did not enter after transaction cleanup")
	}
	close(base.release)
	for range 2 {
		if runErr := <-errorsByRun; runErr != nil {
			t.Fatalf("parallel stable-generation run failed: %v", runErr)
		}
	}
}

func TestRecoverStalePinnedSDKProfileResidue(t *testing.T) {
	now := time.Now()
	profile := t.TempDir()
	if err := ensureProfileOwnership(profile); err != nil {
		t.Fatal(err)
	}
	staleNames := []string{
		sdkProfileLockName,
		"." + sdkProfileManifestName + ".tmp-123456789",
		".config.json.tmp-234567890",
		".config.toml.tmp-345678901",
		".instructions.md.tmp-456789012",
	}
	for _, name := range staleNames {
		path := filepath.Join(profile, name)
		if err := os.WriteFile(path, []byte("crash-residue"), 0o600); err != nil {
			t.Fatal(err)
		}
		old := now.Add(-sdkProfileResidueStaleAfter - time.Minute)
		if err := os.Chtimes(path, old, old); err != nil {
			t.Fatal(err)
		}
	}
	fresh := filepath.Join(profile, ".config.toml.tmp-567890123")
	if err := os.WriteFile(fresh, []byte("active"), 0o600); err != nil {
		t.Fatal(err)
	}
	nearMatch := filepath.Join(profile, ".config.toml.tmp-not-sdk")
	if err := os.WriteFile(nearMatch, []byte("unknown"), 0o600); err != nil {
		t.Fatal(err)
	}
	old := now.Add(-sdkProfileResidueStaleAfter - time.Minute)
	if err := os.Chtimes(nearMatch, old, old); err != nil {
		t.Fatal(err)
	}
	if err := recoverStaleSDKProfileResidue(profile, now); err != nil {
		t.Fatal(err)
	}
	for _, name := range staleNames {
		if _, err := os.Lstat(filepath.Join(profile, name)); !os.IsNotExist(err) {
			t.Fatalf("stale pinned SDK residue %q was not removed: %v", name, err)
		}
	}
	for _, path := range []string{fresh, nearMatch} {
		if _, err := os.Lstat(path); err != nil {
			t.Fatalf("fresh or near-match transaction entry was removed: %q: %v", path, err)
		}
	}

	unowned := t.TempDir()
	unownedLock := filepath.Join(unowned, sdkProfileLockName)
	if err := os.WriteFile(unownedLock, []byte("foreign"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(unownedLock, old, old); err != nil {
		t.Fatal(err)
	}
	if err := recoverStaleSDKProfileResidue(unowned, now); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(unownedLock); err != nil {
		t.Fatalf("unowned SDK-looking residue was modified: %v", err)
	}
}

func TestRecoverStalePinnedSDKProfileResidueRejectsLinks(t *testing.T) {
	profile := t.TempDir()
	if err := ensureProfileOwnership(profile); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "external-lock")
	if err := os.WriteFile(target, []byte("external"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(profile, sdkProfileLockName)
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("file symlink creation is unavailable: %v", err)
	}
	if err := recoverStaleSDKProfileResidue(profile, time.Now().Add(24*time.Hour)); err == nil {
		t.Fatal("linked SDK residue was accepted for recovery")
	}
	contents, err := os.ReadFile(target)
	if err != nil || string(contents) != "external" {
		t.Fatalf("external residue link target was modified: contents=%q err=%v", contents, err)
	}
}

func TestCodexSafetyArgumentsRemoveToolSurfaces(t *testing.T) {
	joined := strings.Join(codexSafetyArgs(), " ")
	required := []string{"--sandbox read-only", "--ignore-rules", `-c web_search="disabled"`, "-c notify=[]", "--ephemeral"}
	for _, feature := range []string{
		"shell_tool", "unified_exec", "shell_zsh_fork", "unified_exec_zsh_fork", "shell_snapshot", "deferred_executor",
		"code_mode", "code_mode_buffered_exec", "code_mode_host", "code_mode_only", "executor_capability_discovery",
		"hooks", "web_search_request", "web_search_cached", "standalone_web_search", "search_tool",
		"browser_use", "browser_use_full_cdp_access", "browser_use_external", "computer_use", "image_generation", "in_app_browser",
		"apps", "enable_mcp_apps", "apps_mcp_path_override", "plugins", "plugin_hooks", "remote_plugin", "plugin_sharing",
		"multi_agent", "multi_agent_v2", "multi_agent_mode", "enable_fanout", "collaboration_modes", "skill_mcp_dependency_install",
		"chronicle", "memories", "external_agent_memory_import", "goals", "artifact", "realtime_conversation", "network_proxy",
		"request_permissions_tool", "workspace_dependencies", "skill_search", "tool_suggest", "auth_elicitation",
		"tool_call_mcp_elicitation", "prevent_idle_sleep",
	} {
		required = append(required, "--disable "+feature)
	}
	for _, required := range required {
		if !strings.Contains(joined, required) {
			t.Fatalf("missing safety argument %q in %q", required, joined)
		}
	}
	if strings.Contains(joined, "--ignore-user-config") {
		t.Fatalf("native Codex settings were disabled by host arguments: %q", joined)
	}
	if strings.Contains(joined, "--strict-config") {
		t.Fatalf("complete native settings must retain Codex's forward-compatible field handling: %q", joined)
	}
	if strings.Contains(joined, "dangerously-bypass") {
		t.Fatalf("unsafe argument in %q", joined)
	}
}

func TestCodexChildEnvironmentClearsInheritedCredentials(t *testing.T) {
	credentialNames := []string{
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
	for _, name := range credentialNames {
		t.Setenv(name, "must-not-reach-codex-child")
	}
	bindings := codexChildEnvironmentBindings()
	values := make(map[string]string, len(bindings))
	for _, binding := range bindings {
		values[binding.Name] = binding.Value
	}
	for _, name := range credentialNames {
		value, ok := values[name]
		if !ok || value != "" {
			t.Fatalf("credential %s was not explicitly cleared: present=%v value=%q", name, ok, value)
		}
	}
	if _, ok := values["CODEX_HOME"]; ok {
		t.Fatal("credential filtering must not override the cloned profile CODEX_HOME binding")
	}
	values = make(map[string]string)
	for _, binding := range credentialEnvironmentBindings([]string{"openai_api_key=case-variant-must-not-reach-child"}) {
		values[binding.Name] = binding.Value
	}
	if value, ok := values["openai_api_key"]; !ok || value != "" {
		t.Fatalf("case-variant credential was not explicitly cleared: present=%v value=%q", ok, value)
	}
	values = make(map[string]string)
	for _, binding := range credentialEnvironmentBindings([]string{
		"FUTURE_PROVIDER_API_KEY=unlisted-provider-secret",
		"AWS_SECRET_ACCESS_KEY=unlisted-cloud-secret",
		"UNLISTED_CLOUD_PASSWORD=unlisted-cloud-password",
		"SSH_AUTH_SOCK=/credential/broker.sock",
		"openai_base_url=https://untrusted-provider.invalid",
		"RANDOM_HOST_VALUE=must-not-reach-child",
		"PATH=/must/remain/available",
		"HOME=/safe/runtime/home",
		"SystemRoot=C:\\Windows",
		"CODEX_HOME=/source/profile/overridden-by-sdk",
		"=C:=C:\\workspace\\current-directory",
		"HTTP_PROXY=http://proxy.example:8080",
		"HTTPS_PROXY=http://user:password@proxy.example:8080",
	}) {
		values[binding.Name] = binding.Value
	}
	for _, name := range []string{"FUTURE_PROVIDER_API_KEY", "AWS_SECRET_ACCESS_KEY", "UNLISTED_CLOUD_PASSWORD", "SSH_AUTH_SOCK", "openai_base_url", "RANDOM_HOST_VALUE", "HTTPS_PROXY"} {
		if value, ok := values[name]; !ok || value != "" {
			t.Fatalf("dynamic credential %s was not explicitly cleared: present=%v value=%q", name, ok, value)
		}
	}
	for _, name := range []string{"PATH", "HOME", "SystemRoot", "CODEX_HOME", "HTTP_PROXY"} {
		if _, ok := values[name]; ok {
			t.Fatalf("safe runtime environment %s must remain available or be injected by the SDK", name)
		}
	}
	if _, ok := values[""]; ok {
		t.Fatal("Windows drive-current-directory pseudo environment produced an invalid empty-name binding")
	}
}

func TestCodexHomeEnvironmentRequiresCanonicalCasing(t *testing.T) {
	if err := validateCodexHomeEnvironment([]string{"CODEX_HOME=/linked/source"}); err != nil {
		t.Fatalf("canonical CODEX_HOME was rejected: %v", err)
	}
	for _, name := range []string{"codex_home", "Codex_Home", "CODEX_home"} {
		if err := validateCodexHomeEnvironment([]string{name + "=/native/profile"}); err == nil {
			t.Fatalf("expected mixed-case key %q to fail closed", name)
		}
		bindings := credentialEnvironmentBindings([]string{name + "=/native/profile"})
		found := false
		for _, binding := range bindings {
			if binding.Name == name && binding.Value == "" {
				found = true
			}
		}
		if !found {
			t.Fatalf("mixed-case key %q was not defensively cleared", name)
		}
	}
}

func TestCodexSubprocessUsesOnlyLinkedProfileAuthentication(t *testing.T) {
	source := t.TempDir()
	profile := filepath.Join(t.TempDir(), "profile")
	workspace := filepath.Join(t.TempDir(), "workspace")
	capture := filepath.Join(t.TempDir(), "environment.txt")
	if err := os.WriteFile(filepath.Join(source, "auth.json"), []byte(`{"tokens":{"access_token":"test-only"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	nativeConfig := `
model = "gpt-native"
model_provider = "company.prod"
approval_policy = "never"
[model_providers."company.prod"]
name = "Company Gateway"
base_url = "https://gateway.example.com/v1"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
[model_providers.unselected]
env_key = "MUST_NOT_REACH_CHILD"
[mcp_servers."native.canary"]
command = "MCP_COMMAND_MUST_NOT_START"
`
	if err := os.WriteFile(filepath.Join(source, "config.toml"), []byte(nativeConfig), 0o600); err != nil {
		t.Fatal(err)
	}
	command := filepath.Join(t.TempDir(), "fake-codex")
	escapedCapture := strings.ReplaceAll(capture, "'", "'\"'\"'")
	script := "#!/bin/sh\nset -eu\nif [ \"${1-}\" = \"--version\" ]; then echo 'codex-cli " + auditedCodexCLIVersion + "'; exit 0; fi\nprintf 'AIOS=%s\\nOPENAI=%s\\nAZURE=%s\\nFUTURE=%s\\nRANDOM=%s\\nCODEX_HOME=%s\\n' \"$AIOS_SIDECAR_TOKEN\" \"$OPENAI_API_KEY\" \"$AZURE_CLIENT_SECRET\" \"$FUTURE_PROVIDER_API_KEY\" \"$RANDOM_HOST_VALUE\" \"$CODEX_HOME\" > '__CAPTURE__'\nfor arg in \"$@\"; do printf 'ARG=%s\\n' \"$arg\" >> '__CAPTURE__'; done\ncat >/dev/null\nprintf '{\"type\":\"thread.started\",\"thread_id\":\"fake-thread\"}\\n'\nprintf '{\"type\":\"item.completed\",\"item\":{\"id\":\"fake-message\",\"type\":\"agent_message\",\"text\":\"{\\\"ok\\\":true}\"}}\\n'\nprintf '{\"type\":\"turn.completed\",\"usage\":{}}\\n'\n"
	script = strings.ReplaceAll(script, "__CAPTURE__", escapedCapture)
	if runtime.GOOS == "windows" {
		command += ".cmd"
		escapedCapture = strings.ReplaceAll(capture, "%", "%%")
		script = "@echo off\r\nif \"%~1\"==\"--version\" (echo codex-cli " + auditedCodexCLIVersion + "& exit /b 0)\r\n> \"__CAPTURE__\" (\r\n  echo AIOS=%AIOS_SIDECAR_TOKEN%\r\n  echo OPENAI=%OPENAI_API_KEY%\r\n  echo AZURE=%AZURE_CLIENT_SECRET%\r\n  echo FUTURE=%FUTURE_PROVIDER_API_KEY%\r\n  echo RANDOM=%RANDOM_HOST_VALUE%\r\n  echo CODEX_HOME=%CODEX_HOME%\r\n  echo ARGS=%*\r\n)\r\necho {\"type\":\"thread.started\",\"thread_id\":\"fake-thread\"}\r\necho {\"type\":\"item.completed\",\"item\":{\"id\":\"fake-message\",\"type\":\"agent_message\",\"text\":\"{\\\"ok\\\":true}\"}}\r\necho {\"type\":\"turn.completed\",\"usage\":{}}\r\n"
		script = strings.ReplaceAll(script, "__CAPTURE__", escapedCapture)
	}
	if err := os.WriteFile(command, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}

	t.Setenv("CODEX_HOME", source)
	t.Setenv("AIOS_SIDECAR_TOKEN", "sidecar-secret-must-not-leak")
	t.Setenv("OPENAI_API_KEY", "provider-secret-must-not-override-link")
	t.Setenv("AZURE_CLIENT_SECRET", "azure-secret-must-not-leak")
	cfg := config.Config{ListenAddress: "127.0.0.1:4317", Token: strings.Repeat("x", 32), AllowedOrigin: "http://localhost:5173", ProfileDir: profile, WorkspaceDir: workspace, CodexCommand: command, MaxBodyBytes: 1024, MaxConcurrentRuns: 1, ChatTimeout: time.Second, GameTimeout: time.Second, ReadinessTimeout: time.Second}
	runner, err := NewCodexRunner(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runner.Close() })
	// Added after construction to prove the adapter refreshes the fail-closed
	// allowlist at the actual process-spawn boundary.
	t.Setenv("FUTURE_PROVIDER_API_KEY", "unlisted-provider-secret-must-not-leak")
	t.Setenv("RANDOM_HOST_VALUE", "ordinary-unknown-value-must-not-leak")
	result, err := runner.Run(t.Context(), RunRequest{
		Prompt:     "respond with structured output",
		Schema:     []byte(`{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false}`),
		SchemaName: "credential_isolation_test",
	})
	if err != nil {
		t.Fatal(err)
	}
	if string(result.JSON) != `{"ok":true}` {
		t.Fatalf("unexpected fake Codex result: %s", result.JSON)
	}
	raw, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	values := map[string]string{}
	for _, line := range strings.Split(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\n") {
		name, value, ok := strings.Cut(line, "=")
		if ok {
			values[name] = value
		}
	}
	for _, name := range []string{"AIOS", "OPENAI", "AZURE", "FUTURE", "RANDOM"} {
		if values[name] != "" {
			t.Fatalf("%s credential reached the Codex subprocess", name)
		}
	}
	if !strings.EqualFold(filepath.Clean(values["CODEX_HOME"]), filepath.Clean(profile)) {
		t.Fatalf("subprocess did not use cloned profile: got %q want %q", values["CODEX_HOME"], profile)
	}
	if !sameFile(filepath.Join(source, "auth.json"), filepath.Join(profile, "auth.json")) {
		t.Fatal("cloned profile did not retain linked authentication")
	}
	argvCapture := string(raw)
	for _, required := range []string{"--ignore-rules", "--disable hooks", "notify=[]", "mcp_servers={", "native.canary", "enabled=false"} {
		if !strings.Contains(argvCapture, required) {
			t.Fatalf("fake Codex did not receive host safety override %q: %s", required, argvCapture)
		}
	}
	for _, forbidden := range []string{"--ignore-user-config", "--output-schema", "model_provider=", "model_providers=", "https://gateway.example.com/v1", "approval_policy", "env_key", "MUST_NOT_REACH_CHILD", "unselected", "MCP_COMMAND_MUST_NOT_START"} {
		if strings.Contains(argvCapture, forbidden) {
			t.Fatalf("fake Codex argv received native value or removed flag %q: %s", forbidden, argvCapture)
		}
	}
	if err := validateClonedCodexSettings(source, profile); err != nil {
		t.Fatalf("real SDK run did not preserve the full native settings semantics: %v", err)
	}
}

func TestRealSDKPromptValidationRejectsSchemaInvalidJSON(t *testing.T) {
	source := t.TempDir()
	writeTestNativeAuth(t, source)
	profile := filepath.Join(t.TempDir(), "profile")
	workspace := filepath.Join(t.TempDir(), "workspace")
	command := filepath.Join(t.TempDir(), "schema-invalid-fake-codex")
	script := "#!/bin/sh\nset -eu\nif [ \"${1-}\" = \"--version\" ]; then echo 'codex-cli " + auditedCodexCLIVersion + "'; exit 0; fi\ncat >/dev/null\nprintf '{\"type\":\"thread.started\",\"thread_id\":\"schema-thread\"}\\n'\nprintf '{\"type\":\"item.completed\",\"item\":{\"id\":\"schema-message\",\"type\":\"agent_message\",\"text\":\"{\\\"ok\\\":\\\"not-a-boolean\\\"}\"}}\\n'\nprintf '{\"type\":\"turn.completed\",\"usage\":{}}\\n'\n"
	if runtime.GOOS == "windows" {
		command += ".cmd"
		script = "@echo off\r\nif \"%~1\"==\"--version\" (echo codex-cli " + auditedCodexCLIVersion + "& exit /b 0)\r\necho {\"type\":\"thread.started\",\"thread_id\":\"schema-thread\"}\r\necho {\"type\":\"item.completed\",\"item\":{\"id\":\"schema-message\",\"type\":\"agent_message\",\"text\":\"{\\\"ok\\\":\\\"not-a-boolean\\\"}\"}}\r\necho {\"type\":\"turn.completed\",\"usage\":{}}\r\n"
	}
	if err := os.WriteFile(command, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_HOME", source)
	runner, err := NewCodexRunner(testRunnerConfig(t, profile, workspace, command))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runner.Close() })
	_, err = runner.Run(t.Context(), RunRequest{
		Prompt:     "return schema-invalid structured output",
		Schema:     []byte(`{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false}`),
		SchemaName: "local_schema_rejection",
	})
	if !errors.Is(err, ErrInvalidAI) {
		t.Fatalf("local SDK schema rejection = %v, want %v", err, ErrInvalidAI)
	}
}

func TestRealSDKProfileMaterializationSupportsParallelRuns(t *testing.T) {
	source := t.TempDir()
	writeTestNativeAuth(t, source)
	profile := filepath.Join(t.TempDir(), "profile")
	workspace := filepath.Join(t.TempDir(), "workspace")
	command := filepath.Join(t.TempDir(), "parallel-fake-codex")
	script := "#!/bin/sh\nset -eu\nif [ \"${1-}\" = \"--version\" ]; then echo 'codex-cli " + auditedCodexCLIVersion + "'; exit 0; fi\ncat >/dev/null\nsleep 0.2\nprintf '{\"type\":\"thread.started\",\"thread_id\":\"parallel-thread\"}\\n'\nprintf '{\"type\":\"item.completed\",\"item\":{\"id\":\"parallel-message\",\"type\":\"agent_message\",\"text\":\"{\\\"ok\\\":true}\"}}\\n'\nprintf '{\"type\":\"turn.completed\",\"usage\":{}}\\n'\n"
	if runtime.GOOS == "windows" {
		command += ".cmd"
		script = "@echo off\r\nif \"%~1\"==\"--version\" (echo codex-cli " + auditedCodexCLIVersion + "& exit /b 0)\r\nping 127.0.0.1 -n 2 >nul\r\necho {\"type\":\"thread.started\",\"thread_id\":\"parallel-thread\"}\r\necho {\"type\":\"item.completed\",\"item\":{\"id\":\"parallel-message\",\"type\":\"agent_message\",\"text\":\"{\\\"ok\\\":true}\"}}\r\necho {\"type\":\"turn.completed\",\"usage\":{}}\r\n"
	}
	if err := os.WriteFile(command, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_HOME", source)
	runner, err := NewCodexRunner(testRunnerConfig(t, profile, workspace, command))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runner.Close() })
	if readiness := runner.Readiness(t.Context()); !readiness.Ready {
		t.Fatalf("parallel SDK test profile was not ready: %+v", readiness.Checks)
	}

	const workers = 6
	start := make(chan struct{})
	results := make(chan error, workers)
	for range workers {
		go func() {
			<-start
			result, runErr := runner.Run(t.Context(), RunRequest{
				Prompt:     "return structured output",
				Schema:     []byte(`{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false}`),
				SchemaName: "parallel_profile_materialization",
			})
			if runErr == nil && string(result.JSON) != `{"ok":true}` {
				runErr = fmt.Errorf("unexpected parallel result %s", result.JSON)
			}
			results <- runErr
		}()
	}
	close(start)
	for range workers {
		if runErr := <-results; runErr != nil {
			t.Fatalf("parallel real-SDK run failed: %v", runErr)
		}
	}
	if runner.authState != codexAuthVerified || !runner.hasAuthGeneration {
		t.Fatal("parallel real-SDK runs did not record the credential generation used at the spawn lease")
	}
	if err := isolatedProfileContentsQuiescent(profile); err != nil {
		t.Fatalf("profile did not return to a closed quiescent state: %v", err)
	}
}

func TestPrepareDedicatedWorkspaceCreatesDistinctEmptyChildren(t *testing.T) {
	root := filepath.Join(t.TempDir(), "workspace-root")
	first, err := prepareDedicatedWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	second, err := prepareDedicatedWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	if first == second || filepath.Dir(first) != root || filepath.Dir(second) != root {
		t.Fatalf("expected distinct children under %q, got %q and %q", root, first, second)
	}
	for _, workspace := range []string{first, second} {
		entries, err := os.ReadDir(workspace)
		if err != nil || len(entries) != 0 {
			t.Fatalf("run workspace is not empty: %q entries=%v err=%v", workspace, entries, err)
		}
	}
	marker, err := os.ReadFile(filepath.Join(root, workspaceOwnershipMarker))
	if err != nil || string(marker) != workspaceOwnershipMarker+"\n" {
		t.Fatalf("invalid workspace ownership marker: contents=%q err=%v", marker, err)
	}
}

func TestPrepareDedicatedWorkspaceRejectsUnclaimedOrUnknownContent(t *testing.T) {
	empty := t.TempDir()
	if _, err := prepareDedicatedWorkspace(empty); err == nil {
		t.Fatal("expected an existing unclaimed empty root to be rejected")
	}

	unclaimed := t.TempDir()
	if err := os.WriteFile(filepath.Join(unclaimed, "AGENTS.md"), []byte("untrusted instructions"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := prepareDedicatedWorkspace(unclaimed); err == nil {
		t.Fatal("expected an unclaimed non-empty root to be rejected")
	}
	if _, err := os.Stat(filepath.Join(unclaimed, "AGENTS.md")); err != nil {
		t.Fatalf("unknown user content was modified: %v", err)
	}

	claimed := filepath.Join(t.TempDir(), "claimed")
	if _, err := prepareDedicatedWorkspace(claimed); err != nil {
		t.Fatal(err)
	}
	unknown := filepath.Join(claimed, "project.rules")
	if err := os.WriteFile(unknown, []byte("untrusted instructions"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := prepareDedicatedWorkspace(claimed); err == nil {
		t.Fatal("expected unknown content in a claimed root to be rejected")
	}
	if _, err := os.Stat(unknown); err != nil {
		t.Fatalf("unknown user content was modified: %v", err)
	}
}

func TestNewCodexRunnerPreflightRejectsExistingProfileWithoutMutation(t *testing.T) {
	for _, testCase := range []struct {
		name     string
		populate func(*testing.T, string)
	}{
		{name: "unclaimed-empty", populate: func(*testing.T, string) {}},
		{name: "foreign-auth", populate: func(t *testing.T, profile string) {
			if err := os.WriteFile(filepath.Join(profile, "auth.json"), []byte("do-not-replace"), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "arbitrary-content", populate: func(t *testing.T, profile string) {
			if err := os.WriteFile(filepath.Join(profile, "user-project.txt"), []byte("do-not-touch"), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			source := t.TempDir()
			writeTestNativeAuth(t, source)
			profile := t.TempDir()
			testCase.populate(t, profile)
			workspace := filepath.Join(t.TempDir(), "must-not-be-created")
			before, err := snapshotDirectory(profile)
			if err != nil {
				t.Fatal(err)
			}
			t.Setenv("CODEX_HOME", source)
			if _, err := NewCodexRunner(testRunnerConfig(t, profile, workspace, "go")); err == nil {
				t.Fatal("unsafe existing profile was accepted")
			}
			after, err := snapshotDirectory(profile)
			if err != nil {
				t.Fatal(err)
			}
			if before != after {
				t.Fatalf("existing profile changed during rejected preflight: before=%q after=%q", before, after)
			}
			if _, err := os.Lstat(workspace); !os.IsNotExist(err) {
				t.Fatalf("workspace was created before profile preflight failed: %v", err)
			}
		})
	}
}

func TestExistingUnclaimedProfileWithSameAuthenticationIsRejected(t *testing.T) {
	source := t.TempDir()
	sourceAuth := writeTestNativeAuth(t, source)
	profile := t.TempDir()
	if err := os.Link(sourceAuth, filepath.Join(profile, "auth.json")); err != nil {
		t.Fatal(err)
	}
	workspace := filepath.Join(t.TempDir(), "workspace")
	t.Setenv("CODEX_HOME", source)
	_, err := NewCodexRunner(testRunnerConfig(t, profile, workspace, "go"))
	if err == nil {
		t.Fatal("an unclaimed existing profile was accepted")
	}
	if !sameFile(sourceAuth, filepath.Join(profile, "auth.json")) {
		t.Fatal("rejected preflight modified the native authentication identity")
	}
	if profileOwnershipValid(profile) {
		t.Fatal("rejected preflight claimed an existing unowned profile")
	}
	if _, err := os.Lstat(workspace); !os.IsNotExist(err) {
		t.Fatalf("workspace was created before unclaimed profile rejection: %v", err)
	}
}

func TestReadinessReconcilesSidecarOwnedStaleAuthentication(t *testing.T) {
	source := t.TempDir()
	sourceAuth := writeTestNativeAuth(t, source)
	profile := filepath.Join(t.TempDir(), "profile")
	workspace := filepath.Join(t.TempDir(), "workspace")
	t.Setenv("CODEX_HOME", source)
	runner, err := NewCodexRunner(testRunnerConfig(t, profile, workspace, "go"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runner.Close() })
	if readiness := runner.Readiness(t.Context()); !readiness.Ready {
		t.Fatalf("initial readiness failed: %+v", readiness.Checks)
	}
	authPath := filepath.Join(profile, "auth.json")
	if !sameFile(sourceAuth, authPath) {
		t.Fatal("initial SDK clone did not link native authentication")
	}
	if err := os.Remove(sourceAuth); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sourceAuth, []byte(`{"OPENAI_API_KEY":"refreshed-test-only"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	// A symlink follows path replacement immediately; a Windows hardlink is
	// stale until the SDK reconciles it. Both are valid AuthLink outcomes.
	readiness := runner.Readiness(t.Context())
	if !readiness.Ready {
		t.Fatalf("readiness did not reconcile refreshed authentication: %+v", readiness.Checks)
	}
	if !sameFile(sourceAuth, authPath) {
		t.Fatal("SDK readiness did not relink the refreshed native authentication")
	}
	if err := os.Remove(sourceAuth); err != nil {
		t.Fatal(err)
	}
	if readiness := runner.Readiness(t.Context()); readiness.Ready {
		t.Fatal("readiness remained ready after native Codex logout")
	}
	if _, err := os.Lstat(authPath); !os.IsNotExist(err) {
		t.Fatalf("sidecar-owned stale authentication survived native logout reconciliation: %v", err)
	}
}

func TestRunWithoutNativeAuthenticationReturnsStableAuthenticationError(t *testing.T) {
	source := t.TempDir()
	profile := filepath.Join(t.TempDir(), "profile")
	workspace := filepath.Join(t.TempDir(), "workspace")
	t.Setenv("CODEX_HOME", source)
	runner, err := NewCodexRunner(testRunnerConfig(t, profile, workspace, "go"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = runner.Close() })
	_, err = runner.Run(t.Context(), RunRequest{
		Prompt:     "must not start",
		Schema:     []byte(`{"type":"object"}`),
		SchemaName: "missing_auth_preflight",
	})
	if !errors.Is(err, ErrAuthentication) {
		t.Fatalf("missing native authentication returned %v", err)
	}
}

func TestRunRevalidatesFilesystemAfterCachedReadiness(t *testing.T) {
	t.Run("stale-owned-auth-is-reconciled", func(t *testing.T) {
		source := t.TempDir()
		writeTestNativeAuth(t, source)
		profile := filepath.Join(t.TempDir(), "profile")
		workspace := filepath.Join(t.TempDir(), "workspace")
		t.Setenv("CODEX_HOME", source)
		runner, err := NewCodexRunner(testRunnerConfig(t, profile, workspace, "go"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = runner.Close() })
		_ = runner.Readiness(t.Context())
		authPath := filepath.Join(profile, "auth.json")
		if err := os.Remove(authPath); err != nil {
			t.Fatal(err)
		}
		foreign := []byte("foreign-auth-must-survive-run")
		if err := os.WriteFile(authPath, foreign, 0o600); err != nil {
			t.Fatal(err)
		}
		_, err = runner.Run(t.Context(), RunRequest{Prompt: "must not start", Schema: []byte(`{"type":"object"}`), SchemaName: "preflight_test"})
		if err == nil {
			t.Fatal("the non-Codex test command unexpectedly produced a valid result")
		}
		if !sameFile(filepath.Join(source, "auth.json"), authPath) {
			t.Fatal("run did not use SDK clone reconciliation for the sidecar-owned stale authentication")
		}
	})

	for _, injected := range []string{"AGENTS.md", filepath.Join(".codex", "config.toml")} {
		t.Run("injected-workspace-"+strings.ReplaceAll(injected, string(filepath.Separator), "-"), func(t *testing.T) {
			source := t.TempDir()
			writeTestNativeAuth(t, source)
			profile := filepath.Join(t.TempDir(), "profile")
			workspaceRoot := filepath.Join(t.TempDir(), "workspace")
			t.Setenv("CODEX_HOME", source)
			runner, err := NewCodexRunner(testRunnerConfig(t, profile, workspaceRoot, "go"))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = runner.Close() })
			injectedPath := filepath.Join(runner.filesystemGuard.workspaceDir, injected)
			if err := os.MkdirAll(filepath.Dir(injectedPath), 0o700); err != nil {
				t.Fatal(err)
			}
			contents := []byte("untrusted project configuration")
			if err := os.WriteFile(injectedPath, contents, 0o600); err != nil {
				t.Fatal(err)
			}
			_, err = runner.Run(t.Context(), RunRequest{Prompt: "must not start", Schema: []byte(`{"type":"object"}`), SchemaName: "preflight_test"})
			if err == nil || !strings.Contains(err.Error(), "workspace must remain empty") {
				t.Fatalf("run did not reject injected workspace resource %q: %v", injected, err)
			}
			got, readErr := os.ReadFile(injectedPath)
			if readErr != nil || !bytes.Equal(got, contents) {
				t.Fatalf("run modified injected workspace resource %q: contents=%q err=%v", injected, got, readErr)
			}
		})
	}

	t.Run("tampered-cloned-settings-are-rebuilt-by-sdk", func(t *testing.T) {
		source := t.TempDir()
		writeTestNativeAuth(t, source)
		if err := os.WriteFile(filepath.Join(source, "config.toml"), []byte("model = 'safe-model'\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		profile := filepath.Join(t.TempDir(), "profile")
		workspace := filepath.Join(t.TempDir(), "workspace")
		t.Setenv("CODEX_HOME", source)
		runner, err := NewCodexRunner(testRunnerConfig(t, profile, workspace, "go"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = runner.Close() })
		_ = runner.Readiness(t.Context())
		configPath := filepath.Join(profile, "config.toml")
		tampered := []byte("model = 'attacker-model'\n")
		if err := os.WriteFile(configPath, tampered, 0o600); err != nil {
			t.Fatal(err)
		}
		_, err = runner.Run(t.Context(), RunRequest{Prompt: "must not start", Schema: []byte(`{"type":"object"}`), SchemaName: "preflight_test"})
		if err == nil {
			t.Fatal("the non-Codex test command unexpectedly produced a valid result")
		}
		if settingsErr := validateClonedCodexSettings(source, profile); settingsErr != nil {
			t.Fatalf("sidecar-owned tampered settings were not rebuilt by the pinned SDK: %v", settingsErr)
		}
		contents, readErr := os.ReadFile(configPath)
		if readErr != nil || bytes.Equal(contents, tampered) {
			t.Fatalf("tampered settings survived SDK reconciliation: contents=%q err=%v", contents, readErr)
		}
	})

	t.Run("linked-run-workspace", func(t *testing.T) {
		source := t.TempDir()
		writeTestNativeAuth(t, source)
		profile := filepath.Join(t.TempDir(), "profile")
		workspaceRoot := filepath.Join(t.TempDir(), "workspace")
		t.Setenv("CODEX_HOME", source)
		runner, err := NewCodexRunner(testRunnerConfig(t, profile, workspaceRoot, "go"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = runner.Close() })
		_ = runner.Readiness(t.Context())
		runWorkspace := runner.filesystemGuard.workspaceDir
		if err := os.Remove(runWorkspace); err != nil {
			t.Fatal(err)
		}
		target := t.TempDir()
		if err := os.Symlink(target, runWorkspace); err != nil {
			t.Skipf("directory symlink creation is unavailable: %v", err)
		}
		_, err = runner.Run(t.Context(), RunRequest{Prompt: "must not start", Schema: []byte(`{"type":"object"}`), SchemaName: "preflight_test"})
		if err == nil || !strings.Contains(err.Error(), "preflight") {
			t.Fatalf("run did not reject linked workspace at filesystem preflight: %v", err)
		}
	})
}

func TestNewCodexRunnerRejectsLinkedOrSpecialProfileAndWorkspacePaths(t *testing.T) {
	for _, target := range []string{"profile-root", "profile-parent", "workspace-root", "workspace-parent"} {
		t.Run(target, func(t *testing.T) {
			source := t.TempDir()
			writeTestNativeAuth(t, source)
			base := t.TempDir()
			linkTarget := t.TempDir()
			link := filepath.Join(base, "linked")
			if err := os.Symlink(linkTarget, link); err != nil {
				t.Skipf("directory symlink creation is unavailable: %v", err)
			}
			profile := filepath.Join(base, "profile")
			workspace := filepath.Join(base, "workspace")
			switch target {
			case "profile-root":
				profile = link
			case "profile-parent":
				profile = filepath.Join(link, "profile")
			case "workspace-root":
				workspace = link
			case "workspace-parent":
				workspace = filepath.Join(link, "workspace")
			}
			t.Setenv("CODEX_HOME", source)
			if _, err := NewCodexRunner(testRunnerConfig(t, profile, workspace, "go")); err == nil {
				t.Fatalf("%s symlink path was accepted", target)
			}
		})
	}

	for _, target := range []string{"profile", "workspace"} {
		t.Run(target+"-special-file", func(t *testing.T) {
			source := t.TempDir()
			writeTestNativeAuth(t, source)
			base := t.TempDir()
			profile := filepath.Join(base, "profile")
			workspace := filepath.Join(base, "workspace")
			path := profile
			if target == "workspace" {
				path = workspace
			}
			if err := os.WriteFile(path, []byte("not-a-directory"), 0o600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("CODEX_HOME", source)
			if _, err := NewCodexRunner(testRunnerConfig(t, profile, workspace, "go")); err == nil {
				t.Fatalf("%s special file was accepted", target)
			}
		})
	}
}

func TestNewCodexRunnerRejectsNativeHomeLinksAndDirectoryOverlap(t *testing.T) {
	t.Run("native-home-link", func(t *testing.T) {
		nativeTarget := t.TempDir()
		writeTestNativeAuth(t, nativeTarget)
		link := filepath.Join(t.TempDir(), "native-link")
		if err := os.Symlink(nativeTarget, link); err != nil {
			t.Skipf("directory symlink creation is unavailable: %v", err)
		}
		t.Setenv("CODEX_HOME", link)
		if _, err := NewCodexRunner(testRunnerConfig(t, filepath.Join(t.TempDir(), "profile"), filepath.Join(t.TempDir(), "workspace"), "go")); err == nil {
			t.Fatal("linked native Codex home was accepted")
		}
	})

	for _, authType := range []string{"directory", "symlink"} {
		t.Run("native-auth-"+authType, func(t *testing.T) {
			source := t.TempDir()
			authPath := filepath.Join(source, "auth.json")
			if authType == "directory" {
				if err := os.Mkdir(authPath, 0o700); err != nil {
					t.Fatal(err)
				}
			} else {
				target := filepath.Join(t.TempDir(), "auth-target.json")
				if err := os.WriteFile(target, []byte("native"), 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, authPath); err != nil {
					t.Skipf("file symlink creation is unavailable: %v", err)
				}
			}
			profile := filepath.Join(t.TempDir(), "profile")
			workspace := filepath.Join(t.TempDir(), "workspace")
			t.Setenv("CODEX_HOME", source)
			if _, err := NewCodexRunner(testRunnerConfig(t, profile, workspace, "go")); err == nil {
				t.Fatalf("native auth %s was accepted", authType)
			}
			if _, err := os.Lstat(profile); !os.IsNotExist(err) {
				t.Fatalf("profile was created before native auth rejection: %v", err)
			}
			if _, err := os.Lstat(workspace); !os.IsNotExist(err) {
				t.Fatalf("workspace was created before native auth rejection: %v", err)
			}
		})
	}

	for _, relation := range []string{"profile-inside-native", "native-inside-profile", "workspace-inside-native"} {
		t.Run(relation, func(t *testing.T) {
			base := t.TempDir()
			source := filepath.Join(base, "native")
			profile := filepath.Join(base, "profile")
			workspace := filepath.Join(base, "workspace")
			switch relation {
			case "profile-inside-native":
				profile = filepath.Join(source, "profile")
			case "native-inside-profile":
				source = filepath.Join(profile, "native")
			case "workspace-inside-native":
				workspace = filepath.Join(source, "workspace")
			}
			writeTestNativeAuth(t, source)
			t.Setenv("CODEX_HOME", source)
			_, err := NewCodexRunner(testRunnerConfig(t, profile, workspace, "go"))
			if err == nil || !strings.Contains(err.Error(), "overlap") {
				t.Fatalf("unsafe %s relationship was not rejected as overlap: %v", relation, err)
			}
		})
	}
}

func TestWorkspaceMarkerLinkIsRejectedWithoutFollowingIt(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(t.TempDir(), "external-marker")
	if err := os.WriteFile(target, []byte(workspaceOwnershipMarker+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(root, workspaceOwnershipMarker)); err != nil {
		t.Skipf("file symlink creation is unavailable: %v", err)
	}
	if _, err := prepareDedicatedWorkspace(root); err == nil {
		t.Fatal("linked workspace ownership marker was accepted")
	}
	contents, err := os.ReadFile(target)
	if err != nil || string(contents) != workspaceOwnershipMarker+"\n" {
		t.Fatalf("external marker was modified: contents=%q err=%v", contents, err)
	}
}

func snapshotDirectory(root string) (string, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return "", err
	}
	var snapshot strings.Builder
	for _, entry := range entries {
		info, err := os.Lstat(filepath.Join(root, entry.Name()))
		if err != nil {
			return "", err
		}
		snapshot.WriteString(entry.Name())
		snapshot.WriteByte(':')
		snapshot.WriteString(info.Mode().String())
		if info.Mode().IsRegular() {
			contents, err := os.ReadFile(filepath.Join(root, entry.Name()))
			if err != nil {
				return "", err
			}
			snapshot.WriteByte(':')
			snapshot.Write(contents)
		}
		snapshot.WriteByte('\n')
	}
	return snapshot.String(), nil
}

func TestWorkspaceRootCannotOverlapAuthenticationOrProfile(t *testing.T) {
	base := t.TempDir()
	for _, paths := range [][2]string{
		{base, filepath.Join(base, "child")},
		{filepath.Join(base, "child"), base},
		{base, base},
	} {
		if !pathsOverlap(paths[0], paths[1]) {
			t.Fatalf("expected paths to overlap: %q and %q", paths[0], paths[1])
		}
	}
	if pathsOverlap(filepath.Join(base, "left"), filepath.Join(base, "right")) {
		t.Fatal("sibling directories must not be treated as overlapping")
	}
}

func TestIsolatedProfileAllowsOnlyCodexRuntimeState(t *testing.T) {
	profile := t.TempDir()
	for _, directory := range []string{"skills", "tmp"} {
		if err := os.Mkdir(filepath.Join(profile, directory), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{
		"auth.json",
		".agent-adaptor-profile-manifest.json",
		"installation_id",
		"goals_1.sqlite",
		"logs_2.sqlite-shm",
		"memories_3.sqlite-wal",
		"state_5.sqlite",
	} {
		if err := os.WriteFile(filepath.Join(profile, name), []byte("runtime-state"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := isolatedProfileContents(profile); err != nil {
		t.Fatalf("expected runtime state to be accepted: %v", err)
	}

	if err := os.WriteFile(filepath.Join(profile, "config.toml"), []byte("model = 'operator-settings'"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := isolatedProfileContents(profile); err != nil {
		t.Fatalf("expected SDK settings file to be accepted: %v", err)
	}
	if err := os.WriteFile(filepath.Join(profile, "unknown-settings.toml"), []byte("unsafe"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := isolatedProfileContents(profile); err == nil {
		t.Fatal("unknown profile configuration name was accepted")
	}
}

func TestIsolatedProfileRejectsWrongTypesAndPersistentSessions(t *testing.T) {
	for _, testCase := range []struct {
		name      string
		path      string
		directory bool
	}{
		{name: "auth-directory", path: "auth.json", directory: true},
		{name: "manifest-directory", path: ".agent-adaptor-profile-manifest.json", directory: true},
		{name: "installation-directory", path: "installation_id", directory: true},
		{name: "tmp-file", path: "tmp"},
		{name: "skills-file", path: "skills"},
		{name: "database-directory", path: "state_1.sqlite", directory: true},
		{name: "persistent-sessions-directory", path: "sessions", directory: true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			profile := t.TempDir()
			path := filepath.Join(profile, testCase.path)
			var err error
			if testCase.directory {
				err = os.Mkdir(path, 0o700)
			} else {
				err = os.WriteFile(path, []byte("wrong-type"), 0o600)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := isolatedProfileContents(profile); err == nil {
				t.Fatalf("profile resource %q with unsafe type was accepted", testCase.path)
			}
		})
	}

	profile := t.TempDir()
	tmp := filepath.Join(profile, "tmp")
	if err := os.Mkdir(tmp, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmp, "leftover"), []byte("persistent"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := isolatedProfileContents(profile); err == nil {
		t.Fatal("non-empty profile tmp directory was accepted")
	}
}

func TestIsolatedProfileRejectsLinksWithoutFollowingThem(t *testing.T) {
	for _, testCase := range []struct {
		name      string
		linkPath  string
		targetDir bool
	}{
		{name: "tmp-link", linkPath: "tmp", targetDir: true},
		{name: "manifest-link", linkPath: ".agent-adaptor-profile-manifest.json"},
		{name: "database-link", linkPath: "logs_1.sqlite"},
		{name: "system-skills-link", linkPath: filepath.Join("skills", ".system"), targetDir: true},
		{name: "nested-system-skill-link", linkPath: filepath.Join("skills", ".system", "nested", "external-skill")},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			profile := t.TempDir()
			targetRoot := t.TempDir()
			target := filepath.Join(targetRoot, "target")
			if testCase.targetDir {
				if err := os.Mkdir(target, 0o700); err != nil {
					t.Fatal(err)
				}
			} else if err := os.WriteFile(target, []byte("external"), 0o600); err != nil {
				t.Fatal(err)
			}
			link := filepath.Join(profile, testCase.linkPath)
			if err := os.MkdirAll(filepath.Dir(link), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, link); err != nil {
				t.Skipf("symlink creation is unavailable: %v", err)
			}
			if err := isolatedProfileContents(profile); err == nil {
				t.Fatalf("profile link %q was accepted", testCase.linkPath)
			}
			if _, err := os.Stat(target); err != nil {
				t.Fatalf("external link target was modified: %v", err)
			}
		})
	}

	t.Run("profile-root-link", func(t *testing.T) {
		target := t.TempDir()
		if err := os.Mkdir(filepath.Join(target, "tmp"), 0o700); err != nil {
			t.Fatal(err)
		}
		root := filepath.Join(t.TempDir(), "linked-profile")
		if err := os.Symlink(target, root); err != nil {
			t.Skipf("symlink creation is unavailable: %v", err)
		}
		if err := isolatedProfileContents(root); err == nil {
			t.Fatal("linked profile root was accepted")
		}
		if _, err := os.Stat(filepath.Join(target, "tmp")); err != nil {
			t.Fatalf("linked profile target was modified: %v", err)
		}
	})
}

func TestIsolatedProfileRejectsNonEmptySkills(t *testing.T) {
	profile := t.TempDir()
	if err := os.Mkdir(filepath.Join(profile, "skills"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(profile, "skills", "unexpected-skill.md"), []byte("unsafe"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := isolatedProfileContents(profile); err == nil {
		t.Fatal("expected inherited skills to be rejected")
	}
}

func TestIsolatedProfileAllowsProviderSystemSkills(t *testing.T) {
	profile := t.TempDir()
	systemSkills := filepath.Join(profile, "skills", ".system")
	if err := os.MkdirAll(systemSkills, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(systemSkills, "provider-owned"), []byte("runtime"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := isolatedProfileContents(profile); err != nil {
		t.Fatalf("expected provider system skills to be accepted: %v", err)
	}
}
