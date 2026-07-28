package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

const nativeHostName = "com.akubrowser.runtime"

var (
	manifestOriginPattern = regexp.MustCompile(`^chrome-extension://[a-p]{32}/$`)
	callerOriginPattern   = regexp.MustCompile(`^chrome-extension://[a-p]{32}/?$`)
)

type NativeHostManifest struct {
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	Path           string   `json:"path"`
	Type           string   `json:"type"`
	AllowedOrigins []string `json:"allowed_origins"`
}

func loadNativeHostManifest(path, executablePath string) (NativeHostManifest, error) {
	data, err := readBoundedFile(path, 64*1024)
	if err != nil {
		return NativeHostManifest{}, fmt.Errorf("read native host manifest: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var manifest NativeHostManifest
	if err := decoder.Decode(&manifest); err != nil {
		return NativeHostManifest{}, fmt.Errorf("decode native host manifest: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return NativeHostManifest{}, err
	}
	if manifest.Name != nativeHostName {
		return NativeHostManifest{}, errors.New("native host manifest name is invalid")
	}
	if manifest.Type != "stdio" {
		return NativeHostManifest{}, errors.New("native host manifest type must be stdio")
	}
	if manifest.Description == "" {
		return NativeHostManifest{}, errors.New("native host manifest description is required")
	}
	if len(manifest.AllowedOrigins) == 0 {
		return NativeHostManifest{}, errors.New("native host manifest must allow at least one exact extension origin")
	}
	seen := make(map[string]struct{}, len(manifest.AllowedOrigins))
	for _, origin := range manifest.AllowedOrigins {
		if strings.Contains(origin, "*") || !manifestOriginPattern.MatchString(origin) {
			return NativeHostManifest{}, fmt.Errorf("native host manifest origin %q is not exact", origin)
		}
		if _, duplicate := seen[origin]; duplicate {
			return NativeHostManifest{}, fmt.Errorf("native host manifest origin %q is duplicated", origin)
		}
		seen[origin] = struct{}{}
	}
	manifestExecutable, err := filepath.Abs(manifest.Path)
	if err != nil {
		return NativeHostManifest{}, fmt.Errorf("resolve manifest executable path: %w", err)
	}
	actualExecutable, err := filepath.Abs(executablePath)
	if err != nil {
		return NativeHostManifest{}, fmt.Errorf("resolve native host executable path: %w", err)
	}
	if !strings.EqualFold(filepath.Clean(manifestExecutable), filepath.Clean(actualExecutable)) {
		return NativeHostManifest{}, errors.New("native host manifest path does not match the running executable")
	}
	return manifest, nil
}

func authorizeOrigin(manifest NativeHostManifest, origin string) error {
	if !callerOriginPattern.MatchString(origin) {
		return errors.New("caller origin is not a Chrome extension origin")
	}
	canonicalOrigin := strings.TrimSuffix(origin, "/") + "/"
	for _, allowed := range manifest.AllowedOrigins {
		if canonicalOrigin == allowed {
			return nil
		}
	}
	return errors.New("caller extension origin is not allowlisted")
}
