package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestNativeMessageFrameRoundTrip(t *testing.T) {
	request := validRequest("ensure_runtime")
	input := framedJSON(t, request)

	decoded, err := readRequest(bytes.NewReader(input))
	if err != nil {
		t.Fatalf("read request: %v", err)
	}
	if !reflect.DeepEqual(decoded, request) {
		t.Fatalf("decoded request differs: %#v", decoded)
	}

	response := Response{
		SchemaVersion: responseProtocolVersion(request),
		Kind:          "response",
		RequestID:     request.RequestID,
		Action:        request.Action,
		Status:        "ready",
		Runtime: &RuntimeState{
			Version:               "0.7.4",
			Channel:               "stable",
			RuntimeRevision:       "source-adapters-v84",
			BridgeContractVersion: bridgeContract,
			Endpoint:              loopbackEndpoint,
			InstanceEpoch:         "runtime:0001",
			ProcessState:          "ready",
		},
		Update: UpdateState{
			Phase:             "idle",
			CurrentVersion:    stringPointer("0.7.4"),
			RollbackAvailable: true,
			Urgency:           "security",
			Deadline:          "2026-08-15T00:00:00Z",
		},
	}
	var output bytes.Buffer
	if err := writeResponse(&output, response); err != nil {
		t.Fatalf("write response: %v", err)
	}
	payload, err := readFrame(&output, maxResponseBytes)
	if err != nil {
		t.Fatalf("read response frame: %v", err)
	}
	var decodedResponse Response
	if err := json.Unmarshal(payload, &decodedResponse); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if decodedResponse.RequestID != request.RequestID || decodedResponse.Status != "ready" {
		t.Fatalf("response correlation failed: %#v", decodedResponse)
	}
	assertSchemaResponse(t, payload)
	var update map[string]json.RawMessage
	if err := json.Unmarshal(decodedResponseJSON(t, payload, "update"), &update); err != nil {
		t.Fatal(err)
	}
	if len(update) != 4 || update["urgency"] != nil || update["deadline"] != nil {
		t.Fatalf("legacy response update shape changed: %s", payload)
	}
}

func decodedResponseJSON(t *testing.T, payload []byte, key string) json.RawMessage {
	t.Helper()
	var root map[string]json.RawMessage
	if err := json.Unmarshal(payload, &root); err != nil {
		t.Fatal(err)
	}
	return root[key]
}

func TestNativeMessageRejectsOversizedAndUnknownInput(t *testing.T) {
	var oversized bytes.Buffer
	var header [4]byte
	binary.LittleEndian.PutUint32(header[:], maxRequestBytes+1)
	oversized.Write(header[:])
	if _, err := readRequest(&oversized); err == nil {
		t.Fatal("oversized native message was accepted")
	}

	raw := `{"schemaVersion":1,"kind":"request","requestId":"request-20260728-0001","action":"status","extension":{"product":"AkuBrowser","productVersion":"0.7.4","runtimeRevision":"source-adapters-v84","bridgeContractVersion":"aku-browser.bridge.v2"},"command":"powershell.exe"}`
	var input bytes.Buffer
	binary.LittleEndian.PutUint32(header[:], uint32(len(raw)))
	input.Write(header[:])
	input.WriteString(raw)
	if _, err := readRequest(&input); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("request with arbitrary command was not rejected: %v", err)
	}
}

func TestRequestValidationFailsClosed(t *testing.T) {
	tests := []struct {
		name string
		edit func(*Request)
		code string
	}{
		{
			name: "protocol",
			edit: func(request *Request) { request.SchemaVersion = 3 },
			code: "protocol_incompatible",
		},
		{
			name: "action",
			edit: func(request *Request) { request.Action = "execute_shell" },
			code: "invalid_request",
		},
		{
			name: "product",
			edit: func(request *Request) { request.Extension.Product = "OtherProduct" },
			code: "invalid_request",
		},
		{
			name: "contract",
			edit: func(request *Request) { request.Extension.BridgeContractVersion = "unknown.v1" },
			code: "protocol_incompatible",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := validRequest("status")
			test.edit(&request)
			state := validateRequest(request)
			if state == nil || state.Code != test.code {
				t.Fatalf("unexpected validation result: %#v", state)
			}
		})
	}
}

func TestProtocolV2NegotiatesBoundedBridgeCapabilities(t *testing.T) {
	request := validV2Request("ensure_runtime")
	if state := validateRequest(request); state != nil {
		t.Fatalf("valid v2 request rejected: %#v", state)
	}
	request.Extension.Capabilities = []string{"authority.read_only_bounded"}
	if state := validateRequest(request); state == nil || state.Code != "protocol_incompatible" {
		t.Fatalf("missing bounded-capture capability was accepted: %#v", state)
	}
}

func TestReconcileRuntimeIsV2Only(t *testing.T) {
	if state := validateRequest(validV2Request("reconcile_runtime")); state != nil {
		t.Fatalf("valid v2 reconcile request rejected: %#v", state)
	}
	if state := validateRequest(validRequest("reconcile_runtime")); state == nil || state.Code != "invalid_request" {
		t.Fatalf("legacy reconcile request was accepted: %#v", state)
	}
}

func TestProtocolV2ResponsePreservesBoundedUpdatePolicy(t *testing.T) {
	request := validV2Request("status")
	response := errorResponse(request, "ready", nil, UpdateState{
		Phase:    "waiting_for_idle",
		Urgency:  "required",
		Deadline: "2026-08-15T00:00:00Z",
	}, nil)
	var output bytes.Buffer
	if err := writeResponse(&output, response); err != nil {
		t.Fatalf("write response: %v", err)
	}
	payload, err := readFrame(&output, maxResponseBytes)
	if err != nil {
		t.Fatalf("read response frame: %v", err)
	}
	var update map[string]any
	if err := json.Unmarshal(decodedResponseJSON(t, payload, "update"), &update); err != nil {
		t.Fatal(err)
	}
	if update["urgency"] != "required" || update["deadline"] != "2026-08-15T00:00:00Z" {
		t.Fatalf("v2 update policy was not preserved: %s", payload)
	}
}

func assertSchemaResponse(t *testing.T, payload []byte) {
	t.Helper()
	var root map[string]json.RawMessage
	if err := json.Unmarshal(payload, &root); err != nil {
		t.Fatal(err)
	}
	expected := []string{
		"schemaVersion",
		"kind",
		"requestId",
		"action",
		"status",
		"runtime",
		"update",
		"error",
	}
	if len(root) != len(expected) {
		t.Fatalf("response root has unexpected fields: %v", root)
	}
	for _, key := range expected {
		if _, ok := root[key]; !ok {
			t.Fatalf("response root is missing %s", key)
		}
	}
}

func framedJSON(t *testing.T, value any) []byte {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	framed := make([]byte, 4+len(payload))
	binary.LittleEndian.PutUint32(framed[:4], uint32(len(payload)))
	copy(framed[4:], payload)
	return framed
}

func validRequest(action string) Request {
	return Request{
		SchemaVersion: legacyProtocolVersion,
		Kind:          "request",
		RequestID:     "request-20260728-0001",
		Action:        action,
		Extension: ExtensionIdentity{
			Product:               "AkuBrowser",
			ProductVersion:        "0.7.4",
			RuntimeRevision:       "source-adapters-v84",
			BridgeContractVersion: bridgeContract,
		},
	}
}

func validV2Request(action string) Request {
	request := validRequest(action)
	request.SchemaVersion = protocolVersion
	request.Extension.BridgeProtocol = &BridgeProtocol{Name: bridgeProtocolName, Version: bridgeProtocolVersion}
	request.Extension.Capabilities = []string{"authority.read_only_bounded", "capture.bounded"}
	return request
}

func stringPointer(value string) *string {
	return &value
}
