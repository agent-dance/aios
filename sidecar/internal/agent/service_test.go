package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	agentadaptor "github.com/agent-dance/agent-adaptor"
	"github.com/buthim/alsniper-os/sidecar/internal/protocol"
)

type fakeRunner struct {
	output  []byte
	entered chan RunRequest
	release chan struct{}
	err     error
}

type recordingChatTrace struct {
	stages    []ChatTraceStage
	decisions []ChatDecisionSummary
}

func (r *recordingChatTrace) Stage(_ context.Context, stage ChatTraceStage) error {
	r.stages = append(r.stages, stage)
	return nil
}

func (r *recordingChatTrace) Decision(_ context.Context, decision ChatDecisionSummary) error {
	r.decisions = append(r.decisions, decision)
	return nil
}

func (f *fakeRunner) Run(ctx context.Context, req RunRequest) (RunResult, error) {
	if f.entered != nil {
		f.entered <- req
	}
	if f.release != nil {
		select {
		case <-f.release:
		case <-ctx.Done():
			return RunResult{}, ctx.Err()
		}
	}
	if f.err != nil {
		return RunResult{}, f.err
	}
	return RunResult{RunID: "run-1", Model: "test-model", JSON: append([]byte(nil), f.output...)}, nil
}
func (f *fakeRunner) Readiness(context.Context) Readiness {
	return Readiness{Ready: true, Checks: []protocol.HealthCheck{{Code: "fake", Status: "pass", Message: "ready"}}}
}
func revision(value int64) *int64 { return &value }
func chatRequest(thread string) protocol.ChatRequest {
	return protocol.ChatRequest{RequestID: "request-1", ThreadID: thread, Message: "hello", Context: protocol.ChatContext{OSRevision: revision(7)}}
}
func gameRequest(seat string) protocol.GameDecisionRequest {
	return protocol.GameDecisionRequest{RequestID: "request-game", GameID: "doudizhu", GameVersion: "1.0.0", MatchID: "match-1", SeatID: seat, Observation: protocol.GameObservation{Revision: 1, Decision: protocol.DecisionWindow{Mode: "sequential", Phase: "play", ActiveSeatIDs: []string{seat}, TurnNonce: "nonce-1"}, Observation: json.RawMessage(`{"visible":true}`)}, LegalActions: []protocol.LegalAction{{ID: "action-1", Label: "Play", Action: json.RawMessage(`{"type":"play"}`)}}}
}

func enabledDomainAgent() protocol.EnabledAgent {
	return protocol.EnabledAgent{ID: "travel.planner", Name: "Travel", Description: "Plans travel", Instructions: "Provide travel-domain expertise.", Capabilities: []string{"os.app.open"}, Contributions: []string{"domain-agent"}}
}

func TestServiceAttachesRevisionAndFinalizesManifest(t *testing.T) {
	runner := &fakeRunner{output: []byte(`{"message":"Ready","mood":"helpful","intents":[{"id":"install","type":"install_agent","manifest":{"id":"travel.planner","name":"Travel","version":"1.0.0","description":"Plans travel","instructions":"Plan useful trips.","capabilities":["a2ui.surface.publish"]}}]}`)}
	service, _ := NewService(runner, 2)
	response, err := service.Chat(context.Background(), chatRequest("thread-1"))
	if err != nil {
		t.Fatal(err)
	}
	intent := response.Intents[0]
	if intent.ExpectedRevision == nil || *intent.ExpectedRevision != 7 {
		t.Fatal("revision was not attached")
	}
	if intent.Manifest.ContentDigest == "" || intent.Manifest.GeneratedBy == nil || intent.Manifest.GeneratedBy.RunID != "run-1" {
		t.Fatalf("manifest was not finalized: %+v", intent.Manifest)
	}
}

func TestChatWithTraceEmitsOnlyClosedHostMilestones(t *testing.T) {
	runner := &fakeRunner{output: []byte(`{"message":"Ready","mood":"focused","intents":[]}`)}
	service, _ := NewService(runner, 1)
	trace := &recordingChatTrace{}
	response, err := service.ChatWithTrace(context.Background(), chatRequest("thread-trace"), trace)
	if err != nil {
		t.Fatal(err)
	}
	wantStages := []ChatTraceStage{
		ChatTraceRequestAccepted,
		ChatTraceContextValidated,
		ChatTraceExecutionStarted,
		ChatTraceExecutionComplete,
		ChatTraceOutputValidated,
		ChatTraceResponseReady,
	}
	if fmt.Sprint(trace.stages) != fmt.Sprint(wantStages) {
		t.Fatalf("trace stages = %v, want %v", trace.stages, wantStages)
	}
	if len(trace.decisions) != 1 || trace.decisions[0] != (ChatDecisionSummary{Mood: "focused", IntentType: "none"}) {
		t.Fatalf("trace decision = %+v", trace.decisions)
	}
	if response.Message != "Ready" || response.Mood != "focused" {
		t.Fatalf("response changed by trace mode: %+v", response)
	}
}

func TestServiceAllowsOnlyAnEnabledActiveDomainAgent(t *testing.T) {
	runner := &fakeRunner{output: []byte(`{"message":"Ready","mood":"helpful","activeAgentId":"travel.planner","intents":[]}`)}
	service, _ := NewService(runner, 1)
	req := chatRequest("thread-domain")
	req.Context.EnabledAgents = []protocol.EnabledAgent{enabledDomainAgent()}
	response, err := service.Chat(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if response.ActiveAgentID != "travel.planner" {
		t.Fatalf("active Agent attribution lost: %+v", response)
	}

	runner.output = []byte(`{"message":"Ready","mood":"helpful","activeAgentId":"unknown.agent","intents":[]}`)
	if _, err := service.Chat(context.Background(), chatRequest("thread-unknown")); !errors.Is(err, ErrInvalidAI) {
		t.Fatalf("unknown activeAgentId was not rejected: %v", err)
	}
	prompt, err := chatPrompt(req)
	if err != nil {
		t.Fatal(err)
	}
	for _, boundary := range []string{"domain expertise only", "never grants", "cannot directly control the OS"} {
		if !strings.Contains(prompt, boundary) {
			t.Fatalf("chat policy omitted %q", boundary)
		}
	}
}

func TestServiceRejectsSameSessionAndGlobalOverflow(t *testing.T) {
	runner := &fakeRunner{output: []byte(`{"message":"ok","mood":"neutral","intents":[]}`), entered: make(chan RunRequest, 2), release: make(chan struct{})}
	service, _ := NewService(runner, 1)
	done := make(chan error, 1)
	go func() { _, err := service.Chat(context.Background(), chatRequest("same")); done <- err }()
	<-runner.entered
	if _, err := service.Chat(context.Background(), chatRequest("same")); !errors.Is(err, ErrConflict) {
		t.Fatalf("expected conflict, got %v", err)
	}
	if _, err := service.Decide(context.Background(), gameRequest("seat-1")); !errors.Is(err, ErrBusy) {
		t.Fatalf("expected busy, got %v", err)
	}
	close(runner.release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestDifferentSeatsCanRunConcurrentlyAndCancellationPropagates(t *testing.T) {
	runner := &fakeRunner{output: []byte(`{"actionId":"action-1"}`), entered: make(chan RunRequest, 2), release: make(chan struct{})}
	service, _ := NewService(runner, 2)
	done := make(chan error, 2)
	for _, seat := range []string{"seat-1", "seat-2"} {
		go func(seat string) { _, err := service.Decide(context.Background(), gameRequest(seat)); done <- err }(seat)
	}
	<-runner.entered
	<-runner.entered
	close(runner.release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	cancelRunner := &fakeRunner{entered: make(chan RunRequest, 1), release: make(chan struct{})}
	cancelService, _ := NewService(cancelRunner, 1)
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	_, err := cancelService.Chat(ctx, chatRequest("cancel"))
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("deadline was not preserved: %v", err)
	}
}

func TestAdversarialGameTupleCannotCollideAcrossActiveRuns(t *testing.T) {
	runner := &fakeRunner{output: []byte(`{"actionId":"action-1"}`), entered: make(chan RunRequest, 2), release: make(chan struct{})}
	service, _ := NewService(runner, 2)
	firstRequest := gameRequest("d")
	firstRequest.GameID, firstRequest.MatchID = "a", "b:c"
	secondRequest := gameRequest("d")
	secondRequest.GameID, secondRequest.MatchID = "a:b", "c"
	// Both tuples produced "game:a:b:c:d" under the former ':' join.
	if strings.Join([]string{"game", firstRequest.GameID, firstRequest.MatchID, firstRequest.SeatID}, ":") != strings.Join([]string{"game", secondRequest.GameID, secondRequest.MatchID, secondRequest.SeatID}, ":") {
		t.Fatal("test tuples do not exercise the historical collision")
	}
	done := make(chan error, 2)
	go func() { _, err := service.Decide(context.Background(), firstRequest); done <- err }()
	<-runner.entered
	go func() { _, err := service.Decide(context.Background(), secondRequest); done <- err }()
	select {
	case <-runner.entered:
	case err := <-done:
		t.Fatalf("adversarial tuple was rejected as an active-session collision: %v", err)
	case <-time.After(time.Second):
		t.Fatal("second non-colliding tuple did not reach the runner")
	}
	firstKey := canonicalInvocationKey("game", firstRequest.GameID, firstRequest.MatchID, firstRequest.SeatID)
	secondKey := canonicalInvocationKey("game", secondRequest.GameID, secondRequest.MatchID, secondRequest.SeatID)
	if firstKey == secondKey {
		t.Fatalf("active keys are not injectively encoded: %q %q", firstKey, secondKey)
	}
	close(runner.release)
	for range 2 {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
}

func TestSchemasAreJSONAndChatAllowsAtMostOneIntent(t *testing.T) {
	for _, schema := range [][]byte{ChatSchema(), GameSchema()} {
		var value any
		if err := json.Unmarshal(schema, &value); err != nil {
			t.Fatal(err)
		}
	}
	if !strings.Contains(string(ChatSchema()), `"intents":{"type":"array","maxItems":1`) {
		t.Fatal("chat schema does not enforce one intent")
	}
	chatSchemaText := string(ChatSchema())
	for _, contract := range []string{
		`"activeAgentId":{"$ref":"#/$defs/id"}`,
		`"type":{"const":"set_system_status"}`,
		`"statusPatch":{"type":"object","additionalProperties":false,"minProperties":1`,
		`"accent":{"enum":["lime","cyan","amber"]}`,
		`"description":{"type":"string","maxLength":400}},"required":["id","label"]`,
		`"surfaceId":{"type":"string","pattern":"^ui-[A-Za-z0-9][A-Za-z0-9._:-]{0,124}$"}`,
		`"manifestId":{"type":"string","minLength":3,"maxLength":128,"pattern":"^[a-z0-9]+([.-][a-z0-9]+)*$"}`,
		`"manifest":{"type":"object","additionalProperties":false,"properties":{"id":{"$ref":"#/$defs/manifestId"}`,
		`"version":{"type":"string","maxLength":64`,
		`"capabilities":{"type":"array","maxItems":9,"uniqueItems":true`,
		`"instructions":{"type":"string","minLength":1,"maxLength":12000}`,
	} {
		if !strings.Contains(chatSchemaText, contract) {
			t.Fatalf("chat schema drifted from contract %s", contract)
		}
	}
	statusStart := strings.Index(chatSchemaText, `"type":{"const":"set_system_status"}`)
	statusEnd := strings.Index(chatSchemaText[statusStart:], `"required":["id","type","statusPatch"]`)
	statusSchema := chatSchemaText[statusStart : statusStart+statusEnd]
	for _, readOnly := range []string{"healthScore", "wifiLabel", "storageUsedGb"} {
		if strings.Contains(statusSchema, readOnly) {
			t.Fatalf("read-only telemetry %q leaked into status write schema", readOnly)
		}
	}
	policy := denyPolicy()
	if policy.Isolation != agentadaptor.IsolationReadOnly || policy.WebSearch != agentadaptor.FeatureDeny || policy.Browser != agentadaptor.FeatureDeny || policy.HumanDecision.Permission != agentadaptor.HumanDecisionAutoReject || policy.HumanDecision.PlanReview != agentadaptor.HumanDecisionAutoReject || policy.HumanDecision.Question != agentadaptor.QuestionAutoReject {
		t.Fatalf("unsafe policy: %+v", policy)
	}
}
