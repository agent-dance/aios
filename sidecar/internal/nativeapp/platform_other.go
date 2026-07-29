//go:build !windows

package nativeapp

import "context"

type unsupportedPlatform struct{}

func NewPlatform() Platform { return unsupportedPlatform{} }

func (unsupportedPlatform) Discover(context.Context) (Discovery, error) {
	return Discovery{Platform: "unsupported", State: "unsupported"}, nil
}

func (unsupportedPlatform) Install(context.Context, InstallMode) error { return ErrUnsupported }

func (unsupportedPlatform) Launch(context.Context) (Discovery, error) {
	return Discovery{}, ErrUnsupported
}
