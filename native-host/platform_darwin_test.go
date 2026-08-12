//go:build darwin

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDarwinRuntimePlatformUsesUniversalUserScopedLayout(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(t.TempDir(), "AkuBrowser", "host", "AkuBrowserRuntimeHost")
	platform, err := resolveRuntimePlatform(executable)
	if err != nil {
		t.Fatal(err)
	}
	if platform.Architecture != "macos-universal" || platform.RuntimeExecutable != "AkuSidecar" {
		t.Fatalf("platform=%+v", platform)
	}
	if platform.RuntimeRoot != filepath.Join(filepath.Dir(filepath.Dir(executable)), "runtime") {
		t.Fatalf("runtime root=%s", platform.RuntimeRoot)
	}
	if platform.DataRoot != filepath.Join(home, "Library", "Application Support", "AkuBrowser", "data") {
		t.Fatalf("data root=%s", platform.DataRoot)
	}
	if platform.UpdateManifestURL != "https://github.com/abangkis/AkuBrowser/releases/latest/download/AkuSidecarUpdate-macos-universal.json" {
		t.Fatalf("preferred manifest URL=%s", platform.UpdateManifestURL)
	}
	if platform.LegacyUpdateManifestURL != "https://github.com/abangkis/AkuBrowser/releases/latest/download/AkuBrowserRuntimeUpdate-macos-universal.json" {
		t.Fatalf("legacy manifest URL=%s", platform.LegacyUpdateManifestURL)
	}
}
