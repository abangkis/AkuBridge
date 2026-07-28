//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

func startDetachedProcess(executablePath, workingDirectory string, arguments ...string) error {
	command := exec.Command(executablePath, arguments...)
	command.Dir = workingDirectory
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}
