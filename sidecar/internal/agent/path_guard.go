package agent

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func validateExactProfileMarker(path, expected, label string) error {
	if err := validateProfileEntry(path, false, false); err != nil {
		return fmt.Errorf("%s is missing or unsafe", label)
	}
	pathInfo, err := os.Lstat(path)
	if err != nil || pathInfo.Size() != int64(len(expected)) {
		return fmt.Errorf("%s has an invalid size", label)
	}
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open %s: %w", label, err)
	}
	defer file.Close()
	openedInfo, err := file.Stat()
	if err != nil || !openedInfo.Mode().IsRegular() || !os.SameFile(pathInfo, openedInfo) {
		return fmt.Errorf("%s changed identity while opening", label)
	}
	contents, err := io.ReadAll(io.LimitReader(file, int64(len(expected)+1)))
	if err != nil {
		return fmt.Errorf("read %s: %w", label, err)
	}
	currentInfo, err := os.Lstat(path)
	if err != nil || !os.SameFile(openedInfo, currentInfo) {
		return fmt.Errorf("%s changed identity while reading", label)
	}
	if !bytes.Equal(contents, []byte(expected)) {
		return fmt.Errorf("%s is invalid", label)
	}
	return nil
}

const (
	sdkProfileLockName          = ".agent-adaptor-profile.lock"
	sdkProfileManifestName      = ".agent-adaptor-profile-manifest.json"
	sdkProfileQuiesceWindow     = 2 * time.Second
	sdkProfileResidueStaleAfter = 10 * time.Minute
)

// inspectRealDirectoryPath walks every existing path component with Lstat.
// It never follows a symbolic link or Windows reparse point and optionally
// creates a missing suffix one directory at a time. The return value reports
// whether the target existed before this call.
func inspectRealDirectoryPath(path, label string, createMissing bool) (bool, error) {
	clean, err := filepath.Abs(path)
	if err != nil {
		return false, fmt.Errorf("normalize %s: %w", label, err)
	}
	clean = filepath.Clean(clean)
	if filepath.Dir(clean) == clean {
		return false, fmt.Errorf("%s must not be a filesystem root", label)
	}

	chain := []string{clean}
	for parent := filepath.Dir(clean); parent != clean; parent = filepath.Dir(parent) {
		chain = append(chain, parent)
		clean = parent
	}
	for left, right := 0, len(chain)-1; left < right; left, right = left+1, right-1 {
		chain[left], chain[right] = chain[right], chain[left]
	}

	targetExisted := false
	for index, component := range chain {
		info, statErr := os.Lstat(component)
		existedBefore := statErr == nil
		if os.IsNotExist(statErr) {
			if !createMissing {
				return false, nil
			}
			if index == 0 {
				return false, fmt.Errorf("%s filesystem root does not exist", label)
			}
			if mkdirErr := os.Mkdir(component, 0o700); mkdirErr != nil {
				if !os.IsExist(mkdirErr) {
					return false, fmt.Errorf("create %s: %w", label, mkdirErr)
				}
				existedBefore = true
			}
			info, statErr = os.Lstat(component)
		}
		if statErr != nil {
			return false, fmt.Errorf("inspect %s path: %w", label, statErr)
		}
		if info.Mode()&os.ModeSymlink != 0 || profileEntryHasReparsePoint(info) {
			return false, fmt.Errorf("%s path contains a link or reparse point", label)
		}
		if !info.IsDir() {
			return false, fmt.Errorf("%s path contains a non-directory component", label)
		}
		if index == len(chain)-1 {
			targetExisted = existedBefore
		}
	}
	return targetExisted, nil
}

// canonicalPathForOverlap resolves the deepest existing, already-preflighted
// ancestor and appends the missing suffix. On Windows this normalizes aliases
// such as short names before containment checks.
func canonicalPathForOverlap(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	probe := filepath.Clean(absolute)
	suffix := make([]string, 0, 4)
	for {
		if _, err := os.Lstat(probe); err == nil {
			resolved, err := filepath.EvalSymlinks(probe)
			if err != nil {
				return "", err
			}
			for index := len(suffix) - 1; index >= 0; index-- {
				resolved = filepath.Join(resolved, suffix[index])
			}
			return filepath.Clean(resolved), nil
		} else if !os.IsNotExist(err) {
			return "", err
		}
		parent := filepath.Dir(probe)
		if parent == probe {
			return "", errors.New("path has no existing filesystem ancestor")
		}
		suffix = append(suffix, filepath.Base(probe))
		probe = parent
	}
}

func preflightDedicatedProfile(profileDir, sourceAuth string, createMissing bool) error {
	existed, err := inspectRealDirectoryPath(profileDir, "isolated profile", createMissing)
	if err != nil {
		return err
	}
	if !existed && !createMissing {
		return nil
	}
	if !existed {
		if err := ensureProfileOwnership(profileDir); err != nil {
			return err
		}
	}
	if err := isolatedProfileContentsQuiescent(profileDir); err != nil {
		return fmt.Errorf("isolated profile is not dedicated: %w", err)
	}

	authPath := filepath.Join(profileDir, "auth.json")
	if _, err := os.Lstat(authPath); os.IsNotExist(err) {
		if profileOwnershipValid(profileDir) {
			return nil
		}
		return errors.New("existing isolated profile is unclaimed")
	} else if err != nil {
		return fmt.Errorf("inspect isolated profile authentication: %w", err)
	}
	if !sameFile(sourceAuth, authPath) {
		// A sidecar-owned profile may legitimately point at the previous OAuth
		// credential generation after `codex login` atomically replaces the
		// native file. The SDK's auth-only clone reconciliation is authorized to
		// repair this fixed entry before a strict runtime preflight. Unclaimed
		// profiles remain immutable and are rejected above.
		if profileOwnershipValid(profileDir) {
			return nil
		}
		return errors.New("isolated profile auth.json is not the native Codex authentication file")
	}
	return nil
}

// isolatedProfileContentsQuiescent never accepts SDK materialization files as
// profile content. Instead it waits for the pinned SDK's bounded lock/tmp
// transaction to disappear, then validates the original closed allowlist.
// Rechecking transient state after the scan closes the appear/disappear race
// between independent Agent seats without serializing their model processes.
func isolatedProfileContentsQuiescent(profileDir string) error {
	deadline := time.Now().Add(sdkProfileQuiesceWindow)
	for {
		if err := recoverStaleSDKProfileResidue(profileDir, time.Now()); err != nil {
			return err
		}
		beforeTransient, err := sdkProfileTransactionPresent(profileDir)
		if err != nil {
			return err
		}
		if !beforeTransient {
			contentsErr := isolatedProfileContents(profileDir)
			afterTransient, transientErr := sdkProfileTransactionPresent(profileDir)
			if transientErr != nil {
				return transientErr
			}
			if !afterTransient {
				if contentsErr == nil {
					return nil
				}
				// The transaction may have completed between the directory scan and
				// the second transient check. One clean re-scan distinguishes that
				// case from a persistent unknown profile entry.
				if retryErr := isolatedProfileContents(profileDir); retryErr == nil {
					return nil
				} else {
					retryTransient, retryStateErr := sdkProfileTransactionPresent(profileDir)
					if retryStateErr != nil {
						return retryStateErr
					}
					if !retryTransient {
						return retryErr
					}
				}
			}
		}
		if time.Now().After(deadline) {
			return errors.New("agent-adaptor profile materialization did not become quiescent")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func sdkProfileTransactionPresent(profileDir string) (bool, error) {
	entries, err := os.ReadDir(profileDir)
	if err != nil {
		return false, fmt.Errorf("inspect isolated profile transaction state: %w", err)
	}
	for _, entry := range entries {
		name := entry.Name()
		if sdkProfileTransactionFileName(name) {
			info, err := os.Lstat(filepath.Join(profileDir, name))
			if os.IsNotExist(err) {
				continue
			}
			if err != nil {
				return false, fmt.Errorf("inspect agent-adaptor transaction residue %q: %w", name, err)
			}
			if info.Mode()&os.ModeSymlink != 0 || profileEntryHasReparsePoint(info) || !info.Mode().IsRegular() {
				return false, fmt.Errorf("agent-adaptor transaction residue %q must be a real regular file", name)
			}
			return true, nil
		}
	}
	return false, nil
}

// recoverStaleSDKProfileResidue mirrors the pinned SDK's ten-minute stale lock
// threshold and recognizes only its exact lock plus numeric CreateTemp names.
// Recovery is limited to sidecar-owned profiles and real regular files, so a
// near-match, link, reparse point, directory, or fresh transaction is never
// removed.
func recoverStaleSDKProfileResidue(profileDir string, now time.Time) error {
	if !profileOwnershipValid(profileDir) {
		return nil
	}
	entries, err := os.ReadDir(profileDir)
	if err != nil {
		return fmt.Errorf("inspect isolated profile transaction residue: %w", err)
	}
	for _, entry := range entries {
		name := entry.Name()
		if !sdkProfileTransactionFileName(name) {
			continue
		}
		path := filepath.Join(profileDir, name)
		info, err := os.Lstat(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return fmt.Errorf("inspect agent-adaptor transaction residue %q: %w", name, err)
		}
		if info.Mode()&os.ModeSymlink != 0 || profileEntryHasReparsePoint(info) || !info.Mode().IsRegular() {
			return fmt.Errorf("agent-adaptor transaction residue %q must be a real regular file", name)
		}
		if info.ModTime().Add(sdkProfileResidueStaleAfter).After(now) {
			continue
		}
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove stale agent-adaptor transaction residue %q: %w", name, err)
		}
	}
	return nil
}

func sdkProfileTransactionFileName(name string) bool {
	if name == sdkProfileLockName {
		return true
	}
	for _, base := range append([]string{sdkProfileManifestName}, codexSDKSettingsFiles[:]...) {
		prefix := "." + base + ".tmp-"
		suffix, ok := strings.CutPrefix(name, prefix)
		if !ok || suffix == "" || len(suffix) > 10 {
			continue
		}
		numeric := true
		for _, char := range suffix {
			if char < '0' || char > '9' {
				numeric = false
				break
			}
		}
		if numeric {
			return true
		}
	}
	return false
}

func prepareDedicatedProfile(profileDir, sourceAuth string) error {
	if err := preflightDedicatedProfile(profileDir, sourceAuth, true); err != nil {
		return err
	}
	if err := ensureProfileOwnership(profileDir); err != nil {
		return err
	}
	return preflightDedicatedProfile(profileDir, sourceAuth, false)
}

// claimDedicatedProfileForLease performs only link-safe directory creation and
// ownership validation. It deliberately does not scan, recover, remove, or
// reconcile profile contents; those mutations are authorized only after the
// caller holds the cross-process process-lifetime lease.
func claimDedicatedProfileForLease(profileDir string) error {
	existed, err := inspectRealDirectoryPath(profileDir, "isolated profile", true)
	if err != nil {
		return err
	}
	if !existed {
		if err := ensureProfileOwnership(profileDir); err != nil {
			return err
		}
	}
	if !profileOwnershipValid(profileDir) {
		return errors.New("existing isolated profile is unclaimed")
	}
	return nil
}

func preflightRuntimeProfile(profileDir, sourceAuth string) error {
	existed, err := inspectRealDirectoryPath(profileDir, "isolated profile", false)
	if err != nil {
		return err
	}
	if !existed {
		return errors.New("isolated profile disappeared before Codex execution")
	}
	if err := preflightDedicatedProfile(profileDir, sourceAuth, false); err != nil {
		return err
	}
	if _, err := os.Lstat(sourceAuth); err != nil {
		return fmt.Errorf("%w: native Codex authentication is unavailable before Codex execution", ErrAuthentication)
	}
	if _, err := os.Lstat(filepath.Join(profileDir, "auth.json")); err != nil {
		return fmt.Errorf("%w: isolated profile authentication is unavailable before Codex execution", ErrAuthentication)
	}
	if !sameFile(sourceAuth, filepath.Join(profileDir, "auth.json")) {
		return fmt.Errorf("%w: isolated profile authentication is not the current native Codex credential", ErrAuthentication)
	}
	if err := validateClonedCodexSettings(filepath.Dir(sourceAuth), profileDir); err != nil {
		return err
	}
	return nil
}

// postflightReconciledProfile validates the SDK-owned auth-only clone without
// requiring a login to exist during readiness. When native auth is present,
// however, reconciliation must have produced the exact same file identity.
func postflightReconciledProfile(sourceHome, profileDir, sourceAuth string, requireAuth bool) error {
	exists, err := inspectRealDirectoryPath(profileDir, "isolated profile", false)
	if err != nil {
		return err
	}
	if !exists {
		return errors.New("isolated profile disappeared before authentication validation")
	}
	if err := preflightDedicatedProfile(profileDir, sourceAuth, false); err != nil {
		return err
	}
	sourceInfo, sourceErr := os.Lstat(sourceAuth)
	if os.IsNotExist(sourceErr) {
		if requireAuth {
			return fmt.Errorf("%w: native Codex authentication is unavailable", ErrAuthentication)
		}
		if _, targetErr := os.Lstat(filepath.Join(profileDir, "auth.json")); targetErr == nil {
			return errors.New("isolated profile retains authentication after native logout")
		} else if !os.IsNotExist(targetErr) {
			return fmt.Errorf("inspect isolated profile authentication after native logout: %w", targetErr)
		}
		return validateClonedCodexSettings(sourceHome, profileDir)
	}
	if sourceErr != nil {
		return fmt.Errorf("inspect native Codex authentication: %w", sourceErr)
	}
	if sourceInfo.Mode()&os.ModeSymlink != 0 || profileEntryHasReparsePoint(sourceInfo) || !sourceInfo.Mode().IsRegular() {
		return errors.New("native Codex auth.json must be a real regular file")
	}
	if !sameFile(sourceAuth, filepath.Join(profileDir, "auth.json")) {
		return errors.New("SDK authentication clone is not linked to the current native Codex credential")
	}
	return validateClonedCodexSettings(sourceHome, profileDir)
}

func removeSidecarOwnedAuthIfSourceMissing(profileDir, sourceAuth string) error {
	if _, err := os.Lstat(sourceAuth); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect native Codex authentication before logout reconciliation: %w", err)
	}
	if !profileOwnershipValid(profileDir) {
		return errors.New("isolated profile authentication can only be reconciled after sidecar ownership is established")
	}
	authPath := filepath.Join(profileDir, "auth.json")
	info, err := os.Lstat(authPath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect stale isolated authentication: %w", err)
	}
	if info.IsDir() || (!info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 && !profileEntryHasReparsePoint(info)) {
		return errors.New("stale isolated authentication must be a file or authentication link")
	}
	if err := os.Remove(authPath); err != nil {
		return fmt.Errorf("remove stale isolated authentication after native logout: %w", err)
	}
	return nil
}

func preflightNativeCodexHome(sourceHome string) error {
	if _, err := inspectRealDirectoryPath(sourceHome, "native Codex home", false); err != nil {
		return err
	}
	authPath := filepath.Join(sourceHome, "auth.json")
	info, err := os.Lstat(authPath)
	if os.IsNotExist(err) {
		return validateNativeCodexSettings(sourceHome)
	}
	if err != nil {
		return fmt.Errorf("inspect native Codex authentication: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || profileEntryHasReparsePoint(info) || !info.Mode().IsRegular() {
		return errors.New("native Codex auth.json must be a real regular file")
	}
	return validateNativeCodexSettings(sourceHome)
}

func profileOwnershipValid(profileDir string) bool {
	marker := filepath.Join(profileDir, profileOwnershipMarker)
	return validateExactProfileMarker(marker, profileOwnershipMarker+"\n", "isolated profile ownership marker") == nil
}

func ensureProfileOwnership(profileDir string) error {
	marker := filepath.Join(profileDir, profileOwnershipMarker)
	if _, err := os.Lstat(marker); err == nil {
		if !profileOwnershipValid(profileDir) {
			return errors.New("isolated profile ownership marker is invalid")
		}
		return nil
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect isolated profile ownership marker: %w", err)
	}
	file, err := os.OpenFile(marker, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if os.IsExist(err) && profileOwnershipValid(profileDir) {
			return nil
		}
		return fmt.Errorf("claim isolated profile: %w", err)
	}
	if _, err := file.WriteString(profileOwnershipMarker + "\n"); err != nil {
		_ = file.Close()
		return fmt.Errorf("write isolated profile ownership marker: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close isolated profile ownership marker: %w", err)
	}
	return nil
}

func preflightDedicatedWorkspace(root string) error {
	existed, err := inspectRealDirectoryPath(root, "isolated workspace root", false)
	if err != nil {
		return err
	}
	if !existed {
		return nil
	}
	return validateDedicatedWorkspaceContents(root, true)
}

func preflightRuntimeWorkspace(root, workspace string) error {
	rootExists, err := inspectRealDirectoryPath(root, "isolated workspace root", false)
	if err != nil {
		return err
	}
	if !rootExists {
		return errors.New("isolated workspace root disappeared before Codex execution")
	}
	if err := validateDedicatedWorkspaceContents(root, true); err != nil {
		return err
	}
	workspaceExists, err := inspectRealDirectoryPath(workspace, "isolated run workspace", false)
	if err != nil {
		return err
	}
	if !workspaceExists {
		return errors.New("isolated run workspace disappeared before Codex execution")
	}
	entries, err := os.ReadDir(workspace)
	if err != nil {
		return fmt.Errorf("inspect isolated run workspace contents: %w", err)
	}
	if len(entries) != 0 {
		return errors.New("isolated run workspace must remain empty before Codex execution")
	}
	canonicalRoot, err := canonicalPathForOverlap(root)
	if err != nil {
		return err
	}
	canonicalWorkspace, err := canonicalPathForOverlap(workspace)
	if err != nil {
		return err
	}
	if !strings.EqualFold(filepath.Clean(filepath.Dir(canonicalWorkspace)), filepath.Clean(canonicalRoot)) || !strings.HasPrefix(filepath.Base(canonicalWorkspace), workspaceRunPrefix) {
		return errors.New("isolated run workspace escaped its guarded root")
	}
	return nil
}

func validateDedicatedWorkspaceContents(root string, requireOwnership bool) error {
	entries, err := os.ReadDir(root)
	if err != nil {
		return fmt.Errorf("inspect isolated workspace root: %w", err)
	}
	markerPresent := false
	for _, entry := range entries {
		if entry.Name() == workspaceOwnershipMarker {
			markerPresent = true
			break
		}
	}
	if !markerPresent {
		if requireOwnership || len(entries) != 0 {
			return errors.New("isolated workspace root is unclaimed")
		}
		return nil
	}
	for _, entry := range entries {
		path := filepath.Join(root, entry.Name())
		if entry.Name() == workspaceOwnershipMarker {
			if err := validateProfileEntry(path, false, false); err != nil {
				return errors.New("isolated workspace ownership marker must be a regular file")
			}
			if err := validateExactProfileMarker(path, workspaceOwnershipMarker+"\n", "isolated workspace ownership marker"); err != nil {
				return err
			}
			continue
		}
		if !strings.HasPrefix(entry.Name(), workspaceRunPrefix) {
			return fmt.Errorf("isolated workspace root contains unknown resource %q", entry.Name())
		}
		if err := validateProfileEntry(path, true, false); err != nil {
			return fmt.Errorf("isolated workspace run directory %q is unsafe", entry.Name())
		}
	}
	return nil
}
