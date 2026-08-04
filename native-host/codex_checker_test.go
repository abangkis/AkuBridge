package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCodexCheckerAcceptsValidatedReasoningRuntimeWithoutExposingItsPath(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/reasoning/runtime/discover" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"reasoningRuntime":{"provider":"codex-app-server","label":"Codex executable","executablePath":"C:\\private\\codex.exe","editable":true}}`)
	}))
	defer server.Close()

	state, failure := (HTTPReasoningRuntimeChecker{Endpoint: server.URL}).Check(context.Background())

	if failure != nil || state.Status != "available" {
		t.Fatalf("Codex was not accepted: state=%+v error=%+v", state, failure)
	}
	if strings.Contains(fmt.Sprintf("%+v", state), "private") {
		t.Fatal("Codex executable path escaped the native host boundary")
	}
}

func TestCodexCheckerMapsDiscoveryMissToInstallGuidance(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"not found"}`, http.StatusBadRequest)
	}))
	defer server.Close()

	state, failure := (HTTPReasoningRuntimeChecker{Endpoint: server.URL}).Check(context.Background())

	if state.Status != "not_found" || failure == nil || failure.Code != "codex_not_found" || failure.Remediation != "install_codex" {
		t.Fatalf("missing Codex result is unclear: state=%+v error=%+v", state, failure)
	}
}

func TestInstalledCodexCheckerUsesThePackagedProbeWhenRuntimeIsStopped(t *testing.T) {
	runtimeRoot := writeActiveRuntime(t, activeFixture())
	executable := filepath.Join(runtimeRoot, "versions", activeFixture().Version, "AkuSidecar.exe")
	if err := os.MkdirAll(filepath.Dir(executable), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(executable, []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	checker := InstalledCodexChecker{
		RuntimeRoot: runtimeRoot,
		HTTP: HTTPReasoningRuntimeChecker{
			Endpoint: "http://127.0.0.1:1",
			Client:   &http.Client{Timeout: 10 * time.Millisecond},
		},
		RunProbe: func(_ context.Context, received string) ([]byte, error) {
			if received != executable {
				t.Fatalf("unexpected packaged probe path: %s", received)
			}
			return json.Marshal(map[string]any{
				"status":     "ok",
				"executable": `C:\private\codex.exe`,
			})
		},
	}

	state, failure := checker.Check(context.Background())

	if failure != nil || state.Status != "available" {
		t.Fatalf("packaged Codex probe failed: state=%+v error=%+v", state, failure)
	}
}
