package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestSignedRuntimeUpdaterActivatesHealthyCandidateAndKeepsOneRollback(t *testing.T) {
	fixture := newRuntimeUpdateFixture(t)
	attempt := fixture.updater.Update(context.Background(), fixture.active, fixture.expected)
	if !attempt.Succeeded() || attempt.Active.Version != "0.7.9" {
		t.Fatalf("attempt=%+v", attempt)
	}
	var current ActiveRuntime
	readJSONFileForTest(t, filepath.Join(fixture.root, "current.json"), &current)
	if current.Version != "0.7.9" || current.RollbackVersion == nil || *current.RollbackVersion != "0.7.4" {
		t.Fatalf("current=%+v", current)
	}
	if fixture.control.shutdownCalls != 1 || fixture.launcher.calls != 1 {
		t.Fatalf("shutdown=%d launches=%d", fixture.control.shutdownCalls, fixture.launcher.calls)
	}
	if _, err := os.Stat(filepath.Join(fixture.root, "versions", "0.7.4")); err != nil {
		t.Fatalf("rollback version removed: %v", err)
	}
	if data, err := os.ReadFile(filepath.Join(fixture.root, "versions", "0.7.9", ".activation-confirmed")); err != nil || string(data) != "0.7.9\n" {
		t.Fatalf("activation confirmation=%q err=%v", data, err)
	}
}

func TestSignedRuntimeUpdaterDefersActivationWhileRuntimeIsBusy(t *testing.T) {
	fixture := newRuntimeUpdateFixture(t)
	fixture.control.ready = false
	attempt := fixture.updater.Update(context.Background(), fixture.active, fixture.expected)
	if attempt.Code != "runtime_busy" || attempt.Phase != "waiting_for_idle" {
		t.Fatalf("attempt=%+v", attempt)
	}
	if fixture.control.shutdownCalls != 0 || fixture.launcher.calls != 0 {
		t.Fatalf("busy update mutated runtime: shutdown=%d launches=%d", fixture.control.shutdownCalls, fixture.launcher.calls)
	}
	var current ActiveRuntime
	readJSONFileForTest(t, filepath.Join(fixture.root, "current.json"), &current)
	if current.Version != "0.7.4" {
		t.Fatalf("busy update changed current=%+v", current)
	}
}

func TestSignedRuntimeUpdaterClassifiesSignedMinimumHostUpgrade(t *testing.T) {
	fixture := newIndependentRuntimeUpdateFixture(t)
	publicKey, privateKey := updateTestKey()
	manifest := sidecarUpdateManifestForTest("0.8.1", "sidecar-runtime-v101", legacyWindowsArchitecture)
	manifest.MinHostVersion = "0.8.1"
	fixture.transport.manifest = signSidecarUpdateManifestForTest(t, privateKey, manifest)
	fixture.updater.PublicKey = base64.StdEncoding.EncodeToString(publicKey)

	attempt := fixture.updater.Update(context.Background(), fixture.active, fixture.expected)

	if attempt.Code != "host_upgrade_required" || attempt.Retryable || attempt.Remediation != "reinstall_runtime" ||
		attempt.TargetVersion != "0.8.1" {
		t.Fatalf("host upgrade attempt=%+v", attempt)
	}
}

func TestSignedRuntimeUpdaterDoesNotOfferHostInstallerToIncompatibleBridge(t *testing.T) {
	fixture := newIndependentRuntimeUpdateFixture(t)
	publicKey, privateKey := updateTestKey()
	manifest := sidecarUpdateManifestForTest("0.8.1", "sidecar-runtime-v101", legacyWindowsArchitecture)
	manifest.MinHostVersion = "0.8.0"
	manifest.BridgeCompatibility.MinVersion = bridgeProtocolVersion + 1
	manifest.BridgeCompatibility.MaxVersion = bridgeProtocolVersion + 1
	fixture.transport.manifest = signSidecarUpdateManifestForTest(t, privateKey, manifest)
	fixture.updater.PublicKey = base64.StdEncoding.EncodeToString(publicKey)

	attempt := fixture.updater.Update(context.Background(), fixture.active, fixture.expected)

	if attempt.Code == "host_upgrade_required" || attempt.TargetVersion == "0.8.1" {
		t.Fatalf("incompatible Bridge received installer authority: %+v", attempt)
	}
}

func TestSignedRuntimeUpdaterDefersWhenAnotherHostOwnsTheUpdateLock(t *testing.T) {
	fixture := newRuntimeUpdateFixture(t)
	owner := startUpdateLockOwner(t, fixture.root)

	attempt := fixture.updater.Update(context.Background(), fixture.active, fixture.expected)

	if attempt.Code != "runtime_busy" || attempt.Phase != "waiting_for_idle" || !attempt.Retryable {
		t.Fatalf("attempt=%+v", attempt)
	}
	if fixture.control.shutdownCalls != 0 || fixture.launcher.calls != 0 {
		t.Fatalf("locked update mutated runtime: shutdown=%d launches=%d", fixture.control.shutdownCalls, fixture.launcher.calls)
	}
	owner.stop(t)
}

func TestUpdateLockRecoversAfterOwnerProcessCrashes(t *testing.T) {
	root := t.TempDir()
	owner := startUpdateLockOwner(t, root)
	if _, err := acquireUpdateLock(root); !errors.Is(err, errRuntimeUpdateLocked) {
		t.Fatalf("live owner did not exclude another process: %v", err)
	}
	owner.crash(t)

	if _, err := os.Stat(filepath.Join(root, "update.lock")); err != nil {
		t.Fatalf("abandoned lock file is unavailable: %v", err)
	}
	release, err := acquireUpdateLock(root)
	if err != nil {
		t.Fatalf("OS did not release the crashed process lock: %v", err)
	}
	release()
}

const updateLockHelperEnvironment = "AKU_TEST_UPDATE_LOCK_HELPER"
const updateLockRootEnvironment = "AKU_TEST_UPDATE_LOCK_ROOT"

func TestUpdateLockHelperProcess(t *testing.T) {
	if os.Getenv(updateLockHelperEnvironment) != "1" {
		return
	}
	release, err := acquireUpdateLock(os.Getenv(updateLockRootEnvironment))
	if err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "acquire helper update lock: %v\n", err)
		os.Exit(2)
	}
	_, _ = fmt.Fprintln(os.Stdout, "locked")
	_, _ = io.Copy(io.Discard, os.Stdin)
	release()
}

type updateLockOwner struct {
	command *exec.Cmd
	stdin   io.WriteCloser
	stderr  *bytes.Buffer
}

func startUpdateLockOwner(t *testing.T, root string) *updateLockOwner {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^TestUpdateLockHelperProcess$")
	command.Env = append(os.Environ(),
		updateLockHelperEnvironment+"=1",
		updateLockRootEnvironment+"="+root,
	)
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stderr := &bytes.Buffer{}
	command.Stderr = stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	owner := &updateLockOwner{command: command, stdin: stdin, stderr: stderr}
	t.Cleanup(func() {
		if command.ProcessState != nil {
			return
		}
		_ = stdin.Close()
		_ = command.Process.Kill()
		_ = command.Wait()
	})
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil || line != "locked\n" {
		_ = command.Process.Kill()
		_ = command.Wait()
		t.Fatalf("update lock helper did not acquire lock: line=%q err=%v stderr=%s", line, err, stderr.String())
	}
	return owner
}

func (owner *updateLockOwner) stop(t *testing.T) {
	t.Helper()
	if err := owner.stdin.Close(); err != nil {
		t.Fatal(err)
	}
	if err := owner.command.Wait(); err != nil {
		t.Fatalf("update lock helper exit: %v stderr=%s", err, owner.stderr.String())
	}
}

func (owner *updateLockOwner) crash(t *testing.T) {
	t.Helper()
	if err := owner.command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := owner.command.Wait(); err == nil {
		t.Fatal("crashed update lock helper exited successfully")
	}
}

func TestSignedRuntimeUpdaterStagesIndependentSidecarOnceAndResumesOffline(t *testing.T) {
	active := ActiveRuntime{
		SchemaVersion: 1, Channel: "stable", Version: "0.7.4",
		RuntimeRevision: "sidecar-runtime-v84", BridgeContractVersion: bridgeContract,
	}
	expected := sidecarBridgeIdentityForTest()
	root := writeActiveRuntime(t, active)
	if err := os.MkdirAll(filepath.Join(root, "versions", active.Version), 0o700); err != nil {
		t.Fatal(err)
	}

	targetVersion := "0.8.1"
	archivePath := filepath.Join(t.TempDir(), "sidecar.zip")
	writeRuntimeArchiveVersionForTest(t, archivePath, map[string][]byte{
		"AkuSidecar.exe":      []byte("independent-sidecar"),
		"config/sidecar.json": []byte(`{"version":1}`),
	}, targetVersion, legacyWindowsArchitecture)
	archiveData, err := os.ReadFile(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	archiveHash := sha256.Sum256(archiveData)
	publicKey, privateKey := updateTestKey()
	manifest := sidecarUpdateManifestForTest(targetVersion, "sidecar-runtime-v101", legacyWindowsArchitecture)
	manifest.Urgency = "recommended"
	manifest.Artifact.Size = int64(len(archiveData))
	manifest.Artifact.SHA256 = hex.EncodeToString(archiveHash[:])
	manifestData := signSidecarUpdateManifestForTest(t, privateKey, manifest)

	transport := &memoryUpdateTransport{manifest: manifestData, artifact: archiveData}
	control := &fakeRuntimeUpdateControl{ready: false}
	launcher := &updateRecordingLauncher{}
	health := &updateHealthProber{
		launcher: launcher, expected: expected, active: active, candidateVersion: targetVersion,
	}
	candidateProbe := &recordingCandidateProbe{}
	updater := SignedRuntimeUpdater{
		RuntimeRoot: root, DataRoot: filepath.Join(t.TempDir(), "data"),
		PublicKey: base64.StdEncoding.EncodeToString(publicKey),
		Transport: transport, Control: control, Probe: candidateProbe,
		Launcher: launcher, Health: health, ControlToken: string(make([]byte, 64)),
		Now:            func() time.Time { return time.Date(2026, 8, 12, 1, 0, 0, 0, time.UTC) },
		ActivationWait: 5 * time.Millisecond, PollInterval: time.Millisecond,
	}

	deferred := updater.Update(context.Background(), active, expected)
	if deferred.Code != "runtime_busy" || deferred.TargetVersion != targetVersion || deferred.Urgency != "recommended" {
		t.Fatalf("deferred=%+v", deferred)
	}
	if transport.downloadCalls != 1 || transport.readCalls != 1 {
		t.Fatalf("initial transport calls: reads=%d downloads=%d", transport.readCalls, transport.downloadCalls)
	}
	prepared := updater.Prepared(context.Background(), active, expected)
	if prepared.Phase != "waiting_for_idle" || prepared.TargetVersion != targetVersion || prepared.Urgency != "recommended" {
		t.Fatalf("prepared=%+v", prepared)
	}
	if candidateProbe.last.Version != targetVersion ||
		candidateProbe.last.DatabaseSchemaVersion != currentDatabaseSchemaVersion {
		t.Fatalf("candidate expectation=%+v", candidateProbe.last)
	}

	control.ready = true
	transport.readErr = errors.New("offline")
	completed := updater.Update(context.Background(), active, expected)
	if !completed.Succeeded() || completed.Active.Version != targetVersion {
		t.Fatalf("completed=%+v", completed)
	}
	if transport.downloadCalls != 1 || transport.readCalls != 2 {
		t.Fatalf("resume transport calls: reads=%d downloads=%d", transport.readCalls, transport.downloadCalls)
	}
	if _, err := os.Stat(filepath.Join(root, "prepared")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("prepared payload survived activation: %v", err)
	}
}

func TestSignedRuntimeUpdaterRejectsCorruptedPreparedArtifactOffline(t *testing.T) {
	fixture := newIndependentRuntimeUpdateFixture(t)
	fixture.control.ready = false
	deferred := fixture.updater.Update(context.Background(), fixture.active, fixture.expected)
	if deferred.Code != "runtime_busy" {
		t.Fatalf("deferred=%+v", deferred)
	}
	if err := os.WriteFile(fixture.updater.preparedArchivePath(), []byte("corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	fixture.transport.readErr = errors.New("offline")
	result := fixture.updater.Update(context.Background(), fixture.active, fixture.expected)
	if result.Code != "update_check_failed" || !result.Retryable {
		t.Fatalf("result=%+v", result)
	}
	if fixture.transport.downloadCalls != 1 {
		t.Fatalf("corrupted prepared artifact triggered a second download: %d", fixture.transport.downloadCalls)
	}
}

func TestSignedRuntimeUpdaterCanUpgradeAnAlreadyStoppedRuntime(t *testing.T) {
	fixture := newRuntimeUpdateFixture(t)
	fixture.health.stoppedInitially = true
	attempt := fixture.updater.Update(context.Background(), fixture.active, fixture.expected)
	if !attempt.Succeeded() || attempt.Active.Version != "0.7.9" {
		t.Fatalf("attempt=%+v", attempt)
	}
	if fixture.control.shutdownCalls != 0 || fixture.launcher.calls != 1 {
		t.Fatalf("stopped runtime handoff shutdown=%d launches=%d", fixture.control.shutdownCalls, fixture.launcher.calls)
	}
}

func TestSignedRuntimeUpdaterReplacesOnlyAnUnactivatedInterruptedCandidate(t *testing.T) {
	fixture := newRuntimeUpdateFixture(t)
	orphan := filepath.Join(fixture.root, "versions", "0.7.9")
	if err := os.MkdirAll(orphan, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(orphan, "orphan.txt"), []byte("interrupted"), 0o600); err != nil {
		t.Fatal(err)
	}
	attempt := fixture.updater.Update(context.Background(), fixture.active, fixture.expected)
	if !attempt.Succeeded() {
		t.Fatalf("attempt=%+v", attempt)
	}
	if _, err := os.Stat(filepath.Join(orphan, "orphan.txt")); !os.IsNotExist(err) {
		t.Fatalf("interrupted candidate survived activation: %v", err)
	}
}

func TestSignedRuntimeUpdaterRollsBackFailedCandidate(t *testing.T) {
	fixture := newRuntimeUpdateFixture(t)
	fixture.health.failCandidate = true
	attempt := fixture.updater.Update(context.Background(), fixture.active, fixture.expected)
	if attempt.Code != "candidate_health_failed" || attempt.Phase != "rolling_back" {
		t.Fatalf("attempt=%+v", attempt)
	}
	if fixture.launcher.calls != 2 {
		t.Fatalf("expected candidate and rollback launches, got %d", fixture.launcher.calls)
	}
	var current ActiveRuntime
	readJSONFileForTest(t, filepath.Join(fixture.root, "current.json"), &current)
	if current.Version != "0.7.4" {
		t.Fatalf("rollback current=%+v", current)
	}
	if _, err := os.Stat(filepath.Join(fixture.root, "versions", "0.7.9")); !os.IsNotExist(err) {
		t.Fatalf("failed candidate retained with authority: %v", err)
	}
}

type runtimeUpdateFixture struct {
	root     string
	active   ActiveRuntime
	expected ExtensionIdentity
	control  *fakeRuntimeUpdateControl
	launcher *updateRecordingLauncher
	health   *updateHealthProber
	updater  SignedRuntimeUpdater
}

type independentRuntimeUpdateFixture struct {
	active    ActiveRuntime
	expected  ExtensionIdentity
	control   *fakeRuntimeUpdateControl
	transport *memoryUpdateTransport
	updater   SignedRuntimeUpdater
}

func newIndependentRuntimeUpdateFixture(t *testing.T) independentRuntimeUpdateFixture {
	t.Helper()
	active := ActiveRuntime{
		SchemaVersion: 1, Channel: "stable", Version: "0.7.4",
		RuntimeRevision: "sidecar-runtime-v84", BridgeContractVersion: bridgeContract,
	}
	expected := sidecarBridgeIdentityForTest()
	root := writeActiveRuntime(t, active)
	if err := os.MkdirAll(filepath.Join(root, "versions", active.Version), 0o700); err != nil {
		t.Fatal(err)
	}
	targetVersion := "0.8.1"
	archivePath := filepath.Join(t.TempDir(), "sidecar.zip")
	writeRuntimeArchiveVersionForTest(t, archivePath, map[string][]byte{
		"AkuSidecar.exe":      []byte("independent-sidecar"),
		"config/sidecar.json": []byte(`{"version":1}`),
	}, targetVersion, legacyWindowsArchitecture)
	archiveData, err := os.ReadFile(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	archiveHash := sha256.Sum256(archiveData)
	publicKey, privateKey := updateTestKey()
	manifest := sidecarUpdateManifestForTest(targetVersion, "sidecar-runtime-v101", legacyWindowsArchitecture)
	manifest.Artifact.Size = int64(len(archiveData))
	manifest.Artifact.SHA256 = hex.EncodeToString(archiveHash[:])
	transport := &memoryUpdateTransport{
		manifest: signSidecarUpdateManifestForTest(t, privateKey, manifest), artifact: archiveData,
	}
	control := &fakeRuntimeUpdateControl{ready: true}
	launcher := &updateRecordingLauncher{}
	updater := SignedRuntimeUpdater{
		RuntimeRoot: root, DataRoot: filepath.Join(t.TempDir(), "data"),
		PublicKey: base64.StdEncoding.EncodeToString(publicKey), Transport: transport,
		Control: control, Probe: successfulCandidateProbe{}, Launcher: launcher,
		Health: &updateHealthProber{
			launcher: launcher, expected: expected, active: active, candidateVersion: targetVersion,
		},
		ControlToken:   string(make([]byte, 64)),
		Now:            func() time.Time { return time.Date(2026, 8, 12, 1, 0, 0, 0, time.UTC) },
		ActivationWait: 5 * time.Millisecond, PollInterval: time.Millisecond,
	}
	return independentRuntimeUpdateFixture{
		active: active, expected: expected, control: control, transport: transport, updater: updater,
	}
}

func newRuntimeUpdateFixture(t *testing.T) runtimeUpdateFixture {
	t.Helper()
	active := ActiveRuntime{
		SchemaVersion: 1, Channel: "stable", Version: "0.7.4",
		RuntimeRevision: "source-adapters-v84", BridgeContractVersion: bridgeContract,
	}
	expected := ExtensionIdentity{
		Product: "AkuBrowser", ProductVersion: "0.7.9",
		RuntimeRevision: "source-adapters-v91", BridgeContractVersion: bridgeContract,
	}
	root := writeActiveRuntime(t, active)
	if err := os.MkdirAll(filepath.Join(root, "versions", active.Version), 0o700); err != nil {
		t.Fatal(err)
	}
	archivePath := filepath.Join(t.TempDir(), "runtime.zip")
	writeRuntimeArchiveForTest(t, archivePath, map[string][]byte{
		"AkuSidecar.exe":      []byte("signed-sidecar"),
		"config/sidecar.json": []byte(`{"version":1}`),
	})
	archiveData, err := os.ReadFile(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	archiveHash := sha256.Sum256(archiveData)
	publicKey, privateKey := updateTestKey()
	manifest := SignedUpdateManifest{
		SchemaVersion: 1, Product: "AkuBrowser", Channel: "stable",
		Version: expected.ProductVersion, RuntimeRevision: expected.RuntimeRevision,
		BridgeContractVersion: expected.BridgeContractVersion,
		PublishedAt:           "2026-07-29T00:00:00Z",
		Artifact: UpdateArtifact{
			URL:  "https://github.com/abangkis/AkuBrowser/releases/download/v0.7.9/AkuBrowserRuntime-0.7.9-windows-x64.zip",
			Size: int64(len(archiveData)), SHA256: hex.EncodeToString(archiveHash[:]),
		},
		Signature: UpdateSignature{Algorithm: "ed25519", KeyID: updateSigningKeyID},
	}
	payload, _ := json.Marshal(manifest.unsigned())
	manifest.Signature.Value = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, payload))
	manifestData, _ := json.Marshal(manifest)
	control := &fakeRuntimeUpdateControl{ready: true}
	launcher := &updateRecordingLauncher{}
	health := &updateHealthProber{launcher: launcher, expected: expected, active: active}
	updater := SignedRuntimeUpdater{
		RuntimeRoot: root, DataRoot: filepath.Join(t.TempDir(), "data"),
		PublicKey: base64.StdEncoding.EncodeToString(publicKey),
		Transport: &memoryUpdateTransport{manifest: manifestData, artifact: archiveData},
		Control:   control, Probe: successfulCandidateProbe{},
		Launcher: launcher, Health: health, ControlToken: string(make([]byte, 64)),
		Now:            func() time.Time { return time.Date(2026, 7, 29, 1, 0, 0, 0, time.UTC) },
		ActivationWait: 5 * time.Millisecond, PollInterval: time.Millisecond,
	}
	return runtimeUpdateFixture{
		root: root, active: active, expected: expected, control: control,
		launcher: launcher, health: health, updater: updater,
	}
}

type memoryUpdateTransport struct {
	manifest, artifact       []byte
	readErr, downloadErr     error
	readCalls, downloadCalls int
}

func (transport *memoryUpdateTransport) Read(context.Context, string, int64) ([]byte, error) {
	transport.readCalls++
	if transport.readErr != nil {
		return nil, transport.readErr
	}
	return append([]byte(nil), transport.manifest...), nil
}

func (transport *memoryUpdateTransport) Download(_ context.Context, _ UpdateArtifact, destination string) error {
	transport.downloadCalls++
	if transport.downloadErr != nil {
		return transport.downloadErr
	}
	return os.WriteFile(destination, transport.artifact, 0o600)
}

type fakeRuntimeUpdateControl struct {
	ready         bool
	shutdownCalls int
}

func (control *fakeRuntimeUpdateControl) Readiness(context.Context) (bool, string, error) {
	if control.ready {
		return true, "idle", nil
	}
	return false, "active_session", nil
}
func (control *fakeRuntimeUpdateControl) ShutdownIfIdle(context.Context, string) error {
	control.shutdownCalls++
	return nil
}
func (*fakeRuntimeUpdateControl) WaitStopped(context.Context) error { return nil }

type successfulCandidateProbe struct{}

func (successfulCandidateProbe) Probe(context.Context, string, string, CandidateExpectation) error {
	return nil
}

type recordingCandidateProbe struct {
	last CandidateExpectation
}

func (probe *recordingCandidateProbe) Probe(_ context.Context, _, _ string, expected CandidateExpectation) error {
	probe.last = expected
	return nil
}

type updateRecordingLauncher struct{ calls int }

func (launcher *updateRecordingLauncher) Start(string, string, string, string, string) error {
	launcher.calls++
	return nil
}

type updateHealthProber struct {
	launcher         *updateRecordingLauncher
	expected         ExtensionIdentity
	active           ActiveRuntime
	candidateVersion string
	failCandidate    bool
	stoppedInitially bool
}

func (prober *updateHealthProber) Probe(context.Context) (ProbeResult, error) {
	if prober.stoppedInitially && prober.launcher.calls == 0 {
		return ProbeResult{Reachable: false}, nil
	}
	if prober.failCandidate && prober.launcher.calls == 1 {
		return ProbeResult{Reachable: false}, nil
	}
	version := prober.candidateVersion
	if version == "" {
		version = prober.expected.ProductVersion
	}
	if prober.launcher.calls == 0 || prober.launcher.calls > 1 {
		version = prober.active.Version
	}
	return ProbeResult{Reachable: true, Health: Health{
		Status: "ok", Version: version, Runtime: "go",
		BridgeContractVersion: bridgeContract, InstanceEpoch: "runtime-update-test",
	}}, nil
}

func readJSONFileForTest(t *testing.T, path string, target any) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, target); err != nil {
		t.Fatal(err)
	}
}
