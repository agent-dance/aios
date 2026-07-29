package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/buthim/alsniper-os/sidecar/internal/agent"
	"github.com/buthim/alsniper-os/sidecar/internal/protocol"
)

func TestAgentErrorClassificationIsStableSanitizedAndShared(t *testing.T) {
	tests := []struct {
		name      string
		err       error
		status    int
		code      string
		message   string
		retryable bool
	}{
		{
			name: "unavailable", err: agent.ErrUnavailable,
			status: http.StatusServiceUnavailable, code: "AGENT_UNAVAILABLE",
			message: "The local Codex runtime is not ready.", retryable: true,
		},
		{
			name: "authentication", err: errors.Join(agent.ErrAgent, agent.ErrAuthentication, errors.New("RAW_PROVIDER_CANARY")),
			status: http.StatusServiceUnavailable, code: "AGENT_AUTH_REQUIRED",
			message: "Codex authentication was rejected. Run codex login, then retry; the runtime reconnects automatically.", retryable: false,
		},
		{
			name: "invalid output", err: errors.Join(agent.ErrAgent, agent.ErrInvalidAI, errors.New("RAW_SCHEMA_CANARY")),
			status: http.StatusBadGateway, code: "INVALID_AGENT_OUTPUT",
			message: "The Agent returned an invalid structured response.", retryable: true,
		},
		{
			name: "unknown provider", err: errors.Join(agent.ErrAgent, errors.New("RAW_FAILURE_CANARY")),
			status: http.StatusBadGateway, code: "AGENT_FAILED", message: "The local Agent run failed.", retryable: true,
		},
		{
			name: "caller cancellation", err: context.Canceled,
			status: 499, code: "REQUEST_CANCELLED", message: "The request was cancelled.", retryable: false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			classified := classifyAgentError(test.err)
			if classified.status != test.status || classified.body.Code != test.code || classified.body.Message != test.message || classified.body.Retryable != test.retryable {
				t.Fatalf("classification = %+v", classified)
			}
			streamBody := (&Server{}).agentDebugFailure(test.err)
			if streamBody != classified.body {
				t.Fatalf("unary/debug classification drifted: unary=%+v debug=%+v", classified.body, streamBody)
			}
			if strings.Contains(classified.body.Message, "RAW_") {
				t.Fatalf("raw error leaked through stable response: %q", classified.body.Message)
			}
		})
	}
}

func TestClassifyReadinessPreservesAuthenticationRecovery(t *testing.T) {
	if err := classifyReadiness(agent.Readiness{Ready: true}); err != nil {
		t.Fatalf("ready runtime returned %v", err)
	}
	for _, code := range []string{"auth_link", "auth_provider"} {
		err := classifyReadiness(agent.Readiness{Checks: []protocol.HealthCheck{{Code: code, Status: "fail", Message: "sanitized"}}})
		if !errors.Is(err, agent.ErrAuthentication) {
			t.Fatalf("%s readiness returned %v", code, err)
		}
	}
	err := classifyReadiness(agent.Readiness{Checks: []protocol.HealthCheck{{Code: "codex_cli", Status: "fail", Message: "sanitized"}}})
	if !errors.Is(err, agent.ErrUnavailable) {
		t.Fatalf("non-auth readiness returned %v", err)
	}
}
