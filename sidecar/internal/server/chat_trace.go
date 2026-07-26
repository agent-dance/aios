package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/buthim/alsniper-os/sidecar/internal/agent"
	"github.com/buthim/alsniper-os/sidecar/internal/protocol"
)

const (
	agentDebugTracePath         = "/v1/chat/trace"
	agentDebugContentType       = "application/x-ndjson"
	headerAgentDebugProfile     = "X-AIOS-Stream-Profile"
	agentDebugFrameContext      = "AIOS1-STREAM-FRAME"
	agentDebugTracePayloadLimit = 32 * 1024
	agentDebugTerminalLimit     = 4 * 1024 * 1024
	agentDebugWireFrameLimit    = 6 * 1024 * 1024
	agentDebugStreamLimit       = 6 * 1024 * 1024
	agentDebugEventLimit        = 16
	agentDebugSignalBuffer      = 2
	agentDebugWriteTimeout      = 2 * time.Second
	agentDebugInitialFrameMAC   = "0000000000000000000000000000000000000000000000000000000000000000"
)

var errAgentDebugFrameRejected = errors.New("Agent debug frame rejected before write")

var agentDebugSafeTargetPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._,:-]{0,127}$`)

type agentDebugValidPayload interface {
	Validate() error
}

type agentDebugStreamWriter struct {
	server       *Server
	w            http.ResponseWriter
	requestID    string
	requestNonce string
	sequence     uint64
	previousMAC  string
	eventCount   int
	totalBytes   int
}

func newAgentDebugStreamWriter(server *Server, w http.ResponseWriter, r *http.Request) *agentDebugStreamWriter {
	return &agentDebugStreamWriter{
		server: server, w: w,
		requestID: w.Header().Get(headerRequestID), requestNonce: boundedRequestNonce(r.Header.Get(headerNonce)),
		previousMAC: agentDebugInitialFrameMAC,
	}
}

func (w *agentDebugStreamWriter) start() error {
	w.w.Header().Set("Content-Type", agentDebugContentType)
	w.w.Header().Set(headerRequestNonce, w.requestNonce)
	w.w.Header().Set(headerAgentDebugProfile, protocol.AgentDebugProfile)
	w.w.WriteHeader(http.StatusOK)
	return w.flush()
}

func (w *agentDebugStreamWriter) write(payload agentDebugValidPayload) error {
	if payload == nil || w.eventCount >= agentDebugEventLimit {
		return fmt.Errorf("%w: event limit exceeded", errAgentDebugFrameRejected)
	}
	if err := payload.Validate(); err != nil {
		return fmt.Errorf("%w: validate payload: %v", errAgentDebugFrameRejected, err)
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("%w: encode payload", errAgentDebugFrameRejected)
	}
	payloadLimit := agentDebugTracePayloadLimit
	switch payload.(type) {
	case protocol.AgentDebugCompletedPayload, protocol.AgentDebugFailedPayload:
		payloadLimit = agentDebugTerminalLimit
	}
	if len(raw) == 0 || len(raw) > payloadLimit {
		return fmt.Errorf("%w: payload size limit exceeded", errAgentDebugFrameRejected)
	}
	sequence := w.sequence + 1
	payloadHash := sha256Hex(raw)
	canonical := agentDebugFrameCanonical(
		w.requestNonce,
		w.requestID,
		w.server.transportAuthority(),
		http.MethodPost,
		agentDebugTracePath,
		http.StatusOK,
		protocol.AgentDebugProfile,
		sequence,
		w.previousMAC,
		payloadHash,
		protocol.Version,
	)
	mac := hmacHex(w.server.cfg.Token, canonical)
	line := strconv.FormatUint(sequence, 10) + "." + base64.RawURLEncoding.EncodeToString(raw) + "." + mac + "\n"
	if len(line) > agentDebugWireFrameLimit {
		return fmt.Errorf("%w: wire frame size limit exceeded", errAgentDebugFrameRejected)
	}
	if w.totalBytes+len(line) > agentDebugStreamLimit {
		return fmt.Errorf("%w: stream size limit exceeded", errAgentDebugFrameRejected)
	}
	controller := http.NewResponseController(w.w)
	if err := controller.SetWriteDeadline(time.Now().Add(agentDebugWriteTimeout)); err != nil && !errors.Is(err, http.ErrNotSupported) {
		return err
	}
	defer func() { _ = controller.SetWriteDeadline(time.Time{}) }()
	if _, err := io.WriteString(w.w, line); err != nil {
		return err
	}
	if err := controller.Flush(); err != nil && !errors.Is(err, http.ErrNotSupported) {
		return err
	}
	w.sequence = sequence
	w.previousMAC = mac
	w.eventCount++
	w.totalBytes += len(line)
	return nil
}

func (w *agentDebugStreamWriter) flush() error {
	controller := http.NewResponseController(w.w)
	if err := controller.SetWriteDeadline(time.Now().Add(agentDebugWriteTimeout)); err != nil && !errors.Is(err, http.ErrNotSupported) {
		return err
	}
	defer func() { _ = controller.SetWriteDeadline(time.Time{}) }()
	if err := controller.Flush(); err != nil && !errors.Is(err, http.ErrNotSupported) {
		return err
	}
	return nil
}

func agentDebugFrameCanonical(
	requestNonce, requestID, authority, method, path string,
	status int,
	profile string,
	sequence uint64,
	previousMAC, payloadHash, version string,
) string {
	return strings.Join([]string{
		agentDebugFrameContext,
		requestNonce,
		requestID,
		authority,
		method,
		path,
		strconv.Itoa(status),
		profile,
		strconv.FormatUint(sequence, 10),
		previousMAC,
		payloadHash,
		version,
	}, "\n")
}

type chatTraceSignal struct {
	stage    agent.ChatTraceStage
	decision *agent.ChatDecisionSummary
}

type channelChatTraceSink struct {
	channel chan<- chatTraceSignal
}

func (s channelChatTraceSink) Stage(ctx context.Context, stage agent.ChatTraceStage) error {
	select {
	case s.channel <- chatTraceSignal{stage: stage}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s channelChatTraceSink) Decision(ctx context.Context, decision agent.ChatDecisionSummary) error {
	select {
	case s.channel <- chatTraceSignal{decision: &decision}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

type chatTraceResult struct {
	response protocol.ChatResponse
	err      error
}

func (s *Server) chatTrace(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		s.writeError(w, r, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only POST is supported.", false, "")
		return
	}
	var request protocol.AgentDebugTraceRequest
	if err := s.decode(r, &request); err != nil {
		s.writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "The request body is invalid.", false, request.Request.RequestID)
		return
	}
	if err := request.Validate(); err != nil {
		s.writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", err.Error(), false, request.Request.RequestID)
		return
	}
	if err := s.readinessError(r.Context()); err != nil {
		s.writeAgentError(w, r, err, request.Request.RequestID)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), s.cfg.ChatTimeout)
	defer cancel()
	stream := newAgentDebugStreamWriter(s, w, r)
	if err := stream.start(); err != nil {
		return
	}

	started := s.now()
	traceID := newRequestID()
	signals := make(chan chatTraceSignal, agentDebugSignalBuffer)
	result := make(chan chatTraceResult, 1)
	go func() {
		response, err := s.service.ChatWithTrace(ctx, request.Request, channelChatTraceSink{channel: signals})
		result <- chatTraceResult{response: response, err: err}
		close(signals)
	}()

	for signal := range signals {
		payload, err := s.agentDebugTracePayload(traceID, started, signal)
		if err != nil || stream.write(payload) != nil {
			cancel()
			return
		}
	}
	outcome := <-result
	if outcome.err != nil {
		failure := s.agentDebugFailure(outcome.err)
		if err := stream.write(s.agentDebugFailureTracePayload(traceID, started, failure)); err != nil {
			cancel()
			return
		}
		if err := stream.write(protocol.AgentDebugFailedPayload{
			Kind: "failed", TraceID: traceID, TimeUnixMS: s.now().UnixMilli(), Error: failure,
		}); err != nil {
			cancel()
		}
		return
	}
	if err := stream.write(protocol.AgentDebugCompletedPayload{
		Kind: "completed", TraceID: traceID, TimeUnixMS: s.now().UnixMilli(), Response: outcome.response,
	}); err != nil {
		if errors.Is(err, errAgentDebugFrameRejected) {
			if fallbackErr := stream.write(protocol.AgentDebugFailedPayload{
				Kind: "failed", TraceID: traceID, TimeUnixMS: s.now().UnixMilli(),
				Error: protocol.AgentDebugFailureBody{
					Code: "TRACE_RESPONSE_REJECTED", Message: "The Agent response exceeded the debug stream contract.", Retryable: false,
				},
			}); fallbackErr != nil {
				cancel()
			}
		}
		cancel()
	}
}

func (s *Server) agentDebugFailureTracePayload(traceID string, started time.Time, failure protocol.AgentDebugFailureBody) protocol.AgentDebugTracePayload {
	now := s.now()
	elapsed := now.Sub(started).Milliseconds()
	if elapsed < 0 {
		elapsed = 0
	}
	if elapsed > 600000 {
		elapsed = 600000
	}
	return protocol.AgentDebugTracePayload{
		Kind:       "trace",
		TraceID:    traceID,
		TimeUnixMS: now.UnixMilli(),
		Source:     "sidecar",
		Stage:      "completion",
		Status:     "failed",
		Title:      "Agent run failed",
		Detail:     failure.Message,
		ElapsedMS:  elapsed,
	}
}

func (s *Server) agentDebugTracePayload(traceID string, started time.Time, signal chatTraceSignal) (protocol.AgentDebugTracePayload, error) {
	now := s.now()
	elapsed := now.Sub(started).Milliseconds()
	if elapsed < 0 {
		elapsed = 0
	}
	if elapsed > 600000 {
		elapsed = 600000
	}
	base := protocol.AgentDebugTracePayload{
		Kind: "trace", TraceID: traceID, TimeUnixMS: now.UnixMilli(), Source: "sidecar", ElapsedMS: elapsed,
	}
	if signal.decision != nil {
		base.Stage = "decision"
		base.Status = "info"
		base.Title = "Decision summary"
		base.Detail = fmt.Sprintf(
			"mood=%s; intent=%s; surface=%s; domain_agent=%s",
			signal.decision.Mood,
			signal.decision.IntentType,
			yesNo(signal.decision.HasSurface),
			yesNo(signal.decision.ActiveAgentSelected),
		)
		if agentDebugSafeTargetPattern.MatchString(signal.decision.Target) {
			base.Detail += "; target=" + signal.decision.Target
		}
		return base, base.Validate()
	}
	switch signal.stage {
	case agent.ChatTraceRequestAccepted:
		base.Stage, base.Status, base.Title = "request", "started", "Request accepted"
	case agent.ChatTraceContextValidated:
		base.Stage, base.Status, base.Title = "request", "completed", "Context validated"
	case agent.ChatTraceExecutionStarted:
		base.Stage, base.Status, base.Title = "analysis", "started", "Model execution started"
		base.Detail = "Waiting for one locally schema-validated response."
	case agent.ChatTraceExecutionComplete:
		base.Stage, base.Status, base.Title = "analysis", "completed", "Model execution completed"
	case agent.ChatTraceOutputValidated:
		base.Stage, base.Status, base.Title = "decision", "completed", "Structured output validated"
	case agent.ChatTraceResponseReady:
		base.Stage, base.Status, base.Title = "completion", "completed", "Response ready"
	default:
		return protocol.AgentDebugTracePayload{}, errors.New("unsupported Agent debug stage")
	}
	return base, base.Validate()
}

func yesNo(value bool) string {
	if value {
		return "yes"
	}
	return "no"
}

func (s *Server) agentDebugFailure(err error) protocol.AgentDebugFailureBody {
	return classifyAgentError(err).body
}
