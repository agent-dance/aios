package agent

import (
	"context"

	"github.com/buthim/alsniper-os/sidecar/internal/protocol"
)

type unavailableRunner struct{}

func NewUnavailableRunner() Runner { return unavailableRunner{} }

func (unavailableRunner) Run(context.Context, RunRequest) (RunResult, error) {
	return RunResult{}, ErrUnavailable
}

func (unavailableRunner) Readiness(context.Context) Readiness {
	return Readiness{
		Ready: false,
		Checks: []protocol.HealthCheck{{
			Code: "agent_runtime", Status: "fail", Message: "The local Codex runtime is unavailable.",
		}},
	}
}
