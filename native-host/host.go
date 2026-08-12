package main

import (
	"context"
	"encoding/json"
	"io"
	"sync"
	"time"
)

type Host struct {
	Controller   RuntimeController
	CodexChecker CodexChecker
	Diagnostic   *DiagnosticWriter
}

func (host Host) Handle(ctx context.Context, request Request) Response {
	if validationError := validateRequest(request); validationError != nil {
		status := "error"
		if validationError.Code == "protocol_incompatible" {
			status = "incompatible"
		}
		host.log("warn", "request_rejected", map[string]any{"code": validationError.Code})
		return errorResponse(request, status, nil, UpdateState{Phase: "idle"}, validationError)
	}

	if request.Action == "check_codex" {
		codex, state := CodexState{Status: "error"}, protocolError(
			"codex_check_failed",
			"Codex availability could not be checked.",
			true,
			"retry",
		)
		if host.CodexChecker != nil {
			codex, state = host.CodexChecker.Check(ctx)
		}
		status := "error"
		if state == nil {
			status = "ready"
		}
		host.log("info", "request_completed", map[string]any{
			"action": request.Action,
			"status": status,
		})
		return Response{
			SchemaVersion: responseProtocolVersion(request),
			Kind:          "response",
			RequestID:     request.RequestID,
			Action:        request.Action,
			Status:        status,
			Runtime:       nil,
			Update:        UpdateState{Phase: "idle"},
			Error:         state,
			Codex:         &codex,
		}
	}

	var outcome Outcome
	switch request.Action {
	case "status":
		outcome = host.Controller.Status(ctx, request.Extension)
	case "ensure_runtime":
		outcome = host.Controller.Ensure(ctx, request.Extension)
	case "reconcile_runtime":
		outcome = host.Controller.Reconcile(ctx, request.Extension)
	case "shutdown_if_idle":
		outcome = host.Controller.ShutdownIfIdle(ctx, request.Extension)
	}
	fields := map[string]any{
		"action": request.Action,
		"status": outcome.Status,
	}
	if outcome.Error != nil {
		fields["code"] = outcome.Error.Code
	}
	host.log("info", "request_completed", fields)
	return Response{
		SchemaVersion: responseProtocolVersion(request),
		Kind:          "response",
		RequestID:     request.RequestID,
		Action:        request.Action,
		Status:        outcome.Status,
		Runtime:       outcome.Runtime,
		Update:        outcome.Update,
		Error:         outcome.Error,
	}
}

func (host Host) log(level, event string, fields map[string]any) {
	if host.Diagnostic != nil {
		host.Diagnostic.Log(level, event, fields)
	}
}

type DiagnosticWriter struct {
	mu      sync.Mutex
	encoder *json.Encoder
	now     func() time.Time
}

func NewDiagnosticWriter(writer io.Writer) *DiagnosticWriter {
	return &DiagnosticWriter{
		encoder: json.NewEncoder(writer),
		now:     time.Now,
	}
}

func (writer *DiagnosticWriter) Log(level, event string, fields map[string]any) {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	entry := map[string]any{
		"time":  writer.now().UTC().Format(time.RFC3339Nano),
		"level": level,
		"event": event,
	}
	for key, value := range fields {
		entry[key] = value
	}
	_ = writer.encoder.Encode(entry)
}
