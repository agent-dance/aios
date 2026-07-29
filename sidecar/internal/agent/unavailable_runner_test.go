package agent

import (
	"context"
	"errors"
	"testing"
)

func TestUnavailableRunnerFailsClosedWithSanitizedReadiness(t *testing.T) {
	runner := NewUnavailableRunner()
	readiness := runner.Readiness(context.Background())
	if readiness.Ready || len(readiness.Checks) != 1 || readiness.Checks[0].Code != "agent_runtime" || readiness.Checks[0].Status != "fail" {
		t.Fatalf("unexpected readiness: %+v", readiness)
	}
	if _, err := runner.Run(context.Background(), RunRequest{Prompt: "must not execute"}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("unavailable runner returned %v", err)
	}
}
