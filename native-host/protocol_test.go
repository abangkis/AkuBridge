package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
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
	if decoded != request {
		t.Fatalf("decoded request differs: %#v", decoded)
	}

	response := Response{
		SchemaVersion: protocolVersion,
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
			edit: func(request *Request) { request.SchemaVersion = 2 },
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
		SchemaVersion: protocolVersion,
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

func stringPointer(value string) *string {
	return &value
}
