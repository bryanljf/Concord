//go:build !windows

package webmopus

import "os"

// openShared opens a file for reading (renaming or deleting it while open is always allowed
// outside Windows).
func openShared(path string) (*os.File, error) { return os.Open(path) }
