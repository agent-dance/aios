//go:build windows

package nativeapp

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const (
	wechatPackageID        = "Tencent.WeChat.Universal"
	wechatPublisher        = "Tencent Technology (Shenzhen) Company Limited"
	wechatPublisherCountry = "CN"
	wechatPublisherSerial  = "9144030071526726XG"
	wingetPackageFamily    = "Microsoft.DesktopAppInstaller_8wekyb3d8bbwe"
	microsoftPublisher     = "Microsoft Corporation"
	maxCommandOutput       = 64 * 1024
	certNameAttrType       = 3
)

var (
	versionDLL                     = windows.NewLazySystemDLL("version.dll")
	procGetFileVersionInfoSize     = versionDLL.NewProc("GetFileVersionInfoSizeW")
	procGetFileVersionInfo         = versionDLL.NewProc("GetFileVersionInfoW")
	procVerQueryValue              = versionDLL.NewProc("VerQueryValueW")
	kernel32DLL                    = windows.NewLazySystemDLL("kernel32.dll")
	procGetPackagesByPackageFamily = kernel32DLL.NewProc("GetPackagesByPackageFamily")
	procGetPackagePathByFullName   = kernel32DLL.NewProc("GetPackagePathByFullName")
	discoverySlot                  = make(chan struct{}, 1)
)

type windowsPlatform struct{}

type registryLocation struct {
	root registry.Key
	path string
	view uint32
	kind string
}

type executableCandidate struct {
	path string
}

type trustedExecutable struct {
	path    string
	version string
	handle  windows.Handle
}

type signerIdentity struct {
	commonName   string
	organization string
	country      string
	serialNumber string
}

type cryptProviderCertPrefix struct {
	size    uint32
	context *windows.CertContext
}

type vsFixedFileInfo struct {
	signature        uint32
	structVersion    uint32
	fileVersionMS    uint32
	fileVersionLS    uint32
	productVersionMS uint32
	productVersionLS uint32
	fileFlagsMask    uint32
	fileFlags        uint32
	fileOS           uint32
	fileType         uint32
	fileSubtype      uint32
	fileDateMS       uint32
	fileDateLS       uint32
}

var registryLocations = []registryLocation{
	{registry.CURRENT_USER, `Software\Classes\xweixin\shell\open\command`, 0, "protocol"},
	{registry.CURRENT_USER, `Software\Classes\weixin\shell\open\command`, 0, "protocol"},
	{registry.LOCAL_MACHINE, `SOFTWARE\Classes\xweixin\shell\open\command`, registry.WOW64_64KEY, "protocol"},
	{registry.LOCAL_MACHINE, `SOFTWARE\Classes\weixin\shell\open\command`, registry.WOW64_64KEY, "protocol"},
	{registry.LOCAL_MACHINE, `SOFTWARE\Classes\xweixin\shell\open\command`, registry.WOW64_32KEY, "protocol"},
	{registry.LOCAL_MACHINE, `SOFTWARE\Classes\weixin\shell\open\command`, registry.WOW64_32KEY, "protocol"},
	{registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\App Paths\Weixin.exe`, 0, "app-path"},
	{registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\App Paths\WeChat.exe`, 0, "app-path"},
	{registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Weixin.exe`, registry.WOW64_64KEY, "app-path"},
	{registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\WeChat.exe`, registry.WOW64_64KEY, "app-path"},
	{registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Weixin`, registry.WOW64_64KEY, "uninstall"},
	{registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\WeChat`, registry.WOW64_64KEY, "uninstall"},
	{registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Weixin`, registry.WOW64_32KEY, "uninstall"},
	{registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\WeChat`, registry.WOW64_32KEY, "uninstall"},
	{registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Uninstall\Weixin`, 0, "uninstall"},
	{registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Uninstall\WeChat`, 0, "uninstall"},
}

func NewPlatform() Platform { return windowsPlatform{} }

func (windowsPlatform) Discover(ctx context.Context) (Discovery, error) {
	trusted, state, err := discoverTrustedExecutableBounded(ctx)
	if err != nil {
		return Discovery{}, err
	}
	if state != "installed" {
		return Discovery{Platform: "windows", State: state}, nil
	}
	defer windows.CloseHandle(trusted.handle)
	return installedDiscovery(trusted.version), nil
}

func (windowsPlatform) Install(ctx context.Context, mode InstallMode) error {
	args, err := wingetInstallArguments(mode)
	if err != nil {
		return err
	}
	winget, handle, err := trustedWingetExecutableBounded(ctx)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	if err := ctx.Err(); err != nil {
		return err
	}
	cmd := exec.Command(winget, args...)
	systemDirectory, err := windows.GetSystemDirectory()
	if err != nil {
		return errors.New("resolve Windows system directory")
	}
	cmd.Dir = systemDirectory
	cmd.Env = nativeChildEnvironment()
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	var output boundedBuffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	if err := runInKillOnCloseJob(ctx, cmd); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("Windows Package Manager did not complete successfully")
	}
	return nil
}

func wingetInstallArguments(mode InstallMode) ([]string, error) {
	arguments := []string{
		"install", "--id", wechatPackageID, "--exact", "--source", "winget", "--scope", "machine", "--silent",
		"--disable-interactivity", "--accept-package-agreements", "--accept-source-agreements",
	}
	switch mode {
	case InstallModeFresh:
	case InstallModeRepair:
		arguments = append(arguments, "--force")
	default:
		return nil, errors.New("unsupported native app install mode")
	}
	return arguments, nil
}

func runInKillOnCloseJob(ctx context.Context, cmd *exec.Cmd) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(job)
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(
		job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits)),
	); err != nil {
		return err
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags |= windows.CREATE_SUSPENDED
	if err := cmd.Start(); err != nil {
		return err
	}
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return err
	}
	assignErr := windows.AssignProcessToJobObject(job, process)
	_ = windows.CloseHandle(process)
	if assignErr != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return assignErr
	}
	if err := resumeSuspendedProcess(uint32(cmd.Process.Pid)); err != nil {
		_ = windows.TerminateJobObject(job, 1)
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return err
	}
	wait := make(chan error, 1)
	go func() { wait <- cmd.Wait() }()
	select {
	case err := <-wait:
		return err
	case <-ctx.Done():
		if err := windows.TerminateJobObject(job, 1); err != nil {
			_ = cmd.Process.Kill()
		}
		select {
		case <-wait:
		case <-time.After(5 * time.Second):
		}
		return ctx.Err()
	}
}

func resumeSuspendedProcess(processID uint32) error {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ThreadEntry32{Size: uint32(unsafe.Sizeof(windows.ThreadEntry32{}))}
	if err := windows.Thread32First(snapshot, &entry); err != nil {
		return err
	}
	for {
		if entry.OwnerProcessID == processID {
			thread, err := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, entry.ThreadID)
			if err != nil {
				return err
			}
			previous, resumeErr := windows.ResumeThread(thread)
			_ = windows.CloseHandle(thread)
			if resumeErr != nil || previous == ^uint32(0) {
				if resumeErr != nil {
					return resumeErr
				}
				return errors.New("resume Windows Package Manager process")
			}
			if previous != 1 {
				return errors.New("Windows Package Manager process suspension state is invalid")
			}
			return nil
		}
		if err := windows.Thread32Next(snapshot, &entry); err != nil {
			return errors.New("find Windows Package Manager primary thread")
		}
	}
}

func (windowsPlatform) Launch(ctx context.Context) (Discovery, error) {
	trusted, state, err := discoverTrustedExecutableBounded(ctx)
	if err != nil {
		return Discovery{}, err
	}
	switch state {
	case "not-installed":
		return Discovery{}, ErrNotInstalled
	case "invalid":
		return Discovery{}, ErrInvalidInstallation
	case "installed":
	default:
		return Discovery{}, errors.New("invalid discovery state")
	}
	defer windows.CloseHandle(trusted.handle)
	if err := ctx.Err(); err != nil {
		return Discovery{}, err
	}
	process, err := os.StartProcess(trusted.path, []string{trusted.path}, &os.ProcAttr{Dir: filepath.Dir(trusted.path), Env: nativeChildEnvironment()})
	if err != nil {
		return Discovery{}, err
	}
	if err := process.Release(); err != nil {
		return Discovery{}, err
	}
	return installedDiscovery(trusted.version), nil
}

func installedDiscovery(version string) Discovery {
	return Discovery{
		Platform: "windows", State: "installed", Version: version,
		Installed: true, Launchable: true, PublisherVerified: true,
	}
}

type trustedDiscoveryResult struct {
	trusted trustedExecutable
	state   string
	err     error
}

type trustedWingetResult struct {
	path   string
	handle windows.Handle
	err    error
}

func discoverTrustedExecutableBounded(ctx context.Context) (trustedExecutable, string, error) {
	select {
	case discoverySlot <- struct{}{}:
	case <-ctx.Done():
		return trustedExecutable{}, "", ctx.Err()
	}
	result := make(chan trustedDiscoveryResult)
	go func() {
		defer func() { <-discoverySlot }()
		trusted, state, err := discoverTrustedExecutable(ctx)
		select {
		case result <- trustedDiscoveryResult{trusted: trusted, state: state, err: err}:
		case <-ctx.Done():
			if trusted.handle != 0 && trusted.handle != windows.InvalidHandle {
				_ = windows.CloseHandle(trusted.handle)
			}
		}
	}()
	select {
	case value := <-result:
		return value.trusted, value.state, value.err
	case <-ctx.Done():
		return trustedExecutable{}, "", ctx.Err()
	}
}

func trustedWingetExecutableBounded(ctx context.Context) (string, windows.Handle, error) {
	select {
	case discoverySlot <- struct{}{}:
	case <-ctx.Done():
		return "", windows.InvalidHandle, ctx.Err()
	}
	result := make(chan trustedWingetResult)
	go func() {
		defer func() { <-discoverySlot }()
		path, handle, err := trustedWingetExecutable()
		select {
		case result <- trustedWingetResult{path: path, handle: handle, err: err}:
		case <-ctx.Done():
			if handle != 0 && handle != windows.InvalidHandle {
				_ = windows.CloseHandle(handle)
			}
		}
	}()
	select {
	case value := <-result:
		return value.path, value.handle, value.err
	case <-ctx.Done():
		return "", windows.InvalidHandle, ctx.Err()
	}
}

func trustedWingetExecutable() (string, windows.Handle, error) {
	packageNames, err := packageFullNamesByFamily(wingetPackageFamily)
	if err != nil {
		return "", windows.InvalidHandle, errors.New("Windows Package Manager package is unavailable")
	}
	sort.Sort(sort.Reverse(sort.StringSlice(packageNames)))
	roots, err := trustedProgramFilesRoots()
	if err != nil {
		return "", windows.InvalidHandle, err
	}
	for _, packageName := range packageNames {
		if !strings.HasPrefix(packageName, "Microsoft.DesktopAppInstaller_") || !strings.HasSuffix(packageName, "__8wekyb3d8bbwe") {
			continue
		}
		packagePath, err := packagePathByFullName(packageName)
		if err != nil {
			continue
		}
		candidate := filepath.Join(packagePath, "winget.exe")
		handle, finalPath, err := openTrustedWingetExecutable(candidate, roots, packageName)
		if err != nil {
			continue
		}
		if err := verifyAuthenticode(finalPath, handle, signerIdentity{
			commonName: microsoftPublisher, organization: microsoftPublisher, country: "US",
		}); err != nil {
			_ = windows.CloseHandle(handle)
			continue
		}
		return finalPath, handle, nil
	}
	return "", windows.InvalidHandle, errors.New("a trusted Windows Package Manager executable was not found")
}

func packageFullNamesByFamily(family string) ([]string, error) {
	familyUTF16, err := windows.UTF16PtrFromString(family)
	if err != nil {
		return nil, err
	}
	var count, bufferLength uint32
	result, _, _ := procGetPackagesByPackageFamily.Call(
		uintptr(unsafe.Pointer(familyUTF16)), uintptr(unsafe.Pointer(&count)), 0,
		uintptr(unsafe.Pointer(&bufferLength)), 0,
	)
	if syscall.Errno(result) != windows.ERROR_INSUFFICIENT_BUFFER || count == 0 || count > 64 || bufferLength == 0 || bufferLength > 65536 {
		return nil, errors.New("query Windows Package Manager package names")
	}
	namePointers := make([]*uint16, count)
	buffer := make([]uint16, bufferLength)
	result, _, _ = procGetPackagesByPackageFamily.Call(
		uintptr(unsafe.Pointer(familyUTF16)), uintptr(unsafe.Pointer(&count)), uintptr(unsafe.Pointer(&namePointers[0])),
		uintptr(unsafe.Pointer(&bufferLength)), uintptr(unsafe.Pointer(&buffer[0])),
	)
	if result != 0 || count == 0 || int(count) > len(namePointers) {
		return nil, errors.New("read Windows Package Manager package names")
	}
	values := make([]string, 0, count)
	for _, value := range namePointers[:count] {
		if value == nil {
			continue
		}
		values = append(values, windows.UTF16PtrToString(value))
	}
	if len(values) == 0 {
		return nil, errors.New("Windows Package Manager package list is empty")
	}
	return values, nil
}

func packagePathByFullName(packageName string) (string, error) {
	nameUTF16, err := windows.UTF16PtrFromString(packageName)
	if err != nil {
		return "", err
	}
	var length uint32
	result, _, _ := procGetPackagePathByFullName.Call(uintptr(unsafe.Pointer(nameUTF16)), uintptr(unsafe.Pointer(&length)), 0)
	if syscall.Errno(result) != windows.ERROR_INSUFFICIENT_BUFFER || length == 0 || length > 32768 {
		return "", errors.New("query Windows package path")
	}
	buffer := make([]uint16, length)
	result, _, _ = procGetPackagePathByFullName.Call(uintptr(unsafe.Pointer(nameUTF16)), uintptr(unsafe.Pointer(&length)), uintptr(unsafe.Pointer(&buffer[0])))
	if result != 0 {
		return "", errors.New("read Windows package path")
	}
	return windows.UTF16ToString(buffer), nil
}

func openTrustedWingetExecutable(path string, roots []string, packageName string) (windows.Handle, string, error) {
	if strings.HasPrefix(path, `\\`) || strings.HasPrefix(path, `\\?\`) || strings.Contains(strings.TrimPrefix(path, filepath.VolumeName(path)), ":") {
		return windows.InvalidHandle, "", errors.New("unsupported Windows Package Manager path")
	}
	clean, err := filepath.Abs(filepath.Clean(path))
	if err != nil || !strings.EqualFold(filepath.Base(clean), "winget.exe") {
		return windows.InvalidHandle, "", errors.New("invalid Windows Package Manager path")
	}
	trusted := false
	for _, root := range roots {
		relative, err := filepath.Rel(root, clean)
		if err != nil {
			continue
		}
		parts := strings.Split(relative, string(filepath.Separator))
		if len(parts) == 3 && strings.EqualFold(parts[0], "WindowsApps") && parts[1] == packageName && strings.EqualFold(parts[2], "winget.exe") {
			trusted = true
			break
		}
	}
	if !trusted {
		return windows.InvalidHandle, "", errors.New("Windows Package Manager is outside Program Files")
	}
	if err := rejectReparseComponents(clean, roots); err != nil {
		return windows.InvalidHandle, "", err
	}
	value, err := windows.UTF16PtrFromString(clean)
	if err != nil {
		return windows.InvalidHandle, "", err
	}
	handle, err := windows.CreateFile(value, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return windows.InvalidHandle, "", err
	}
	finalPath, err := finalPathForHandle(handle)
	if err != nil || !strings.EqualFold(filepath.Clean(finalPath), clean) {
		_ = windows.CloseHandle(handle)
		return windows.InvalidHandle, "", errors.New("Windows Package Manager path changed while opening")
	}
	return handle, finalPath, nil
}

func discoverTrustedExecutable(ctx context.Context) (trustedExecutable, string, error) {
	candidates, err := readRegistryCandidates(ctx)
	if err != nil {
		return trustedExecutable{}, "", err
	}
	if len(candidates) == 0 {
		return trustedExecutable{}, "not-installed", nil
	}
	roots, err := trustedProgramFilesRoots()
	if err != nil {
		return trustedExecutable{}, "", err
	}
	foundExisting := false
	for _, candidate := range candidates {
		if err := ctx.Err(); err != nil {
			return trustedExecutable{}, "", err
		}
		handle, finalPath, err := openTrustedWeChatExecutable(candidate.path, roots)
		if errors.Is(err, os.ErrNotExist) || errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
			continue
		}
		if err != nil {
			foundExisting = true
			continue
		}
		foundExisting = true
		if err := verifyAuthenticode(finalPath, handle, signerIdentity{
			commonName: wechatPublisher, organization: wechatPublisher,
			country: wechatPublisherCountry, serialNumber: wechatPublisherSerial,
		}); err != nil {
			_ = windows.CloseHandle(handle)
			continue
		}
		version, err := executableVersion(finalPath)
		if err != nil {
			_ = windows.CloseHandle(handle)
			continue
		}
		if len(version) > 128 {
			_ = windows.CloseHandle(handle)
			continue
		}
		return trustedExecutable{path: finalPath, version: version, handle: handle}, "installed", nil
	}
	if foundExisting {
		return trustedExecutable{}, "invalid", nil
	}
	return trustedExecutable{}, "not-installed", nil
}

func readRegistryCandidates(ctx context.Context) ([]executableCandidate, error) {
	candidates := make([]executableCandidate, 0, len(registryLocations))
	seen := make(map[string]struct{})
	for _, location := range registryLocations {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		key, err := registry.OpenKey(location.root, location.path, registry.QUERY_VALUE|location.view)
		if errors.Is(err, registry.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, errors.New("read a fixed WeChat registry key")
		}
		paths := candidatesFromRegistryKey(key, location.kind)
		_ = key.Close()
		for _, path := range paths {
			if !isAllowedExecutableName(path) || !filepath.IsAbs(path) || filepath.VolumeName(path) == "" {
				continue
			}
			clean := filepath.Clean(path)
			lower := strings.ToLower(clean)
			if _, exists := seen[lower]; exists {
				continue
			}
			seen[lower] = struct{}{}
			candidates = append(candidates, executableCandidate{path: clean})
		}
	}
	return candidates, nil
}

func candidatesFromRegistryKey(key registry.Key, kind string) []string {
	switch kind {
	case "protocol":
		command, _, err := key.GetStringValue("")
		if err != nil {
			return nil
		}
		path, ok := parseProtocolCommand(command)
		if !ok {
			return nil
		}
		return []string{path}
	case "app-path":
		path, _, err := key.GetStringValue("")
		if err != nil {
			return nil
		}
		return []string{strings.TrimSpace(path)}
	case "uninstall":
		location, _, err := key.GetStringValue("InstallLocation")
		if err != nil || strings.TrimSpace(location) == "" {
			return nil
		}
		location = strings.Trim(strings.TrimSpace(location), `"`)
		return []string{filepath.Join(location, "Weixin.exe"), filepath.Join(location, "WeChat.exe")}
	default:
		return nil
	}
}

func parseProtocolCommand(command string) (string, bool) {
	value := strings.TrimSpace(command)
	var path string
	for _, suffix := range []string{` "%1"`, ` %1`} {
		if strings.HasSuffix(value, suffix) {
			path = strings.TrimSpace(strings.TrimSuffix(value, suffix))
			break
		}
	}
	if path == "" {
		return "", false
	}
	if strings.HasPrefix(path, `"`) || strings.HasSuffix(path, `"`) {
		if len(path) < 2 || !strings.HasPrefix(path, `"`) || !strings.HasSuffix(path, `"`) {
			return "", false
		}
		path = path[1 : len(path)-1]
	}
	if strings.ContainsAny(path, `"&|<>`) || !filepath.IsAbs(path) || filepath.VolumeName(path) == "" ||
		strings.Contains(strings.TrimPrefix(path, filepath.VolumeName(path)), ":") || !isAllowedExecutableName(path) {
		return "", false
	}
	return filepath.Clean(path), true
}

func isAllowedExecutableName(path string) bool {
	base := filepath.Base(strings.TrimSpace(path))
	return strings.EqualFold(base, "Weixin.exe") || strings.EqualFold(base, "WeChat.exe")
}

func trustedProgramFilesRoots() ([]string, error) {
	ids := []*windows.KNOWNFOLDERID{windows.FOLDERID_ProgramFiles, windows.FOLDERID_ProgramFilesX64, windows.FOLDERID_ProgramFilesX86}
	roots := make([]string, 0, len(ids))
	seen := make(map[string]struct{})
	for _, id := range ids {
		root, err := windows.KnownFolderPath(id, 0)
		if err != nil || root == "" {
			continue
		}
		root, err = filepath.EvalSymlinks(root)
		if err != nil {
			continue
		}
		key := strings.ToLower(filepath.Clean(root))
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		roots = append(roots, filepath.Clean(root))
	}
	if len(roots) == 0 {
		return nil, errors.New("resolve trusted Program Files roots")
	}
	return roots, nil
}

func validateExecutablePath(path string, roots []string) (string, error) {
	if strings.HasPrefix(path, `\\`) || strings.HasPrefix(path, `\\?\`) || strings.Contains(strings.TrimPrefix(path, filepath.VolumeName(path)), ":") {
		return "", errors.New("unsupported executable path")
	}
	finalPath, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	finalPath, err = filepath.Abs(finalPath)
	if err != nil || !isAllowedExecutableName(finalPath) {
		return "", errors.New("invalid executable path")
	}
	for _, root := range roots {
		relative, err := filepath.Rel(root, finalPath)
		if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			continue
		}
		parts := strings.Split(relative, string(filepath.Separator))
		if len(parts) == 3 && strings.EqualFold(parts[0], "Tencent") &&
			((strings.EqualFold(parts[1], "Weixin") && strings.EqualFold(parts[2], "Weixin.exe")) ||
				(strings.EqualFold(parts[1], "WeChat") && strings.EqualFold(parts[2], "WeChat.exe"))) {
			return filepath.Clean(finalPath), nil
		}
	}
	return "", errors.New("executable is outside the trusted installation roots")
}

func openTrustedWeChatExecutable(path string, roots []string) (windows.Handle, string, error) {
	validated, err := validateExecutablePath(path, roots)
	if err != nil {
		return windows.InvalidHandle, "", err
	}
	if err := rejectReparseComponents(validated, roots); err != nil {
		return windows.InvalidHandle, "", err
	}
	pathUTF16, err := windows.UTF16PtrFromString(validated)
	if err != nil {
		return windows.InvalidHandle, "", err
	}
	handle, err := windows.CreateFile(pathUTF16, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return windows.InvalidHandle, "", err
	}
	finalPath, err := finalPathForHandle(handle)
	if err != nil {
		_ = windows.CloseHandle(handle)
		return windows.InvalidHandle, "", err
	}
	finalPath, err = validateExecutablePath(finalPath, roots)
	if err != nil || !strings.EqualFold(filepath.Clean(validated), filepath.Clean(finalPath)) {
		_ = windows.CloseHandle(handle)
		return windows.InvalidHandle, "", errors.New("executable path changed while opening")
	}
	return handle, finalPath, nil
}

func finalPathForHandle(handle windows.Handle) (string, error) {
	size := uint32(512)
	for size <= 32768 {
		buffer := make([]uint16, size)
		length, err := windows.GetFinalPathNameByHandle(handle, &buffer[0], size, 0)
		if err != nil {
			return "", err
		}
		if length < size {
			path := windows.UTF16ToString(buffer[:length])
			if strings.HasPrefix(path, `\\?\UNC\`) {
				return "", errors.New("UNC executable paths are unsupported")
			}
			return strings.TrimPrefix(path, `\\?\`), nil
		}
		size = length + 1
	}
	return "", errors.New("executable path is too long")
}

func rejectReparseComponents(path string, roots []string) error {
	for _, root := range roots {
		relative, err := filepath.Rel(root, path)
		if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			continue
		}
		current := root
		for _, component := range strings.Split(relative, string(filepath.Separator)) {
			current = filepath.Join(current, component)
			value, err := windows.UTF16PtrFromString(current)
			if err != nil {
				return err
			}
			attributes, err := windows.GetFileAttributes(value)
			if err != nil {
				return err
			}
			if attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
				return errors.New("reparse points are not allowed in the executable path")
			}
		}
		return nil
	}
	return errors.New("executable is outside the trusted installation roots")
}

func verifyAuthenticode(path string, handle windows.Handle, expected signerIdentity) error {
	pathUTF16, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	fileInfo := &windows.WinTrustFileInfo{
		Size:     uint32(unsafe.Sizeof(windows.WinTrustFileInfo{})),
		FilePath: pathUTF16,
		File:     handle,
	}
	data := &windows.WinTrustData{
		Size:                            uint32(unsafe.Sizeof(windows.WinTrustData{})),
		UIChoice:                        windows.WTD_UI_NONE,
		RevocationChecks:                windows.WTD_REVOKE_WHOLECHAIN,
		UnionChoice:                     windows.WTD_CHOICE_FILE,
		FileOrCatalogOrBlobOrSgnrOrCert: unsafe.Pointer(fileInfo),
		StateAction:                     windows.WTD_STATEACTION_VERIFY,
		ProvFlags:                       windows.WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT | windows.WTD_DISABLE_MD2_MD4 | windows.WTD_SAFER_FLAG,
		UIContext:                       windows.WTD_UICONTEXT_EXECUTE,
	}
	verifyErr := windows.WinVerifyTrustEx(windows.InvalidHWND, &windows.WINTRUST_ACTION_GENERIC_VERIFY_V2, data)
	if verifyErr == nil {
		verifyErr = verifySignerIdentity(data.StateData, expected)
	}
	data.StateAction = windows.WTD_STATEACTION_CLOSE
	closeErr := windows.WinVerifyTrustEx(windows.InvalidHWND, &windows.WINTRUST_ACTION_GENERIC_VERIFY_V2, data)
	if verifyErr != nil {
		return verifyErr
	}
	return closeErr
}

func verifySignerIdentity(stateData windows.Handle, expected signerIdentity) error {
	providerData := wTHelperProvDataFromStateData(uintptr(stateData))
	if providerData == 0 {
		return errors.New("read Authenticode provider data")
	}
	signer := wTHelperGetProvSignerFromChain(providerData, 0, false, 0)
	if signer == 0 {
		return errors.New("read Authenticode signer")
	}
	providerCert := wTHelperGetProvCertFromChain(signer, 0)
	if providerCert == 0 {
		return errors.New("read Authenticode signer certificate")
	}
	var providerCertificate cryptProviderCertPrefix
	var bytesRead uintptr
	if err := windows.ReadProcessMemory(
		windows.CurrentProcess(), providerCert, (*byte)(unsafe.Pointer(&providerCertificate)), unsafe.Sizeof(providerCertificate), &bytesRead,
	); err != nil || bytesRead != unsafe.Sizeof(providerCertificate) {
		return errors.New("copy Authenticode signer certificate")
	}
	certificate := providerCertificate.context
	if certificate == nil {
		return errors.New("missing Authenticode signer certificate")
	}
	commonName, err := certificateAttribute(certificate, "2.5.4.3")
	if err != nil {
		return err
	}
	organization, err := certificateAttribute(certificate, "2.5.4.10")
	if err != nil {
		return err
	}
	country, err := certificateAttribute(certificate, "2.5.4.6")
	if err != nil {
		return err
	}
	serialNumber := ""
	if expected.serialNumber != "" {
		serialNumber, err = certificateAttribute(certificate, "2.5.4.5")
		if err != nil {
			return err
		}
	}
	actual := signerIdentity{commonName: commonName, organization: organization, country: country, serialNumber: serialNumber}
	if !matchesSignerIdentity(actual, expected) {
		return errors.New("unexpected Authenticode signer")
	}
	return nil
}

func matchesSignerIdentity(actual, expected signerIdentity) bool {
	return actual.commonName == expected.commonName && actual.organization == expected.organization &&
		actual.country == expected.country && actual.serialNumber == expected.serialNumber
}

func certificateAttribute(certificate *windows.CertContext, oid string) (string, error) {
	oidBytes := append([]byte(oid), 0)
	typeParameter := unsafe.Pointer(&oidBytes[0])
	size := windows.CertGetNameString(certificate, certNameAttrType, 0, typeParameter, nil, 0)
	if size <= 1 {
		return "", errors.New("read signer certificate attribute")
	}
	value := make([]uint16, size)
	if windows.CertGetNameString(certificate, certNameAttrType, 0, typeParameter, &value[0], size) != size {
		return "", errors.New("read signer certificate attribute")
	}
	return windows.UTF16ToString(value), nil
}

func executableVersion(path string) (string, error) {
	pathUTF16, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return "", err
	}
	var handle uint32
	size, _, _ := procGetFileVersionInfoSize.Call(uintptr(unsafe.Pointer(pathUTF16)), uintptr(unsafe.Pointer(&handle)))
	if size == 0 || size > 16*1024*1024 {
		return "", errors.New("read executable version size")
	}
	data := make([]byte, size)
	ok, _, _ := procGetFileVersionInfo.Call(uintptr(unsafe.Pointer(pathUTF16)), 0, size, uintptr(unsafe.Pointer(&data[0])))
	if ok == 0 {
		return "", errors.New("read executable version")
	}
	root, _ := windows.UTF16PtrFromString(`\`)
	var value unsafe.Pointer
	var valueSize uint32
	ok, _, _ = procVerQueryValue.Call(uintptr(unsafe.Pointer(&data[0])), uintptr(unsafe.Pointer(root)), uintptr(unsafe.Pointer(&value)), uintptr(unsafe.Pointer(&valueSize)))
	if ok == 0 || value == nil || valueSize < uint32(unsafe.Sizeof(vsFixedFileInfo{})) {
		return "", errors.New("query executable version")
	}
	fixed := (*vsFixedFileInfo)(value)
	if fixed.signature != 0xfeef04bd {
		return "", errors.New("invalid executable version resource")
	}
	return fmt.Sprintf("%d.%d.%d.%d", fixed.fileVersionMS>>16, fixed.fileVersionMS&0xffff, fixed.fileVersionLS>>16, fixed.fileVersionLS&0xffff), nil
}

func nativeChildEnvironment() []string {
	allowed := map[string]struct{}{
		"allusersprofile": {}, "appdata": {}, "commonprogramfiles": {}, "commonprogramfiles(x86)": {},
		"commonprogramw6432": {}, "homedrive": {}, "homepath": {}, "localappdata": {}, "number_of_processors": {},
		"os": {}, "pathext": {}, "processor_architecture": {}, "processor_identifier": {}, "processor_level": {},
		"processor_revision": {}, "programdata": {}, "programfiles": {}, "programfiles(x86)": {}, "programw6432": {},
		"public": {}, "sessionname": {}, "systemdrive": {}, "systemroot": {}, "temp": {}, "tmp": {},
		"userdomain": {}, "username": {}, "userprofile": {}, "windir": {},
	}
	environment := make([]string, 0, len(allowed))
	seen := make(map[string]struct{}, len(allowed))
	for _, entry := range os.Environ() {
		name, _, found := strings.Cut(entry, "=")
		key := strings.ToLower(name)
		if !found {
			continue
		}
		if _, ok := allowed[key]; !ok {
			continue
		}
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		environment = append(environment, entry)
	}
	return environment
}

type boundedBuffer struct {
	buffer bytes.Buffer
}

func (b *boundedBuffer) Write(data []byte) (int, error) {
	originalLength := len(data)
	remaining := maxCommandOutput - b.buffer.Len()
	if remaining > 0 {
		_, _ = b.buffer.Write(data[:min(remaining, len(data))])
	}
	return originalLength, nil
}

var _ io.Writer = (*boundedBuffer)(nil)
