package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const (
	runtimePayloadSchemaVersion = 1
	maxRuntimePayloadFiles      = 512
	maxRuntimePayloadFileBytes  = 256 * 1024 * 1024
)

type RuntimePayloadFile struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type RuntimePayloadManifest struct {
	SchemaVersion int                  `json:"schemaVersion"`
	Product       string               `json:"product"`
	Version       string               `json:"version"`
	Architecture  string               `json:"architecture"`
	Files         []RuntimePayloadFile `json:"files"`
}

func extractVerifiedRuntimeArchive(archivePath, candidateRoot, expectedVersion string, platform ...string) (err error) {
	expectedArchitecture := legacyWindowsArchitecture
	executableName := "AkuSidecar.exe"
	if len(platform) > 0 && platform[0] != "" {
		expectedArchitecture = platform[0]
	}
	if len(platform) > 1 && platform[1] != "" {
		executableName = platform[1]
	}
	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		return fmt.Errorf("open runtime archive: %w", err)
	}
	defer reader.Close()
	if len(reader.File) < 3 || len(reader.File) > maxRuntimePayloadFiles+1 {
		return errors.New("runtime archive file count is invalid")
	}
	entries := make(map[string]*zip.File, len(reader.File))
	var totalUncompressed uint64
	for _, entry := range reader.File {
		name, nameErr := validateArchivePath(entry.Name)
		if nameErr != nil {
			return nameErr
		}
		if entry.FileInfo().IsDir() {
			continue
		}
		if entry.UncompressedSize64 > maxRuntimePayloadFileBytes {
			return fmt.Errorf("runtime archive entry %q is too large", name)
		}
		totalUncompressed += entry.UncompressedSize64
		if totalUncompressed > maxUpdateArtifactBytes {
			return errors.New("runtime archive expanded size exceeds its bound")
		}
		if _, duplicate := entries[name]; duplicate {
			return fmt.Errorf("runtime archive contains duplicate entry %q", name)
		}
		entries[name] = entry
	}
	manifestEntry := entries["payload-manifest.json"]
	if manifestEntry == nil {
		return errors.New("runtime archive payload manifest is missing")
	}
	manifestData, err := readBoundedZipFile(manifestEntry, maxUpdateManifestBytes)
	if err != nil {
		return err
	}
	var manifest RuntimePayloadManifest
	decoder := json.NewDecoder(strings.NewReader(string(manifestData)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return fmt.Errorf("decode runtime payload manifest: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return err
	}
	if manifest.SchemaVersion != runtimePayloadSchemaVersion || manifest.Product != "AkuBrowser" ||
		manifest.Version != expectedVersion || manifest.Architecture != expectedArchitecture ||
		!supportedRuntimeArchitecture(manifest.Architecture) {
		return errors.New("runtime payload identity is invalid")
	}
	if len(manifest.Files) < 2 || len(manifest.Files) > maxRuntimePayloadFiles {
		return errors.New("runtime payload file list is invalid")
	}
	expected := make(map[string]RuntimePayloadFile, len(manifest.Files))
	for _, item := range manifest.Files {
		name, pathErr := validateArchivePath(item.Path)
		if pathErr != nil || name == "payload-manifest.json" || item.Size < 0 ||
			item.Size > maxRuntimePayloadFileBytes || !sha256Pattern.MatchString(item.SHA256) {
			return fmt.Errorf("runtime payload file declaration %q is invalid", item.Path)
		}
		if _, duplicate := expected[name]; duplicate {
			return fmt.Errorf("runtime payload manifest duplicates %q", name)
		}
		expected[name] = item
	}
	for _, required := range []string{executableName, "config/sidecar.json"} {
		if _, ok := expected[required]; !ok {
			return fmt.Errorf("runtime payload is missing %s", required)
		}
	}
	if len(entries) != len(expected)+1 {
		return errors.New("runtime archive contains undeclared files")
	}
	if err := os.Mkdir(candidateRoot, 0o700); err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = os.RemoveAll(candidateRoot)
		}
	}()
	for name, item := range expected {
		entry := entries[name]
		if entry == nil {
			return fmt.Errorf("runtime archive is missing declared file %q", name)
		}
		target := filepath.Join(candidateRoot, filepath.FromSlash(name))
		if err := extractRuntimeFile(entry, target, item); err != nil {
			return err
		}
	}
	if executableName != "AkuSidecar.exe" {
		for _, name := range []string{executableName, "c2patool"} {
			if _, present := expected[name]; !present {
				continue
			}
			if err := os.Chmod(filepath.Join(candidateRoot, name), 0o700); err != nil {
				return fmt.Errorf("make runtime executable %s: %w", name, err)
			}
		}
	}
	return nil
}

func validateArchivePath(name string) (string, error) {
	if name == "" || strings.Contains(name, `\`) || strings.Contains(name, ":") ||
		strings.HasPrefix(name, "/") || filepath.IsAbs(name) {
		return "", fmt.Errorf("runtime archive path %q is invalid", name)
	}
	cleaned := filepath.ToSlash(filepath.Clean(filepath.FromSlash(name)))
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") || cleaned != strings.TrimSuffix(name, "/") {
		return "", fmt.Errorf("runtime archive path %q is invalid", name)
	}
	return cleaned, nil
}

func readBoundedZipFile(entry *zip.File, maximum int64) ([]byte, error) {
	source, err := entry.Open()
	if err != nil {
		return nil, err
	}
	defer source.Close()
	data, err := io.ReadAll(io.LimitReader(source, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maximum {
		return nil, errors.New("runtime archive entry exceeds its bound")
	}
	return data, nil
}

func extractRuntimeFile(entry *zip.File, target string, expected RuntimePayloadFile) error {
	if int64(entry.UncompressedSize64) != expected.Size {
		return fmt.Errorf("runtime payload size differs for %q", expected.Path)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	source, err := entry.Open()
	if err != nil {
		return err
	}
	defer source.Close()
	file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	hash := sha256.New()
	count, copyErr := io.Copy(io.MultiWriter(file, hash), io.LimitReader(source, expected.Size+1))
	closeErr := file.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if count != expected.Size || hex.EncodeToString(hash.Sum(nil)) != expected.SHA256 {
		return fmt.Errorf("runtime payload checksum differs for %q", expected.Path)
	}
	return nil
}
