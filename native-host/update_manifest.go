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
	"strings"
	"time"
)

const (
	updateManifestSchemaVersion        = 1
	sidecarUpdateManifestSchemaVersion = 2
	updateSigningKeyID                 = "aku-runtime-stable-v1"
	maxUpdateManifestBytes             = 64 * 1024
	maxUpdateArtifactBytes             = 512 * 1024 * 1024
	currentDatabaseSchemaVersion       = 7
)

// Production builds inject this base64-encoded Ed25519 public key with -ldflags.
// An empty value deliberately disables automatic updates.
var pinnedUpdatePublicKey = ""

// Production builds inject the independently versioned native helper version.
// Keeping a valid development default makes local contract tests deterministic.
var runtimeHostVersion = "0.7.9"
var sha256Pattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var errHostUpgradeRequired = errors.New("native runtime host upgrade required")

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

type BridgeCompatibility struct {
	Protocol             string   `json:"protocol"`
	MinVersion           int      `json:"minVersion"`
	MaxVersion           int      `json:"maxVersion"`
	RequiredCapabilities []string `json:"requiredCapabilities"`
}

type DatabaseCompatibility struct {
	MinSchemaVersion int  `json:"minSchemaVersion"`
	MaxSchemaVersion int  `json:"maxSchemaVersion"`
	RollbackSafe     bool `json:"rollbackSafe"`
}

type SidecarUpdateArtifact struct {
	Platform string `json:"platform"`
	URL      string `json:"url"`
	Size     int64  `json:"size"`
	SHA256   string `json:"sha256"`
}

type SignedSidecarUpdateManifest struct {
	SchemaVersion         int                   `json:"schemaVersion"`
	Product               string                `json:"product"`
	Channel               string                `json:"channel"`
	SidecarVersion        string                `json:"sidecarVersion"`
	RuntimeRevision       string                `json:"runtimeRevision"`
	MinHostVersion        string                `json:"minHostVersion"`
	BridgeCompatibility   BridgeCompatibility   `json:"bridgeCompatibility"`
	DatabaseCompatibility DatabaseCompatibility `json:"databaseCompatibility"`
	PublishedAt           string                `json:"publishedAt"`
	Urgency               string                `json:"urgency,omitempty"`
	Deadline              string                `json:"deadline,omitempty"`
	Artifact              SidecarUpdateArtifact `json:"artifact"`
	Signature             UpdateSignature       `json:"signature"`
}

type unsignedSidecarUpdateManifest struct {
	SchemaVersion         int                   `json:"schemaVersion"`
	Product               string                `json:"product"`
	Channel               string                `json:"channel"`
	SidecarVersion        string                `json:"sidecarVersion"`
	RuntimeRevision       string                `json:"runtimeRevision"`
	MinHostVersion        string                `json:"minHostVersion"`
	BridgeCompatibility   BridgeCompatibility   `json:"bridgeCompatibility"`
	DatabaseCompatibility DatabaseCompatibility `json:"databaseCompatibility"`
	PublishedAt           string                `json:"publishedAt"`
	Urgency               string                `json:"urgency,omitempty"`
	Deadline              string                `json:"deadline,omitempty"`
	Artifact              SidecarUpdateArtifact `json:"artifact"`
}

type VerifiedUpdateManifest struct {
	SchemaVersion         int
	Channel               string
	Version               string
	RuntimeRevision       string
	BridgeContractVersion string
	PublishedAt           string
	Urgency               string
	Deadline              string
	Artifact              UpdateArtifact
}

func decodeAndVerifyUpdateManifest(data []byte, publicKey string, expected ExtensionIdentity, active ActiveRuntime, now time.Time, platforms ...string) (SignedUpdateManifest, error) {
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
	if err := validateUpdateManifest(manifest, expected, active, now, platforms...); err != nil {
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

func (manifest SignedSidecarUpdateManifest) unsigned() unsignedSidecarUpdateManifest {
	return unsignedSidecarUpdateManifest{
		SchemaVersion: manifest.SchemaVersion, Product: manifest.Product,
		Channel: manifest.Channel, SidecarVersion: manifest.SidecarVersion,
		RuntimeRevision: manifest.RuntimeRevision, MinHostVersion: manifest.MinHostVersion,
		BridgeCompatibility:   manifest.BridgeCompatibility,
		DatabaseCompatibility: manifest.DatabaseCompatibility,
		PublishedAt:           manifest.PublishedAt, Urgency: manifest.Urgency,
		Deadline: manifest.Deadline, Artifact: manifest.Artifact,
	}
}

func decodeAndVerifySidecarUpdateManifest(data []byte, publicKey string, expected ExtensionIdentity, active ActiveRuntime, now time.Time, platform string) (VerifiedUpdateManifest, error) {
	if len(data) == 0 || len(data) > maxUpdateManifestBytes {
		return VerifiedUpdateManifest{}, errors.New("update manifest size is invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var manifest SignedSidecarUpdateManifest
	if err := decoder.Decode(&manifest); err != nil {
		return VerifiedUpdateManifest{}, fmt.Errorf("decode sidecar update manifest: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return VerifiedUpdateManifest{}, err
	}
	if manifest.Signature.Algorithm != "ed25519" || manifest.Signature.KeyID != updateSigningKeyID {
		return VerifiedUpdateManifest{}, errors.New("update signing identity is invalid")
	}
	decodedKey, err := base64.StdEncoding.DecodeString(publicKey)
	if err != nil || len(decodedKey) != ed25519.PublicKeySize {
		return VerifiedUpdateManifest{}, errors.New("pinned update public key is unavailable or invalid")
	}
	signature, err := base64.StdEncoding.DecodeString(manifest.Signature.Value)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return VerifiedUpdateManifest{}, errors.New("update manifest signature encoding is invalid")
	}
	payload, err := json.Marshal(manifest.unsigned())
	if err != nil {
		return VerifiedUpdateManifest{}, err
	}
	if !ed25519.Verify(ed25519.PublicKey(decodedKey), payload, signature) {
		return VerifiedUpdateManifest{}, errors.New("update manifest signature is invalid")
	}
	// Compatibility-driven remediation is trusted only after the signed
	// manifest has been authenticated. Otherwise an attacker could turn an
	// unsigned minHostVersion value into an installer prompt.
	urgency := manifest.Urgency
	if urgency == "" {
		urgency = "routine"
	}
	verified := VerifiedUpdateManifest{
		SchemaVersion: manifest.SchemaVersion, Channel: manifest.Channel, Version: manifest.SidecarVersion,
		RuntimeRevision: manifest.RuntimeRevision, BridgeContractVersion: bridgeContract,
		PublishedAt: manifest.PublishedAt, Urgency: urgency, Deadline: manifest.Deadline,
		Artifact: UpdateArtifact{URL: manifest.Artifact.URL, Size: manifest.Artifact.Size, SHA256: manifest.Artifact.SHA256},
	}
	if err := validateSidecarUpdateManifest(manifest, expected, active, now, platform); err != nil {
		if errors.Is(err, errHostUpgradeRequired) {
			return verified, err
		}
		return VerifiedUpdateManifest{}, err
	}
	return verified, nil
}

func validateSidecarUpdateManifest(manifest SignedSidecarUpdateManifest, expected ExtensionIdentity, active ActiveRuntime, now time.Time, platform string) error {
	if manifest.SchemaVersion != sidecarUpdateManifestSchemaVersion || manifest.Product != "AkuSidecar" {
		return errors.New("sidecar update manifest identity is invalid")
	}
	if manifest.Channel != active.Channel || manifest.Channel != "stable" {
		return errors.New("automatic updates require the stable channel")
	}
	if !versionPattern.MatchString(manifest.SidecarVersion) || !revisionPattern.MatchString(manifest.RuntimeRevision) ||
		!versionPattern.MatchString(manifest.MinHostVersion) {
		return errors.New("sidecar update version metadata is invalid")
	}
	if manifest.BridgeCompatibility.Protocol != bridgeProtocolName ||
		manifest.BridgeCompatibility.MinVersion < 1 ||
		manifest.BridgeCompatibility.MaxVersion < manifest.BridgeCompatibility.MinVersion {
		return errors.New("Bridge compatibility range is invalid")
	}
	if expected.BridgeProtocol == nil || expected.BridgeProtocol.Name != manifest.BridgeCompatibility.Protocol ||
		expected.BridgeProtocol.Version < manifest.BridgeCompatibility.MinVersion ||
		expected.BridgeProtocol.Version > manifest.BridgeCompatibility.MaxVersion {
		return errors.New("requesting Bridge protocol is outside the Sidecar compatibility range")
	}
	capabilities := make(map[string]struct{}, len(expected.Capabilities))
	for _, capability := range expected.Capabilities {
		capabilities[capability] = struct{}{}
	}
	if len(manifest.BridgeCompatibility.RequiredCapabilities) > 64 {
		return errors.New("required Bridge capabilities exceed the allowed bound")
	}
	seenRequired := make(map[string]struct{}, len(manifest.BridgeCompatibility.RequiredCapabilities))
	for _, required := range manifest.BridgeCompatibility.RequiredCapabilities {
		if !capabilityPattern.MatchString(required) {
			return errors.New("required Bridge capability identifier is invalid")
		}
		if _, duplicate := seenRequired[required]; duplicate {
			return errors.New("required Bridge capabilities contain a duplicate")
		}
		seenRequired[required] = struct{}{}
		if _, present := capabilities[required]; !present {
			return fmt.Errorf("requesting Bridge is missing required capability %s", required)
		}
	}
	if manifest.DatabaseCompatibility.MinSchemaVersion < 1 ||
		manifest.DatabaseCompatibility.MaxSchemaVersion < manifest.DatabaseCompatibility.MinSchemaVersion ||
		currentDatabaseSchemaVersion < manifest.DatabaseCompatibility.MinSchemaVersion ||
		currentDatabaseSchemaVersion > manifest.DatabaseCompatibility.MaxSchemaVersion ||
		!manifest.DatabaseCompatibility.RollbackSafe {
		return errors.New("Sidecar update is not rollback-safe for the current database schema")
	}
	published, err := time.Parse(time.RFC3339, manifest.PublishedAt)
	if err != nil || published.After(now.Add(10*time.Minute)) {
		return errors.New("update publication time is invalid")
	}
	if manifest.Urgency == "" {
		manifest.Urgency = "routine"
	}
	switch manifest.Urgency {
	case "routine", "recommended", "required", "security":
	default:
		return errors.New("sidecar update urgency is invalid")
	}
	if manifest.Deadline != "" {
		deadline, deadlineErr := time.Parse(time.RFC3339, manifest.Deadline)
		if deadlineErr != nil || deadline.Before(published) || (manifest.Urgency != "required" && manifest.Urgency != "security") {
			return errors.New("sidecar update deadline is invalid")
		}
	}
	if manifest.Artifact.Platform != platform || !supportedRuntimeArchitecture(platform) ||
		manifest.Artifact.Size <= 0 || manifest.Artifact.Size > maxUpdateArtifactBytes ||
		!sha256Pattern.MatchString(manifest.Artifact.SHA256) {
		return errors.New("sidecar update artifact metadata is invalid")
	}
	expectedName := "AkuSidecar-" + manifest.SidecarVersion + "-" + platform + ".zip"
	parsed, err := url.Parse(manifest.Artifact.URL)
	if err != nil || parsed.Scheme != "https" || parsed.Host != "github.com" ||
		parsed.RawQuery != "" || parsed.Fragment != "" ||
		path.Clean(parsed.Path) != "/abangkis/AkuBrowser/releases/download/v"+manifest.SidecarVersion+"/"+expectedName {
		return errors.New("sidecar update artifact URL is outside the fixed release origin")
	}
	if manifest.Signature.Algorithm != "ed25519" || manifest.Signature.KeyID != updateSigningKeyID {
		return errors.New("update signing identity is invalid")
	}
	// This check deliberately runs last. A host-upgrade installer target is
	// actionable only after every signed identity, Bridge capability, database,
	// and fixed-origin artifact constraint has passed.
	if compareVersions(runtimeHostVersion, manifest.MinHostVersion) < 0 {
		return fmt.Errorf("%w: native runtime host is too old for this Sidecar update", errHostUpgradeRequired)
	}
	return nil
}

func validateUpdateManifest(manifest SignedUpdateManifest, expected ExtensionIdentity, active ActiveRuntime, now time.Time, platforms ...string) error {
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
	architecture := legacyWindowsArchitecture
	if len(platforms) > 0 && platforms[0] != "" {
		architecture = platforms[0]
	}
	if !supportedRuntimeArchitecture(architecture) {
		return errors.New("runtime update architecture is unsupported")
	}
	expectedName := "AkuBrowserRuntime-" + manifest.Version + "-" + architecture + ".zip"
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

func supportedRuntimeArchitecture(value string) bool {
	switch value {
	case "windows-x64", "macos-universal", "linux-x64", "linux-arm64":
		return true
	default:
		return false
	}
}

func compareVersions(left, right string) int {
	type semanticVersion struct {
		core       [3]string
		prerelease []string
	}
	parse := func(value string) semanticVersion {
		parts := strings.SplitN(value, "-", 2)
		core := strings.Split(parts[0], ".")
		parsed := semanticVersion{}
		copy(parsed.core[:], core)
		if len(parts) == 2 {
			parsed.prerelease = strings.Split(parts[1], ".")
		}
		return parsed
	}
	compareNumeric := func(leftIdentifier, rightIdentifier string) int {
		leftIdentifier = strings.TrimLeft(leftIdentifier, "0")
		rightIdentifier = strings.TrimLeft(rightIdentifier, "0")
		if leftIdentifier == "" {
			leftIdentifier = "0"
		}
		if rightIdentifier == "" {
			rightIdentifier = "0"
		}
		if len(leftIdentifier) < len(rightIdentifier) {
			return -1
		}
		if len(leftIdentifier) > len(rightIdentifier) {
			return 1
		}
		return strings.Compare(leftIdentifier, rightIdentifier)
	}
	isNumeric := func(identifier string) bool {
		return identifier != "" && strings.IndexFunc(identifier, func(value rune) bool {
			return value < '0' || value > '9'
		}) == -1
	}
	l, r := parse(left), parse(right)
	for index := range l.core {
		if comparison := compareNumeric(l.core[index], r.core[index]); comparison != 0 {
			return comparison
		}
	}
	if len(l.prerelease) == 0 && len(r.prerelease) == 0 {
		return 0
	}
	if len(l.prerelease) == 0 {
		return 1
	}
	if len(r.prerelease) == 0 {
		return -1
	}
	for index := 0; index < len(l.prerelease) && index < len(r.prerelease); index++ {
		leftIdentifier, rightIdentifier := l.prerelease[index], r.prerelease[index]
		leftNumeric, rightNumeric := isNumeric(leftIdentifier), isNumeric(rightIdentifier)
		if leftNumeric && rightNumeric {
			if comparison := compareNumeric(leftIdentifier, rightIdentifier); comparison != 0 {
				return comparison
			}
			continue
		}
		if leftNumeric != rightNumeric {
			if leftNumeric {
				return -1
			}
			return 1
		}
		if comparison := strings.Compare(leftIdentifier, rightIdentifier); comparison != 0 {
			return comparison
		}
	}
	if len(l.prerelease) < len(r.prerelease) {
		return -1
	}
	if len(l.prerelease) > len(r.prerelease) {
		return 1
	}
	return 0
}
