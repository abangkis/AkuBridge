package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
)

const (
	legacyProtocolVersion = 1
	protocolVersion       = 2
	maxRequestBytes       = 64 * 1024
	maxResponseBytes      = 64 * 1024
	bridgeContract        = "aku-browser.bridge.v2"
	bridgeProtocolName    = "aku-browser.bridge"
	bridgeProtocolVersion = 2
	loopbackEndpoint      = "http://127.0.0.1:11122"
)

var (
	requestIDPattern  = regexp.MustCompile(`^[A-Za-z0-9._-]{16,80}$`)
	versionPattern    = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`)
	revisionPattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{2,79}$`)
	capabilityPattern = regexp.MustCompile(`^[a-z][a-z0-9._-]{1,79}$`)
)

type Request struct {
	SchemaVersion int               `json:"schemaVersion"`
	Kind          string            `json:"kind"`
	RequestID     string            `json:"requestId"`
	Action        string            `json:"action"`
	Extension     ExtensionIdentity `json:"extension"`
}

type ExtensionIdentity struct {
	Product               string          `json:"product"`
	ProductVersion        string          `json:"productVersion"`
	RuntimeRevision       string          `json:"runtimeRevision"`
	BridgeContractVersion string          `json:"bridgeContractVersion"`
	BridgeProtocol        *BridgeProtocol `json:"bridgeProtocol,omitempty"`
	Capabilities          []string        `json:"capabilities,omitempty"`
}

type BridgeProtocol struct {
	Name    string `json:"name"`
	Version int    `json:"version"`
}

type Response struct {
	SchemaVersion int           `json:"schemaVersion"`
	Kind          string        `json:"kind"`
	RequestID     string        `json:"requestId"`
	Action        string        `json:"action"`
	Status        string        `json:"status"`
	Runtime       *RuntimeState `json:"runtime"`
	Update        UpdateState   `json:"update"`
	Error         *ErrorState   `json:"error"`
	Codex         *CodexState   `json:"codex,omitempty"`
}

type CodexState struct {
	Status string `json:"status"`
}

type RuntimeState struct {
	Version               string `json:"version"`
	Channel               string `json:"channel"`
	RuntimeRevision       string `json:"runtimeRevision"`
	BridgeContractVersion string `json:"bridgeContractVersion"`
	Endpoint              string `json:"endpoint"`
	InstanceEpoch         string `json:"instanceEpoch"`
	ProcessState          string `json:"processState"`
}

type UpdateState struct {
	Phase             string  `json:"phase"`
	CurrentVersion    *string `json:"currentVersion"`
	TargetVersion     *string `json:"targetVersion"`
	RollbackAvailable bool    `json:"rollbackAvailable"`
	Urgency           string  `json:"urgency,omitempty"`
	Deadline          string  `json:"deadline,omitempty"`
}

type ErrorState struct {
	Code        string `json:"code"`
	Message     string `json:"message"`
	Retryable   bool   `json:"retryable"`
	Remediation string `json:"remediation"`
}

func readRequest(r io.Reader) (Request, error) {
	payload, err := readFrame(r, maxRequestBytes)
	if err != nil {
		return Request{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var request Request
	if err := decoder.Decode(&request); err != nil {
		return Request{}, fmt.Errorf("decode request: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return Request{}, err
	}
	return request, nil
}

func writeResponse(w io.Writer, response Response) error {
	if response.SchemaVersion == legacyProtocolVersion {
		response.Update.Urgency = ""
		response.Update.Deadline = ""
	}
	payload, err := json.Marshal(response)
	if err != nil {
		return fmt.Errorf("encode response: %w", err)
	}
	if len(payload) > maxResponseBytes {
		return errors.New("native response exceeds bounded size")
	}
	var header [4]byte
	binary.LittleEndian.PutUint32(header[:], uint32(len(payload)))
	if _, err := w.Write(header[:]); err != nil {
		return fmt.Errorf("write response header: %w", err)
	}
	if _, err := w.Write(payload); err != nil {
		return fmt.Errorf("write response body: %w", err)
	}
	return nil
}

func readFrame(r io.Reader, maximum uint32) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, fmt.Errorf("read request header: %w", err)
	}
	length := binary.LittleEndian.Uint32(header[:])
	if length == 0 || length > maximum {
		return nil, fmt.Errorf("request frame length %d is outside the allowed range", length)
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		return nil, fmt.Errorf("read request body: %w", err)
	}
	return payload, nil
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("request contains multiple JSON values")
		}
		return fmt.Errorf("decode trailing request data: %w", err)
	}
	return nil
}

func validateRequest(request Request) *ErrorState {
	if request.SchemaVersion != legacyProtocolVersion && request.SchemaVersion != protocolVersion {
		return protocolError(
			"protocol_incompatible",
			"Native protocol version is not supported.",
			false,
			"reinstall_runtime",
		)
	}
	if request.Kind != "request" {
		return protocolError("invalid_request", "Native message kind must be request.", false, "none")
	}
	if !requestIDPattern.MatchString(request.RequestID) {
		return protocolError("invalid_request", "Request identifier is invalid.", false, "none")
	}
	if !isKnownAction(request.Action) {
		return protocolError("invalid_request", "Native action is not supported.", false, "none")
	}
	if request.SchemaVersion == legacyProtocolVersion && request.Action == "reconcile_runtime" {
		return protocolError("invalid_request", "Runtime reconciliation requires native protocol v2.", false, "none")
	}
	if request.Extension.Product != "AkuBrowser" {
		return protocolError("invalid_request", "Extension product identity is invalid.", false, "none")
	}
	if !versionPattern.MatchString(request.Extension.ProductVersion) {
		return protocolError("invalid_request", "Extension product version is invalid.", false, "none")
	}
	if !revisionPattern.MatchString(request.Extension.RuntimeRevision) {
		return protocolError("invalid_request", "Extension runtime revision is invalid.", false, "none")
	}
	if request.Extension.BridgeContractVersion != bridgeContract {
		return protocolError(
			"protocol_incompatible",
			"Bridge contract is not supported.",
			false,
			"reinstall_runtime",
		)
	}
	if request.SchemaVersion == legacyProtocolVersion {
		if request.Extension.BridgeProtocol != nil || len(request.Extension.Capabilities) != 0 {
			return protocolError("invalid_request", "Legacy native protocol requests cannot negotiate Bridge capabilities.", false, "none")
		}
		return nil
	}
	if request.Extension.BridgeProtocol == nil ||
		request.Extension.BridgeProtocol.Name != bridgeProtocolName ||
		request.Extension.BridgeProtocol.Version != bridgeProtocolVersion {
		return protocolError(
			"protocol_incompatible",
			"Bridge protocol version is not supported.",
			false,
			"reinstall_runtime",
		)
	}
	if state := validateCapabilities(request.Extension.Capabilities); state != nil {
		return state
	}
	return nil
}

func validateCapabilities(capabilities []string) *ErrorState {
	if len(capabilities) == 0 || len(capabilities) > 64 {
		return protocolError("invalid_request", "Bridge capabilities are missing or exceed the allowed bound.", false, "none")
	}
	seen := make(map[string]struct{}, len(capabilities))
	for _, capability := range capabilities {
		if !capabilityPattern.MatchString(capability) {
			return protocolError("invalid_request", "Bridge capability identifier is invalid.", false, "none")
		}
		if _, duplicate := seen[capability]; duplicate {
			return protocolError("invalid_request", "Bridge capabilities contain a duplicate identifier.", false, "none")
		}
		seen[capability] = struct{}{}
	}
	for _, required := range []string{"authority.read_only_bounded", "capture.bounded"} {
		if _, present := seen[required]; !present {
			return protocolError("protocol_incompatible", "Bridge is missing a required safety capability.", false, "reinstall_runtime")
		}
	}
	return nil
}

func isKnownAction(action string) bool {
	switch action {
	case "status", "ensure_runtime", "reconcile_runtime", "shutdown_if_idle", "check_codex":
		return true
	default:
		return false
	}
}

func safeResponseBinding(request Request) (string, string) {
	requestID := request.RequestID
	if !requestIDPattern.MatchString(requestID) {
		requestID = "host-invalid-request"
	}
	action := request.Action
	if !isKnownAction(action) {
		action = "status"
	}
	return requestID, action
}

func protocolError(code, message string, retryable bool, remediation string) *ErrorState {
	return &ErrorState{
		Code:        code,
		Message:     message,
		Retryable:   retryable,
		Remediation: remediation,
	}
}

func errorResponse(request Request, status string, runtime *RuntimeState, update UpdateState, state *ErrorState) Response {
	requestID, action := safeResponseBinding(request)
	return Response{
		SchemaVersion: responseProtocolVersion(request),
		Kind:          "response",
		RequestID:     requestID,
		Action:        action,
		Status:        status,
		Runtime:       runtime,
		Update:        update,
		Error:         state,
	}
}

func responseProtocolVersion(request Request) int {
	if request.SchemaVersion == legacyProtocolVersion {
		return legacyProtocolVersion
	}
	return protocolVersion
}
