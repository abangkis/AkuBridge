//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
)

func resolveRuntimePlatform(executablePath string) (RuntimePlatform, error) {
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		return RuntimePlatform{}, errors.New("LOCALAPPDATA is unavailable")
	}
	installRoot := filepath.Dir(filepath.Dir(executablePath))
	return RuntimePlatform{
		Architecture:            legacyWindowsArchitecture,
		RuntimeExecutable:       "AkuSidecar.exe",
		RuntimeRoot:             filepath.Join(installRoot, "runtime"),
		DataRoot:                filepath.Join(localAppData, "AkuBrowser", "data"),
		UpdateManifestURL:       platformUpdateManifestURL(legacyWindowsArchitecture),
		LegacyUpdateManifestURL: legacyPlatformUpdateManifestURL(legacyWindowsArchitecture),
	}, nil
}
