package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
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
	Start(executablePath, workingDirectory, configPath, databasePath, runtimeControlToken string) error
}

type RuntimeController struct {
	RuntimeRoot       string
	DataRoot          string
	RuntimeExecutable string
	Prober            HealthProber
	Launcher          ProcessLauncher
	Updater           RuntimeUpdater
	UpdateControl     RuntimeUpdateControl
	StartupWait       time.Duration
	PollInterval      time.Duration
	Sleep             func(context.Context, time.Duration) error
}

func (controller RuntimeController) ShutdownIfIdle(ctx context.Context, _ ExtensionIdentity) Outcome {
	active, err := controller.loadActiveRuntime()
	if err != nil {
		return controller.metadataFailure(err)
	}
	if controller.UpdateControl == nil {
		return updateFailureOutcome(active, active.Version, RuntimeUpdateAttempt{
			Phase: "waiting_for_idle", Code: "runtime_busy",
			Message: "Runtime update control is unavailable.", Retryable: true, Remediation: "wait",
		})
	}
	ready, _, err := controller.UpdateControl.Readiness(ctx)
	if err != nil || !ready {
		return updateFailureOutcome(active, active.Version, RuntimeUpdateAttempt{
			Phase: "waiting_for_idle", Code: "runtime_busy",
			Message: "Active AkuBrowser work is blocking shutdown.", Retryable: true, Remediation: "wait",
		})
	}
	token, err := controller.runtimeControlToken()
	if err != nil || controller.UpdateControl.ShutdownIfIdle(ctx, token) != nil ||
		controller.UpdateControl.WaitStopped(ctx) != nil {
		return updateFailureOutcome(active, active.Version, RuntimeUpdateAttempt{
			Phase: "waiting_for_idle", Code: "runtime_busy",
			Message: "AkuBrowser did not complete the idle shutdown handoff.", Retryable: true, Remediation: "wait",
		})
	}
	return Outcome{
		Status: "ready", Runtime: runtimeState(active, "shutdown-complete", "stopped"),
		Update: updateState(active),
	}
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
	updateRequired := runtimeUpdateRequired(active, identity)
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
		if updateRequired {
			return updateRequiredOutcome(active, identity)
		}
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
	if updateRequired {
		return readyUpdateOutcome(active, probe.Health, identity.ProductVersion)
	}
	if controller.Updater != nil && identity.BridgeProtocol != nil {
		prepared := controller.Updater.Prepared(ctx, active, identity)
		if prepared.Code != "" {
			return readyUpdateAttemptOutcome(active, probe.Health, prepared)
		}
		if prepared.Phase != "idle" {
			return readyUpdateAttemptOutcome(active, probe.Health, prepared)
		}
	}
	return readyOutcome(active, probe.Health)
}

func (controller RuntimeController) Ensure(ctx context.Context, identity ExtensionIdentity) Outcome {
	active, err := controller.loadActiveRuntime()
	if err != nil {
		return controller.metadataFailure(err)
	}
	var updateWarning *RuntimeUpdateAttempt
	if controller.Updater != nil && identity.BridgeProtocol != nil {
		attempt := controller.Updater.Update(ctx, active, identity)
		if !attempt.Succeeded() {
			// Retryable discovery/download failures must not prevent an installed,
			// compatible Sidecar from starting. Preserve the warning and reconcile
			// the active runtime before returning it to the Bridge.
			if attempt.Retryable && (attempt.Code == "update_check_failed" || attempt.Code == "download_failed") {
				updateWarning = &attempt
			} else {
				probe, probeErr := controller.Prober.Probe(ctx)
				if probeErr == nil && probe.Reachable && validateHealth(probe.Health, active) == nil {
					return readyUpdateAttemptOutcome(active, probe.Health, attempt)
				}
				return updateFailureOutcome(active, attemptTargetVersion(active.Version, attempt), attempt)
			}
		} else {
			active = attempt.Active
		}
	} else if runtimeUpdateRequired(active, identity) {
		if controller.Updater == nil {
			return updateRequiredOutcome(active, identity)
		}
		attempt := controller.Updater.Update(ctx, active, identity)
		if !attempt.Succeeded() {
			return updateFailureOutcome(active, identity.ProductVersion, attempt)
		}
		active = attempt.Active
		if runtimeUpdateRequired(active, identity) {
			return updateRequiredOutcome(active, identity)
		}
	}
	return controller.reconcileActive(ctx, active, identity, updateWarning)
}

// Reconcile starts or validates only the already-installed active Sidecar. It
// intentionally never reads the update feed, so Chrome/extension startup does
// not bypass the persisted update cadence.
func (controller RuntimeController) Reconcile(ctx context.Context, identity ExtensionIdentity) Outcome {
	active, err := controller.loadActiveRuntime()
	if err != nil {
		return controller.metadataFailure(err)
	}
	return controller.reconcileActive(ctx, active, identity, nil)
}

func (controller RuntimeController) reconcileActive(
	ctx context.Context,
	active ActiveRuntime,
	identity ExtensionIdentity,
	updateWarning *RuntimeUpdateAttempt,
) Outcome {
	activationPending := controller.Updater != nil && controller.Updater.ActivationPending(active)
	probe, err := controller.Prober.Probe(ctx)
	if err != nil {
		if activationPending {
			return controller.rollbackPendingOutcome(ctx, active, identity.ProductVersion)
		}
		return incompatibleOutcome(active, protocolError(
			"runtime_incompatible",
			"Loopback endpoint is occupied by an incompatible runtime.",
			false,
			"reinstall_runtime",
		))
	}
	if probe.Reachable {
		if err := validateHealth(probe.Health, active); err != nil {
			if activationPending {
				return controller.rollbackPendingOutcome(ctx, active, identity.ProductVersion)
			}
			return incompatibleOutcome(active, protocolError(
				"runtime_incompatible",
				"Running AkuBrowser runtime is incompatible.",
				false,
				"reinstall_runtime",
			))
		}
		if activationPending {
			if err := controller.Updater.ConfirmActivation(active); err != nil {
				return updateFailureOutcome(active, identity.ProductVersion, RuntimeUpdateAttempt{
					Phase: "health_check", Code: "internal_error",
					Message:   "Runtime activation confirmation could not be persisted.",
					Retryable: true, Remediation: "retry",
				})
			}
		}
		return readyOutcomeWithUpdateWarning(active, probe.Health, updateWarning)
	}

	executablePath, workingDirectory, configPath, databasePath := controller.runtimePaths(active)
	controlToken, err := controller.runtimeControlToken()
	if err != nil {
		return startFailureOutcome(active)
	}
	if err := controller.Launcher.Start(executablePath, workingDirectory, configPath, databasePath, controlToken); err != nil {
		if activationPending {
			return controller.rollbackPendingOutcome(ctx, active, identity.ProductVersion)
		}
		return startFailureOutcome(active)
	}
	deadline := time.Now().Add(controller.startupWait())
	for {
		probe, err = controller.Prober.Probe(ctx)
		if err == nil && probe.Reachable {
			if healthErr := validateHealth(probe.Health, active); healthErr != nil {
				if activationPending {
					return controller.rollbackPendingOutcome(ctx, active, identity.ProductVersion)
				}
				return incompatibleOutcome(active, protocolError(
					"runtime_incompatible",
					"Started AkuBrowser runtime returned an incompatible health contract.",
					false,
					"reinstall_runtime",
				))
			}
			if activationPending {
				if err := controller.Updater.ConfirmActivation(active); err != nil {
					return updateFailureOutcome(active, identity.ProductVersion, RuntimeUpdateAttempt{
						Phase: "health_check", Code: "internal_error",
						Message:   "Runtime activation confirmation could not be persisted.",
						Retryable: true, Remediation: "retry",
					})
				}
			}
			return readyOutcomeWithUpdateWarning(active, probe.Health, updateWarning)
		}
		if time.Now().After(deadline) {
			if activationPending {
				return controller.rollbackPendingOutcome(ctx, active, identity.ProductVersion)
			}
			return startFailureOutcome(active)
		}
		if sleepErr := controller.sleep(ctx, controller.pollInterval()); sleepErr != nil {
			return startFailureOutcome(active)
		}
	}
}

func readyOutcomeWithUpdateWarning(active ActiveRuntime, health Health, warning *RuntimeUpdateAttempt) Outcome {
	if warning != nil {
		return readyUpdateAttemptOutcome(active, health, *warning)
	}
	return readyOutcome(active, health)
}

func (controller RuntimeController) rollbackPendingOutcome(ctx context.Context, failed ActiveRuntime, target string) Outcome {
	if err := controller.Updater.RollbackPending(ctx, failed); err != nil {
		return updateFailureOutcome(failed, target, RuntimeUpdateAttempt{
			Phase: "rolling_back", Code: "rollback_failed",
			Message:   "An unconfirmed runtime failed and the known-good runtime could not be restored.",
			Retryable: false, Remediation: "reinstall_runtime",
		})
	}
	rollback, err := controller.loadActiveRuntime()
	if err != nil {
		rollback = failed
	}
	return updateFailureOutcome(rollback, target, RuntimeUpdateAttempt{
		Phase: "rolling_back", Code: "candidate_health_failed",
		Message:   "An unconfirmed runtime failed; the known-good runtime was restored.",
		Retryable: true, Remediation: "retry",
	})
}

func updateFailureOutcome(active ActiveRuntime, target string, attempt RuntimeUpdateAttempt) Outcome {
	current := active.Version
	status := "error"
	if attempt.Code == "runtime_busy" {
		status = "busy"
	}
	return Outcome{
		Status:  status,
		Runtime: runtimeState(active, "update-pending", "stopped"),
		Update: UpdateState{
			Phase: attempt.Phase, CurrentVersion: &current, TargetVersion: &target,
			RollbackAvailable: active.RollbackVersion != nil,
			Urgency:           attempt.Urgency, Deadline: attempt.Deadline,
		},
		Error: protocolError(attempt.Code, attempt.Message, attempt.Retryable, attempt.Remediation),
	}
}

func attemptTargetVersion(fallback string, attempt RuntimeUpdateAttempt) string {
	if versionPattern.MatchString(attempt.TargetVersion) {
		return attempt.TargetVersion
	}
	return fallback
}

func (controller RuntimeController) runtimeControlToken() (string, error) {
	tokenPath := filepath.Join(controller.RuntimeRoot, "control-token")
	readToken := func() (string, error) {
		data, err := readBoundedFile(tokenPath, 256)
		if err != nil {
			return "", err
		}
		token := string(bytes.TrimSpace(data))
		if len(token) != 64 {
			return "", errors.New("runtime control token is invalid")
		}
		if _, decodeErr := hex.DecodeString(token); decodeErr != nil {
			return "", errors.New("runtime control token is invalid")
		}
		return token, nil
	}
	if token, err := readToken(); err == nil {
		return token, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	token := hex.EncodeToString(raw[:])
	if err := os.MkdirAll(filepath.Dir(tokenPath), 0o700); err != nil {
		return "", err
	}
	file, err := os.OpenFile(tokenPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		for attempt := 0; attempt < 20; attempt++ {
			if existing, readErr := readToken(); readErr == nil {
				return existing, nil
			}
			time.Sleep(10 * time.Millisecond)
		}
		return "", errors.New("runtime control token creation did not settle")
	}
	if err != nil {
		return "", err
	}
	if _, err := file.WriteString(token); err != nil {
		file.Close()
		return "", err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return "", err
	}
	if err := file.Close(); err != nil {
		return "", err
	}
	return token, nil
}

func writePrivateFileAtomic(destination string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(destination), ".aku-control-*")
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if err := file.Chmod(0o600); err != nil {
		file.Close()
		return err
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return replaceFileAtomic(temporary, destination)
}

func (controller RuntimeController) loadActiveRuntime() (ActiveRuntime, error) {
	return loadActiveRuntimeFile(filepath.Join(controller.RuntimeRoot, "current.json"))
}

func loadActiveRuntimeFile(path string) (ActiveRuntime, error) {
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
	executablePath := filepath.Join(workingDirectory, runtimeExecutableOrDefault(controller.RuntimeExecutable))
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

func runtimeUpdateRequired(active ActiveRuntime, identity ExtensionIdentity) bool {
	if identity.BridgeProtocol != nil {
		return false
	}
	comparison := compareVersions(active.Version, identity.ProductVersion)
	return comparison < 0 ||
		(comparison == 0 && active.RuntimeRevision != identity.RuntimeRevision)
}

func readyUpdateAttemptOutcome(active ActiveRuntime, health Health, attempt RuntimeUpdateAttempt) Outcome {
	current := active.Version
	target := attemptTargetVersion(current, attempt)
	return Outcome{
		Status:  "ready",
		Runtime: runtimeState(active, health.InstanceEpoch, "ready"),
		Update: UpdateState{
			Phase: attempt.Phase, CurrentVersion: &current, TargetVersion: &target,
			RollbackAvailable: active.RollbackVersion != nil,
			Urgency:           attempt.Urgency, Deadline: attempt.Deadline,
		},
		Error: attemptErrorIfActionable(attempt),
	}
}

func attemptErrorIfActionable(attempt RuntimeUpdateAttempt) *ErrorState {
	if attempt.Code == "runtime_busy" {
		return nil
	}
	return protocolError(attempt.Code, attempt.Message, attempt.Retryable, attempt.Remediation)
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

func readyUpdateOutcome(active ActiveRuntime, health Health, targetVersion string) Outcome {
	return Outcome{
		Status:  "ready",
		Runtime: runtimeState(active, health.InstanceEpoch, "ready"),
		Update:  updateStateWithTarget(active, targetVersion),
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

func updateRequiredOutcome(active ActiveRuntime, identity ExtensionIdentity) Outcome {
	return Outcome{
		Status:  "incompatible",
		Runtime: runtimeState(active, "update-required", "stopped"),
		Update:  updateStateWithTarget(active, identity.ProductVersion),
		Error: protocolError(
			"runtime_incompatible",
			"The installed runtime must be reconciled with this extension release.",
			true,
			"retry",
		),
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

func updateStateWithTarget(active ActiveRuntime, targetVersion string) UpdateState {
	state := updateState(active)
	state.TargetVersion = &targetVersion
	return state
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

func (OSProcessLauncher) Start(executablePath, workingDirectory, configPath, databasePath, runtimeControlToken string) error {
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
		"-runtime-control-token",
		runtimeControlToken,
	)
}
