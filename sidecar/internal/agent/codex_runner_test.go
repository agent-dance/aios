package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	agentadaptor "github.com/agent-dance/agent-adaptor"
	"github.com/agent-dance/agent-adaptor/codex"
	"github.com/buthim/alsniper-os/sidecar/internal/config"
)

func TestCodexProcessOutcomeRejectsBufferedOutputAfterAbnormalTermination(t *testing.T) {
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
			err := validateCodexProcessOutcome(test.result)
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

func testRunnerConfig(profile, workspace, command string) config.Config {
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

func TestCodexProfileLinksOnlyAuthentication(t *testing.T) {
	source := t.TempDir()
	profile := filepath.Join(t.TempDir(), "profile")
	workspace := filepath.Join(t.TempDir(), "workspace")
	if err := os.WriteFile(filepath.Join(source, "auth.json"), []byte(`{"OPENAI_API_KEY":"test-only"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "config.toml"), []byte(`model = "must-not-copy"`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(source, "skills"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "skills", "must-not-copy"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_HOME", source)
	cfg := config.Config{ListenAddress: "127.0.0.1:4317", Token: strings.Repeat("x", 32), AllowedOrigin: "http://localhost:5173", ProfileDir: profile, WorkspaceDir: workspace, CodexCommand: "go", MaxBodyBytes: 1024, MaxConcurrentRuns: 1, ChatTimeout: time.Second, GameTimeout: time.Second, ReadinessTimeout: time.Second}
	runner, err := NewCodexRunner(cfg)
	if err != nil {
		t.Fatal(err)
	}
	readiness := runner.Readiness(t.Context())
	statuses := map[string]string{}
	for _, check := range readiness.Checks {
		statuses[check.Code] = check.Status
	}
	if statuses["profile_isolation"] != "pass" || statuses["auth_link"] != "pass" || statuses["profile_contents"] != "pass" {
		t.Fatalf("profile checks failed: %+v", readiness.Checks)
	}
	if !sameFile(filepath.Join(source, "auth.json"), filepath.Join(profile, "auth.json")) {
		t.Fatal("authentication was not linked")
	}
	if _, err := os.Stat(filepath.Join(profile, "config.toml")); !os.IsNotExist(err) {
		t.Fatal("settings were inherited")
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

func TestCodexSafetyArgumentsRemoveToolSurfaces(t *testing.T) {
	joined := strings.Join(codexSafetyArgs(), " ")
	for _, required := range []string{"--sandbox read-only", "--ignore-user-config", "--ignore-rules", "--strict-config", "--disable shell_tool", "--disable browser_use", "--disable computer_use", "--disable multi_agent", "--ephemeral"} {
		if !strings.Contains(joined, required) {
			t.Fatalf("missing safety argument %q in %q", required, joined)
		}
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
	command := filepath.Join(t.TempDir(), "fake-codex")
	escapedCapture := strings.ReplaceAll(capture, "'", "'\"'\"'")
	script := "#!/bin/sh\nset -eu\nprintf 'AIOS=%s\\nOPENAI=%s\\nAZURE=%s\\nFUTURE=%s\\nRANDOM=%s\\nCODEX_HOME=%s\\n' \"$AIOS_SIDECAR_TOKEN\" \"$OPENAI_API_KEY\" \"$AZURE_CLIENT_SECRET\" \"$FUTURE_PROVIDER_API_KEY\" \"$RANDOM_HOST_VALUE\" \"$CODEX_HOME\" > '__CAPTURE__'\ncat >/dev/null\nprintf '{\"type\":\"thread.started\",\"thread_id\":\"fake-thread\"}\\n'\nprintf '{\"type\":\"result\",\"result\":{\"ok\":true}}\\n'\n"
	script = strings.ReplaceAll(script, "__CAPTURE__", escapedCapture)
	if runtime.GOOS == "windows" {
		command += ".cmd"
		escapedCapture = strings.ReplaceAll(capture, "%", "%%")
		script = "@echo off\r\n> \"__CAPTURE__\" (\r\n  echo AIOS=%AIOS_SIDECAR_TOKEN%\r\n  echo OPENAI=%OPENAI_API_KEY%\r\n  echo AZURE=%AZURE_CLIENT_SECRET%\r\n  echo FUTURE=%FUTURE_PROVIDER_API_KEY%\r\n  echo RANDOM=%RANDOM_HOST_VALUE%\r\n  echo CODEX_HOME=%CODEX_HOME%\r\n)\r\necho {\"type\":\"thread.started\",\"thread_id\":\"fake-thread\"}\r\necho {\"type\":\"result\",\"result\":{\"ok\":true}}\r\n"
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
			if _, err := NewCodexRunner(testRunnerConfig(profile, workspace, "go")); err == nil {
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

func TestExistingDedicatedProfileWithSameAuthenticationIsAccepted(t *testing.T) {
	source := t.TempDir()
	sourceAuth := writeTestNativeAuth(t, source)
	profile := t.TempDir()
	if err := os.Link(sourceAuth, filepath.Join(profile, "auth.json")); err != nil {
		t.Fatal(err)
	}
	workspace := filepath.Join(t.TempDir(), "workspace")
	t.Setenv("CODEX_HOME", source)
	runner, err := NewCodexRunner(testRunnerConfig(profile, workspace, "go"))
	if err != nil {
		t.Fatal(err)
	}
	if !sameFile(sourceAuth, filepath.Join(profile, "auth.json")) {
		t.Fatal("existing native authentication identity was not preserved")
	}
	if !profileOwnershipValid(profile) {
		t.Fatal("existing dedicated profile was not claimed by the sidecar")
	}
	if runner == nil {
		t.Fatal("runner was not created")
	}
}

func TestReadinessNeverReplacesForeignAuthentication(t *testing.T) {
	source := t.TempDir()
	sourceAuth := writeTestNativeAuth(t, source)
	profile := filepath.Join(t.TempDir(), "profile")
	workspace := filepath.Join(t.TempDir(), "workspace")
	t.Setenv("CODEX_HOME", source)
	runner, err := NewCodexRunner(testRunnerConfig(profile, workspace, "go"))
	if err != nil {
		t.Fatal(err)
	}
	authPath := filepath.Join(profile, "auth.json")
	if err := os.Remove(authPath); err != nil {
		t.Fatal(err)
	}
	foreign := []byte("foreign-auth-must-survive")
	if err := os.WriteFile(authPath, foreign, 0o600); err != nil {
		t.Fatal(err)
	}
	readiness := runner.Readiness(t.Context())
	if readiness.Ready {
		t.Fatal("readiness passed after profile authentication was replaced")
	}
	contents, err := os.ReadFile(authPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != string(foreign) || sameFile(sourceAuth, authPath) {
		t.Fatal("SDK readiness replaced or relinked foreign authentication")
	}
}

func TestRunRevalidatesFilesystemAfterCachedReadiness(t *testing.T) {
	t.Run("foreign-auth", func(t *testing.T) {
		source := t.TempDir()
		writeTestNativeAuth(t, source)
		profile := filepath.Join(t.TempDir(), "profile")
		workspace := filepath.Join(t.TempDir(), "workspace")
		t.Setenv("CODEX_HOME", source)
		runner, err := NewCodexRunner(testRunnerConfig(profile, workspace, "go"))
		if err != nil {
			t.Fatal(err)
		}
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
		if err == nil || !strings.Contains(err.Error(), "preflight") {
			t.Fatalf("run did not fail at filesystem preflight: %v", err)
		}
		contents, readErr := os.ReadFile(authPath)
		if readErr != nil || string(contents) != string(foreign) {
			t.Fatalf("run preflight modified foreign authentication: contents=%q err=%v", contents, readErr)
		}
	})

	t.Run("linked-run-workspace", func(t *testing.T) {
		source := t.TempDir()
		writeTestNativeAuth(t, source)
		profile := filepath.Join(t.TempDir(), "profile")
		workspaceRoot := filepath.Join(t.TempDir(), "workspace")
		t.Setenv("CODEX_HOME", source)
		runner, err := NewCodexRunner(testRunnerConfig(profile, workspaceRoot, "go"))
		if err != nil {
			t.Fatal(err)
		}
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
			if _, err := NewCodexRunner(testRunnerConfig(profile, workspace, "go")); err == nil {
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
			if _, err := NewCodexRunner(testRunnerConfig(profile, workspace, "go")); err == nil {
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
		if _, err := NewCodexRunner(testRunnerConfig(filepath.Join(t.TempDir(), "profile"), filepath.Join(t.TempDir(), "workspace"), "go")); err == nil {
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
			if _, err := NewCodexRunner(testRunnerConfig(profile, workspace, "go")); err == nil {
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
			_, err := NewCodexRunner(testRunnerConfig(profile, workspace, "go"))
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

	if err := os.WriteFile(filepath.Join(profile, "config.toml"), []byte("model = 'unsafe'"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := isolatedProfileContents(profile); err == nil {
		t.Fatal("expected inherited configuration to be rejected")
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
