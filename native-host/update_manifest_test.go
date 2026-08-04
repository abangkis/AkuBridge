package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
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
		Product: "AkuBrowser", ProductVersion: "0.7.8",
		RuntimeRevision: "source-adapters-v86", BridgeContractVersion: bridgeContract,
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
		Product: "AkuBrowser", ProductVersion: "0.7.8",
		RuntimeRevision: "source-adapters-v86", BridgeContractVersion: bridgeContract,
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
		Product: "AkuBrowser", ProductVersion: "0.7.8",
		RuntimeRevision: "source-adapters-v86", BridgeContractVersion: bridgeContract,
	}
	data := signedUpdateManifestForTest(t, privateKey, expected)
	var manifest SignedUpdateManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest.Artifact.URL = "https://github.com/attacker/AkuBrowser/releases/download/v0.7.8/AkuBrowserRuntime-0.7.8-windows-x64.zip"
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

func signedUpdateManifestForTest(t *testing.T, privateKey ed25519.PrivateKey, expected ExtensionIdentity) []byte {
	t.Helper()
	manifest := SignedUpdateManifest{
		SchemaVersion: 1, Product: "AkuBrowser", Channel: "stable",
		Version: expected.ProductVersion, RuntimeRevision: expected.RuntimeRevision,
		BridgeContractVersion: expected.BridgeContractVersion,
		PublishedAt:           "2026-07-29T00:00:00Z",
		Artifact: UpdateArtifact{
			URL: "https://github.com/abangkis/AkuBrowser/releases/download/v" + expected.ProductVersion +
				"/AkuBrowserRuntime-" + expected.ProductVersion + "-windows-x64.zip",
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

func updateTestKey() (ed25519.PublicKey, ed25519.PrivateKey) {
	seed := make([]byte, ed25519.SeedSize)
	for index := range seed {
		seed[index] = byte(index + 1)
	}
	privateKey := ed25519.NewKeyFromSeed(seed)
	return privateKey.Public().(ed25519.PublicKey), privateKey
}
