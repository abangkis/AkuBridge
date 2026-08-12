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
	Active        ActiveRuntime
	Phase         string
	TargetVersion string
	Urgency       string
	Deadline      string
	Code          string
	Message       string
	Retryable     bool
	Remediation   string
}

func (attempt RuntimeUpdateAttempt) Succeeded() bool { return attempt.Code == "" }

type RuntimeUpdater interface {
	Update(context.Context, ActiveRuntime, ExtensionIdentity) RuntimeUpdateAttempt
	Prepared(context.Context, ActiveRuntime, ExtensionIdentity) RuntimeUpdateAttempt
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
	Probe(context.Context, string, string, CandidateExpectation) error
}

type CandidateExpectation struct {
	Version               string
	BridgeContractVersion string
	DatabaseSchemaVersion int
}

type SignedRuntimeUpdater struct {
	RuntimeRoot       string
	DataRoot          string
	Architecture      string
	RuntimeExecutable string
	ManifestURL       string
	LegacyManifestURL string
	PublicKey         string
	Transport         UpdateTransport
	Control           RuntimeUpdateControl
	Probe             CandidateProbe
	Launcher          ProcessLauncher
	Health            HealthProber
	ControlToken      string
	Now               func() time.Time
	ActivationWait    time.Duration
	PollInterval      time.Duration
	IdleQuietPeriod   time.Duration
}

const preparedUpdateSchemaVersion = 1

var errRuntimeUpdateLocked = errors.New("runtime update lock is already held")

type PreparedUpdateState struct {
	SchemaVersion         int    `json:"schemaVersion"`
	ManifestSchemaVersion int    `json:"manifestSchemaVersion"`
	TargetVersion         string `json:"targetVersion"`
	RuntimeRevision       string `json:"runtimeRevision"`
	BridgeContractVersion string `json:"bridgeContractVersion"`
	Architecture          string `json:"architecture"`
	ArtifactSize          int64  `json:"artifactSize"`
	ArtifactSHA256        string `json:"artifactSha256"`
	Urgency               string `json:"urgency"`
	Deadline              string `json:"deadline,omitempty"`
	PreparedAt            string `json:"preparedAt"`
}

func (updater SignedRuntimeUpdater) Update(ctx context.Context, active ActiveRuntime, expected ExtensionIdentity) RuntimeUpdateAttempt {
	targetVersion := active.Version
	urgency := ""
	deadline := ""
	fail := func(phase, code, message string, retryable bool, remediation string) RuntimeUpdateAttempt {
		updater.audit(active.Version, targetVersion, phase, code)
		return RuntimeUpdateAttempt{
			Active: active, Phase: phase, TargetVersion: targetVersion,
			Urgency: urgency, Deadline: deadline, Code: code, Message: message,
			Retryable: retryable, Remediation: remediation,
		}
	}
	releaseLock, lockErr := acquireUpdateLock(updater.RuntimeRoot)
	if lockErr != nil {
		if !errors.Is(lockErr, errRuntimeUpdateLocked) {
			return fail(
				"staging",
				"internal_error",
				"AkuBrowser could not establish the Sidecar update lock.",
				true,
				"retry",
			)
		}
		return fail(
			"waiting_for_idle",
			"runtime_busy",
			"Another AkuSidecar update check is already active.",
			true,
			"wait",
		)
	}
	defer releaseLock()
	now := time.Now()
	if updater.Now != nil {
		now = updater.Now()
	}
	architecture := architectureOrDefault(updater.Architecture)
	manifestURL := updater.ManifestURL
	legacyRequest := expected.BridgeProtocol == nil
	if legacyRequest {
		manifestURL = updater.LegacyManifestURL
		if manifestURL == "" {
			manifestURL = legacyPlatformUpdateManifestURL(architecture)
		}
	} else if manifestURL == "" {
		manifestURL = platformUpdateManifestURL(architecture)
	}
	manifestData, readErr := updater.Transport.Read(ctx, manifestURL, maxUpdateManifestBytes)
	manifest, manifestErr := updater.decodeManifest(manifestData, expected, active, now.UTC(), architecture, legacyRequest)
	loadedPrepared := false
	if readErr != nil {
		var preparedErr error
		manifest, manifestData, loadedPrepared, preparedErr = updater.loadPreparedUpdate(expected, active, now.UTC(), architecture, legacyRequest)
		if preparedErr != nil || !loadedPrepared {
			return fail("checking", "update_check_failed", "AkuBrowser could not read the signed Sidecar update manifest.", true, "retry")
		}
	} else if manifestErr != nil {
		if errors.Is(manifestErr, errHostUpgradeRequired) {
			targetVersion, urgency, deadline = manifest.Version, manifest.Urgency, manifest.Deadline
			return fail("verifying", "host_upgrade_required", "The native update helper must be refreshed before this Sidecar update can apply.", false, "reinstall_runtime")
		}
		return fail("verifying", "signature_invalid", "The Sidecar update manifest could not be authenticated.", false, "contact_support")
	}
	targetVersion, urgency, deadline = manifest.Version, manifest.Urgency, manifest.Deadline
	if compareVersions(manifest.Version, active.Version) <= 0 {
		updater.clearPreparedUpdate()
		updater.audit(active.Version, manifest.Version, "idle", "")
		return RuntimeUpdateAttempt{Active: active, Phase: "idle", TargetVersion: manifest.Version}
	}

	candidatesRoot := filepath.Join(updater.RuntimeRoot, "candidates")
	if err := os.MkdirAll(candidatesRoot, 0o700); err != nil {
		return fail("staging", "download_failed", "AkuBrowser could not prepare update staging.", true, "retry")
	}
	archivePath := updater.preparedArchivePath()
	if !loadedPrepared {
		if existing, _, ok, _ := updater.loadPreparedUpdate(expected, active, now.UTC(), architecture, legacyRequest); ok &&
			existing.Version == manifest.Version && existing.Artifact == manifest.Artifact {
			loadedPrepared = true
		} else if err := updater.prepareUpdate(ctx, manifestData, manifest, architecture); err != nil {
			code := "download_failed"
			if errors.Is(err, errUpdateChecksum) {
				code = "checksum_invalid"
			}
			return fail("downloading", code, "The Sidecar update artifact failed verification.", code == "download_failed", "retry")
		}
	}

	candidateRoot, err := os.MkdirTemp(candidatesRoot, ".aku-candidate-")
	if err != nil {
		return fail("staging", "download_failed", "AkuBrowser could not create update staging.", true, "retry")
	}
	_ = os.Remove(candidateRoot)
	defer os.RemoveAll(candidateRoot)
	executableName := runtimeExecutableOrDefault(updater.RuntimeExecutable)
	if err := extractVerifiedRuntimeArchive(archivePath, candidateRoot, manifest.Version, architecture, executableName); err != nil {
		return fail("staging", "checksum_invalid", "The runtime update payload is incomplete or changed.", false, "contact_support")
	}
	candidateExecutable := filepath.Join(candidateRoot, executableName)
	candidateConfig := filepath.Join(candidateRoot, "config", "sidecar.json")
	databaseSchemaVersion := 0
	if !legacyRequest {
		databaseSchemaVersion = currentDatabaseSchemaVersion
	}
	if err := updater.Probe.Probe(ctx, candidateExecutable, candidateConfig, CandidateExpectation{
		Version: manifest.Version, BridgeContractVersion: manifest.BridgeContractVersion,
		DatabaseSchemaVersion: databaseSchemaVersion,
	}); err != nil {
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
		if updater.IdleQuietPeriod > 0 {
			timer := time.NewTimer(updater.IdleQuietPeriod)
			select {
			case <-ctx.Done():
				timer.Stop()
				return fail("waiting_for_idle", "runtime_busy", "The idle update handoff was interrupted.", true, "wait")
			case <-timer.C:
			}
			if ready, _, readinessErr = updater.Control.Readiness(ctx); readinessErr != nil || !ready {
				return fail("waiting_for_idle", "runtime_busy", "New activity postponed the Sidecar update.", true, "wait")
			}
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
		updater.clearPreparedUpdate()
		updater.audit(active.Version, newActive.Version, "idle", "")
		return RuntimeUpdateAttempt{Active: newActive, Phase: "idle", TargetVersion: newActive.Version, Urgency: urgency, Deadline: deadline}
	}

	if rollbackErr := updater.RollbackPending(ctx, newActive); rollbackErr != nil {
		return fail("rolling_back", "rollback_failed", "The candidate failed and the previous runtime could not be restarted.", false, "reinstall_runtime")
	}
	return fail("rolling_back", "candidate_health_failed", "The candidate failed its activation health gate; the previous runtime was restored.", true, "retry")
}

func acquireUpdateLock(runtimeRoot string) (func(), error) {
	if err := os.MkdirAll(runtimeRoot, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(runtimeRoot, "update.lock")
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := lockUpdateFile(file); err != nil {
		_ = file.Close()
		return nil, err
	}
	release := func() {
		_ = unlockUpdateFile(file)
		_ = file.Close()
	}
	if err := file.Truncate(0); err != nil {
		release()
		return nil, err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		release()
		return nil, err
	}
	if _, err := fmt.Fprintf(file, "%d\n", os.Getpid()); err != nil {
		release()
		return nil, err
	}
	if err := file.Sync(); err != nil {
		release()
		return nil, err
	}
	return release, nil
}

func (updater SignedRuntimeUpdater) Prepared(_ context.Context, active ActiveRuntime, expected ExtensionIdentity) RuntimeUpdateAttempt {
	if expected.BridgeProtocol == nil {
		return RuntimeUpdateAttempt{Active: active, Phase: "idle", TargetVersion: active.Version}
	}
	now := time.Now().UTC()
	if updater.Now != nil {
		now = updater.Now().UTC()
	}
	manifest, _, ok, err := updater.loadPreparedUpdate(
		expected, active, now, architectureOrDefault(updater.Architecture), false,
	)
	if err != nil {
		return RuntimeUpdateAttempt{
			Active: active, Phase: "verifying", TargetVersion: active.Version,
			Code: "signature_invalid", Message: "The prepared Sidecar update is invalid.",
			Retryable: false, Remediation: "contact_support",
		}
	}
	if !ok || compareVersions(manifest.Version, active.Version) <= 0 {
		return RuntimeUpdateAttempt{Active: active, Phase: "idle", TargetVersion: active.Version}
	}
	return RuntimeUpdateAttempt{
		Active: active, Phase: "waiting_for_idle", TargetVersion: manifest.Version,
		Urgency: manifest.Urgency, Deadline: manifest.Deadline,
	}
}

func (updater SignedRuntimeUpdater) decodeManifest(data []byte, expected ExtensionIdentity, active ActiveRuntime, now time.Time, architecture string, legacy bool) (VerifiedUpdateManifest, error) {
	if legacy {
		manifest, err := decodeAndVerifyUpdateManifest(data, updater.PublicKey, expected, active, now, architecture)
		if err != nil {
			return VerifiedUpdateManifest{}, err
		}
		return VerifiedUpdateManifest{
			SchemaVersion: manifest.SchemaVersion, Channel: manifest.Channel,
			Version: manifest.Version, RuntimeRevision: manifest.RuntimeRevision,
			BridgeContractVersion: manifest.BridgeContractVersion,
			PublishedAt:           manifest.PublishedAt, Artifact: manifest.Artifact,
		}, nil
	}
	return decodeAndVerifySidecarUpdateManifest(data, updater.PublicKey, expected, active, now, architecture)
}

func (updater SignedRuntimeUpdater) preparedRoot() string {
	return filepath.Join(updater.RuntimeRoot, "prepared")
}

func (updater SignedRuntimeUpdater) preparedArchivePath() string {
	return filepath.Join(updater.preparedRoot(), "artifact.zip")
}

func (updater SignedRuntimeUpdater) prepareUpdate(ctx context.Context, manifestData []byte, manifest VerifiedUpdateManifest, architecture string) error {
	root := updater.preparedRoot()
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(root, ".aku-sidecar-download-*.zip")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	_ = temporary.Close()
	defer os.Remove(temporaryPath)
	if err := updater.Transport.Download(ctx, manifest.Artifact, temporaryPath); err != nil {
		return err
	}
	if err := verifyUpdateArtifactFile(temporaryPath, manifest.Artifact); err != nil {
		return err
	}
	archivePath := updater.preparedArchivePath()
	if err := replaceFileAtomic(temporaryPath, archivePath); err != nil {
		return err
	}
	if err := writePrivateFileAtomic(filepath.Join(root, "manifest.json"), manifestData); err != nil {
		updater.clearPreparedUpdate()
		return err
	}
	now := time.Now().UTC()
	if updater.Now != nil {
		now = updater.Now().UTC()
	}
	state := PreparedUpdateState{
		SchemaVersion: preparedUpdateSchemaVersion, ManifestSchemaVersion: manifest.SchemaVersion,
		TargetVersion: manifest.Version, RuntimeRevision: manifest.RuntimeRevision,
		BridgeContractVersion: manifest.BridgeContractVersion, Architecture: architecture,
		ArtifactSize: manifest.Artifact.Size, ArtifactSHA256: manifest.Artifact.SHA256,
		Urgency: manifest.Urgency, Deadline: manifest.Deadline, PreparedAt: now.Format(time.RFC3339Nano),
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		updater.clearPreparedUpdate()
		return err
	}
	if err := writePrivateFileAtomic(filepath.Join(root, "state.json"), append(data, '\n')); err != nil {
		updater.clearPreparedUpdate()
		return err
	}
	updater.audit("", manifest.Version, "staging", "")
	return nil
}

func (updater SignedRuntimeUpdater) loadPreparedUpdate(expected ExtensionIdentity, active ActiveRuntime, now time.Time, architecture string, legacy bool) (VerifiedUpdateManifest, []byte, bool, error) {
	root := updater.preparedRoot()
	stateData, err := readBoundedFile(filepath.Join(root, "state.json"), 16*1024)
	if errors.Is(err, os.ErrNotExist) {
		return VerifiedUpdateManifest{}, nil, false, nil
	}
	if err != nil {
		return VerifiedUpdateManifest{}, nil, false, err
	}
	decoder := json.NewDecoder(bytes.NewReader(stateData))
	decoder.DisallowUnknownFields()
	var state PreparedUpdateState
	if err := decoder.Decode(&state); err != nil || ensureJSONEOF(decoder) != nil {
		return VerifiedUpdateManifest{}, nil, false, errors.New("prepared update state is invalid")
	}
	if state.SchemaVersion != preparedUpdateSchemaVersion || state.Architecture != architecture ||
		!versionPattern.MatchString(state.TargetVersion) || !revisionPattern.MatchString(state.RuntimeRevision) ||
		state.BridgeContractVersion != bridgeContract || state.ArtifactSize <= 0 ||
		state.ArtifactSize > maxUpdateArtifactBytes || !sha256Pattern.MatchString(state.ArtifactSHA256) {
		return VerifiedUpdateManifest{}, nil, false, errors.New("prepared update state metadata is invalid")
	}
	manifestData, err := readBoundedFile(filepath.Join(root, "manifest.json"), maxUpdateManifestBytes)
	if err != nil {
		return VerifiedUpdateManifest{}, nil, false, err
	}
	manifest, err := updater.decodeManifest(manifestData, expected, active, now, architecture, legacy)
	if err != nil {
		return VerifiedUpdateManifest{}, nil, false, err
	}
	if manifest.SchemaVersion != state.ManifestSchemaVersion || manifest.Version != state.TargetVersion ||
		manifest.RuntimeRevision != state.RuntimeRevision || manifest.BridgeContractVersion != state.BridgeContractVersion ||
		manifest.Artifact.Size != state.ArtifactSize || manifest.Artifact.SHA256 != state.ArtifactSHA256 ||
		manifest.Urgency != state.Urgency || manifest.Deadline != state.Deadline {
		return VerifiedUpdateManifest{}, nil, false, errors.New("prepared update state does not match its signed manifest")
	}
	if err := verifyUpdateArtifactFile(updater.preparedArchivePath(), manifest.Artifact); err != nil {
		return VerifiedUpdateManifest{}, nil, false, err
	}
	return manifest, manifestData, true, nil
}

func (updater SignedRuntimeUpdater) clearPreparedUpdate() {
	_ = os.RemoveAll(updater.preparedRoot())
}

func verifyUpdateArtifactFile(path string, artifact UpdateArtifact) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != artifact.Size {
		return errUpdateChecksum
	}
	hash := sha256.New()
	count, err := io.Copy(hash, io.LimitReader(file, artifact.Size+1))
	if err != nil || count != artifact.Size || hex.EncodeToString(hash.Sum(nil)) != artifact.SHA256 {
		return errUpdateChecksum
	}
	return nil
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
		filepath.Join(workingDirectory, runtimeExecutableOrDefault(updater.RuntimeExecutable)), workingDirectory,
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

func (OSCandidateProbe) Probe(ctx context.Context, executable, config string, expected CandidateExpectation) error {
	probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	command := exec.CommandContext(
		probeCtx,
		executable,
		"-config", config,
		"-runtime-candidate-probe",
		"-runtime-candidate-probe-schema", "2",
	)
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
		DatabaseSchemaVersion int    `json:"databaseSchemaVersion"`
	}
	decoder := json.NewDecoder(bytes.NewReader(output))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil || ensureJSONEOF(decoder) != nil {
		return errors.New("candidate probe response is invalid")
	}
	if value.Status != "ok" || value.Version != expected.Version || value.Runtime != "go" ||
		value.BridgeContractVersion != expected.BridgeContractVersion || value.ConfigVersion != 1 ||
		(expected.DatabaseSchemaVersion > 0 && value.DatabaseSchemaVersion != expected.DatabaseSchemaVersion) {
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
