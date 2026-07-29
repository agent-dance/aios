package nativeapp

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/buthim/alsniper-os/sidecar/internal/protocol"
)

var (
	ErrUnsupported         = errors.New("native applications are unsupported on this platform")
	ErrBusy                = errors.New("a native application operation is already running")
	ErrNotInstalled        = errors.New("the native application is not installed")
	ErrInvalidInstallation = errors.New("the native application installation is not trusted")
	ErrStatusFailed        = errors.New("native application status failed")
	ErrInstallFailed       = errors.New("native application installation failed")
	ErrLaunchFailed        = errors.New("native application launch failed")
)

type Discovery struct {
	Platform          string
	State             string
	Installed         bool
	Launchable        bool
	PublisherVerified bool
	Version           string
}

type InstallMode uint8

const (
	InstallModeFresh InstallMode = iota + 1
	InstallModeRepair
)

type Platform interface {
	Discover(context.Context) (Discovery, error)
	Install(context.Context, InstallMode) error
	Launch(context.Context) (Discovery, error)
}

type Service struct {
	platform      Platform
	operationSlot chan struct{}
	receipt       func() (string, error)
}

func NewService(platform Platform) (*Service, error) {
	if platform == nil {
		return nil, errors.New("native app platform is required")
	}
	return &Service{
		platform:      platform,
		operationSlot: make(chan struct{}, 1),
		receipt:       newReceiptID,
	}, nil
}

func (s *Service) Status(ctx context.Context) (protocol.NativeAppStatusResponse, error) {
	if !s.acquire() {
		return protocol.NativeAppStatusResponse{}, ErrBusy
	}
	defer s.release()
	discovery, err := s.platform.Discover(ctx)
	if err != nil {
		return protocol.NativeAppStatusResponse{}, fmt.Errorf("%w: %w", ErrStatusFailed, err)
	}
	if err := validateDiscovery(discovery); err != nil {
		return protocol.NativeAppStatusResponse{}, fmt.Errorf("%w: invalid platform result", ErrStatusFailed)
	}
	response := statusResponse(discovery)
	return response, nil
}

func (s *Service) Install(ctx context.Context, request protocol.NativeAppInstallRequest) (protocol.NativeAppOperationResponse, error) {
	if err := request.Validate(); err != nil {
		return protocol.NativeAppOperationResponse{}, fmt.Errorf("invalid install request: %w", err)
	}
	if !s.acquire() {
		return protocol.NativeAppOperationResponse{}, ErrBusy
	}
	defer s.release()

	discovery, err := s.platform.Discover(ctx)
	if err != nil {
		return protocol.NativeAppOperationResponse{}, fmt.Errorf("%w: %w", ErrStatusFailed, err)
	}
	if err := validateDiscovery(discovery); err != nil {
		return protocol.NativeAppOperationResponse{}, fmt.Errorf("%w: invalid platform result", ErrStatusFailed)
	}
	mode := InstallModeFresh
	switch discovery.State {
	case "unsupported":
		return protocol.NativeAppOperationResponse{}, ErrUnsupported
	case "invalid":
		mode = InstallModeRepair
	case "installed":
		return s.operationResponse(request.RequestID, "install", "already-installed", false, discovery)
	case "not-installed":
	default:
		return protocol.NativeAppOperationResponse{}, fmt.Errorf("%w: invalid platform state", ErrStatusFailed)
	}

	installErr := s.platform.Install(ctx, mode)
	if installErr != nil && (errors.Is(installErr, context.Canceled) || errors.Is(installErr, context.DeadlineExceeded)) {
		return protocol.NativeAppOperationResponse{}, fmt.Errorf("%w: %w", ErrInstallFailed, installErr)
	}
	discovery, err = s.platform.Discover(ctx)
	if err != nil {
		if installErr != nil {
			return protocol.NativeAppOperationResponse{}, fmt.Errorf("%w: %w", ErrInstallFailed, installErr)
		}
		return protocol.NativeAppOperationResponse{}, fmt.Errorf("%w: post-install discovery failed: %w", ErrInstallFailed, err)
	}
	if err := validateDiscovery(discovery); err != nil {
		return protocol.NativeAppOperationResponse{}, fmt.Errorf("%w: invalid post-install platform result", ErrInstallFailed)
	}
	if discovery.State == "installed" {
		return s.operationResponse(request.RequestID, "install", "installed", true, discovery)
	}
	if installErr != nil {
		return protocol.NativeAppOperationResponse{}, fmt.Errorf("%w: %w", ErrInstallFailed, installErr)
	}
	if discovery.State == "invalid" {
		return protocol.NativeAppOperationResponse{}, ErrInvalidInstallation
	}
	return protocol.NativeAppOperationResponse{}, fmt.Errorf("%w: trusted installation was not discovered", ErrInstallFailed)
}

func (s *Service) Launch(ctx context.Context, request protocol.NativeAppLaunchRequest) (protocol.NativeAppOperationResponse, error) {
	if err := request.Validate(); err != nil {
		return protocol.NativeAppOperationResponse{}, fmt.Errorf("invalid launch request: %w", err)
	}
	if !s.acquire() {
		return protocol.NativeAppOperationResponse{}, ErrBusy
	}
	defer s.release()

	discovery, err := s.platform.Launch(ctx)
	if err != nil {
		if errors.Is(err, ErrUnsupported) || errors.Is(err, ErrNotInstalled) || errors.Is(err, ErrInvalidInstallation) {
			return protocol.NativeAppOperationResponse{}, err
		}
		return protocol.NativeAppOperationResponse{}, fmt.Errorf("%w: %w", ErrLaunchFailed, err)
	}
	if err := validateDiscovery(discovery); err != nil {
		return protocol.NativeAppOperationResponse{}, fmt.Errorf("%w: invalid platform result", ErrLaunchFailed)
	}
	if discovery.State != "installed" {
		return protocol.NativeAppOperationResponse{}, fmt.Errorf("%w: platform returned a non-installed state", ErrLaunchFailed)
	}
	return s.operationResponse(request.RequestID, "launch", "launched", false, discovery)
}

func (s *Service) operationResponse(requestID, operation, code string, changed bool, discovery Discovery) (protocol.NativeAppOperationResponse, error) {
	receiptID, err := s.receipt()
	if err != nil {
		return protocol.NativeAppOperationResponse{}, fmt.Errorf("create operation receipt: %w", err)
	}
	response := protocol.NativeAppOperationResponse{
		ProtocolVersion:   protocol.Version,
		RequestID:         requestID,
		AppID:             "wechat",
		Operation:         operation,
		Code:              code,
		Changed:           changed,
		Installed:         discovery.Installed,
		Launchable:        discovery.Launchable,
		PublisherVerified: discovery.PublisherVerified,
		Version:           discovery.Version,
		ReceiptID:         receiptID,
	}
	if err := response.Validate(); err != nil {
		return protocol.NativeAppOperationResponse{}, fmt.Errorf("invalid native app operation response: %w", err)
	}
	return response, nil
}

func (s *Service) acquire() bool {
	select {
	case s.operationSlot <- struct{}{}:
		return true
	default:
		return false
	}
}

func (s *Service) release() { <-s.operationSlot }

func statusResponse(discovery Discovery) protocol.NativeAppStatusResponse {
	response := protocol.NativeAppStatusResponse{
		ProtocolVersion: protocol.Version,
		AppID:           "wechat",
		Platform:        discovery.Platform,
		State:           discovery.State,
	}
	if discovery.State == "installed" {
		response.Installed = discovery.Installed
		response.Launchable = discovery.Launchable
		response.PublisherVerified = discovery.PublisherVerified
		response.Version = discovery.Version
	}
	return response
}

func validateDiscovery(discovery Discovery) error {
	if discovery.State != "installed" && (discovery.Installed || discovery.Launchable || discovery.PublisherVerified || discovery.Version != "") {
		return errors.New("unavailable discovery contains trusted installation fields")
	}
	return statusResponse(discovery).Validate()
}

func newReceiptID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return "native-" + hex.EncodeToString(value[:]), nil
}
