package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/buthim/alsniper-os/sidecar/internal/agent"
	"github.com/buthim/alsniper-os/sidecar/internal/config"
	"github.com/buthim/alsniper-os/sidecar/internal/protocol"
)

func TestVersionJSONIsStableAndMachineReadable(t *testing.T) {
	var output bytes.Buffer
	if err := writeVersionJSON(&output); err != nil {
		t.Fatal(err)
	}
	var metadata versionMetadata
	if err := json.Unmarshal(output.Bytes(), &metadata); err != nil {
		t.Fatalf("invalid version JSON: %v", err)
	}
	if metadata.ProtocolVersion != protocol.Version || metadata.AgentAdaptorVersion != agent.AgentAdaptorVersion || metadata.CodexRequiredVersion != agent.AuditedCodexCLIVersion {
		t.Fatalf("unexpected version metadata: %+v", metadata)
	}
}

func TestCancelWhenStdinCloses(t *testing.T) {
	reader, writer := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go cancelWhenStdinCloses(reader, cancel)
	if _, err := writer.Write([]byte("keepalive")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ctx.Done():
		t.Fatal("stdin data triggered shutdown before EOF")
	default:
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("stdin EOF did not trigger shutdown")
	}
}

func TestCodexInitializationFailureBuildsFailClosedDegradedAgentService(t *testing.T) {
	service, closeRunner, degraded, err := buildAgentService(
		config.Config{MaxConcurrentRuns: 2},
		func(config.Config) (agent.Runner, func() error, error) {
			return nil, nil, errors.New("sensitive profile initialization failure")
		},
	)
	if err != nil || !degraded || service == nil || closeRunner == nil {
		t.Fatalf("degraded service: service=%v close=%v degraded=%v err=%v", service != nil, closeRunner != nil, degraded, err)
	}
	if err := closeRunner(); err != nil {
		t.Fatal(err)
	}
	readiness := service.Readiness(context.Background())
	if readiness.Ready || len(readiness.Checks) != 1 || strings.Contains(strings.ToLower(readiness.Checks[0].Message), "profile") {
		t.Fatalf("degraded readiness leaked initialization details: %+v", readiness)
	}
	revision := int64(0)
	_, err = service.Chat(context.Background(), protocol.ChatRequest{
		RequestID: "request-1", ThreadID: "thread-1", Message: "hello",
		Context: protocol.ChatContext{OSRevision: &revision},
	})
	if !errors.Is(err, agent.ErrUnavailable) {
		t.Fatalf("degraded Agent executed or returned the wrong error: %v", err)
	}
}
