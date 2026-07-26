package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/gofrs/flock"
)

const (
	profileProcessLockName     = ".alsniper-sidecar-profile.lock"
	profileSourceBindingMarker = ".alsniper-sidecar-source-v1"
)

// acquireExclusiveProfileLease gives one sidecar process sole authority over
// the isolated profile for its complete lifetime. In-process RW leases can
// then safely preserve concurrent game-seat inference without a second
// process replacing settings between preflight and Codex process creation.
func acquireExclusiveProfileLease(profileDir, canonicalSource string) (*flock.Flock, error) {
	lockPath := filepath.Join(profileDir, profileProcessLockName)
	if info, err := os.Lstat(lockPath); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || profileEntryHasReparsePoint(info) || !info.Mode().IsRegular() {
			return nil, errors.New("isolated profile process lease must be a real regular file")
		}
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("inspect isolated profile process lease: %w", err)
	}

	lease := flock.New(lockPath)
	locked, err := lease.TryLock()
	if err != nil {
		_ = lease.Close()
		return nil, fmt.Errorf("acquire isolated profile process lease: %w", err)
	}
	if !locked {
		_ = lease.Close()
		return nil, errors.New("isolated profile is already owned by another AlSniper Agent Runtime process")
	}
	if err := validateProfileLeaseFile(lease, profileDir); err != nil {
		_ = lease.Close()
		return nil, err
	}
	if err := ensureProfileSourceBinding(profileDir, canonicalSource); err != nil {
		_ = lease.Close()
		return nil, err
	}
	if err := validateProfileLease(lease, profileDir, canonicalSource); err != nil {
		_ = lease.Close()
		return nil, err
	}
	return lease, nil
}

func validateProfileLease(lease *flock.Flock, profileDir, canonicalSource string) error {
	if err := validateProfileLeaseFile(lease, profileDir); err != nil {
		return err
	}
	if err := validateProfileSourceBinding(profileDir, canonicalSource); err != nil {
		return err
	}
	return nil
}

func validateProfileLeaseFile(lease *flock.Flock, profileDir string) error {
	if lease == nil || !lease.Locked() || filepath.Clean(lease.Path()) != filepath.Clean(filepath.Join(profileDir, profileProcessLockName)) {
		return errors.New("isolated profile process lease is not held")
	}
	pathInfo, err := os.Lstat(lease.Path())
	if err != nil {
		return fmt.Errorf("inspect isolated profile process lease: %w", err)
	}
	if pathInfo.Mode()&os.ModeSymlink != 0 || profileEntryHasReparsePoint(pathInfo) || !pathInfo.Mode().IsRegular() {
		return errors.New("isolated profile process lease must remain a real regular file")
	}
	openedInfo, err := lease.Stat()
	if err != nil || !openedInfo.Mode().IsRegular() || !os.SameFile(pathInfo, openedInfo) {
		return errors.New("isolated profile process lease changed filesystem identity")
	}
	return nil
}

func ensureProfileSourceBinding(profileDir, canonicalSource string) error {
	path := filepath.Join(profileDir, profileSourceBindingMarker)
	if _, err := os.Lstat(path); err == nil {
		return validateProfileSourceBinding(profileDir, canonicalSource)
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect isolated profile source binding: %w", err)
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("create isolated profile source binding: %w", err)
	}
	if _, err := file.WriteString(expectedProfileSourceBinding(canonicalSource)); err != nil {
		_ = file.Close()
		return fmt.Errorf("write isolated profile source binding: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close isolated profile source binding: %w", err)
	}
	return validateProfileSourceBinding(profileDir, canonicalSource)
}

func validateProfileSourceBinding(profileDir, canonicalSource string) error {
	path := filepath.Join(profileDir, profileSourceBindingMarker)
	if err := validateExactProfileMarker(path, expectedProfileSourceBinding(canonicalSource), "isolated profile source binding"); err != nil {
		return errors.New("isolated profile is bound to a different native Codex home")
	}
	return nil
}

func expectedProfileSourceBinding(canonicalSource string) string {
	identity := filepath.Clean(canonicalSource)
	if runtime.GOOS == "windows" {
		identity = strings.ToLower(identity)
	}
	digest := sha256.Sum256([]byte(identity))
	return profileSourceBindingMarker + ":" + hex.EncodeToString(digest[:]) + "\n"
}
