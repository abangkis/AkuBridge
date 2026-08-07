package main

import (
	"context"
	"os"
	"path/filepath"
	"time"
)

func main() {
	os.Exit(run(os.Stdin, os.Stdout, os.Stderr, os.Args))
}

func run(stdin *os.File, stdout *os.File, stderr *os.File, arguments []string) int {
	diagnostic := NewDiagnosticWriter(stderr)
	executablePath, err := os.Executable()
	if err != nil {
		diagnostic.Log("error", "executable_resolution_failed", nil)
		return 2
	}
	manifestPath := filepath.Join(filepath.Dir(executablePath), nativeHostName+".json")
	manifest, err := loadNativeHostManifest(manifestPath, executablePath)
	if err != nil {
		diagnostic.Log("error", "manifest_validation_failed", nil)
		return 3
	}
	if len(arguments) < 2 {
		diagnostic.Log("warn", "origin_missing", nil)
		return 4
	}
	if err := authorizeOrigin(manifest, arguments[1]); err != nil {
		diagnostic.Log("warn", "origin_rejected", nil)
		return 5
	}
	request, err := readRequest(stdin)
	if err != nil {
		diagnostic.Log("warn", "request_read_failed", nil)
		return 6
	}
	platform, err := resolveRuntimePlatform(executablePath)
	if err != nil {
		diagnostic.Log("error", "platform_layout_unavailable", nil)
		response := errorResponse(request, "error", nil, UpdateState{Phase: "idle"}, protocolError(
			"internal_error",
			"AkuBrowser platform storage layout is unavailable.",
			false,
			"contact_support",
		))
		if writeErr := writeResponse(stdout, response); writeErr != nil {
			return 7
		}
		return 0
	}
	controller := RuntimeController{
		RuntimeRoot:       platform.RuntimeRoot,
		DataRoot:          platform.DataRoot,
		RuntimeExecutable: platform.RuntimeExecutable,
		Prober:            HTTPHealthProber{},
		Launcher:          OSProcessLauncher{},
	}
	if token, tokenErr := controller.runtimeControlToken(); tokenErr == nil {
		updateControl := HTTPRuntimeUpdateControl{}
		controller.UpdateControl = updateControl
		controller.Updater = SignedRuntimeUpdater{
			RuntimeRoot:       controller.RuntimeRoot,
			DataRoot:          controller.DataRoot,
			Architecture:      platform.Architecture,
			RuntimeExecutable: platform.RuntimeExecutable,
			ManifestURL:       platform.UpdateManifestURL,
			PublicKey:         pinnedUpdatePublicKey,
			Transport:         HTTPUpdateTransport{},
			Control:           updateControl,
			Probe:             OSCandidateProbe{},
			Launcher:          controller.Launcher,
			Health:            controller.Prober,
			ControlToken:      token,
		}
	} else {
		diagnostic.Log("error", "runtime_control_initialization_failed", nil)
	}
	timeout := 15 * time.Second
	if request.Action == "ensure_runtime" {
		timeout = 3 * time.Minute
	} else if request.Action == "check_codex" {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	response := (Host{
		Controller: controller,
		CodexChecker: InstalledCodexChecker{
			RuntimeRoot:       controller.RuntimeRoot,
			RuntimeExecutable: controller.RuntimeExecutable,
		},
		Diagnostic: diagnostic,
	}).Handle(ctx, request)
	if err := writeResponse(stdout, response); err != nil {
		diagnostic.Log("error", "response_write_failed", nil)
		return 7
	}
	return 0
}
