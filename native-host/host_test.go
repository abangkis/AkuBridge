package main

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestHostPreservesRequestCorrelationAndStructuredDiagnostics(t *testing.T) {
	root := writeActiveRuntime(t, activeFixture())
	var diagnostics bytes.Buffer
	writer := NewDiagnosticWriter(&diagnostics)
	writer.now = func() time.Time {
		return time.Date(2026, 7, 28, 10, 0, 0, 0, time.UTC)
	}
	host := Host{
		Controller: testController(
			root,
			&sequenceProber{results: []probeStep{{result: readyProbe()}}},
			&recordingLauncher{},
		),
		Diagnostic: writer,
	}
	request := validRequest("status")

	response := host.Handle(context.Background(), request)

	if response.RequestID != request.RequestID || response.Action != request.Action || response.Status != "ready" {
		t.Fatalf("request correlation failed: %#v", response)
	}
	var entry map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(diagnostics.Bytes()), &entry); err != nil {
		t.Fatalf("stderr diagnostic is not JSON: %v", err)
	}
	if entry["event"] != "request_completed" || entry["status"] != "ready" {
		t.Fatalf("unexpected diagnostic: %#v", entry)
	}
}

func TestHostRejectsUnknownActionWithoutRuntimeAuthority(t *testing.T) {
	prober := &sequenceProber{}
	launcher := &recordingLauncher{}
	host := Host{Controller: testController(t.TempDir(), prober, launcher)}
	request := validRequest("status")
	request.Action = "execute_shell"

	response := host.Handle(context.Background(), request)

	if response.Status != "error" || response.Error == nil || response.Error.Code != "invalid_request" {
		t.Fatalf("unknown action response is not typed: %#v", response)
	}
	if response.Action != "status" {
		t.Fatalf("invalid action leaked into schema response: %s", response.Action)
	}
	if prober.calls != 0 || launcher.calls != 0 {
		t.Fatal("unknown action reached runtime authority")
	}
}

func TestStageSevenShutdownRequiresExplicitIdleHandoff(t *testing.T) {
	prober := &sequenceProber{}
	launcher := &recordingLauncher{}
	controller := testController(writeActiveRuntime(t, activeFixture()), prober, launcher)
	control := &fakeRuntimeUpdateControl{ready: true}
	controller.UpdateControl = control
	host := Host{Controller: controller}

	response := host.Handle(context.Background(), validRequest("shutdown_if_idle"))

	if response.Status != "ready" || response.Error != nil || response.Runtime.ProcessState != "stopped" {
		t.Fatalf("shutdown boundary is unclear: %#v", response)
	}
	if control.shutdownCalls != 1 || prober.calls != 0 || launcher.calls != 0 {
		t.Fatal("shutdown escaped the idle handoff boundary")
	}
}
