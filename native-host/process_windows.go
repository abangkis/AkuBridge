//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

const (
	detachedProcess       = 0x00000008
	createNewProcessGroup = 0x00000200
)

func startDetachedProcess(executablePath, workingDirectory string, arguments ...string) error {
	command := exec.Command(executablePath, arguments...)
	command.Dir = workingDirectory
	command.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: detachedProcess | createNewProcessGroup,
	}
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}
