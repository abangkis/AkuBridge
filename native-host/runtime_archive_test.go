package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRuntimeArchiveExtractsOnlyDeclaredVerifiedFiles(t *testing.T) {
	archive := filepath.Join(t.TempDir(), "runtime.zip")
	writeRuntimeArchiveForTest(t, archive, map[string][]byte{
		"AkuSidecar.exe":      []byte("signed-sidecar"),
		"config/sidecar.json": []byte(`{"version":1}`),
	})
	candidate := filepath.Join(t.TempDir(), "candidate")
	if err := extractVerifiedRuntimeArchive(archive, candidate, "0.7.8"); err != nil {
		t.Fatalf("extract runtime archive: %v", err)
	}
	if data, err := os.ReadFile(filepath.Join(candidate, "AkuSidecar.exe")); err != nil || string(data) != "signed-sidecar" {
		t.Fatalf("candidate executable=%q err=%v", data, err)
	}
}

func TestRuntimeArchiveRejectsTraversalAndUndeclaredFiles(t *testing.T) {
	for name, files := range map[string]map[string][]byte{
		"traversal": {
			"AkuSidecar.exe":      []byte("sidecar"),
			"config/sidecar.json": []byte(`{"version":1}`),
			"../escape.exe":       []byte("escape"),
		},
		"undeclared": {
			"AkuSidecar.exe":      []byte("sidecar"),
			"config/sidecar.json": []byte(`{"version":1}`),
			"extra.dll":           []byte("extra"),
		},
	} {
		t.Run(name, func(t *testing.T) {
			archive := filepath.Join(t.TempDir(), "runtime.zip")
			writeRuntimeArchiveForTest(t, archive, files)
			if err := extractVerifiedRuntimeArchive(archive, filepath.Join(t.TempDir(), "candidate"), "0.7.8"); err == nil {
				t.Fatal("unsafe archive was accepted")
			}
		})
	}
}

func writeRuntimeArchiveForTest(t *testing.T, archivePath string, files map[string][]byte) {
	t.Helper()
	declared := make([]RuntimePayloadFile, 0, len(files))
	for name, data := range files {
		if strings.HasPrefix(name, "../") || name == "extra.dll" {
			continue
		}
		sum := sha256.Sum256(data)
		declared = append(declared, RuntimePayloadFile{
			Path: name, Size: int64(len(data)), SHA256: hex.EncodeToString(sum[:]),
		})
	}
	manifest, err := json.Marshal(RuntimePayloadManifest{
		SchemaVersion: 1, Product: "AkuBrowser", Version: "0.7.8",
		Architecture: "windows-x64", Files: declared,
	})
	if err != nil {
		t.Fatal(err)
	}
	output, err := os.Create(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(output)
	all := make(map[string][]byte, len(files)+1)
	for name, data := range files {
		all[name] = data
	}
	all["payload-manifest.json"] = manifest
	for name, data := range all {
		entry, createErr := writer.Create(name)
		if createErr != nil {
			t.Fatal(createErr)
		}
		if _, writeErr := entry.Write(data); writeErr != nil {
			t.Fatal(writeErr)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := output.Close(); err != nil {
		t.Fatal(err)
	}
}
