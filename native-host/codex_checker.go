package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const maxCodexCheckResponseBytes = 16 * 1024

type CodexChecker interface {
	Check(context.Context) (CodexState, *ErrorState)
}

type HTTPReasoningRuntimeChecker struct {
	Endpoint string
	Client   *http.Client
}

type InstalledCodexChecker struct {
	RuntimeRoot       string
	RuntimeExecutable string
	HTTP              HTTPReasoningRuntimeChecker
	RunProbe          func(context.Context, string) ([]byte, error)
}

func (checker InstalledCodexChecker) Check(ctx context.Context) (CodexState, *ErrorState) {
	state, failure := checker.HTTP.Check(ctx)
	if failure == nil || state.Status == "not_found" {
		return state, failure
	}

	active, err := loadActiveRuntimeFile(filepath.Join(checker.RuntimeRoot, "current.json"))
	if err != nil {
		return codexCheckFailure()
	}
	executable := filepath.Join(
		checker.RuntimeRoot,
		"versions",
		active.Version,
		runtimeExecutableOrDefault(checker.RuntimeExecutable),
	)
	info, err := os.Stat(executable)
	if err != nil || !info.Mode().IsRegular() {
		return codexCheckFailure()
	}
	runProbe := checker.RunProbe
	if runProbe == nil {
		runProbe = func(ctx context.Context, executable string) ([]byte, error) {
			return exec.CommandContext(ctx, executable, "--discover-codex").Output()
		}
	}
	payload, runErr := runProbe(ctx, executable)
	if len(payload) == 0 || len(payload) > maxCodexCheckResponseBytes {
		return codexCheckFailure()
	}
	var result struct {
		Status string `json:"status"`
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	if err := decoder.Decode(&result); err != nil || ensureJSONEOF(decoder) != nil {
		return codexCheckFailure()
	}
	switch result.Status {
	case "ok":
		if runErr != nil {
			return codexCheckFailure()
		}
		return CodexState{Status: "available"}, nil
	case "not_found":
		return CodexState{Status: "not_found"}, protocolError(
			"codex_not_found",
			"A compatible Codex App Server installation was not found.",
			false,
			"install_codex",
		)
	default:
		return codexCheckFailure()
	}
}

func (checker HTTPReasoningRuntimeChecker) Check(ctx context.Context) (CodexState, *ErrorState) {
	endpoint := strings.TrimRight(strings.TrimSpace(checker.Endpoint), "/")
	if endpoint == "" {
		endpoint = loopbackEndpoint
	}
	client := checker.Client
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Second}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint+"/api/reasoning/runtime/discover", nil)
	if err != nil {
		return codexCheckFailure()
	}
	request.Header.Set("Accept", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return codexCheckFailure()
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxCodexCheckResponseBytes+1))
	if err != nil || len(payload) > maxCodexCheckResponseBytes {
		return codexCheckFailure()
	}
	if response.StatusCode == http.StatusBadRequest {
		return CodexState{Status: "not_found"}, protocolError(
			"codex_not_found",
			"A compatible Codex App Server installation was not found.",
			false,
			"install_codex",
		)
	}
	if response.StatusCode != http.StatusOK {
		return codexCheckFailure()
	}
	var result struct {
		ReasoningRuntime struct {
			Provider       string `json:"provider"`
			ExecutablePath string `json:"executablePath"`
		} `json:"reasoningRuntime"`
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	if err := decoder.Decode(&result); err != nil ||
		result.ReasoningRuntime.Provider != "codex-app-server" ||
		strings.TrimSpace(result.ReasoningRuntime.ExecutablePath) == "" {
		return codexCheckFailure()
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return codexCheckFailure()
	}
	return CodexState{Status: "available"}, nil
}

func codexCheckFailure() (CodexState, *ErrorState) {
	return CodexState{Status: "error"}, protocolError(
		"codex_check_failed",
		"Codex availability could not be checked through the running AkuBrowser Runtime.",
		true,
		"retry",
	)
}

var _ CodexChecker = HTTPReasoningRuntimeChecker{}
var _ CodexChecker = InstalledCodexChecker{}
