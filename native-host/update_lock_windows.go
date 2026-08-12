//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

const (
	lockFileFailImmediately = 0x00000001
	lockFileExclusiveLock   = 0x00000002
	errorLockViolation      = syscall.Errno(33)
)

var (
	updateLockFileEx   = syscall.NewLazyDLL("kernel32.dll").NewProc("LockFileEx")
	updateUnlockFileEx = syscall.NewLazyDLL("kernel32.dll").NewProc("UnlockFileEx")
)

func lockUpdateFile(file *os.File) error {
	var overlapped syscall.Overlapped
	result, _, callErr := updateLockFileEx.Call(
		file.Fd(),
		lockFileExclusiveLock|lockFileFailImmediately,
		0,
		1,
		0,
		uintptr(unsafe.Pointer(&overlapped)),
	)
	if result != 0 {
		return nil
	}
	if errors.Is(callErr, errorLockViolation) {
		return errRuntimeUpdateLocked
	}
	return fmt.Errorf("lock Sidecar update file: %w", callErr)
}

func unlockUpdateFile(file *os.File) error {
	var overlapped syscall.Overlapped
	result, _, callErr := updateUnlockFileEx.Call(
		file.Fd(),
		0,
		1,
		0,
		uintptr(unsafe.Pointer(&overlapped)),
	)
	if result == 0 {
		return fmt.Errorf("unlock Sidecar update file: %w", callErr)
	}
	return nil
}
