//go:build windows

package nativeapp

import (
	"syscall"

	"golang.org/x/sys/windows"
)

var (
	wintrustHelperDLL                = windows.NewLazySystemDLL("wintrust.dll")
	procHelperProvDataFromStateData  = wintrustHelperDLL.NewProc("WTHelperProvDataFromStateData")
	procHelperGetProvSignerFromChain = wintrustHelperDLL.NewProc("WTHelperGetProvSignerFromChain")
	procHelperGetProvCertFromChain   = wintrustHelperDLL.NewProc("WTHelperGetProvCertFromChain")
)

func wTHelperProvDataFromStateData(stateData uintptr) uintptr {
	result, _, _ := syscall.SyscallN(procHelperProvDataFromStateData.Addr(), stateData)
	return result
}

func wTHelperGetProvSignerFromChain(providerData uintptr, signerIndex uint32, counterSigner bool, counterSignerIndex uint32) uintptr {
	counterSignerValue := uintptr(0)
	if counterSigner {
		counterSignerValue = 1
	}
	result, _, _ := syscall.SyscallN(
		procHelperGetProvSignerFromChain.Addr(), providerData, uintptr(signerIndex), counterSignerValue, uintptr(counterSignerIndex),
	)
	return result
}

func wTHelperGetProvCertFromChain(signer uintptr, certificateIndex uint32) uintptr {
	result, _, _ := syscall.SyscallN(procHelperGetProvCertFromChain.Addr(), signer, uintptr(certificateIndex))
	return result
}
