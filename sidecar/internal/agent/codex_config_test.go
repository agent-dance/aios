package agent

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pelletier/go-toml/v2"
)

func TestCodexMCPDisableArgsUseOnlyTopLevelServerIDs(t *testing.T) {
	source := t.TempDir()
	canary := "mcp-command-canary-must-not-enter-argv"
	tomlConfig := `
model_provider = "operator-provider"

[mcp_servers."company.prod"]
command = "` + canary + `"

[mcp_servers."quoted\"server"]
url = "https://example.invalid/mcp"
`
	if err := os.WriteFile(filepath.Join(source, "config.toml"), []byte(tomlConfig), 0o600); err != nil {
		t.Fatal(err)
	}
	jsonConfig := `{"mcpServers":{"json.server":{"command":"json-canary"}}}`
	if err := os.WriteFile(filepath.Join(source, "config.json"), []byte(jsonConfig), 0o600); err != nil {
		t.Fatal(err)
	}

	args, err := codexMCPDisableArgs(source)
	if err != nil {
		t.Fatal(err)
	}
	if len(args) != 2 || args[0] != "-c" {
		t.Fatalf("MCP disable args = %#v", args)
	}
	servers := map[string]bool{}
	var document map[string]any
	if err := toml.Unmarshal([]byte(args[1]), &document); err != nil {
		t.Fatalf("override is not valid TOML: %q: %v", args[1], err)
	}
	root, ok := document["mcp_servers"].(map[string]any)
	if !ok || len(root) != 3 {
		t.Fatalf("override did not encode one closed server table: %#v", document)
	}
	for id, raw := range root {
		entry, ok := raw.(map[string]any)
		if !ok || len(entry) != 1 || entry["enabled"] != false {
			t.Fatalf("server %q was not strictly disabled: %#v", id, raw)
		}
		servers[id] = true
	}
	for _, id := range []string{"company.prod", `quoted"server`, "json.server"} {
		if !servers[id] {
			t.Fatalf("MCP server %q was not projected: %#v", id, args)
		}
	}
	if strings.Contains(strings.Join(args, " "), canary) || strings.Contains(strings.Join(args, " "), "operator-provider") {
		t.Fatalf("MCP values or provider routing leaked into argv: %#v", args)
	}
	if empty, err := codexMCPDisableArgs(t.TempDir()); err != nil || len(empty) != 0 {
		t.Fatalf("empty MCP server set produced an override: %#v err=%v", empty, err)
	}
}

func TestCodexMCPDisableArgsRejectUnsafeOrMalformedSettings(t *testing.T) {
	if err := validateMCPServerID("line\nbreak"); err == nil {
		t.Fatal("control character in MCP server identifier was accepted")
	}
	if err := validateMCPServerID(strings.Repeat("x", 257)); err == nil {
		t.Fatal("oversized MCP server identifier was accepted")
	}

	for _, testCase := range []struct {
		name     string
		filename string
		contents string
	}{
		{name: "invalid-toml", filename: "config.toml", contents: `mcp_servers = "wrong"`},
		{name: "invalid-json", filename: "config.json", contents: `{"mcpServers":[]}`},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			source := t.TempDir()
			if err := os.WriteFile(filepath.Join(source, testCase.filename), []byte(testCase.contents), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := codexMCPDisableArgs(source); err == nil {
				t.Fatal("malformed MCP settings were accepted")
			}
		})
	}
}

func TestCodexMCPDisableArgsAreBoundedForWindowsProcessCreation(t *testing.T) {
	tooMany := make([]string, maxNativeCodexMCPServerIDs+1)
	for index := range tooMany {
		tooMany[index] = fmt.Sprintf("server-%03d", index)
	}
	if _, err := codexMCPDisableArgsFromIDs(tooMany); err == nil {
		t.Fatal("an unbounded MCP server count was accepted")
	}

	tooLarge := make([]string, maxNativeCodexMCPServerIDs)
	for index := range tooLarge {
		prefix := fmt.Sprintf("server-%03d-", index)
		tooLarge[index] = prefix + strings.Repeat("x", 256-len(prefix))
	}
	if _, err := codexMCPDisableArgsFromIDs(tooLarge); err == nil {
		t.Fatal("an MCP projection larger than the argv safety budget was accepted")
	}
}

func TestNativeCodexSettingsReadsAreBoundedAndRejectLinks(t *testing.T) {
	source := t.TempDir()
	target := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(target, []byte("model = 'linked'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(source, "config.toml")); err != nil {
		t.Skipf("file symlink creation is unavailable: %v", err)
	}
	if err := validateNativeCodexSettings(source); err == nil {
		t.Fatal("linked native settings were accepted")
	}

	oversized := t.TempDir()
	file, err := os.Create(filepath.Join(oversized, "instructions.md"))
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(maxNativeCodexSettingsBytes + 1); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if err := validateNativeCodexSettings(oversized); err == nil {
		t.Fatal("oversized native settings were accepted")
	}
}

func TestCodexSettingsGenerationPinsRawSourceFiles(t *testing.T) {
	source := t.TempDir()
	configPath := filepath.Join(source, "config.toml")
	if err := os.WriteFile(configPath, []byte("model = 'one'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	first, err := codexSettingsGeneration(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, []byte("# operator update\nmodel = 'one'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	second, err := codexSettingsGeneration(source)
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("raw native settings update did not change the runner-lifetime generation")
	}
}

func TestCodexSettingsSnapshotBindsGenerationAndMCPProjectionToSameReads(t *testing.T) {
	tomlContents := []byte("model = 'test'\n[mcp_servers.snapshot]\ncommand = 'never-run'\n")
	jsonContents := []byte(`{"mcpServers":{"json-snapshot":{"url":"https://example.invalid"}}}`)
	files := []codexSettingsFileSnapshot{
		testCodexSettingsSnapshotFile("config.json", jsonContents),
		testCodexSettingsSnapshotFile("config.toml", tomlContents),
		{name: "instructions.md"},
	}
	snapshot, err := deriveCodexSettingsSnapshot(files)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(snapshot.mcpServerIDs, ",") != "json-snapshot,snapshot" {
		t.Fatalf("snapshot MCP projection = %#v", snapshot.mcpServerIDs)
	}

	changedFiles := append([]codexSettingsFileSnapshot(nil), files...)
	changedFiles[1] = testCodexSettingsSnapshotFile("config.toml", []byte("model = 'test'\n"))
	changed, err := deriveCodexSettingsSnapshot(changedFiles)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.generation == changed.generation || len(changed.mcpServerIDs) != 1 {
		t.Fatal("settings generation and MCP projection did not change together")
	}
}

func TestCodexSettingsSnapshotRejectsSplitReadRace(t *testing.T) {
	calls := 0
	reader := func(path, _ string) (codexSettingsFileState, []byte, error) {
		pass := calls / len(codexSDKSettingsFiles)
		calls++
		if filepath.Base(path) != "config.toml" {
			return codexSettingsFileState{}, nil, nil
		}
		contents := []byte("model = 'test'\n[mcp_servers.race]\ncommand = 'never-run'\n")
		if pass > 0 {
			contents = []byte("model = 'test'\n")
		}
		file := testCodexSettingsSnapshotFile("config.toml", contents)
		return file.state, file.contents, nil
	}
	if _, err := captureNativeCodexSettingsSnapshotWithReader(t.TempDir(), reader); err == nil {
		t.Fatal("settings changed between generation and MCP projection reads were accepted")
	}
}

func testCodexSettingsSnapshotFile(name string, contents []byte) codexSettingsFileSnapshot {
	return codexSettingsFileSnapshot{
		name:     name,
		state:    codexSettingsFileState{present: true, digest: sha256.Sum256(contents)},
		contents: append([]byte(nil), contents...),
	}
}

func TestValidateClonedCodexSettingsUsesTOMLSemanticsAndExactOtherFiles(t *testing.T) {
	source := t.TempDir()
	target := t.TempDir()
	if err := os.WriteFile(filepath.Join(source, "config.toml"), []byte("model='gpt-test'\n[mcp_servers.demo]\ncommand='safe'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "config.toml"), []byte("model = \"gpt-test\"\n\n[mcp_servers.demo]\ncommand = \"safe\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"config.json", "instructions.md"} {
		contents := []byte("exact-" + name)
		if err := os.WriteFile(filepath.Join(source, name), contents, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(target, name), contents, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := validateClonedCodexSettings(source, target); err != nil {
		t.Fatalf("semantically equivalent SDK config rewrite was rejected: %v", err)
	}
	if err := os.WriteFile(filepath.Join(target, "config.toml"), []byte("model = 'tampered'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := validateClonedCodexSettings(source, target); err == nil {
		t.Fatal("semantically different target config.toml was accepted")
	}
	if err := os.WriteFile(filepath.Join(target, "config.toml"), []byte("model = 'gpt-test'\n[mcp_servers.demo]\ncommand='safe'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "instructions.md"), []byte("truncated"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := validateClonedCodexSettings(source, target); err == nil {
		t.Fatal("non-TOML partial SDK settings copy was accepted")
	}
}

func TestRefreshCodexSettingsTouchesOnlyOwnedPinnedTargets(t *testing.T) {
	source := t.TempDir()
	profile := t.TempDir()
	if err := os.WriteFile(filepath.Join(profile, "config.toml"), []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := refreshSidecarOwnedCodexSettings(source, profile); err == nil {
		t.Fatal("unowned target was refreshed")
	}
	if err := ensureProfileOwnership(profile); err != nil {
		t.Fatal(err)
	}
	unknown := filepath.Join(profile, "operator-canary")
	if err := os.WriteFile(unknown, []byte("preserve"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := refreshSidecarOwnedCodexSettings(source, profile); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(profile, "config.toml")); !os.IsNotExist(err) {
		t.Fatalf("pinned target was not removed: %v", err)
	}
	contents, err := os.ReadFile(unknown)
	if err != nil || !bytes.Equal(contents, []byte("preserve")) {
		t.Fatalf("unknown target changed: contents=%q err=%v", contents, err)
	}
}
