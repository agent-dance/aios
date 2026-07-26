package agent

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"unicode"

	"github.com/pelletier/go-toml/v2"
)

// codexSDKSettingsFiles is pinned to the Codex profile contract in
// agent-adaptor v0.12.1-0.20260725141943-aac715d492a1. IncludeSettings copies
// these files in this order and deliberately treats each file as opaque.
var codexSDKSettingsFiles = [...]string{"config.json", "config.toml", "instructions.md"}

const maxNativeCodexSettingsBytes = 8 << 20

const (
	maxNativeCodexMCPServerIDs       = 128
	maxNativeCodexMCPProjectionBytes = 16 << 10
)

type codexSettingsFileState struct {
	present bool
	digest  [sha256.Size]byte
}

type codexSettingsFileSnapshot struct {
	name     string
	state    codexSettingsFileState
	contents []byte
}

type codexSettingsSnapshot struct {
	generation   [sha256.Size]byte
	mcpServerIDs []string
}

type codexSettingsReader func(path, label string) (codexSettingsFileState, []byte, error)

// validateNativeCodexSettings fails before the SDK can follow an unexpected
// link from the operator-approved source profile. Settings contents remain
// opaque: provider routes, MCP declarations, header/env references, and native
// instructions are intentionally inherited as one full-trust profile.
func validateNativeCodexSettings(sourceHome string) error {
	for _, name := range codexSDKSettingsFiles {
		if _, err := inspectCodexSettingsFile(filepath.Join(sourceHome, name), "native Codex "+name); err != nil {
			return err
		}
	}
	return nil
}

func codexSettingsGeneration(sourceHome string) ([sha256.Size]byte, error) {
	snapshot, err := captureNativeCodexSettingsSnapshot(sourceHome)
	if err != nil {
		return [sha256.Size]byte{}, err
	}
	return snapshot.generation, nil
}

// captureNativeCodexSettingsSnapshot binds the runner-lifetime settings
// generation and the MCP deny projection to the same immutable reads. A
// second complete read must match before the snapshot can be used, closing
// the A -> B -> A split-read window that could otherwise omit an MCP server.
func captureNativeCodexSettingsSnapshot(sourceHome string) (codexSettingsSnapshot, error) {
	return captureNativeCodexSettingsSnapshotWithReader(sourceHome, readCodexSettingsFile)
}

func captureNativeCodexSettingsSnapshotWithReader(sourceHome string, reader codexSettingsReader) (codexSettingsSnapshot, error) {
	beforeFiles, err := readNativeCodexSettingsSnapshotFiles(sourceHome, reader)
	if err != nil {
		return codexSettingsSnapshot{}, err
	}
	before, err := deriveCodexSettingsSnapshot(beforeFiles)
	if err != nil {
		return codexSettingsSnapshot{}, err
	}
	afterFiles, err := readNativeCodexSettingsSnapshotFiles(sourceHome, reader)
	if err != nil {
		return codexSettingsSnapshot{}, err
	}
	after, err := deriveCodexSettingsSnapshot(afterFiles)
	if err != nil {
		return codexSettingsSnapshot{}, err
	}
	if before.generation != after.generation {
		return codexSettingsSnapshot{}, errors.New("native Codex settings changed while capturing the host safety projection")
	}
	return after, nil
}

func readNativeCodexSettingsSnapshotFiles(sourceHome string, reader codexSettingsReader) ([]codexSettingsFileSnapshot, error) {
	files := make([]codexSettingsFileSnapshot, 0, len(codexSDKSettingsFiles))
	for _, name := range codexSDKSettingsFiles {
		state, contents, err := reader(filepath.Join(sourceHome, name), "native Codex "+name)
		if err != nil {
			return nil, err
		}
		files = append(files, codexSettingsFileSnapshot{name: name, state: state, contents: contents})
	}
	return files, nil
}

func deriveCodexSettingsSnapshot(files []codexSettingsFileSnapshot) (codexSettingsSnapshot, error) {
	hash := sha256.New()
	serverIDs := map[string]struct{}{}
	for _, file := range files {
		_, _ = io.WriteString(hash, file.name)
		if file.state.present {
			_, _ = hash.Write([]byte{1})
			_, _ = hash.Write(file.state.digest[:])
		} else {
			_, _ = hash.Write([]byte{0})
		}
		switch file.name {
		case "config.toml":
			if err := collectTOMLMCPServerIDs(file.contents, file.state.present, serverIDs); err != nil {
				return codexSettingsSnapshot{}, err
			}
		case "config.json":
			if err := collectJSONMCPServerIDs(file.contents, file.state.present, serverIDs); err != nil {
				return codexSettingsSnapshot{}, err
			}
		}
	}
	if len(serverIDs) > maxNativeCodexMCPServerIDs {
		return codexSettingsSnapshot{}, fmt.Errorf("native Codex settings declare more than %d MCP servers", maxNativeCodexMCPServerIDs)
	}
	ordered := make([]string, 0, len(serverIDs))
	for id := range serverIDs {
		ordered = append(ordered, id)
	}
	sort.Strings(ordered)
	var snapshot codexSettingsSnapshot
	copy(snapshot.generation[:], hash.Sum(nil))
	snapshot.mcpServerIDs = ordered
	return snapshot, nil
}

// codexMCPDisableArgs extracts only top-level MCP server identifiers from the
// bounded, no-follow native settings reads. Values (commands, headers, env
// references, and other secrets) are never projected into argv. The complete
// settings files are still cloned, while every startup-known MCP server is
// disabled by a host-authority override.
func codexMCPDisableArgs(sourceHome string) ([]string, error) {
	snapshot, err := captureNativeCodexSettingsSnapshot(sourceHome)
	if err != nil {
		return nil, err
	}
	return codexMCPDisableArgsFromIDs(snapshot.mcpServerIDs)
}

func codexMCPDisableArgsFromIDs(serverIDs []string) ([]string, error) {
	if len(serverIDs) > maxNativeCodexMCPServerIDs {
		return nil, fmt.Errorf("native Codex settings declare more than %d MCP servers", maxNativeCodexMCPServerIDs)
	}
	if len(serverIDs) == 0 {
		return nil, nil
	}
	entries := make([]string, 0, len(serverIDs))
	for _, id := range serverIDs {
		if err := validateMCPServerID(id); err != nil {
			return nil, err
		}
		quoted, err := codexTOMLStringLiteral(id)
		if err != nil {
			return nil, fmt.Errorf("encode Codex MCP server identifier: %w", err)
		}
		entries = append(entries, quoted+" = { enabled=false }")
	}
	override := "mcp_servers={ " + strings.Join(entries, ", ") + " }"
	if len(override) > maxNativeCodexMCPProjectionBytes {
		return nil, fmt.Errorf("native Codex MCP safety projection exceeds %d bytes", maxNativeCodexMCPProjectionBytes)
	}
	return []string{"-c", override}, nil
}

func collectTOMLMCPServerIDs(contents []byte, present bool, output map[string]struct{}) error {
	if !present {
		return nil
	}
	var document map[string]any
	if err := toml.Unmarshal(contents, &document); err != nil {
		return errors.New("native Codex config.toml is invalid")
	}
	servers, exists := document["mcp_servers"]
	if !exists {
		return nil
	}
	serverMap, ok := servers.(map[string]any)
	if !ok {
		return errors.New("native Codex config.toml mcp_servers must be a table")
	}
	for id := range serverMap {
		if err := validateMCPServerID(id); err != nil {
			return err
		}
		output[id] = struct{}{}
	}
	return nil
}

func collectJSONMCPServerIDs(contents []byte, present bool, output map[string]struct{}) error {
	if !present {
		return nil
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(contents, &document); err != nil {
		return errors.New("native Codex config.json is invalid")
	}
	for _, key := range []string{"mcp_servers", "mcpServers"} {
		raw, exists := document[key]
		if !exists {
			continue
		}
		var servers map[string]json.RawMessage
		if err := json.Unmarshal(raw, &servers); err != nil {
			return fmt.Errorf("native Codex config.json %s must be an object", key)
		}
		for id := range servers {
			if err := validateMCPServerID(id); err != nil {
				return err
			}
			output[id] = struct{}{}
		}
	}
	return nil
}

func validateMCPServerID(id string) error {
	if id == "" || id != strings.TrimSpace(id) || len(id) > 256 {
		return errors.New("native Codex MCP server identifier must be non-empty, trimmed, and at most 256 bytes")
	}
	for _, char := range id {
		if unicode.IsControl(char) {
			return errors.New("native Codex MCP server identifier must not contain control characters")
		}
	}
	return nil
}

func codexTOMLStringLiteral(value string) (string, error) {
	raw, err := toml.Marshal(struct {
		Value string `toml:"value"`
	}{Value: value})
	if err != nil {
		return "", err
	}
	line := strings.TrimSpace(string(raw))
	literal, ok := strings.CutPrefix(line, "value = ")
	if !ok || literal == "" || strings.ContainsAny(literal, "\r\n") {
		return "", errors.New("TOML encoder did not produce one string literal")
	}
	return literal, nil
}

// refreshSidecarOwnedCodexSettings removes only the three SDK-pinned settings
// targets. The caller must hold the profile reconciliation lease. The SDK then
// performs the final clone; this function never reads from or mutates source.
func refreshSidecarOwnedCodexSettings(sourceHome, profileDir string) error {
	if !profileOwnershipValid(profileDir) {
		return errors.New("isolated profile settings can only be refreshed after sidecar ownership is established")
	}
	if err := validateNativeCodexSettings(sourceHome); err != nil {
		return err
	}
	for _, name := range codexSDKSettingsFiles {
		path := filepath.Join(profileDir, name)
		info, err := os.Lstat(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return fmt.Errorf("inspect isolated profile %s before refresh: %w", name, err)
		}
		if info.Mode()&os.ModeSymlink != 0 || profileEntryHasReparsePoint(info) || !info.Mode().IsRegular() {
			return fmt.Errorf("isolated profile %s must be a real regular file", name)
		}
		if err := os.Remove(path); err != nil {
			return fmt.Errorf("refresh isolated profile %s: %w", name, err)
		}
	}
	return nil
}

// validateClonedCodexSettings proves that the non-atomic SDK copy completed
// with a stable source generation. Reading the source both before and after
// the target closes the common atomic-replace/in-place-update races. A failed
// check leaves the profile unusable; the next exclusive reconciliation removes
// the fixed target files and asks the SDK to clone them again.
func validateClonedCodexSettings(sourceHome, profileDir string) error {
	for _, name := range codexSDKSettingsFiles {
		sourcePath := filepath.Join(sourceHome, name)
		targetPath := filepath.Join(profileDir, name)
		if name == "config.toml" {
			if err := validateClonedCodexTOML(sourcePath, targetPath); err != nil {
				return err
			}
			continue
		}
		before, err := inspectCodexSettingsFile(sourcePath, "native Codex "+name)
		if err != nil {
			return err
		}
		target, err := inspectCodexSettingsFile(targetPath, "isolated profile "+name)
		if err != nil {
			return err
		}
		after, err := inspectCodexSettingsFile(sourcePath, "native Codex "+name)
		if err != nil {
			return err
		}
		if before != after {
			return fmt.Errorf("native Codex %s changed while validating the SDK clone", name)
		}
		if target != after {
			return fmt.Errorf("isolated profile %s is missing, stale, or incomplete", name)
		}
	}
	return nil
}

// The pinned SDK's empty MCP reconciliation parses and atomically re-marshals
// config.toml on every run. Compare the parsed TOML document rather than its
// formatting, while source generation pinning separately detects any raw
// native settings update. A missing file is semantically the empty document
// because the SDK may create an empty config.toml during reconciliation.
func validateClonedCodexTOML(sourcePath, targetPath string) error {
	beforeState, beforeContents, err := readCodexSettingsFile(sourcePath, "native Codex config.toml")
	if err != nil {
		return err
	}
	_, targetContents, err := readCodexSettingsFile(targetPath, "isolated profile config.toml")
	if err != nil {
		return err
	}
	afterState, afterContents, err := readCodexSettingsFile(sourcePath, "native Codex config.toml")
	if err != nil {
		return err
	}
	if beforeState != afterState {
		return errors.New("native Codex config.toml changed while validating the SDK clone")
	}
	beforeDocument, err := parseCodexTOMLDocument(beforeContents)
	if err != nil {
		return errors.New("native Codex config.toml is invalid")
	}
	afterDocument, err := parseCodexTOMLDocument(afterContents)
	if err != nil || !reflect.DeepEqual(beforeDocument, afterDocument) {
		return errors.New("native Codex config.toml changed while validating the SDK clone")
	}
	targetDocument, err := parseCodexTOMLDocument(targetContents)
	if err != nil || !reflect.DeepEqual(targetDocument, afterDocument) {
		return errors.New("isolated profile config.toml is missing, stale, incomplete, or semantically different")
	}
	return nil
}

func parseCodexTOMLDocument(contents []byte) (map[string]any, error) {
	document := map[string]any{}
	if len(contents) == 0 {
		return document, nil
	}
	if err := toml.Unmarshal(contents, &document); err != nil {
		return nil, err
	}
	return document, nil
}

func inspectCodexSettingsFile(path, label string) (codexSettingsFileState, error) {
	state, _, err := readCodexSettingsFile(path, label)
	return state, err
}

func readCodexSettingsFile(path, label string) (codexSettingsFileState, []byte, error) {
	var state codexSettingsFileState
	pathInfo, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return state, nil, nil
	}
	if err != nil {
		return state, nil, fmt.Errorf("inspect %s: %w", label, err)
	}
	if pathInfo.Mode()&os.ModeSymlink != 0 || profileEntryHasReparsePoint(pathInfo) || !pathInfo.Mode().IsRegular() {
		return state, nil, fmt.Errorf("%s must be a real regular file", label)
	}
	if pathInfo.Size() > maxNativeCodexSettingsBytes {
		return state, nil, fmt.Errorf("%s exceeds the safe size limit", label)
	}
	file, err := os.Open(path)
	if err != nil {
		return state, nil, fmt.Errorf("open %s: %w", label, err)
	}
	defer file.Close()
	openedInfo, err := file.Stat()
	if err != nil {
		return state, nil, fmt.Errorf("inspect opened %s: %w", label, err)
	}
	if !openedInfo.Mode().IsRegular() || !os.SameFile(pathInfo, openedInfo) || openedInfo.Size() > maxNativeCodexSettingsBytes {
		return state, nil, fmt.Errorf("%s changed identity, type, or size while opening", label)
	}
	contents, err := io.ReadAll(io.LimitReader(file, maxNativeCodexSettingsBytes+1))
	if err != nil {
		return state, nil, fmt.Errorf("read %s: %w", label, err)
	}
	if len(contents) > maxNativeCodexSettingsBytes {
		return state, nil, fmt.Errorf("%s exceeds the safe size limit", label)
	}
	closedInfo, err := file.Stat()
	if err != nil {
		return state, nil, fmt.Errorf("reinspect opened %s: %w", label, err)
	}
	if !os.SameFile(openedInfo, closedInfo) || openedInfo.Size() != closedInfo.Size() || !openedInfo.ModTime().Equal(closedInfo.ModTime()) {
		return state, nil, fmt.Errorf("%s changed while reading", label)
	}
	currentInfo, err := os.Lstat(path)
	if err != nil || currentInfo.Mode()&os.ModeSymlink != 0 || profileEntryHasReparsePoint(currentInfo) || !currentInfo.Mode().IsRegular() || !os.SameFile(openedInfo, currentInfo) {
		return state, nil, fmt.Errorf("%s changed path identity while reading", label)
	}
	state.present = true
	state.digest = sha256.Sum256(contents)
	return state, contents, nil
}
