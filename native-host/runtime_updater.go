package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type RuntimeUpdateAttempt struct {
	Active      ActiveRuntime
	Phase       string
	Code        string
	Message     string
	Retryable   bool
	Remediation string
}

func (attempt RuntimeUpdateAttempt) Succeeded() bool { return attempt.Code == "" }

type RuntimeUpdater interface {
	Update(context.Context, ActiveRuntime, ExtensionIdentity) RuntimeUpdateAttempt
	ActivationPending(ActiveRuntime) bool
	ConfirmActivation(ActiveRuntime) error
	RollbackPending(context.Context, ActiveRuntime) error
}

type UpdateTransport interface {
	Read(context.Context, string, int64) ([]byte, error)
	Download(context.Context, UpdateArtifact, string) error
}

type RuntimeUpdateControl interface {
	Readiness(context.Context) (bool, string, error)
	ShutdownIfIdle(context.Context, string) error
	WaitStopped(context.Context) error
}

type CandidateProbe interface {
	Probe(context.Context, string, string, ExtensionIdentity) error
}

type SignedRuntimeUpdater struct {
	RuntimeRoot    string
	DataRoot       string
	PublicKey      string
	Transport      UpdateTransport
	Control        RuntimeUpdateControl
	Probe          CandidateProbe
	Launcher       ProcessLauncher
	Health         HealthProber
	ControlToken   string
	Now            func() time.Time
	ActivationWait time.Duration
	PollInterval   time.Duration
}

func (updater SignedRuntimeUpdater) Update(ctx context.Context, active ActiveRuntime, expected ExtensionIdentity) RuntimeUpdateAttempt {
	fail := func(phase, code, message string, retryable bool, remediation string) RuntimeUpdateAttempt {
		updater.audit(active.Version, expected.ProductVersion, phase, code)
		return RuntimeUpdateAttempt{
			Active: active, Phase: phase, Code: code, Message: message,
			Retryable: retryable, Remediation: remediation,
		}
	}
	now := time.Now()
	if updater.Now != nil {
		now = updater.Now()
	}
	manifestData, err := updater.Transport.Read(ctx, updateManifestURL, maxUpdateManifestBytes)
	if err != nil {
		return fail("checking", "update_check_failed", "AkuBrowser could not read the signed runtime update manifest.", true, "retry")
	}
	manifest, err := decodeAndVerifyUpdateManifest(manifestData, updater.PublicKey, expected, active, now.UTC())
	if err != nil {
		return fail("verifying", "signature_invalid", "The runtime update manifest could not be authenticated.", false, "contact_support")
	}

	downloadsRoot := filepath.Join(updater.RuntimeRoot, "downloads")
	candidatesRoot := filepath.Join(updater.RuntimeRoot, "candidates")
	if err := os.MkdirAll(downloadsRoot, 0o700); err != nil {
		return fail("downloading", "download_failed", "AkuBrowser could not prepare the update download.", true, "retry")
	}
	if err := os.MkdirAll(candidatesRoot, 0o700); err != nil {
		return fail("staging", "download_failed", "AkuBrowser could not prepare update staging.", true, "retry")
	}
	archive, err := os.CreateTemp(downloadsRoot, ".aku-runtime-*.zip")
	if err != nil {
		return fail("downloading", "download_failed", "AkuBrowser could not prepare the update download.", true, "retry")
	}
	archivePath := archive.Name()
	_ = archive.Close()
	defer os.Remove(archivePath)
	if err := updater.Transport.Download(ctx, manifest.Artifact, archivePath); err != nil {
		code := "download_failed"
		if errors.Is(err, errUpdateChecksum) {
			code = "checksum_invalid"
		}
		return fail("downloading", code, "The runtime update artifact failed verification.", code == "download_failed", "retry")
	}

	candidateRoot, err := os.MkdirTemp(candidatesRoot, ".aku-candidate-")
	if err != nil {
		return fail("staging", "download_failed", "AkuBrowser could not create update staging.", true, "retry")
	}
	_ = os.Remove(candidateRoot)
	defer os.RemoveAll(candidateRoot)
	if err := extractVerifiedRuntimeArchive(archivePath, candidateRoot, manifest.Version); err != nil {
		return fail("staging", "checksum_invalid", "The runtime update payload is incomplete or changed.", false, "contact_support")
	}
	candidateExecutable := filepath.Join(candidateRoot, "AkuSidecar.exe")
	candidateConfig := filepath.Join(candidateRoot, "config", "sidecar.json")
	if err := updater.Probe.Probe(ctx, candidateExecutable, candidateConfig, expected); err != nil {
		return fail("health_check", "candidate_health_failed", "The candidate runtime did not pass its isolated health probe.", false, "contact_support")
	}
	activeProbe, probeErr := updater.Health.Probe(ctx)
	if probeErr != nil {
		return fail("waiting_for_idle", "runtime_busy", "The loopback endpoint did not prove ownership by the active runtime.", true, "wait")
	}
	if activeProbe.Reachable {
		if validateHealth(activeProbe.Health, active) != nil {
			return fail("waiting_for_idle", "runtime_busy", "The loopback endpoint is not the active AkuBrowser runtime.", false, "reinstall_runtime")
		}
		ready, _, readinessErr := updater.Control.Readiness(ctx)
		if readinessErr != nil {
			return fail("waiting_for_idle", "runtime_busy", "The active runtime did not confirm update readiness.", true, "wait")
		}
		if !ready {
			return fail("waiting_for_idle", "runtime_busy", "Active AkuBrowser work is blocking the runtime update.", true, "wait")
		}
		if err := updater.Control.ShutdownIfIdle(ctx, updater.ControlToken); err != nil {
			return fail("waiting_for_idle", "runtime_busy", "The active runtime did not enter the update handoff.", true, "wait")
		}
		if err := updater.Control.WaitStopped(ctx); err != nil {
			return fail("waiting_for_idle", "runtime_busy", "The active runtime did not stop within the update handoff window.", true, "wait")
		}
	}

	versionRoot := filepath.Join(updater.RuntimeRoot, "versions", manifest.Version)
	if _, err := os.Stat(versionRoot); err == nil {
		if manifest.Version == active.Version ||
			(active.RollbackVersion != nil && manifest.Version == *active.RollbackVersion) {
			return fail("swapping", "candidate_health_failed", "The target runtime directory is already authoritative.", false, "contact_support")
		}
		if err := os.RemoveAll(versionRoot); err != nil {
			return fail("swapping", "internal_error", "AkuBrowser could not remove an interrupted unactivated candidate.", true, "retry")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fail("swapping", "internal_error", "AkuBrowser could not inspect the target runtime directory.", false, "contact_support")
	}
	if err := os.Rename(candidateRoot, versionRoot); err != nil {
		return fail("swapping", "internal_error", "AkuBrowser could not activate the staged runtime directory.", true, "retry")
	}
	newActive := ActiveRuntime{
		SchemaVersion: activeRuntimeSchemaVersion, Channel: manifest.Channel,
		Version: manifest.Version, RuntimeRevision: manifest.RuntimeRevision,
		BridgeContractVersion: manifest.BridgeContractVersion,
		RollbackVersion:       &active.Version,
	}
	rollbackActive := active
	rollbackActive.RollbackVersion = nil
	if err := persistActiveRuntime(filepath.Join(updater.RuntimeRoot, "rollback.json"), rollbackActive); err != nil {
		return fail("swapping", "internal_error", "AkuBrowser could not persist the rollback metadata.", true, "retry")
	}
	if err := persistActiveRuntime(filepath.Join(updater.RuntimeRoot, "current.json"), newActive); err != nil {
		return fail("swapping", "internal_error", "AkuBrowser could not atomically activate the runtime metadata.", true, "retry")
	}
	if err := updater.launchAndCheck(ctx, newActive); err == nil {
		if err := updater.ConfirmActivation(newActive); err != nil {
			return fail("health_check", "internal_error", "The runtime started but activation confirmation could not be persisted.", true, "retry")
		}
		updater.cleanupVersions(newActive)
		updater.audit(active.Version, newActive.Version, "idle", "")
		return RuntimeUpdateAttempt{Active: newActive, Phase: "idle"}
	}

	if rollbackErr := updater.RollbackPending(ctx, newActive); rollbackErr != nil {
		return fail("rolling_back", "rollback_failed", "The candidate failed and the previous runtime could not be restarted.", false, "reinstall_runtime")
	}
	return fail("rolling_back", "candidate_health_failed", "The candidate failed its activation health gate; the previous runtime was restored.", true, "retry")
}

func (updater SignedRuntimeUpdater) ActivationPending(active ActiveRuntime) bool {
	if active.RollbackVersion == nil {
		return false
	}
	data, err := readBoundedFile(
		filepath.Join(updater.RuntimeRoot, "versions", active.Version, ".activation-confirmed"),
		256,
	)
	return err != nil || strings.TrimSpace(string(data)) != active.Version
}

func (updater SignedRuntimeUpdater) ConfirmActivation(active ActiveRuntime) error {
	return writePrivateFileAtomic(
		filepath.Join(updater.RuntimeRoot, "versions", active.Version, ".activation-confirmed"),
		[]byte(active.Version+"\n"),
	)
}

func (updater SignedRuntimeUpdater) RollbackPending(ctx context.Context, failed ActiveRuntime) error {
	if failed.RollbackVersion == nil {
		return errors.New("rollback metadata is unavailable")
	}
	rollback, err := loadActiveRuntimeFile(filepath.Join(updater.RuntimeRoot, "rollback.json"))
	if err != nil || rollback.Version != *failed.RollbackVersion ||
		rollback.Channel != failed.Channel || rollback.BridgeContractVersion != bridgeContract {
		return errors.New("rollback metadata is invalid")
	}
	_ = updater.Control.ShutdownIfIdle(ctx, updater.ControlToken)
	_ = updater.Control.WaitStopped(ctx)
	if err := persistActiveRuntime(filepath.Join(updater.RuntimeRoot, "current.json"), rollback); err != nil {
		return err
	}
	if err := updater.launchAndCheck(ctx, rollback); err != nil {
		return err
	}
	_ = os.RemoveAll(filepath.Join(updater.RuntimeRoot, "versions", failed.Version))
	_ = os.Remove(filepath.Join(updater.RuntimeRoot, "rollback.json"))
	return nil
}

func (updater SignedRuntimeUpdater) launchAndCheck(ctx context.Context, active ActiveRuntime) error {
	workingDirectory := filepath.Join(updater.RuntimeRoot, "versions", active.Version)
	if err := updater.Launcher.Start(
		filepath.Join(workingDirectory, "AkuSidecar.exe"), workingDirectory,
		filepath.Join(workingDirectory, "config", "sidecar.json"),
		filepath.Join(updater.DataRoot, "aku-browser.db"), updater.ControlToken,
	); err != nil {
		return err
	}
	wait := updater.ActivationWait
	if wait <= 0 {
		wait = 12 * time.Second
	}
	poll := updater.PollInterval
	if poll <= 0 {
		poll = 200 * time.Millisecond
	}
	deadline := time.Now().Add(wait)
	for time.Now().Before(deadline) {
		result, err := updater.Health.Probe(ctx)
		if err == nil && result.Reachable && validateHealth(result.Health, active) == nil {
			return nil
		}
		timer := time.NewTimer(poll)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	return errors.New("runtime activation health deadline exceeded")
}

func persistActiveRuntime(path string, active ActiveRuntime) error {
	data, err := json.MarshalIndent(active, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return writePrivateFileAtomic(path, data)
}

func (updater SignedRuntimeUpdater) cleanupVersions(active ActiveRuntime) {
	entries, err := os.ReadDir(filepath.Join(updater.RuntimeRoot, "versions"))
	if err != nil {
		return
	}
	keep := map[string]bool{active.Version: true}
	if active.RollbackVersion != nil {
		keep[*active.RollbackVersion] = true
	}
	for _, entry := range entries {
		if entry.IsDir() && versionPattern.MatchString(entry.Name()) && !keep[entry.Name()] {
			_ = os.RemoveAll(filepath.Join(updater.RuntimeRoot, "versions", entry.Name()))
		}
	}
}

func (updater SignedRuntimeUpdater) audit(from, target, phase, code string) {
	path := filepath.Join(updater.RuntimeRoot, "update-audit.jsonl")
	if info, err := os.Stat(path); err == nil && info.Size() > 1024*1024 {
		_ = os.Remove(path + ".previous")
		_ = os.Rename(path, path+".previous")
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	defer file.Close()
	now := time.Now().UTC()
	if updater.Now != nil {
		now = updater.Now().UTC()
	}
	_ = json.NewEncoder(file).Encode(map[string]any{
		"time": now.Format(time.RFC3339Nano), "fromVersion": from,
		"targetVersion": target, "phase": phase, "code": code,
	})
}

var errUpdateChecksum = errors.New("update artifact checksum mismatch")

type HTTPUpdateTransport struct{ Client *http.Client }

func (transport HTTPUpdateTransport) client() *http.Client {
	if transport.Client != nil {
		return transport.Client
	}
	return &http.Client{
		Timeout: 2 * time.Minute,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) > 5 || request.URL.Scheme != "https" || !allowedUpdateRedirectHost(request.URL.Hostname()) {
				return errors.New("update redirect left the fixed release transport")
			}
			return nil
		},
	}
}

func allowedUpdateRedirectHost(host string) bool {
	return host == "github.com" || strings.HasSuffix(host, ".githubusercontent.com")
}

func (transport HTTPUpdateTransport) Read(ctx context.Context, location string, maximum int64) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, location, nil)
	if err != nil {
		return nil, err
	}
	response, err := transport.client().Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("update endpoint returned %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maximum {
		return nil, errors.New("update response exceeds its bound")
	}
	return data, nil
}

func (transport HTTPUpdateTransport) Download(ctx context.Context, artifact UpdateArtifact, destination string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, artifact.URL, nil)
	if err != nil {
		return err
	}
	response, err := transport.client().Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("update artifact returned %d", response.StatusCode)
	}
	file, err := os.OpenFile(destination, os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	hash := sha256.New()
	count, copyErr := io.Copy(io.MultiWriter(file, hash), io.LimitReader(response.Body, artifact.Size+1))
	closeErr := file.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if count != artifact.Size || hex.EncodeToString(hash.Sum(nil)) != artifact.SHA256 {
		return errUpdateChecksum
	}
	return nil
}

type HTTPRuntimeUpdateControl struct{ Client *http.Client }

func (control HTTPRuntimeUpdateControl) client() *http.Client {
	if control.Client != nil {
		return control.Client
	}
	return &http.Client{Timeout: time.Second}
}

func (control HTTPRuntimeUpdateControl) Readiness(ctx context.Context) (bool, string, error) {
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, loopbackEndpoint+"/api/runtime/update-readiness", nil)
	response, err := control.client().Do(request)
	if err != nil {
		return false, "", err
	}
	defer response.Body.Close()
	var value struct {
		Ready            bool   `json:"ready"`
		Reason           string `json:"reason"`
		ControlAvailable bool   `json:"controlAvailable"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 16*1024)).Decode(&value) != nil {
		return false, "", errors.New("runtime readiness response is invalid")
	}
	return value.Ready && value.ControlAvailable, value.Reason, nil
}

func (control HTTPRuntimeUpdateControl) ShutdownIfIdle(ctx context.Context, token string) error {
	request, _ := http.NewRequestWithContext(ctx, http.MethodPost, loopbackEndpoint+"/api/runtime/shutdown-if-idle", bytes.NewReader(nil))
	request.Header.Set("X-Aku-Runtime-Control-Token", token)
	response, err := control.client().Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		return fmt.Errorf("runtime shutdown handoff returned %d", response.StatusCode)
	}
	return nil
}

func (control HTTPRuntimeUpdateControl) WaitStopped(ctx context.Context) error {
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		request, _ := http.NewRequestWithContext(ctx, http.MethodGet, loopbackEndpoint+"/api/health", nil)
		response, err := control.client().Do(request)
		if err != nil {
			return nil
		}
		response.Body.Close()
		timer := time.NewTimer(100 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	return errors.New("runtime did not stop")
}

type OSCandidateProbe struct{}

func (OSCandidateProbe) Probe(ctx context.Context, executable, config string, expected ExtensionIdentity) error {
	probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	command := exec.CommandContext(probeCtx, executable, "-config", config, "-runtime-candidate-probe")
	command.Dir = filepath.Dir(executable)
	output, err := command.Output()
	if err != nil || len(output) > 16*1024 {
		return errors.New("candidate probe failed")
	}
	var value struct {
		Status                string `json:"status"`
		Version               string `json:"version"`
		Runtime               string `json:"runtime"`
		BridgeContractVersion string `json:"bridgeContractVersion"`
		ConfigVersion         int    `json:"configVersion"`
	}
	decoder := json.NewDecoder(bytes.NewReader(output))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil || ensureJSONEOF(decoder) != nil {
		return errors.New("candidate probe response is invalid")
	}
	if value.Status != "ok" || value.Version != expected.ProductVersion || value.Runtime != "go" ||
		value.BridgeContractVersion != expected.BridgeContractVersion || value.ConfigVersion != 1 {
		return errors.New("candidate probe compatibility mismatch")
	}
	return nil
}

func validateFixedUpdateURL(location string) error {
	parsed, err := url.Parse(location)
	if err != nil || parsed.Scheme != "https" || !allowedUpdateRedirectHost(parsed.Hostname()) {
		return errors.New("update URL is invalid")
	}
	return nil
}
