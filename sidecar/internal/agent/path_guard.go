package agent

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
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
	if err := isolatedProfileContents(profileDir); err != nil {
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
		return errors.New("isolated profile auth.json is not the native Codex authentication file")
	}
	return nil
}

func prepareDedicatedProfile(profileDir, sourceAuth string) error {
	if err := preflightDedicatedProfile(profileDir, sourceAuth, true); err != nil {
		return err
	}
	if err := ensureNativeAuthLink(profileDir, sourceAuth); err != nil {
		return err
	}
	if err := ensureProfileOwnership(profileDir); err != nil {
		return err
	}
	return preflightDedicatedProfile(profileDir, sourceAuth, false)
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
	if _, err := os.Lstat(filepath.Join(profileDir, "auth.json")); err != nil {
		return errors.New("isolated profile authentication is unavailable before Codex execution")
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
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect native Codex authentication: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || profileEntryHasReparsePoint(info) || !info.Mode().IsRegular() {
		return errors.New("native Codex auth.json must be a real regular file")
	}
	return nil
}

func profileOwnershipValid(profileDir string) bool {
	marker := filepath.Join(profileDir, profileOwnershipMarker)
	if err := validateProfileEntry(marker, false, false); err != nil {
		return false
	}
	contents, err := os.ReadFile(marker)
	return err == nil && string(contents) == profileOwnershipMarker+"\n"
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

func ensureNativeAuthLink(profileDir, sourceAuth string) error {
	sourceInfo, err := os.Lstat(sourceAuth)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect native Codex authentication: %w", err)
	}
	if sourceInfo.Mode()&os.ModeSymlink != 0 || profileEntryHasReparsePoint(sourceInfo) || !sourceInfo.Mode().IsRegular() {
		return errors.New("native Codex auth.json must be a real regular file")
	}

	authPath := filepath.Join(profileDir, "auth.json")
	if _, err := os.Lstat(authPath); err == nil {
		if !sameFile(sourceAuth, authPath) {
			return errors.New("isolated profile auth.json is not the native Codex authentication file")
		}
		return nil
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect isolated profile authentication: %w", err)
	}

	symlinkErr := os.Symlink(sourceAuth, authPath)
	if symlinkErr == nil {
		return nil
	}
	if _, err := os.Lstat(authPath); err == nil {
		if sameFile(sourceAuth, authPath) {
			return nil
		}
		return errors.New("isolated profile auth.json appeared concurrently and is not the native authentication file")
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect concurrently-created isolated authentication: %w", err)
	}
	if linkErr := os.Link(sourceAuth, authPath); linkErr != nil {
		if _, err := os.Lstat(authPath); err == nil && sameFile(sourceAuth, authPath) {
			return nil
		}
		return fmt.Errorf("link native Codex authentication without replacement: symlink failed: %v; hardlink failed: %w", symlinkErr, linkErr)
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
			contents, err := os.ReadFile(path)
			if err != nil {
				return fmt.Errorf("read isolated workspace ownership marker: %w", err)
			}
			if string(contents) != workspaceOwnershipMarker+"\n" {
				return errors.New("isolated workspace ownership marker is invalid")
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
