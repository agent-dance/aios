package server

import (
	"context"
	"errors"
	"net/http"

	"github.com/buthim/alsniper-os/sidecar/internal/agent"
	"github.com/buthim/alsniper-os/sidecar/internal/protocol"
)

type agentErrorResponse struct {
	status int
	body   protocol.AgentDebugFailureBody
}

// classifyAgentError is the single sanitized error boundary shared by unary
// and debug-stream responses. Provider text and process output must never be
// copied into the returned body.
func classifyAgentError(err error) agentErrorResponse {
	switch {
	case errors.Is(err, agent.ErrBusy):
		return agentErrorResponse{http.StatusTooManyRequests, protocol.AgentDebugFailureBody{Code: "BUSY", Message: "The sidecar concurrency limit is reached.", Retryable: true}}
	case errors.Is(err, agent.ErrConflict):
		return agentErrorResponse{http.StatusConflict, protocol.AgentDebugFailureBody{Code: "CONFLICT", Message: "This Agent session already has an active turn.", Retryable: true}}
	case errors.Is(err, agent.ErrUnavailable):
		return agentErrorResponse{http.StatusServiceUnavailable, protocol.AgentDebugFailureBody{Code: "AGENT_UNAVAILABLE", Message: "The local Codex runtime is not ready.", Retryable: true}}
	case errors.Is(err, context.DeadlineExceeded):
		return agentErrorResponse{http.StatusGatewayTimeout, protocol.AgentDebugFailureBody{Code: "AGENT_TIMEOUT", Message: "The Agent did not finish before the deadline.", Retryable: true}}
	case errors.Is(err, context.Canceled):
		return agentErrorResponse{499, protocol.AgentDebugFailureBody{Code: "REQUEST_CANCELLED", Message: "The request was cancelled.", Retryable: false}}
	case errors.Is(err, agent.ErrAuthentication):
		return agentErrorResponse{http.StatusServiceUnavailable, protocol.AgentDebugFailureBody{
			Code: "AGENT_AUTH_REQUIRED", Message: "Codex authentication was rejected. Run codex login, then retry; the runtime reconnects automatically.", Retryable: false,
		}}
	case errors.Is(err, agent.ErrInvalidAI):
		return agentErrorResponse{http.StatusBadGateway, protocol.AgentDebugFailureBody{Code: "INVALID_AGENT_OUTPUT", Message: "The Agent returned an invalid structured response.", Retryable: true}}
	default:
		return agentErrorResponse{http.StatusBadGateway, protocol.AgentDebugFailureBody{Code: "AGENT_FAILED", Message: "The local Agent run failed.", Retryable: true}}
	}
}

func classifyReadiness(readiness agent.Readiness) error {
	if readiness.Ready {
		return nil
	}
	for _, check := range readiness.Checks {
		if check.Status == "fail" && (check.Code == "auth_link" || check.Code == "auth_provider") {
			return agent.ErrAuthentication
		}
	}
	return agent.ErrUnavailable
}
