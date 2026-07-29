package main

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/buthim/alsniper-os/sidecar/internal/agent"
	"github.com/buthim/alsniper-os/sidecar/internal/config"
	"github.com/buthim/alsniper-os/sidecar/internal/protocol"
)

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
