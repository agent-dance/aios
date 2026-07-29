//go:build windows

package nativeapp

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestProtocolCommandParserAcceptsOnlyFixedExecutableAndPlaceholder(t *testing.T) {
	valid := []string{
		`"C:\Program Files\Tencent\Weixin\Weixin.exe" "%1"`,
		`C:\Program Files\Tencent\Weixin\Weixin.exe "%1"`,
		`C:\Tencent\Weixin\Weixin.exe "%1"`,
		`"C:\Program Files\Tencent\WeChat\WeChat.exe" %1`,
	}
	for _, command := range valid {
		path, ok := parseProtocolCommand(command)
		if !ok || !isAllowedExecutableName(path) {
			t.Fatalf("valid command rejected: %q", command)
		}
	}
	invalid := []string{
		`"C:\Windows\System32\calc.exe" "%1"`,
		`"C:\Program Files\Tencent\Weixin\Weixin.exe" --extra "%1"`,
		`cmd.exe /c "C:\Program Files\Tencent\Weixin\Weixin.exe" "%1"`,
		`"C:\Program Files\Tencent\Weixin\Weixin.exe" "%1" & calc.exe`,
		`"C:\Program Files\Tencent\Weixin\Weixin.exe"`,
	}
	for _, command := range invalid {
		if _, ok := parseProtocolCommand(command); ok {
			t.Fatalf("unsafe command accepted: %q", command)
		}
	}
}

func TestExecutablePathValidationRequiresExactProgramFilesLayout(t *testing.T) {
	root := filepath.Join(t.TempDir(), "Program Files")
	valid := filepath.Join(root, "Tencent", "Weixin", "Weixin.exe")
	if err := os.MkdirAll(filepath.Dir(valid), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(valid, []byte("test"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := validateExecutablePath(valid, []string{root})
	if err != nil || !strings.EqualFold(got, valid) {
		t.Fatalf("valid path rejected: %q %v", got, err)
	}

	for _, relative := range []string{
		filepath.Join("Tencent", "Weixin", "nested", "Weixin.exe"),
		filepath.Join("Tencent", "Weixin", "WeChat.exe"),
		filepath.Join("Other", "Weixin", "Weixin.exe"),
	} {
		path := filepath.Join(root, relative)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("test"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := validateExecutablePath(path, []string{root}); err == nil {
			t.Fatalf("unsafe layout accepted: %s", relative)
		}
	}
}

func TestWingetInstallArgumentsAreClosedAndExact(t *testing.T) {
	fresh := []string{
		"install", "--id", "Tencent.WeChat.Universal", "--exact", "--source", "winget", "--scope", "machine", "--silent",
		"--disable-interactivity", "--accept-package-agreements", "--accept-source-agreements",
	}
	gotFresh, err := wingetInstallArguments(InstallModeFresh)
	if err != nil || !reflect.DeepEqual(gotFresh, fresh) {
		t.Fatalf("fresh winget arguments:\ngot  %q\nwant %q\nerr %v", gotFresh, fresh, err)
	}
	repair := append(append([]string{}, fresh...), "--force")
	gotRepair, err := wingetInstallArguments(InstallModeRepair)
	if err != nil || !reflect.DeepEqual(gotRepair, repair) {
		t.Fatalf("repair winget arguments:\ngot  %q\nwant %q\nerr %v", gotRepair, repair, err)
	}
	if _, err := wingetInstallArguments(InstallMode(255)); err == nil {
		t.Fatal("unknown install mode was accepted")
	}
}

func TestUserWritableWingetAliasCannotPassTrustedPackageLayout(t *testing.T) {
	root := filepath.Join(t.TempDir(), "Program Files")
	aliasRoot := filepath.Join(t.TempDir(), "LocalAppData")
	alias := filepath.Join(aliasRoot, "Microsoft", "WindowsApps", "winget.exe")
	if err := os.MkdirAll(filepath.Dir(alias), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(alias, []byte("attacker controlled"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, _, err := openTrustedWingetExecutable(alias, []string{root}, "Microsoft.DesktopAppInstaller_1.0.0.0_x64__8wekyb3d8bbwe"); err == nil {
		t.Fatal("user-writable App Execution Alias path was trusted")
	}
}

func TestSignerIdentityMatchingIsExact(t *testing.T) {
	expected := signerIdentity{
		commonName: wechatPublisher, organization: wechatPublisher,
		country: wechatPublisherCountry, serialNumber: wechatPublisherSerial,
	}
	if !matchesSignerIdentity(expected, expected) {
		t.Fatal("exact official signer identity did not match")
	}
	mutations := []signerIdentity{
		{commonName: wechatPublisher + " Evil", organization: wechatPublisher, country: wechatPublisherCountry, serialNumber: wechatPublisherSerial},
		{commonName: wechatPublisher, organization: wechatPublisher, country: "US", serialNumber: wechatPublisherSerial},
		{commonName: wechatPublisher, organization: wechatPublisher, country: wechatPublisherCountry, serialNumber: "different"},
	}
	for _, actual := range mutations {
		if matchesSignerIdentity(actual, expected) {
			t.Fatalf("non-exact signer matched: %+v", actual)
		}
	}
}

func TestNativeChildEnvironmentExcludesSidecarAndProviderSecrets(t *testing.T) {
	t.Setenv("AIOS_SIDECAR_TOKEN", "secret-token")
	t.Setenv("OPENAI_API_KEY", "secret-provider-key")
	t.Setenv("UNRELATED_SECRET", "secret")
	t.Setenv("TEMP", t.TempDir())
	environment := nativeChildEnvironment()
	joined := strings.ToLower(strings.Join(environment, "\n"))
	for _, forbidden := range []string{"aios_sidecar_token=", "openai_api_key=", "unrelated_secret="} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("secret inherited by native child: %s", forbidden)
		}
	}
	if !strings.Contains(joined, "temp=") {
		t.Fatal("minimal native environment omitted TEMP")
	}
}

func TestBoundedCommandOutputNeverExceedsLimit(t *testing.T) {
	var output boundedBuffer
	input := []byte(strings.Repeat("x", maxCommandOutput*2))
	written, err := output.Write(input)
	if err != nil || written != len(input) || output.buffer.Len() != maxCommandOutput {
		t.Fatalf("bounded output: written=%d stored=%d err=%v", written, output.buffer.Len(), err)
	}
}

func TestDiscoveryConcurrencyGateHonorsCancellation(t *testing.T) {
	discoverySlot <- struct{}{}
	defer func() { <-discoverySlot }()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := discoverTrustedExecutableBounded(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("blocked discovery returned %v", err)
	}
}

func TestKillOnCloseJobStartsSuspendedAndHonorsCancellation(t *testing.T) {
	if os.Getenv("AIOS_NATIVEAPP_JOB_HELPER") == "1" {
		for {
			time.Sleep(time.Second)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	cmd := exec.Command(os.Args[0], "-test.run=TestKillOnCloseJobStartsSuspendedAndHonorsCancellation")
	cmd.Env = append(nativeChildEnvironment(), "AIOS_NATIVEAPP_JOB_HELPER=1")
	started := time.Now()
	err := runInKillOnCloseJob(ctx, cmd)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("job returned %v", err)
	}
	if elapsed := time.Since(started); elapsed > 7*time.Second {
		t.Fatalf("job cancellation exceeded bounded grace: %v", elapsed)
	}
}
