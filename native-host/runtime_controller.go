package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

const activeRuntimeSchemaVersion = 1

var instanceEpochPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{8,128}$`)

type ActiveRuntime struct {
	SchemaVersion         int     `json:"schemaVersion"`
	Channel               string  `json:"channel"`
	Version               string  `json:"version"`
	RuntimeRevision       string  `json:"runtimeRevision"`
	BridgeContractVersion string  `json:"bridgeContractVersion"`
	RollbackVersion       *string `json:"rollbackVersion"`
}

type Health struct {
	Status                string `json:"status"`
	Version               string `json:"version"`
	Runtime               string `json:"runtime"`
	BridgeContractVersion string `json:"bridgeContractVersion"`
	InstanceEpoch         string `json:"instanceEpoch"`
}

type ProbeResult struct {
	Reachable bool
	Health    Health
}

type HealthProber interface {
	Probe(context.Context) (ProbeResult, error)
}

type ProcessLauncher interface {
	Start(executablePath, workingDirectory, configPath, databasePath string) error
}

type RuntimeController struct {
	RuntimeRoot  string
	DataRoot     string
	Prober       HealthProber
	Launcher     ProcessLauncher
	StartupWait  time.Duration
	PollInterval time.Duration
	Sleep        func(context.Context, time.Duration) error
}

type Outcome struct {
	Status  string
	Runtime *RuntimeState
	Update  UpdateState
	Error   *ErrorState
}

func (controller RuntimeController) Status(ctx context.Context, identity ExtensionIdentity) Outcome {
	active, err := controller.loadActiveRuntime()
	if err != nil {
		return controller.metadataFailure(err)
	}
	if incompatible := compatibilityError(active, identity); incompatible != nil {
		return incompatibleOutcome(active, incompatible)
	}
	probe, err := controller.Prober.Probe(ctx)
	if err != nil {
		return incompatibleOutcome(active, protocolError(
			"runtime_incompatible",
			"Loopback endpoint did not return the AkuBrowser health contract.",
			false,
			"reinstall_runtime",
		))
	}
	if !probe.Reachable {
		return stoppedOutcome(active)
	}
	if err := validateHealth(probe.Health, active); err != nil {
		return incompatibleOutcome(active, protocolError(
			"runtime_incompatible",
			"Loopback runtime is not compatible with this AkuBrowser installation.",
			false,
			"reinstall_runtime",
		))
	}
	return readyOutcome(active, probe.Health)
}

func (controller RuntimeController) Ensure(ctx context.Context, identity ExtensionIdentity) Outcome {
	active, err := controller.loadActiveRuntime()
	if err != nil {
		return controller.metadataFailure(err)
	}
	if incompatible := compatibilityError(active, identity); incompatible != nil {
		return incompatibleOutcome(active, incompatible)
	}
	probe, err := controller.Prober.Probe(ctx)
	if err != nil {
		return incompatibleOutcome(active, protocolError(
			"runtime_incompatible",
			"Loopback endpoint is occupied by an incompatible runtime.",
			false,
			"reinstall_runtime",
		))
	}
	if probe.Reachable {
		if err := validateHealth(probe.Health, active); err != nil {
			return incompatibleOutcome(active, protocolError(
				"runtime_incompatible",
				"Running AkuBrowser runtime is incompatible.",
				false,
				"reinstall_runtime",
			))
		}
		return readyOutcome(active, probe.Health)
	}

	executablePath, workingDirectory, configPath, databasePath := controller.runtimePaths(active)
	if err := controller.Launcher.Start(executablePath, workingDirectory, configPath, databasePath); err != nil {
		return startFailureOutcome(active)
	}
	deadline := time.Now().Add(controller.startupWait())
	for {
		probe, err = controller.Prober.Probe(ctx)
		if err == nil && probe.Reachable {
			if healthErr := validateHealth(probe.Health, active); healthErr != nil {
				return incompatibleOutcome(active, protocolError(
					"runtime_incompatible",
					"Started AkuBrowser runtime returned an incompatible health contract.",
					false,
					"reinstall_runtime",
				))
			}
			return readyOutcome(active, probe.Health)
		}
		if time.Now().After(deadline) {
			return startFailureOutcome(active)
		}
		if sleepErr := controller.sleep(ctx, controller.pollInterval()); sleepErr != nil {
			return startFailureOutcome(active)
		}
	}
}

func (controller RuntimeController) loadActiveRuntime() (ActiveRuntime, error) {
	path := filepath.Join(controller.RuntimeRoot, "current.json")
	data, err := readBoundedFile(path, 16*1024)
	if err != nil {
		return ActiveRuntime{}, fmt.Errorf("read active runtime metadata: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var active ActiveRuntime
	if err := decoder.Decode(&active); err != nil {
		return ActiveRuntime{}, fmt.Errorf("decode active runtime metadata: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return ActiveRuntime{}, err
	}
	if active.SchemaVersion != activeRuntimeSchemaVersion {
		return ActiveRuntime{}, errors.New("active runtime metadata schema is unsupported")
	}
	if active.Channel != "stable" && active.Channel != "preview" {
		return ActiveRuntime{}, errors.New("active runtime channel is invalid")
	}
	if !versionPattern.MatchString(active.Version) {
		return ActiveRuntime{}, errors.New("active runtime version is invalid")
	}
	if !revisionPattern.MatchString(active.RuntimeRevision) {
		return ActiveRuntime{}, errors.New("active runtime revision is invalid")
	}
	if active.BridgeContractVersion != bridgeContract {
		return ActiveRuntime{}, errors.New("active runtime bridge contract is invalid")
	}
	if active.RollbackVersion != nil && !versionPattern.MatchString(*active.RollbackVersion) {
		return ActiveRuntime{}, errors.New("active rollback version is invalid")
	}
	return active, nil
}

func (controller RuntimeController) runtimePaths(active ActiveRuntime) (string, string, string, string) {
	workingDirectory := filepath.Join(controller.RuntimeRoot, "versions", active.Version)
	executablePath := filepath.Join(workingDirectory, "AkuSidecar.exe")
	configPath := filepath.Join(workingDirectory, "config", "sidecar.json")
	databasePath := filepath.Join(controller.DataRoot, "aku-browser.db")
	return executablePath, workingDirectory, configPath, databasePath
}

func (controller RuntimeController) metadataFailure(_ error) Outcome {
	return Outcome{
		Status: "error",
		Update: UpdateState{Phase: "idle"},
		Error: protocolError(
			"runtime_start_failed",
			"AkuBrowser runtime installation metadata is unavailable or invalid.",
			false,
			"reinstall_runtime",
		),
	}
}

func compatibilityError(active ActiveRuntime, identity ExtensionIdentity) *ErrorState {
	if identity.ProductVersion != active.Version ||
		identity.RuntimeRevision != active.RuntimeRevision ||
		identity.BridgeContractVersion != active.BridgeContractVersion {
		return protocolError(
			"runtime_incompatible",
			"Installed runtime does not match the extension compatibility tuple.",
			false,
			"reinstall_runtime",
		)
	}
	return nil
}

func validateHealth(health Health, active ActiveRuntime) error {
	if health.Status != "ok" ||
		health.Version != active.Version ||
		health.Runtime != "go" ||
		health.BridgeContractVersion != active.BridgeContractVersion ||
		!instanceEpochPattern.MatchString(health.InstanceEpoch) {
		return errors.New("health compatibility tuple mismatch")
	}
	return nil
}

func readyOutcome(active ActiveRuntime, health Health) Outcome {
	return Outcome{
		Status:  "ready",
		Runtime: runtimeState(active, health.InstanceEpoch, "ready"),
		Update:  updateState(active),
	}
}

func stoppedOutcome(active ActiveRuntime) Outcome {
	return Outcome{
		Status:  "error",
		Runtime: runtimeState(active, "not-running", "stopped"),
		Update:  updateState(active),
		Error: protocolError(
			"runtime_start_failed",
			"AkuBrowser runtime is installed but not running.",
			true,
			"retry",
		),
	}
}

func startFailureOutcome(active ActiveRuntime) Outcome {
	return Outcome{
		Status:  "error",
		Runtime: runtimeState(active, "start-failed", "failed"),
		Update:  updateState(active),
		Error: protocolError(
			"runtime_start_failed",
			"AkuBrowser runtime could not become healthy.",
			true,
			"retry",
		),
	}
}

func incompatibleOutcome(active ActiveRuntime, state *ErrorState) Outcome {
	return Outcome{
		Status:  "incompatible",
		Runtime: runtimeState(active, "incompatible", "failed"),
		Update:  updateState(active),
		Error:   state,
	}
}

func runtimeState(active ActiveRuntime, epoch, processState string) *RuntimeState {
	return &RuntimeState{
		Version:               active.Version,
		Channel:               active.Channel,
		RuntimeRevision:       active.RuntimeRevision,
		BridgeContractVersion: active.BridgeContractVersion,
		Endpoint:              loopbackEndpoint,
		InstanceEpoch:         epoch,
		ProcessState:          processState,
	}
}

func updateState(active ActiveRuntime) UpdateState {
	version := active.Version
	return UpdateState{
		Phase:             "idle",
		CurrentVersion:    &version,
		TargetVersion:     nil,
		RollbackAvailable: active.RollbackVersion != nil,
	}
}

func (controller RuntimeController) startupWait() time.Duration {
	if controller.StartupWait > 0 {
		return controller.StartupWait
	}
	return 12 * time.Second
}

func (controller RuntimeController) pollInterval() time.Duration {
	if controller.PollInterval > 0 {
		return controller.PollInterval
	}
	return 200 * time.Millisecond
}

func (controller RuntimeController) sleep(ctx context.Context, duration time.Duration) error {
	if controller.Sleep != nil {
		return controller.Sleep(ctx, duration)
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

type HTTPHealthProber struct {
	Client *http.Client
}

func (prober HTTPHealthProber) Probe(ctx context.Context) (ProbeResult, error) {
	client := prober.Client
	if client == nil {
		client = &http.Client{Timeout: 900 * time.Millisecond}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, loopbackEndpoint+"/api/health", nil)
	if err != nil {
		return ProbeResult{}, err
	}
	request.Header.Set("Accept", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return ProbeResult{Reachable: false}, nil
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return ProbeResult{Reachable: true}, fmt.Errorf("health endpoint returned status %d", response.StatusCode)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, 16*1024+1))
	if err != nil {
		return ProbeResult{Reachable: true}, fmt.Errorf("read health response: %w", err)
	}
	if len(payload) > 16*1024 {
		return ProbeResult{Reachable: true}, errors.New("health response exceeds bounded size")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	var health Health
	if err := decoder.Decode(&health); err != nil {
		return ProbeResult{Reachable: true}, fmt.Errorf("decode health response: %w", err)
	}
	return ProbeResult{Reachable: true, Health: health}, nil
}

func readBoundedFile(path string, maximum int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maximum {
		return nil, errors.New("file exceeds bounded size")
	}
	return data, nil
}

type OSProcessLauncher struct{}

func (OSProcessLauncher) Start(executablePath, workingDirectory, configPath, databasePath string) error {
	for _, required := range []string{executablePath, configPath} {
		info, err := os.Stat(required)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("required runtime file is not regular: %s", filepath.Base(required))
		}
	}
	if err := os.MkdirAll(filepath.Dir(databasePath), 0o700); err != nil {
		return fmt.Errorf("prepare AkuBrowser data directory: %w", err)
	}
	return startDetachedProcess(
		executablePath,
		workingDirectory,
		"-config",
		configPath,
		"-database",
		databasePath,
	)
}
