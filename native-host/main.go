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
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		diagnostic.Log("error", "local_app_data_missing", nil)
		response := errorResponse(request, "error", nil, UpdateState{Phase: "idle"}, protocolError(
			"internal_error",
			"AkuBrowser local application data directory is unavailable.",
			false,
			"contact_support",
		))
		if writeErr := writeResponse(stdout, response); writeErr != nil {
			return 7
		}
		return 0
	}
	installRoot := filepath.Dir(filepath.Dir(executablePath))
	controller := RuntimeController{
		RuntimeRoot: filepath.Join(installRoot, "runtime"),
		DataRoot:    filepath.Join(localAppData, "AkuBrowser", "data"),
		Prober:      HTTPHealthProber{},
		Launcher:    OSProcessLauncher{},
	}
	if token, tokenErr := controller.runtimeControlToken(); tokenErr == nil {
		updateControl := HTTPRuntimeUpdateControl{}
		controller.UpdateControl = updateControl
		controller.Updater = SignedRuntimeUpdater{
			RuntimeRoot:  controller.RuntimeRoot,
			DataRoot:     controller.DataRoot,
			PublicKey:    pinnedUpdatePublicKey,
			Transport:    HTTPUpdateTransport{},
			Control:      updateControl,
			Probe:        OSCandidateProbe{},
			Launcher:     controller.Launcher,
			Health:       controller.Prober,
			ControlToken: token,
		}
	} else {
		diagnostic.Log("error", "runtime_control_initialization_failed", nil)
	}
	timeout := 15 * time.Second
	if request.Action == "ensure_runtime" {
		timeout = 3 * time.Minute
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	response := (Host{Controller: controller, Diagnostic: diagnostic}).Handle(ctx, request)
	if err := writeResponse(stdout, response); err != nil {
		diagnostic.Log("error", "response_write_failed", nil)
		return 7
	}
	return 0
}
