package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	updateManifestSchemaVersion = 1
	updateManifestURL           = "https://github.com/abangkis/AkuBrowser/releases/latest/download/AkuBrowserRuntimeUpdate.json"
	updateSigningKeyID          = "aku-runtime-stable-v1"
	maxUpdateManifestBytes      = 64 * 1024
	maxUpdateArtifactBytes      = 512 * 1024 * 1024
)

// Production builds inject this base64-encoded Ed25519 public key with -ldflags.
// An empty value deliberately disables automatic updates.
var pinnedUpdatePublicKey = ""
var sha256Pattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type UpdateArtifact struct {
	URL    string `json:"url"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type UpdateSignature struct {
	Algorithm string `json:"algorithm"`
	KeyID     string `json:"keyId"`
	Value     string `json:"value"`
}

type SignedUpdateManifest struct {
	SchemaVersion         int             `json:"schemaVersion"`
	Product               string          `json:"product"`
	Channel               string          `json:"channel"`
	Version               string          `json:"version"`
	RuntimeRevision       string          `json:"runtimeRevision"`
	BridgeContractVersion string          `json:"bridgeContractVersion"`
	PublishedAt           string          `json:"publishedAt"`
	Artifact              UpdateArtifact  `json:"artifact"`
	Signature             UpdateSignature `json:"signature"`
}

type unsignedUpdateManifest struct {
	SchemaVersion         int            `json:"schemaVersion"`
	Product               string         `json:"product"`
	Channel               string         `json:"channel"`
	Version               string         `json:"version"`
	RuntimeRevision       string         `json:"runtimeRevision"`
	BridgeContractVersion string         `json:"bridgeContractVersion"`
	PublishedAt           string         `json:"publishedAt"`
	Artifact              UpdateArtifact `json:"artifact"`
}

func decodeAndVerifyUpdateManifest(data []byte, publicKey string, expected ExtensionIdentity, active ActiveRuntime, now time.Time) (SignedUpdateManifest, error) {
	if len(data) == 0 || len(data) > maxUpdateManifestBytes {
		return SignedUpdateManifest{}, errors.New("update manifest size is invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var manifest SignedUpdateManifest
	if err := decoder.Decode(&manifest); err != nil {
		return SignedUpdateManifest{}, fmt.Errorf("decode update manifest: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return SignedUpdateManifest{}, err
	}
	if err := validateUpdateManifest(manifest, expected, active, now); err != nil {
		return SignedUpdateManifest{}, err
	}
	decodedKey, err := base64.StdEncoding.DecodeString(publicKey)
	if err != nil || len(decodedKey) != ed25519.PublicKeySize {
		return SignedUpdateManifest{}, errors.New("pinned update public key is unavailable or invalid")
	}
	signature, err := base64.StdEncoding.DecodeString(manifest.Signature.Value)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return SignedUpdateManifest{}, errors.New("update manifest signature encoding is invalid")
	}
	payload, err := json.Marshal(manifest.unsigned())
	if err != nil {
		return SignedUpdateManifest{}, err
	}
	if !ed25519.Verify(ed25519.PublicKey(decodedKey), payload, signature) {
		return SignedUpdateManifest{}, errors.New("update manifest signature is invalid")
	}
	return manifest, nil
}

func (manifest SignedUpdateManifest) unsigned() unsignedUpdateManifest {
	return unsignedUpdateManifest{
		SchemaVersion: manifest.SchemaVersion, Product: manifest.Product,
		Channel: manifest.Channel, Version: manifest.Version,
		RuntimeRevision:       manifest.RuntimeRevision,
		BridgeContractVersion: manifest.BridgeContractVersion,
		PublishedAt:           manifest.PublishedAt, Artifact: manifest.Artifact,
	}
}

func validateUpdateManifest(manifest SignedUpdateManifest, expected ExtensionIdentity, active ActiveRuntime, now time.Time) error {
	if manifest.SchemaVersion != updateManifestSchemaVersion || manifest.Product != "AkuBrowser" {
		return errors.New("update manifest identity is invalid")
	}
	if manifest.Channel != active.Channel || manifest.Channel != "stable" {
		return errors.New("automatic updates require the stable channel")
	}
	if manifest.Version != expected.ProductVersion ||
		manifest.RuntimeRevision != expected.RuntimeRevision ||
		manifest.BridgeContractVersion != expected.BridgeContractVersion {
		return errors.New("update manifest does not match the requesting extension")
	}
	if compareVersions(manifest.Version, active.Version) <= 0 {
		return errors.New("update target must be newer than the active runtime")
	}
	published, err := time.Parse(time.RFC3339, manifest.PublishedAt)
	if err != nil || published.After(now.Add(10*time.Minute)) {
		return errors.New("update publication time is invalid")
	}
	if manifest.Artifact.Size <= 0 || manifest.Artifact.Size > maxUpdateArtifactBytes {
		return errors.New("update artifact size is invalid")
	}
	if !sha256Pattern.MatchString(manifest.Artifact.SHA256) {
		return errors.New("update artifact checksum is invalid")
	}
	expectedName := "AkuBrowserRuntime-" + manifest.Version + "-windows-x64.zip"
	parsed, err := url.Parse(manifest.Artifact.URL)
	if err != nil || parsed.Scheme != "https" || parsed.Host != "github.com" ||
		parsed.RawQuery != "" || parsed.Fragment != "" ||
		path.Clean(parsed.Path) != "/abangkis/AkuBrowser/releases/download/v"+manifest.Version+"/"+expectedName {
		return errors.New("update artifact URL is outside the fixed release origin")
	}
	if manifest.Signature.Algorithm != "ed25519" || manifest.Signature.KeyID != updateSigningKeyID {
		return errors.New("update signing identity is invalid")
	}
	return nil
}

func compareVersions(left, right string) int {
	parse := func(value string) [3]int {
		var result [3]int
		core := strings.SplitN(value, "-", 2)[0]
		parts := strings.Split(core, ".")
		for index := 0; index < len(parts) && index < len(result); index++ {
			result[index], _ = strconv.Atoi(parts[index])
		}
		return result
	}
	l, r := parse(left), parse(right)
	for index := range l {
		if l[index] < r[index] {
			return -1
		}
		if l[index] > r[index] {
			return 1
		}
	}
	return 0
}
