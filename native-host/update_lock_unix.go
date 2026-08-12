//go:build darwin || linux

package main

import (
	"errors"
	"os"
	"syscall"
)

func lockUpdateFile(file *os.File) error {
	err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if err == nil {
		return nil
	}
	if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
		return errRuntimeUpdateLocked
	}
	return err
}

func unlockUpdateFile(file *os.File) error {
	return syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
}
