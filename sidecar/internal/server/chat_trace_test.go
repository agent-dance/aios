package server

import (
	"context"
	"crypto/hmac"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/buthim/alsniper-os/sidecar/internal/agent"
	"github.com/buthim/alsniper-os/sidecar/internal/protocol"
)

const debugTestNonce = "00112233445566778899aabbccddeeff"

func debugRequestBody(message string) string {
	request := protocol.AgentDebugTraceRequest{
		Profile: protocol.AgentDebugProfile,
		Request: protocol.ChatRequest{
			RequestID: "request-1",
			ThreadID:  "thread-1",
			Message:   message,
			Context:   protocol.ChatContext{OSRevision: func() *int64 { value := int64(3); return &value }()},
		},
	}
	raw, err := json.Marshal(request)
	if err != nil {
		panic(err)
	}
	return string(raw)
}

func authenticatedDebugPayloads(t *testing.T, rec *httptest.ResponseRecorder, token, authority, nonce string) []json.RawMessage {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("debug status = %d: %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Content-Type") != agentDebugContentType || rec.Header().Get(headerAgentDebugProfile) != protocol.AgentDebugProfile {
		t.Fatalf("debug metadata = %+v", rec.Header())
	}
	if rec.Header().Get(headerRequestNonce) != nonce || rec.Header().Get(headerProtocol) != protocol.Version {
		t.Fatalf("debug authentication metadata = %+v", rec.Header())
	}
	body := rec.Body.String()
	if body == "" || !strings.HasSuffix(body, "\n") || strings.Contains(body, "\r") || strings.HasSuffix(body, "\n\n") {
		t.Fatalf("debug framing delimiters are invalid: %q", body)
	}
	lines := strings.Split(strings.TrimSuffix(body, "\n"), "\n")
	payloads := make([]json.RawMessage, 0, len(lines))
	previousMAC := agentDebugInitialFrameMAC
	for index, line := range lines {
		parts := strings.Split(line, ".")
		if len(parts) != 3 || parts[0] != strconv.Itoa(index+1) {
			t.Fatalf("frame %d is malformed: %q", index+1, line)
		}
		raw, err := base64.RawURLEncoding.DecodeString(parts[1])
		if err != nil || base64.RawURLEncoding.EncodeToString(raw) != parts[1] {
			t.Fatalf("frame %d payload is not canonical base64url: %v", index+1, err)
		}
		payloadHash := sha256Hex(raw)
		canonical := agentDebugFrameCanonical(
			nonce,
			rec.Header().Get(headerRequestID),
			authority,
			http.MethodPost,
			agentDebugTracePath,
			http.StatusOK,
			protocol.AgentDebugProfile,
			uint64(index+1),
			previousMAC,
			payloadHash,
			protocol.Version,
		)
		expectedMAC := hmacHex(token, canonical)
		if !hmac.Equal([]byte(expectedMAC), []byte(parts[2])) {
			t.Fatalf("frame %d MAC mismatch", index+1)
		}
		var payload map[string]any
		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Fatalf("frame %d JSON: %v", index+1, err)
		}
		payloads = append(payloads, append(json.RawMessage(nil), raw...))
		previousMAC = parts[2]
	}
	return payloads
}

func TestChatTraceProducesAuthenticatedSummaryAndOneTerminal(t *testing.T) {
	cfg := testConfig(t)
	h := handler(t, runner{ready: true, output: []byte(`{"message":"Safe response","mood":"helpful","intents":[{"id":"intent-1","type":"open_app","appId":"finder"}]}`)}, cfg)
	body := debugRequestBody("PROMPT_CANARY_DO_NOT_DISCLOSE")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, request(http.MethodPost, agentDebugTracePath, body, cfg))

	payloads := authenticatedDebugPayloads(t, rec, cfg.Token, "http://"+cfg.ListenAddress, debugTestNonce)
	if len(payloads) != 8 {
		t.Fatalf("frame count = %d, want 8", len(payloads))
	}
	traceID := ""
	terminals := 0
	decisionTargetSeen := false
	decodedPayloads := strings.Builder{}
	for index, raw := range payloads {
		decodedPayloads.Write(raw)
		var envelope struct {
			Kind    string `json:"kind"`
			TraceID string `json:"traceId"`
		}
		if err := json.Unmarshal(raw, &envelope); err != nil {
			t.Fatal(err)
		}
		if index == 0 {
			traceID = envelope.TraceID
		} else if envelope.TraceID != traceID {
			t.Fatal("trace identity changed within stream")
		}
		if envelope.Kind == "completed" || envelope.Kind == "failed" {
			terminals++
			if index != len(payloads)-1 {
				t.Fatal("terminal frame was not last")
			}
		}
		var trace protocol.AgentDebugTracePayload
		if envelope.Kind == "trace" && json.Unmarshal(raw, &trace) == nil && trace.Stage == "decision" && strings.Contains(trace.Detail, "target=finder") {
			decisionTargetSeen = true
		}
	}
	if terminals != 1 {
		t.Fatalf("terminal count = %d", terminals)
	}
	if !decisionTargetSeen {
		t.Fatal("validated decision target was not summarized")
	}
	if strings.Contains(decodedPayloads.String(), "PROMPT_CANARY_DO_NOT_DISCLOSE") {
		t.Fatal("request prompt leaked into debug payloads")
	}
	var terminal protocol.AgentDebugCompletedPayload
	if err := json.Unmarshal(payloads[len(payloads)-1], &terminal); err != nil {
		t.Fatal(err)
	}
	if terminal.Kind != "completed" || terminal.Response.Message != "Safe response" || terminal.Response.RequestID != "request-1" {
		t.Fatalf("unexpected terminal: %+v", terminal)
	}
}

func TestChatTraceDeadlineEndsWithAuthenticatedFailure(t *testing.T) {
	cfg := testConfig(t)
	h := handler(t, runner{ready: true, wait: true}, cfg)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, request(http.MethodPost, agentDebugTracePath, debugRequestBody("hello"), cfg))
	payloads := authenticatedDebugPayloads(t, rec, cfg.Token, "http://"+cfg.ListenAddress, debugTestNonce)
	assertSanitizedFailureTrace(t, payloads, "The Agent did not finish before the deadline.")
	var failed protocol.AgentDebugFailedPayload
	if err := json.Unmarshal(payloads[len(payloads)-1], &failed); err != nil {
		t.Fatal(err)
	}
	if failed.Kind != "failed" || failed.Error.Code != "AGENT_TIMEOUT" || !failed.Error.Retryable {
		t.Fatalf("deadline terminal = %+v", failed)
	}
}

func TestChatTraceSanitizesRunnerFailure(t *testing.T) {
	cfg := testConfig(t)
	h := handler(t, runner{ready: true, err: errors.New("RAW_ERROR_CANARY C:\\private\\profile auth-token")}, cfg)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, request(http.MethodPost, agentDebugTracePath, debugRequestBody("hello"), cfg))
	payloads := authenticatedDebugPayloads(t, rec, cfg.Token, "http://"+cfg.ListenAddress, debugTestNonce)
	decoded := strings.Builder{}
	for _, payload := range payloads {
		decoded.Write(payload)
	}
	if strings.Contains(decoded.String(), "RAW_ERROR_CANARY") || strings.Contains(decoded.String(), `C:\private\profile`) || strings.Contains(decoded.String(), "auth-token") {
		t.Fatalf("raw runner failure leaked: %s", decoded.String())
	}
	assertSanitizedFailureTrace(t, payloads, "The local Agent run failed.")
	var failed protocol.AgentDebugFailedPayload
	if err := json.Unmarshal(payloads[len(payloads)-1], &failed); err != nil {
		t.Fatal(err)
	}
	if failed.Kind != "failed" || failed.Error.Code != "AGENT_FAILED" || !failed.Error.Retryable {
		t.Fatalf("failure was not stable and sanitized: %+v", failed)
	}
}

func assertSanitizedFailureTrace(t *testing.T, payloads []json.RawMessage, detail string) {
	t.Helper()
	if len(payloads) < 2 {
		t.Fatalf("failure stream contains only %d frame(s)", len(payloads))
	}
	var trace protocol.AgentDebugTracePayload
	if err := json.Unmarshal(payloads[len(payloads)-2], &trace); err != nil {
		t.Fatal(err)
	}
	if trace.Kind != "trace" || trace.Stage != "completion" || trace.Status != "failed" || trace.Title != "Agent run failed" || trace.Detail != detail {
		t.Fatalf("failure trace is incomplete or unsafe: %+v", trace)
	}
}

func TestChatTraceRejectsInvalidWrapperAsSignedJSON(t *testing.T) {
	cfg := testConfig(t)
	for name, body := range map[string]string{
		"profile":       `{"profile":"agent-debug.v2","request":{"requestId":"request-1","threadId":"thread-1","message":"hello","context":{"osRevision":0}}}`,
		"unknown field": `{"profile":"agent-debug.v1","request":{"requestId":"request-1","threadId":"thread-1","message":"hello","context":{"osRevision":0}},"extra":true}`,
	} {
		t.Run(name, func(t *testing.T) {
			h := handler(t, runner{ready: true}, cfg)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, request(http.MethodPost, agentDebugTracePath, body, cfg))
			if rec.Code != http.StatusBadRequest || rec.Header().Get(headerAgentDebugProfile) != "" || decodeError(t, rec).Error.Code != "INVALID_REQUEST" {
				t.Fatalf("unexpected rejection: %d %s", rec.Code, rec.Body.String())
			}
			verifySignedResponse(t, rec, cfg, debugTestNonce)
		})
	}
}

type debugTestPayload struct {
	Data string `json:"data"`
}

func (debugTestPayload) Validate() error { return nil }

func testDebugWriter(t *testing.T, cfgToken string) (*agentDebugStreamWriter, *httptest.ResponseRecorder) {
	t.Helper()
	rec := httptest.NewRecorder()
	rec.Header().Set(headerRequestID, "transport-request-1")
	req := httptest.NewRequest(http.MethodPost, agentDebugTracePath, nil)
	req.Header.Set(headerNonce, debugTestNonce)
	writer := newAgentDebugStreamWriter(&Server{cfg: testConfig(t)}, rec, req)
	writer.server.cfg.Token = cfgToken
	if err := writer.start(); err != nil {
		t.Fatal(err)
	}
	return writer, rec
}

func TestAgentDebugWriterEnforcesPayloadStreamAndEventLimitsBeforeWrite(t *testing.T) {
	writer, rec := testDebugWriter(t, strings.Repeat("k", 32))
	if err := writer.write(debugTestPayload{Data: strings.Repeat("x", agentDebugTracePayloadLimit)}); !errors.Is(err, errAgentDebugFrameRejected) || rec.Body.Len() != 0 {
		t.Fatalf("oversized payload write = %v, bytes = %d", err, rec.Body.Len())
	}

	writer, _ = testDebugWriter(t, strings.Repeat("k", 32))
	writer.totalBytes = agentDebugStreamLimit - 8
	if err := writer.write(debugTestPayload{Data: "stream-overflow"}); !errors.Is(err, errAgentDebugFrameRejected) {
		t.Fatalf("stream limit was not enforced: %v", err)
	}

	writer, _ = testDebugWriter(t, strings.Repeat("k", 32))
	for index := 0; index < agentDebugEventLimit; index++ {
		if err := writer.write(debugTestPayload{Data: "ok"}); err != nil {
			t.Fatalf("event %d: %v", index+1, err)
		}
	}
	if err := writer.write(debugTestPayload{Data: "one-too-many"}); !errors.Is(err, errAgentDebugFrameRejected) {
		t.Fatalf("event limit was not enforced: %v", err)
	}
}

func TestAgentDebugTraceSinkUnblocksOnCancellationWhenQueueIsFull(t *testing.T) {
	signals := make(chan chatTraceSignal, agentDebugSignalBuffer)
	for index := 0; index < agentDebugSignalBuffer; index++ {
		signals <- chatTraceSignal{stage: agent.ChatTraceRequestAccepted}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := (channelChatTraceSink{channel: signals}).Stage(ctx, agent.ChatTraceRequestAccepted)
	if !errors.Is(err, context.Canceled) || len(signals) != agentDebugSignalBuffer {
		t.Fatalf("full trace relay did not fail closed on cancellation: %v", err)
	}
}

func TestAgentDebugFrameCanonicalGoldenAndBinding(t *testing.T) {
	const payload = `{"kind":"trace","traceId":"trace-vector-1","timeUnixMs":1785038400000,"source":"sidecar","stage":"analysis","status":"started","title":"Model execution started","elapsedMs":7}`
	const payloadHash = "15b3f7b8244fc365b0fc382807379d9fc1c1ece1b73336dce4c69af89c7d14cb"
	if got := sha256Hex([]byte(payload)); got != payloadHash {
		t.Fatalf("payload golden SHA-256 = %s", got)
	}
	values := []any{
		debugTestNonce,
		"request-vector-1",
		"http://127.0.0.1:4317",
		http.MethodPost,
		agentDebugTracePath,
		http.StatusOK,
		protocol.AgentDebugProfile,
		uint64(1),
		agentDebugInitialFrameMAC,
		payloadHash,
		protocol.Version,
	}
	canonical := agentDebugFrameCanonical(
		values[0].(string), values[1].(string), values[2].(string), values[3].(string), values[4].(string),
		values[5].(int), values[6].(string), values[7].(uint64), values[8].(string), values[9].(string), values[10].(string),
	)
	const goldenMAC = "dabbfc9d147527f17ceea62d3486b3bcf91dc9cef43bc38fc6e86186fa57cc13"
	if mac := hmacHex("0123456789abcdef0123456789abcdef", canonical); mac != goldenMAC {
		t.Fatalf("canonical golden MAC = %s", mac)
	}
	for index := range values {
		mutated := append([]any(nil), values...)
		switch value := mutated[index].(type) {
		case string:
			mutated[index] = value + "-tampered"
		case int:
			mutated[index] = value + 1
		case uint64:
			mutated[index] = value + 1
		}
		candidate := agentDebugFrameCanonical(
			mutated[0].(string), mutated[1].(string), mutated[2].(string), mutated[3].(string), mutated[4].(string),
			mutated[5].(int), mutated[6].(string), mutated[7].(uint64), mutated[8].(string), mutated[9].(string), mutated[10].(string),
		)
		if hmacHex("0123456789abcdef0123456789abcdef", candidate) == goldenMAC {
			t.Fatalf("canonical field %d is not bound", index)
		}
	}
}
