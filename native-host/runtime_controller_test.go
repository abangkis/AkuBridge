package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStatusReportsCompatibleRunningRuntime(t *testing.T) {
	root := writeActiveRuntime(t, activeFixture())
	prober := &sequenceProber{results: []probeStep{{result: readyProbe()}}}
	launcher := &recordingLauncher{}
	controller := testController(root, prober, launcher)

	outcome := controller.Status(context.Background(), validRequest("status").Extension)

	if outcome.Status != "ready" || outcome.Runtime == nil || outcome.Runtime.ProcessState != "ready" {
		t.Fatalf("unexpected status outcome: %#v", outcome)
	}
	if launcher.calls != 0 {
		t.Fatal("status launched a process")
	}
}

func TestEnsureStartsFixedInstalledSidecarAndWaitsForHealth(t *testing.T) {
	active := activeFixture()
	root := writeActiveRuntime(t, active)
	prober := &sequenceProber{results: []probeStep{
		{result: ProbeResult{Reachable: false}},
		{result: ProbeResult{Reachable: false}},
		{result: readyProbe()},
	}}
	launcher := &recordingLauncher{}
	controller := testController(root, prober, launcher)

	outcome := controller.Ensure(context.Background(), validRequest("ensure_runtime").Extension)

	if outcome.Status != "ready" {
		t.Fatalf("runtime did not become ready: %#v", outcome)
	}
	if launcher.calls != 1 {
		t.Fatalf("expected one launch, got %d", launcher.calls)
	}
	expectedDirectory := filepath.Join(root, "versions", active.Version)
	if launcher.executable != filepath.Join(expectedDirectory, "AkuSidecar.exe") {
		t.Fatalf("unexpected executable path: %s", launcher.executable)
	}
	if launcher.workingDirectory != expectedDirectory {
		t.Fatalf("unexpected working directory: %s", launcher.workingDirectory)
	}
	if launcher.config != filepath.Join(expectedDirectory, "config", "sidecar.json") {
		t.Fatalf("unexpected config path: %s", launcher.config)
	}
	if launcher.database != filepath.Join(controller.DataRoot, "aku-browser.db") {
		t.Fatalf("unexpected database path: %s", launcher.database)
	}
}

func TestEnsureRejectsIncompatibleTupleWithoutLaunching(t *testing.T) {
	root := writeActiveRuntime(t, activeFixture())
	prober := &sequenceProber{}
	launcher := &recordingLauncher{}
	controller := testController(root, prober, launcher)
	identity := validRequest("ensure_runtime").Extension
	identity.RuntimeRevision = "untrusted-revision"

	outcome := controller.Ensure(context.Background(), identity)

	if outcome.Status != "incompatible" || outcome.Error == nil || outcome.Error.Code != "runtime_incompatible" {
		t.Fatalf("unexpected incompatible outcome: %#v", outcome)
	}
	if launcher.calls != 0 || prober.calls != 0 {
		t.Fatal("incompatible tuple reached the runtime or process launcher")
	}
}

func TestEnsureRejectsOccupiedIncompatibleEndpointWithoutLaunching(t *testing.T) {
	root := writeActiveRuntime(t, activeFixture())
	prober := &sequenceProber{results: []probeStep{{
		result: ProbeResult{
			Reachable: true,
			Health: Health{
				Status:                "ok",
				Version:               "9.9.9",
				Runtime:               "go",
				BridgeContractVersion: bridgeContract,
				InstanceEpoch:         "foreign:0001",
			},
		},
	}}}
	launcher := &recordingLauncher{}
	outcome := testController(root, prober, launcher).
		Ensure(context.Background(), validRequest("ensure_runtime").Extension)

	if outcome.Status != "incompatible" {
		t.Fatalf("occupied endpoint was not rejected: %#v", outcome)
	}
	if launcher.calls != 0 {
		t.Fatal("host launched beside an incompatible loopback process")
	}
}

func TestEnsureRecoversAfterCrashedRuntimeStartFailure(t *testing.T) {
	root := writeActiveRuntime(t, activeFixture())
	failedLauncher := &recordingLauncher{err: os.ErrPermission}
	failed := testController(
		root,
		&sequenceProber{results: []probeStep{{result: ProbeResult{Reachable: false}}}},
		failedLauncher,
	).Ensure(context.Background(), validRequest("ensure_runtime").Extension)
	if failed.Status != "error" || failed.Error == nil ||
		failed.Error.Code != "runtime_start_failed" || !failed.Error.Retryable {
		t.Fatalf("crashed runtime failure was not recoverable and typed: %#v", failed)
	}

	recoveredLauncher := &recordingLauncher{}
	recovered := testController(
		root,
		&sequenceProber{results: []probeStep{
			{result: ProbeResult{Reachable: false}},
			{result: readyProbe()},
		}},
		recoveredLauncher,
	).Ensure(context.Background(), validRequest("ensure_runtime").Extension)
	if recovered.Status != "ready" || recoveredLauncher.calls != 1 {
		t.Fatalf("runtime did not recover on the next lifecycle event: %#v", recovered)
	}
}

func TestFailedCandidateDirectoryCannotReplaceKnownGoodActiveRuntime(t *testing.T) {
	active := activeFixture()
	root := writeActiveRuntime(t, active)
	candidatePath := filepath.Join(root, "versions", "0.7.5", "AkuSidecar.exe")
	if err := os.MkdirAll(filepath.Dir(candidatePath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(candidatePath, []byte("failed-candidate"), 0o600); err != nil {
		t.Fatal(err)
	}
	launcher := &recordingLauncher{}
	outcome := testController(
		root,
		&sequenceProber{results: []probeStep{
			{result: ProbeResult{Reachable: false}},
			{result: readyProbe()},
		}},
		launcher,
	).Ensure(context.Background(), validRequest("ensure_runtime").Extension)

	if outcome.Status != "ready" {
		t.Fatalf("known-good runtime was not recovered: %#v", outcome)
	}
	expected := filepath.Join(root, "versions", active.Version, "AkuSidecar.exe")
	if launcher.executable != expected {
		t.Fatalf("unactivated candidate gained process authority: %s", launcher.executable)
	}
}

func TestRuntimeMetadataRejectsUnknownExecutableAuthority(t *testing.T) {
	root := t.TempDir()
	value := map[string]any{
		"schemaVersion":         1,
		"channel":               "stable",
		"version":               "0.7.4",
		"runtimeRevision":       "source-adapters-v84",
		"bridgeContractVersion": bridgeContract,
		"rollbackVersion":       nil,
		"executablePath":        `C:\untrusted\payload.exe`,
	}
	writeJSONFile(t, filepath.Join(root, "current.json"), value)
	controller := testController(root, &sequenceProber{}, &recordingLauncher{})

	outcome := controller.Ensure(context.Background(), validRequest("ensure_runtime").Extension)

	if outcome.Status != "error" || outcome.Error == nil || outcome.Error.Remediation != "reinstall_runtime" {
		t.Fatalf("unknown metadata authority was not rejected: %#v", outcome)
	}
}

func activeFixture() ActiveRuntime {
	return ActiveRuntime{
		SchemaVersion:         1,
		Channel:               "stable",
		Version:               "0.7.4",
		RuntimeRevision:       "source-adapters-v84",
		BridgeContractVersion: bridgeContract,
		RollbackVersion:       stringPointer("0.7.3"),
	}
}

func readyProbe() ProbeResult {
	return ProbeResult{
		Reachable: true,
		Health: Health{
			Status:                "ok",
			Version:               "0.7.4",
			Runtime:               "go",
			BridgeContractVersion: bridgeContract,
			InstanceEpoch:         "runtime:0001",
		},
	}
}

type probeStep struct {
	result ProbeResult
	err    error
}

type sequenceProber struct {
	results []probeStep
	calls   int
}

func (prober *sequenceProber) Probe(context.Context) (ProbeResult, error) {
	index := prober.calls
	prober.calls++
	if index >= len(prober.results) {
		return ProbeResult{Reachable: false}, nil
	}
	return prober.results[index].result, prober.results[index].err
}

type recordingLauncher struct {
	calls            int
	executable       string
	workingDirectory string
	config           string
	database         string
	err              error
}

func (launcher *recordingLauncher) Start(executable, workingDirectory, config, database string) error {
	launcher.calls++
	launcher.executable = executable
	launcher.workingDirectory = workingDirectory
	launcher.config = config
	launcher.database = database
	return launcher.err
}

func testController(root string, prober HealthProber, launcher ProcessLauncher) RuntimeController {
	return RuntimeController{
		RuntimeRoot:  root,
		DataRoot:     filepath.Join(testsDataRoot(root), "data"),
		Prober:       prober,
		Launcher:     launcher,
		StartupWait:  time.Second,
		PollInterval: time.Millisecond,
		Sleep: func(context.Context, time.Duration) error {
			return nil
		},
	}
}

func testsDataRoot(root string) string {
	return filepath.Join(root, "local-app-data", "AkuBrowser")
}

func writeActiveRuntime(t *testing.T, active ActiveRuntime) string {
	t.Helper()
	root := t.TempDir()
	writeJSONFile(t, filepath.Join(root, "current.json"), active)
	return root
}

func writeJSONFile(t *testing.T, path string, value any) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}
