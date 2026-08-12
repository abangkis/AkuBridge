//go:build darwin

package main

import (
	"os"
	"path/filepath"
)

func resolveRuntimePlatform(executablePath string) (RuntimePlatform, error) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return RuntimePlatform{}, err
	}
	installRoot := filepath.Dir(filepath.Dir(executablePath))
	architecture := "macos-universal"
	return RuntimePlatform{
		Architecture:            architecture,
		RuntimeExecutable:       "AkuSidecar",
		RuntimeRoot:             filepath.Join(installRoot, "runtime"),
		DataRoot:                filepath.Join(home, "Library", "Application Support", "AkuBrowser", "data"),
		UpdateManifestURL:       platformUpdateManifestURL(architecture),
		LegacyUpdateManifestURL: legacyPlatformUpdateManifestURL(architecture),
	}, nil
}
