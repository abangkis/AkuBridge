package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestSignedUpdateManifestAuthenticatesExactUpgrade(t *testing.T) {
	publicKey, privateKey := updateTestKey()
	active := ActiveRuntime{
		SchemaVersion: 1, Channel: "stable", Version: "0.7.4",
		RuntimeRevision: "source-adapters-v84", BridgeContractVersion: bridgeContract,
	}
	expected := ExtensionIdentity{
		Product: "AkuBrowser", ProductVersion: "0.7.9",
		RuntimeRevision: "source-adapters-v91", BridgeContractVersion: bridgeContract,
	}
	data := signedUpdateManifestForTest(t, privateKey, expected)
	manifest, err := decodeAndVerifyUpdateManifest(
		data, base64.StdEncoding.EncodeToString(publicKey), expected, active,
		time.Date(2026, 7, 29, 1, 0, 0, 0, time.UTC),
	)
	if err != nil {
		t.Fatalf("verify update manifest: %v", err)
	}
	if manifest.Version != expected.ProductVersion || manifest.Artifact.Size != 1234 {
		t.Fatalf("manifest=%+v", manifest)
	}
}

func TestSignedUpdateManifestFailsClosedForTamperAndDowngrade(t *testing.T) {
	publicKey, privateKey := updateTestKey()
	active := ActiveRuntime{
		SchemaVersion: 1, Channel: "stable", Version: "0.7.4",
		RuntimeRevision: "source-adapters-v84", BridgeContractVersion: bridgeContract,
	}
	expected := ExtensionIdentity{
		Product: "AkuBrowser", ProductVersion: "0.7.9",
		RuntimeRevision: "source-adapters-v91", BridgeContractVersion: bridgeContract,
	}
	data := signedUpdateManifestForTest(t, privateKey, expected)
	tampered := strings.Replace(string(data), `"size":1234`, `"size":1235`, 1)
	if _, err := decodeAndVerifyUpdateManifest(
		[]byte(tampered), base64.StdEncoding.EncodeToString(publicKey), expected, active,
		time.Date(2026, 7, 29, 1, 0, 0, 0, time.UTC),
	); err == nil || !strings.Contains(err.Error(), "signature") {
		t.Fatalf("tampered manifest error=%v", err)
	}

	expected.ProductVersion = "0.7.3"
	expected.RuntimeRevision = "source-adapters-v83"
	data = signedUpdateManifestForTest(t, privateKey, expected)
	if _, err := decodeAndVerifyUpdateManifest(
		data, base64.StdEncoding.EncodeToString(publicKey), expected, active,
		time.Date(2026, 7, 29, 1, 0, 0, 0, time.UTC),
	); err == nil || !strings.Contains(err.Error(), "newer") {
		t.Fatalf("downgrade error=%v", err)
	}
}

func TestUpdateManifestRejectsAnotherReleaseOrigin(t *testing.T) {
	_, privateKey := updateTestKey()
	expected := ExtensionIdentity{
		Product: "AkuBrowser", ProductVersion: "0.7.9",
		RuntimeRevision: "source-adapters-v91", BridgeContractVersion: bridgeContract,
	}
	data := signedUpdateManifestForTest(t, privateKey, expected)
	var manifest SignedUpdateManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest.Artifact.URL = "https://github.com/attacker/AkuBrowser/releases/download/v0.7.9/AkuBrowserRuntime-0.7.9-windows-x64.zip"
	payload, _ := json.Marshal(manifest.unsigned())
	manifest.Signature.Value = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, payload))
	data, _ = json.Marshal(manifest)
	active := ActiveRuntime{SchemaVersion: 1, Channel: "stable", Version: "0.7.4", RuntimeRevision: "source-adapters-v84", BridgeContractVersion: bridgeContract}
	if _, err := decodeAndVerifyUpdateManifest(
		data, base64.StdEncoding.EncodeToString(privateKey.Public().(ed25519.PublicKey)),
		expected, active, time.Date(2026, 7, 29, 1, 0, 0, 0, time.UTC),
	); err == nil || !strings.Contains(err.Error(), "fixed release origin") {
		t.Fatalf("origin error=%v", err)
	}
}

func TestSignedUpdateManifestAcceptsExactMacOSUniversalArtifact(t *testing.T) {
	publicKey, privateKey := updateTestKey()
	active := ActiveRuntime{
		SchemaVersion: 1, Channel: "stable", Version: "0.7.4",
		RuntimeRevision: "source-adapters-v84", BridgeContractVersion: bridgeContract,
	}
	expected := ExtensionIdentity{
		Product: "AkuBrowser", ProductVersion: "0.7.9",
		RuntimeRevision: "source-adapters-v91", BridgeContractVersion: bridgeContract,
	}
	data := signedUpdateManifestForTest(t, privateKey, expected, "macos-universal")
	if _, err := decodeAndVerifyUpdateManifest(
		data, base64.StdEncoding.EncodeToString(publicKey), expected, active,
		time.Date(2026, 8, 7, 1, 0, 0, 0, time.UTC), "macos-universal",
	); err != nil {
		t.Fatalf("verify macOS update manifest: %v", err)
	}
}

func TestSignedSidecarUpdateManifestAuthenticatesIndependentTarget(t *testing.T) {
	publicKey, privateKey := updateTestKey()
	active := ActiveRuntime{
		SchemaVersion: 1, Channel: "stable", Version: "0.7.4",
		RuntimeRevision: "sidecar-runtime-v84", BridgeContractVersion: bridgeContract,
	}
	expected := sidecarBridgeIdentityForTest()
	manifest := sidecarUpdateManifestForTest("0.8.1", "sidecar-runtime-v101", "windows-x64")
	data := signSidecarUpdateManifestForTest(t, privateKey, manifest)

	verified, err := decodeAndVerifySidecarUpdateManifest(
		data, base64.StdEncoding.EncodeToString(publicKey), expected, active,
		time.Date(2026, 8, 12, 1, 0, 0, 0, time.UTC), "windows-x64",
	)
	if err != nil {
		t.Fatalf("verify independent Sidecar update manifest: %v", err)
	}
	if verified.Version != "0.8.1" || verified.RuntimeRevision != "sidecar-runtime-v101" ||
		verified.Urgency != "routine" {
		t.Fatalf("manifest=%+v", verified)
	}
	if verified.Version == expected.ProductVersion {
		t.Fatal("Sidecar target unexpectedly remained coupled to the Bridge version")
	}
}

func TestSignedSidecarUpdateManifestRejectsIncompatibleHostBridgeAndDatabase(t *testing.T) {
	publicKey, privateKey := updateTestKey()
	active := ActiveRuntime{
		SchemaVersion: 1, Channel: "stable", Version: "0.7.4",
		RuntimeRevision: "sidecar-runtime-v84", BridgeContractVersion: bridgeContract,
	}
	expected := sidecarBridgeIdentityForTest()
	now := time.Date(2026, 8, 12, 1, 0, 0, 0, time.UTC)

	tests := []struct {
		name       string
		mutate     func(*SignedSidecarUpdateManifest)
		wantSubstr string
	}{
		{
			name: "host too old",
			mutate: func(manifest *SignedSidecarUpdateManifest) {
				manifest.MinHostVersion = "0.8.0"
			},
			wantSubstr: "host is too old",
		},
		{
			name: "Bridge protocol excluded",
			mutate: func(manifest *SignedSidecarUpdateManifest) {
				manifest.BridgeCompatibility.MinVersion = 3
				manifest.BridgeCompatibility.MaxVersion = 3
			},
			wantSubstr: "outside the Sidecar compatibility range",
		},
		{
			name: "Bridge capability missing",
			mutate: func(manifest *SignedSidecarUpdateManifest) {
				manifest.BridgeCompatibility.RequiredCapabilities = append(
					manifest.BridgeCompatibility.RequiredCapabilities, "update.future_required",
				)
			},
			wantSubstr: "missing required capability",
		},
		{
			name: "database schema excluded",
			mutate: func(manifest *SignedSidecarUpdateManifest) {
				manifest.DatabaseCompatibility.MinSchemaVersion = currentDatabaseSchemaVersion + 1
				manifest.DatabaseCompatibility.MaxSchemaVersion = currentDatabaseSchemaVersion + 1
			},
			wantSubstr: "not rollback-safe",
		},
		{
			name: "rollback not guaranteed",
			mutate: func(manifest *SignedSidecarUpdateManifest) {
				manifest.DatabaseCompatibility.RollbackSafe = false
			},
			wantSubstr: "not rollback-safe",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			manifest := sidecarUpdateManifestForTest("0.8.1", "sidecar-runtime-v101", "windows-x64")
			test.mutate(&manifest)
			data := signSidecarUpdateManifestForTest(t, privateKey, manifest)
			_, err := decodeAndVerifySidecarUpdateManifest(
				data, base64.StdEncoding.EncodeToString(publicKey), expected, active, now, "windows-x64",
			)
			if err == nil || !strings.Contains(err.Error(), test.wantSubstr) {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func TestSignedSidecarUpdateManifestRequiresBoundedDeadlineSemantics(t *testing.T) {
	publicKey, privateKey := updateTestKey()
	active := ActiveRuntime{
		SchemaVersion: 1, Channel: "stable", Version: "0.7.4",
		RuntimeRevision: "sidecar-runtime-v84", BridgeContractVersion: bridgeContract,
	}
	expected := sidecarBridgeIdentityForTest()
	manifest := sidecarUpdateManifestForTest("0.8.1", "sidecar-runtime-v101", "windows-x64")
	manifest.Urgency = "routine"
	manifest.Deadline = "2026-08-13T00:00:00Z"
	data := signSidecarUpdateManifestForTest(t, privateKey, manifest)
	_, err := decodeAndVerifySidecarUpdateManifest(
		data, base64.StdEncoding.EncodeToString(publicKey), expected, active,
		time.Date(2026, 8, 12, 1, 0, 0, 0, time.UTC), "windows-x64",
	)
	if err == nil || !strings.Contains(err.Error(), "deadline") {
		t.Fatalf("deadline error=%v", err)
	}
}

func TestSemanticVersionPrereleasePrecedence(t *testing.T) {
	for _, test := range []struct {
		left, right string
		want        int
	}{
		{"0.8.0-rc.1", "0.8.0", -1},
		{"0.8.0-rc.2", "0.8.0-rc.10", -1},
		{"0.8.0-beta.11", "0.8.0-rc.1", -1},
		{"0.8.0", "0.8.0-rc.9", 1},
	} {
		if got := compareVersions(test.left, test.right); got != test.want {
			t.Fatalf("compareVersions(%q, %q)=%d want %d", test.left, test.right, got, test.want)
		}
	}
}

func TestSidecarManifestTreatsPrereleaseHostAsOlderThanFinalMinimum(t *testing.T) {
	previous := runtimeHostVersion
	runtimeHostVersion = "0.8.0-rc.1"
	t.Cleanup(func() { runtimeHostVersion = previous })
	publicKey, privateKey := updateTestKey()
	manifest := sidecarUpdateManifestForTest("0.8.1", "sidecar-runtime-v101", "windows-x64")
	manifest.MinHostVersion = "0.8.0"
	data := signSidecarUpdateManifestForTest(t, privateKey, manifest)
	_, err := decodeAndVerifySidecarUpdateManifest(
		data, base64.StdEncoding.EncodeToString(publicKey), sidecarBridgeIdentityForTest(), activeFixture(),
		time.Date(2026, 8, 12, 1, 0, 0, 0, time.UTC), "windows-x64",
	)
	if !errors.Is(err, errHostUpgradeRequired) {
		t.Fatalf("prerelease host error=%v", err)
	}
}

func signedUpdateManifestForTest(t *testing.T, privateKey ed25519.PrivateKey, expected ExtensionIdentity, platforms ...string) []byte {
	t.Helper()
	architecture := legacyWindowsArchitecture
	if len(platforms) > 0 {
		architecture = platforms[0]
	}
	manifest := SignedUpdateManifest{
		SchemaVersion: 1, Product: "AkuBrowser", Channel: "stable",
		Version: expected.ProductVersion, RuntimeRevision: expected.RuntimeRevision,
		BridgeContractVersion: expected.BridgeContractVersion,
		PublishedAt:           "2026-07-29T00:00:00Z",
		Artifact: UpdateArtifact{
			URL: "https://github.com/abangkis/AkuBrowser/releases/download/v" + expected.ProductVersion +
				"/AkuBrowserRuntime-" + expected.ProductVersion + "-" + architecture + ".zip",
			Size: 1234, SHA256: strings.Repeat("a", 64),
		},
		Signature: UpdateSignature{Algorithm: "ed25519", KeyID: updateSigningKeyID},
	}
	payload, err := json.Marshal(manifest.unsigned())
	if err != nil {
		t.Fatal(err)
	}
	manifest.Signature.Value = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, payload))
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func sidecarBridgeIdentityForTest() ExtensionIdentity {
	return ExtensionIdentity{
		Product: "AkuBrowser", ProductVersion: "0.7.9",
		RuntimeRevision: "bridge-release-v91", BridgeContractVersion: bridgeContract,
		BridgeProtocol: &BridgeProtocol{Name: bridgeProtocolName, Version: bridgeProtocolVersion},
		Capabilities: []string{
			"authority.read_only_bounded", "capture.bounded", "runtime.update_readiness",
		},
	}
}

func sidecarUpdateManifestForTest(version, revision, platform string) SignedSidecarUpdateManifest {
	return SignedSidecarUpdateManifest{
		SchemaVersion: sidecarUpdateManifestSchemaVersion, Product: "AkuSidecar", Channel: "stable",
		SidecarVersion: version, RuntimeRevision: revision, MinHostVersion: runtimeHostVersion,
		BridgeCompatibility: BridgeCompatibility{
			Protocol: bridgeProtocolName, MinVersion: bridgeProtocolVersion, MaxVersion: bridgeProtocolVersion,
			RequiredCapabilities: []string{"authority.read_only_bounded", "capture.bounded"},
		},
		DatabaseCompatibility: DatabaseCompatibility{
			MinSchemaVersion: currentDatabaseSchemaVersion, MaxSchemaVersion: currentDatabaseSchemaVersion,
			RollbackSafe: true,
		},
		PublishedAt: "2026-08-12T00:00:00Z",
		Artifact: SidecarUpdateArtifact{
			Platform: platform,
			URL: "https://github.com/abangkis/AkuBrowser/releases/download/v" + version +
				"/AkuSidecar-" + version + "-" + platform + ".zip",
			Size: 1234, SHA256: strings.Repeat("a", 64),
		},
		Signature: UpdateSignature{Algorithm: "ed25519", KeyID: updateSigningKeyID},
	}
}

func signSidecarUpdateManifestForTest(t *testing.T, privateKey ed25519.PrivateKey, manifest SignedSidecarUpdateManifest) []byte {
	t.Helper()
	payload, err := json.Marshal(manifest.unsigned())
	if err != nil {
		t.Fatal(err)
	}
	manifest.Signature.Value = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, payload))
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func updateTestKey() (ed25519.PublicKey, ed25519.PrivateKey) {
	seed := make([]byte, ed25519.SeedSize)
	for index := range seed {
		seed[index] = byte(index + 1)
	}
	privateKey := ed25519.NewKeyFromSeed(seed)
	return privateKey.Public().(ed25519.PublicKey), privateKey
}
