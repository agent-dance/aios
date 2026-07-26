package agent

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestProfileLeaseIsExclusiveAndBoundToNativeSource(t *testing.T) {
	profile := t.TempDir()
	if err := ensureProfileOwnership(profile); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(t.TempDir(), "native")
	if err := os.Mkdir(source, 0o700); err != nil {
		t.Fatal(err)
	}
	canonical, err := canonicalPathForOverlap(source)
	if err != nil {
		t.Fatal(err)
	}
	first, err := acquireExclusiveProfileLease(profile, canonical)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = first.Close() })
	if _, err := acquireExclusiveProfileLease(profile, canonical); err == nil {
		t.Fatal("a second process lease for the same profile was accepted")
	}
	guard := &codexFilesystemGuard{}
	runner := &CodexRunner{profileLease: first, filesystemGuard: guard}
	guard.mu.RLock()
	closed := make(chan error, 1)
	go func() { closed <- runner.Close() }()
	select {
	case err := <-closed:
		guard.mu.RUnlock()
		t.Fatalf("runner released its process lease before an active run completed: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	if _, err := acquireExclusiveProfileLease(profile, canonical); err == nil {
		guard.mu.RUnlock()
		t.Fatal("another process acquired the profile while Close was waiting for an active run")
	}
	guard.mu.RUnlock()
	if err := <-closed; err != nil {
		t.Fatal(err)
	}
	reopened, err := acquireExclusiveProfileLease(profile, canonical)
	if err != nil {
		t.Fatalf("profile lease was not released after active runs completed: %v", err)
	}
	if err := reopened.Close(); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(t.TempDir(), "other-native")
	if err := os.Mkdir(other, 0o700); err != nil {
		t.Fatal(err)
	}
	otherCanonical, err := canonicalPathForOverlap(other)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateProfileSourceBinding(profile, otherCanonical); err == nil {
		t.Fatal("profile source binding accepted a different native Codex home")
	}
}

func TestProfileLeaseRejectsLinkTarget(t *testing.T) {
	profile := t.TempDir()
	if err := ensureProfileOwnership(profile); err != nil {
		t.Fatal(err)
	}
	external := filepath.Join(t.TempDir(), "external-lock")
	if err := os.WriteFile(external, []byte("external"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, filepath.Join(profile, profileProcessLockName)); err != nil {
		t.Skipf("file symlink creation is unavailable: %v", err)
	}
	if _, err := acquireExclusiveProfileLease(profile, t.TempDir()); err == nil {
		t.Fatal("linked profile process lease was accepted")
	}
}
