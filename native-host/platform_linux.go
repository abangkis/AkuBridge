//go:build linux

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

func resolveRuntimePlatform(executablePath string) (RuntimePlatform, error) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return RuntimePlatform{}, err
	}
	dataHome := os.Getenv("XDG_DATA_HOME")
	if dataHome == "" {
		dataHome = filepath.Join(home, ".local", "share")
	}
	architecture := ""
	switch runtime.GOARCH {
	case "amd64":
		architecture = "linux-x64"
	case "arm64":
		architecture = "linux-arm64"
	default:
		return RuntimePlatform{}, fmt.Errorf("unsupported Linux architecture: %s", runtime.GOARCH)
	}
	installRoot := filepath.Dir(filepath.Dir(executablePath))
	return RuntimePlatform{
		Architecture:            architecture,
		RuntimeExecutable:       "AkuSidecar",
		RuntimeRoot:             filepath.Join(installRoot, "runtime"),
		DataRoot:                filepath.Join(dataHome, "AkuBrowser", "data"),
		UpdateManifestURL:       platformUpdateManifestURL(architecture),
		LegacyUpdateManifestURL: legacyPlatformUpdateManifestURL(architecture),
	}, nil
}
