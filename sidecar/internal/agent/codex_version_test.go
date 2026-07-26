package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestValidateCodexCLIVersionPinsAuditedBuild(t *testing.T) {
	for _, testCase := range []struct {
		name    string
		version string
		valid   bool
	}{
		{name: "audited", version: "codex-cli 0.145.0", valid: true},
		{name: "older", version: "codex-cli 0.144.0"},
		{name: "future-patch", version: "codex-cli 0.145.1"},
		{name: "future-feature-surface", version: "codex-cli 0.146.0"},
		{name: "unexpected-output", version: "wrapper 0.145.0"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			command := writeVersionedFakeCodex(t, testCase.version, "")
			err := validateCodexCLIVersion(context.Background(), command)
			if testCase.valid && err != nil {
				t.Fatalf("audited CLI rejected: %v", err)
			}
			if !testCase.valid && err == nil {
				t.Fatal("unaudited CLI version was accepted")
			}
		})
	}
}

func TestCodexVersionProbeDoesNotInheritCredentials(t *testing.T) {
	capture := filepath.Join(t.TempDir(), "captured.txt")
	command := writeVersionedFakeCodex(t, "codex-cli 0.145.0", capture)
	t.Setenv("OPENAI_API_KEY", "must-not-reach-version-probe")
	t.Setenv("FUTURE_PROVIDER_SECRET", "must-not-reach-version-probe")
	if err := validateCodexCLIVersion(context.Background(), command); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(contents)) != "|" {
		t.Fatalf("credential reached version probe: %q", contents)
	}
}

func TestCodexVersionProbeHonorsCallerCancellation(t *testing.T) {
	command := writeVersionedFakeCodex(t, "codex-cli "+auditedCodexCLIVersion, "")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := validateCodexCLIVersion(ctx, command); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled version probe returned %v", err)
	}
}

func writeVersionedFakeCodex(t *testing.T, version, capture string) string {
	t.Helper()
	dir := t.TempDir()
	command := filepath.Join(dir, "fake-codex")
	if runtime.GOOS == "windows" {
		command += ".cmd"
		script := "@echo off\r\n"
		if capture != "" {
			script += "> \"" + strings.ReplaceAll(capture, "%", "%%") + "\" echo %OPENAI_API_KEY%^|%FUTURE_PROVIDER_SECRET%\r\n"
		}
		script += "echo " + version + "\r\n"
		if err := os.WriteFile(command, []byte(script), 0o700); err != nil {
			t.Fatal(err)
		}
		return command
	}
	script := "#!/bin/sh\nset -eu\n"
	if capture != "" {
		script += "printf '%s|%s\\n' \"${OPENAI_API_KEY-}\" \"${FUTURE_PROVIDER_SECRET-}\" > '" + strings.ReplaceAll(capture, "'", "'\"'\"'") + "'\n"
	}
	script += "printf '%s\\n' '" + strings.ReplaceAll(version, "'", "'\"'\"'") + "'\n"
	if err := os.WriteFile(command, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	return command
}
