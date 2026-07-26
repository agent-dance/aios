//go:build !windows

package agent

import "os"

func profileEntryHasReparsePoint(os.FileInfo) bool {
	return false
}
