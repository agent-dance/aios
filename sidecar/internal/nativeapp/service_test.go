package nativeapp

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/buthim/alsniper-os/sidecar/internal/protocol"
)

type fakePlatform struct {
	mu             sync.Mutex
	discoveries    []Discovery
	discoverErr    error
	installErr     error
	postInstallErr error
	launchValue    Discovery
	launchErr      error
	installGate    chan struct{}
	installCalls   int
	installModes   []InstallMode
	launchCalls    int
}

func (f *fakePlatform) Discover(context.Context) (Discovery, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.discoverErr != nil {
		return Discovery{}, f.discoverErr
	}
	if len(f.discoveries) == 0 {
		return Discovery{Platform: "windows", State: "not-installed"}, nil
	}
	value := f.discoveries[0]
	if len(f.discoveries) > 1 {
		f.discoveries = f.discoveries[1:]
	}
	return value, nil
}

func (f *fakePlatform) Install(_ context.Context, mode InstallMode) error {
	f.mu.Lock()
	f.installCalls++
	f.installModes = append(f.installModes, mode)
	gate, err := f.installGate, f.installErr
	if f.postInstallErr != nil {
		f.discoverErr = f.postInstallErr
	}
	f.mu.Unlock()
	if gate != nil {
		<-gate
	}
	return err
}

func (f *fakePlatform) Launch(context.Context) (Discovery, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.launchCalls++
	return f.launchValue, f.launchErr
}

func installed(version string) Discovery {
	return Discovery{
		Platform: "windows", State: "installed", Version: version,
		Installed: true, Launchable: true, PublisherVerified: true,
	}
}

func testService(t *testing.T, platform Platform) *Service {
	t.Helper()
	service, err := NewService(platform)
	if err != nil {
		t.Fatal(err)
	}
	service.receipt = func() (string, error) { return "native-00112233445566778899aabbccddeeff", nil }
	return service
}

func TestStatusPreservesClosedTrustStates(t *testing.T) {
	tests := []struct {
		name      string
		discovery Discovery
		wantState string
		installed bool
	}{
		{"installed", installed("4.1.12.26"), "installed", true},
		{"not installed", Discovery{Platform: "windows", State: "not-installed"}, "not-installed", false},
		{"invalid", Discovery{Platform: "windows", State: "invalid"}, "invalid", false},
		{"unsupported", Discovery{Platform: "unsupported", State: "unsupported"}, "unsupported", false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := testService(t, &fakePlatform{discoveries: []Discovery{test.discovery}})
			response, err := service.Status(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if response.State != test.wantState || response.Installed != test.installed || response.Launchable != test.installed || response.PublisherVerified != test.installed {
				t.Fatalf("unexpected response: %+v", response)
			}
			if test.installed != (response.Version != "") {
				t.Fatalf("unexpected version presence: %+v", response)
			}
		})
	}
}

func TestStatusRejectsInconsistentRawDiscovery(t *testing.T) {
	service := testService(t, &fakePlatform{discoveries: []Discovery{{
		Platform: "windows", State: "not-installed", Installed: true, Version: "untrusted",
	}}})
	if _, err := service.Status(context.Background()); !errors.Is(err, ErrStatusFailed) {
		t.Fatalf("inconsistent platform contract returned %v", err)
	}
}

func TestInstallIsIdempotentAndReverifiesAfterWinget(t *testing.T) {
	request := protocol.NativeAppInstallRequest{RequestID: "request-1", AcceptedTerms: true}
	alreadyPlatform := &fakePlatform{discoveries: []Discovery{installed("4.1.12.26")}}
	response, err := testService(t, alreadyPlatform).Install(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if response.Code != "already-installed" || response.Changed || alreadyPlatform.installCalls != 0 {
		t.Fatalf("idempotent install failed: response=%+v calls=%d", response, alreadyPlatform.installCalls)
	}

	newPlatform := &fakePlatform{discoveries: []Discovery{{Platform: "windows", State: "not-installed"}, installed("4.1.12.26")}}
	response, err = testService(t, newPlatform).Install(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if response.Code != "installed" || !response.Changed || response.Version != "4.1.12.26" || newPlatform.installCalls != 1 ||
		len(newPlatform.installModes) != 1 || newPlatform.installModes[0] != InstallModeFresh {
		t.Fatalf("new install failed: response=%+v calls=%d modes=%v", response, newPlatform.installCalls, newPlatform.installModes)
	}

	reconciledPlatform := &fakePlatform{
		discoveries: []Discovery{{Platform: "windows", State: "not-installed"}, installed("4.1.12.26")},
		installErr:  errors.New("non-zero exit after external completion"),
	}
	response, err = testService(t, reconciledPlatform).Install(context.Background(), request)
	if err != nil || response.Code != "installed" || !response.Changed {
		t.Fatalf("trusted postcondition did not reconcile install exit: response=%+v err=%v", response, err)
	}
}

func TestInvalidInstallationUsesClosedRepairModeAndMustReverify(t *testing.T) {
	request := protocol.NativeAppInstallRequest{RequestID: "request-repair", AcceptedTerms: true}
	platform := &fakePlatform{discoveries: []Discovery{{Platform: "windows", State: "invalid"}, installed("4.1.12.26")}}
	response, err := testService(t, platform).Install(context.Background(), request)
	if err != nil || response.Code != "installed" || !response.Changed || len(platform.installModes) != 1 || platform.installModes[0] != InstallModeRepair {
		t.Fatalf("repair did not restore a trusted install: response=%+v modes=%v err=%v", response, platform.installModes, err)
	}
	reconciled := &fakePlatform{
		discoveries: []Discovery{{Platform: "windows", State: "invalid"}, installed("4.1.12.26")},
		installErr:  errors.New("non-zero exit after repair completion"),
	}
	response, err = testService(t, reconciled).Install(context.Background(), request)
	if err != nil || response.Code != "installed" || len(reconciled.installModes) != 1 || reconciled.installModes[0] != InstallModeRepair {
		t.Fatalf("trusted repair postcondition did not reconcile installer exit: response=%+v modes=%v err=%v", response, reconciled.installModes, err)
	}

	tests := []struct {
		name       string
		post       Discovery
		installErr error
		want       error
	}{
		{"still invalid", Discovery{Platform: "windows", State: "invalid"}, nil, ErrInvalidInstallation},
		{"repair command failed", Discovery{Platform: "windows", State: "invalid"}, errors.New("winget failed"), ErrInstallFailed},
		{"installation disappeared", Discovery{Platform: "windows", State: "not-installed"}, nil, ErrInstallFailed},
		{"repair cancelled", Discovery{Platform: "windows", State: "invalid"}, context.Canceled, context.Canceled},
		{"repair timed out", Discovery{Platform: "windows", State: "invalid"}, context.DeadlineExceeded, context.DeadlineExceeded},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			platform := &fakePlatform{
				discoveries: []Discovery{{Platform: "windows", State: "invalid"}, test.post},
				installErr:  test.installErr,
			}
			_, err := testService(t, platform).Install(context.Background(), request)
			if !errors.Is(err, test.want) {
				t.Fatalf("repair returned %v, want %v", err, test.want)
			}
			if len(platform.installModes) != 1 || platform.installModes[0] != InstallModeRepair {
				t.Fatalf("invalid installation did not use repair mode: %v", platform.installModes)
			}
		})
	}
}

func TestInstallFailsClosedForInvalidOrUnverifiedResult(t *testing.T) {
	request := protocol.NativeAppInstallRequest{RequestID: "request-1", AcceptedTerms: true}
	tests := []struct {
		name     string
		platform *fakePlatform
		want     error
	}{
		{"preexisting invalid", &fakePlatform{discoveries: []Discovery{{Platform: "windows", State: "invalid"}}}, ErrInvalidInstallation},
		{"post install missing", &fakePlatform{discoveries: []Discovery{{Platform: "windows", State: "not-installed"}, {Platform: "windows", State: "not-installed"}}}, ErrInstallFailed},
		{"post install invalid", &fakePlatform{discoveries: []Discovery{{Platform: "windows", State: "not-installed"}, {Platform: "windows", State: "invalid"}}}, ErrInvalidInstallation},
		{"unverified installed contract", &fakePlatform{discoveries: []Discovery{{Platform: "windows", State: "installed", Version: "4.1.12.26"}}}, ErrStatusFailed},
		{"inconsistent unavailable contract", &fakePlatform{discoveries: []Discovery{{Platform: "windows", State: "not-installed", Installed: true, Version: "4.1.12.26"}}}, ErrStatusFailed},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := testService(t, test.platform).Install(context.Background(), request)
			if !errors.Is(err, test.want) {
				t.Fatalf("got %v, want %v", err, test.want)
			}
		})
	}
}

func TestPostInstallDiscoveryPreservesCancellationCause(t *testing.T) {
	for _, cause := range []error{context.DeadlineExceeded, context.Canceled} {
		platform := &fakePlatform{
			discoveries:    []Discovery{{Platform: "windows", State: "not-installed"}},
			postInstallErr: cause,
		}
		_, err := testService(t, platform).Install(context.Background(), protocol.NativeAppInstallRequest{RequestID: "request-1", AcceptedTerms: true})
		if !errors.Is(err, cause) || !errors.Is(err, ErrInstallFailed) {
			t.Fatalf("post-install error lost classification for %v: %v", cause, err)
		}
	}
}

func TestLaunchUsesOnlyPlatformVerifiedResult(t *testing.T) {
	platform := &fakePlatform{launchValue: installed("4.1.12.26")}
	response, err := testService(t, platform).Launch(context.Background(), protocol.NativeAppLaunchRequest{RequestID: "request-2"})
	if err != nil {
		t.Fatal(err)
	}
	if response.Code != "launched" || response.Changed || platform.launchCalls != 1 || response.ReceiptID == "" {
		t.Fatalf("unexpected launch: %+v calls=%d", response, platform.launchCalls)
	}

	platform = &fakePlatform{launchErr: ErrInvalidInstallation}
	_, err = testService(t, platform).Launch(context.Background(), protocol.NativeAppLaunchRequest{RequestID: "request-2"})
	if !errors.Is(err, ErrInvalidInstallation) {
		t.Fatalf("untrusted launch returned %v", err)
	}
}

func TestMutatingOperationsAreSingleFlight(t *testing.T) {
	gate := make(chan struct{})
	platform := &fakePlatform{
		discoveries: []Discovery{{Platform: "windows", State: "not-installed"}},
		installGate: gate,
	}
	service := testService(t, platform)
	done := make(chan error, 1)
	go func() {
		_, err := service.Install(context.Background(), protocol.NativeAppInstallRequest{RequestID: "request-1", AcceptedTerms: true})
		done <- err
	}()
	for {
		platform.mu.Lock()
		started := platform.installCalls == 1
		platform.mu.Unlock()
		if started {
			break
		}
	}
	_, err := service.Launch(context.Background(), protocol.NativeAppLaunchRequest{RequestID: "request-2"})
	if !errors.Is(err, ErrBusy) {
		t.Fatalf("concurrent operation returned %v", err)
	}
	if _, err := service.Status(context.Background()); !errors.Is(err, ErrBusy) {
		t.Fatalf("concurrent status returned %v", err)
	}
	close(gate)
	if err := <-done; !errors.Is(err, ErrInstallFailed) {
		t.Fatalf("install result after release: %v", err)
	}
}

func TestServiceRejectsInvalidRequestsWithoutPlatformCalls(t *testing.T) {
	platform := &fakePlatform{}
	service := testService(t, platform)
	if _, err := service.Install(context.Background(), protocol.NativeAppInstallRequest{RequestID: "request-1"}); err == nil {
		t.Fatal("install accepted missing terms")
	}
	if _, err := service.Launch(context.Background(), protocol.NativeAppLaunchRequest{}); err == nil {
		t.Fatal("launch accepted missing request id")
	}
	if platform.installCalls != 0 || platform.launchCalls != 0 {
		t.Fatal("invalid request reached the native platform")
	}
}
