package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testExtensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"

func TestManifestAllowsOnlyExactConfiguredOrigin(t *testing.T) {
	executablePath := filepath.Join(t.TempDir(), "AkuBrowserRuntimeHost.exe")
	manifestPath := writeManifest(t, executablePath, []string{testExtensionOrigin}, nil)

	manifest, err := loadNativeHostManifest(manifestPath, executablePath)
	if err != nil {
		t.Fatalf("load manifest: %v", err)
	}
	if err := authorizeOrigin(manifest, testExtensionOrigin); err != nil {
		t.Fatalf("authorize exact origin: %v", err)
	}
	if err := authorizeOrigin(manifest, strings.TrimSuffix(testExtensionOrigin, "/")); err != nil {
		t.Fatalf("authorize Chrome caller origin without trailing slash: %v", err)
	}
	for _, origin := range []string{
		"chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
		"https://example.com/",
	} {
		if err := authorizeOrigin(manifest, origin); err == nil {
			t.Fatalf("unauthorized origin accepted: %s", origin)
		}
	}
}

func TestManifestRejectsWildcardPathMismatchAndUnknownFields(t *testing.T) {
	executablePath := filepath.Join(t.TempDir(), "AkuBrowserRuntimeHost.exe")
	tests := []struct {
		name    string
		origins []string
		extra   map[string]any
		path    string
	}{
		{name: "wildcard", origins: []string{"chrome-extension://*/"}},
		{name: "path mismatch", origins: []string{testExtensionOrigin}, path: executablePath + ".other"},
		{name: "unknown field", origins: []string{testExtensionOrigin}, extra: map[string]any{"command": "cmd.exe"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := test.path
			if path == "" {
				path = executablePath
			}
			manifestPath := writeManifest(t, path, test.origins, test.extra)
			if _, err := loadNativeHostManifest(manifestPath, executablePath); err == nil {
				t.Fatal("invalid native host manifest was accepted")
			}
		})
	}
}

func writeManifest(t *testing.T, executablePath string, origins []string, extra map[string]any) string {
	t.Helper()
	value := map[string]any{
		"name":            nativeHostName,
		"description":     "AkuBrowser Runtime Host",
		"path":            executablePath,
		"type":            "stdio",
		"allowed_origins": origins,
	}
	for key, item := range extra {
		value[key] = item
	}
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(t.TempDir(), nativeHostName+".json")
	if err := os.WriteFile(manifestPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return manifestPath
}
