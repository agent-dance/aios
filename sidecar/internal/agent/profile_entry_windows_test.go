package agent

import (
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

type reparseFileInfo struct {
	attributes syscall.Win32FileAttributeData
}

func (i reparseFileInfo) Name() string       { return "junction" }
func (i reparseFileInfo) Size() int64        { return 0 }
func (i reparseFileInfo) Mode() fs.FileMode  { return fs.ModeDir }
func (i reparseFileInfo) ModTime() time.Time { return time.Time{} }
func (i reparseFileInfo) IsDir() bool        { return true }
func (i reparseFileInfo) Sys() any           { return &i.attributes }

func TestProfileEntryDetectsWindowsReparsePoint(t *testing.T) {
	info := reparseFileInfo{attributes: syscall.Win32FileAttributeData{FileAttributes: syscall.FILE_ATTRIBUTE_REPARSE_POINT}}
	if !profileEntryHasReparsePoint(info) {
		t.Fatal("Windows reparse point was not detected")
	}
}

func createWindowsJunction(t *testing.T, target, link string) {
	t.Helper()
	output, err := exec.Command("cmd.exe", "/d", "/c", "mklink", "/J", link, target).CombinedOutput()
	if err != nil {
		t.Skipf("Windows junction creation is unavailable: %v (%s)", err, output)
	}
}

func TestNewCodexRunnerRejectsWindowsJunctionRootsAndParents(t *testing.T) {
	for _, testCase := range []string{"profile-root", "workspace-parent"} {
		t.Run(testCase, func(t *testing.T) {
			source := t.TempDir()
			writeTestNativeAuth(t, source)
			base := t.TempDir()
			target := t.TempDir()
			junction := filepath.Join(base, "junction")
			createWindowsJunction(t, target, junction)
			profile := filepath.Join(base, "profile")
			workspace := filepath.Join(base, "workspace")
			if testCase == "profile-root" {
				profile = junction
			} else {
				workspace = filepath.Join(junction, "workspace")
			}
			t.Setenv("CODEX_HOME", source)
			if _, err := NewCodexRunner(testRunnerConfig(t, profile, workspace, "go")); err == nil {
				t.Fatalf("%s Windows junction was accepted", testCase)
			}
			untouched := workspace
			if testCase == "workspace-parent" {
				untouched = profile
			}
			if _, err := os.Lstat(untouched); !os.IsNotExist(err) {
				t.Fatalf("other isolated root was written before junction rejection: %v", err)
			}
		})
	}
}

func TestPrepareDedicatedWorkspaceRejectsWindowsRunJunction(t *testing.T) {
	root := filepath.Join(t.TempDir(), "workspace")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, workspaceOwnershipMarker), []byte(workspaceOwnershipMarker+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	target := t.TempDir()
	createWindowsJunction(t, target, filepath.Join(root, workspaceRunPrefix+"junction"))
	if _, err := prepareDedicatedWorkspace(root); err == nil {
		t.Fatal("Windows run workspace junction was accepted")
	}
}
