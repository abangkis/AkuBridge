package main

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSignedRuntimeUpdaterActivatesHealthyCandidateAndKeepsOneRollback(t *testing.T) {
	fixture := newRuntimeUpdateFixture(t)
	attempt := fixture.updater.Update(context.Background(), fixture.active, fixture.expected)
	if !attempt.Succeeded() || attempt.Active.Version != "0.7.8" {
		t.Fatalf("attempt=%+v", attempt)
	}
	var current ActiveRuntime
	readJSONFileForTest(t, filepath.Join(fixture.root, "current.json"), &current)
	if current.Version != "0.7.8" || current.RollbackVersion == nil || *current.RollbackVersion != "0.7.4" {
		t.Fatalf("current=%+v", current)
	}
	if fixture.control.shutdownCalls != 1 || fixture.launcher.calls != 1 {
		t.Fatalf("shutdown=%d launches=%d", fixture.control.shutdownCalls, fixture.launcher.calls)
	}
	if _, err := os.Stat(filepath.Join(fixture.root, "versions", "0.7.4")); err != nil {
		t.Fatalf("rollback version removed: %v", err)
	}
	if data, err := os.ReadFile(filepath.Join(fixture.root, "versions", "0.7.8", ".activation-confirmed")); err != nil || string(data) != "0.7.8\n" {
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

func TestSignedRuntimeUpdaterCanUpgradeAnAlreadyStoppedRuntime(t *testing.T) {
	fixture := newRuntimeUpdateFixture(t)
	fixture.health.stoppedInitially = true
	attempt := fixture.updater.Update(context.Background(), fixture.active, fixture.expected)
	if !attempt.Succeeded() || attempt.Active.Version != "0.7.8" {
		t.Fatalf("attempt=%+v", attempt)
	}
	if fixture.control.shutdownCalls != 0 || fixture.launcher.calls != 1 {
		t.Fatalf("stopped runtime handoff shutdown=%d launches=%d", fixture.control.shutdownCalls, fixture.launcher.calls)
	}
}

func TestSignedRuntimeUpdaterReplacesOnlyAnUnactivatedInterruptedCandidate(t *testing.T) {
	fixture := newRuntimeUpdateFixture(t)
	orphan := filepath.Join(fixture.root, "versions", "0.7.8")
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
	if _, err := os.Stat(filepath.Join(fixture.root, "versions", "0.7.8")); !os.IsNotExist(err) {
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

func newRuntimeUpdateFixture(t *testing.T) runtimeUpdateFixture {
	t.Helper()
	active := ActiveRuntime{
		SchemaVersion: 1, Channel: "stable", Version: "0.7.4",
		RuntimeRevision: "source-adapters-v84", BridgeContractVersion: bridgeContract,
	}
	expected := ExtensionIdentity{
		Product: "AkuBrowser", ProductVersion: "0.7.8",
		RuntimeRevision: "source-adapters-v86", BridgeContractVersion: bridgeContract,
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
			URL:  "https://github.com/abangkis/AkuBrowser/releases/download/v0.7.8/AkuBrowserRuntime-0.7.8-windows-x64.zip",
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
		Transport: memoryUpdateTransport{manifest: manifestData, artifact: archiveData},
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

type memoryUpdateTransport struct{ manifest, artifact []byte }

func (transport memoryUpdateTransport) Read(context.Context, string, int64) ([]byte, error) {
	return append([]byte(nil), transport.manifest...), nil
}
func (transport memoryUpdateTransport) Download(_ context.Context, _ UpdateArtifact, destination string) error {
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

func (successfulCandidateProbe) Probe(context.Context, string, string, ExtensionIdentity) error {
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
	version := prober.expected.ProductVersion
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
