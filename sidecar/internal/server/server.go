package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/buthim/alsniper-os/sidecar/internal/agent"
	"github.com/buthim/alsniper-os/sidecar/internal/config"
	"github.com/buthim/alsniper-os/sidecar/internal/protocol"
)

const (
	headerProtocol           = "X-AIOS-Protocol-Version"
	headerTimestamp          = "X-AIOS-Timestamp"
	headerNonce              = "X-AIOS-Nonce"
	headerContentSHA256      = "X-AIOS-Content-SHA256"
	headerSignature          = "X-AIOS-Signature"
	headerRequestNonce       = "X-AIOS-Request-Nonce"
	headerRequestID          = "X-Request-Id"
	requestSignatureContext  = "AIOS1-REQUEST"
	responseSignatureContext = "AIOS1-RESPONSE"
	authenticationWindow     = 30 * time.Second
	replayCacheCapacity      = 4096
	authConcurrencyLimit     = 16
)

var (
	hexNoncePattern = regexp.MustCompile(`^[0-9a-f]{32}$`)
	hexHashPattern  = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type replayCache struct {
	mu      sync.Mutex
	expires map[string]int64
}

func newReplayCache() *replayCache { return &replayCache{expires: make(map[string]int64)} }

func (c *replayCache) add(nonce string, expiresAt, now int64) (replayed, full bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for candidate, expiry := range c.expires {
		if expiry < now {
			delete(c.expires, candidate)
		}
	}
	if _, exists := c.expires[nonce]; exists {
		return true, false
	}
	if len(c.expires) >= replayCacheCapacity {
		return false, true
	}
	c.expires[nonce] = expiresAt
	return false, false
}

type Server struct {
	cfg       config.Config
	service   *agent.Service
	handler   http.Handler
	nonces    *replayCache
	authSlots chan struct{}
	now       func() time.Time
}

func New(cfg config.Config, service *agent.Service) (*Server, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if service == nil {
		return nil, errors.New("agent service is required")
	}
	server := &Server{
		cfg: cfg, service: service, nonces: newReplayCache(),
		authSlots: make(chan struct{}, authConcurrencyLimit), now: time.Now,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/health", server.health)
	mux.HandleFunc("/v1/chat", server.chat)
	mux.HandleFunc(agentDebugTracePath, server.chatTrace)
	mux.HandleFunc("/v1/game/decide", server.decide)
	mux.HandleFunc("/", server.notFound)
	server.handler = server.security(mux)
	return server, nil
}

func (s *Server) Handler() http.Handler { return s.handler }

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		s.writeError(w, r, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only GET is supported.", false, "")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), s.cfg.ReadinessTimeout)
	defer cancel()
	readiness := s.service.Readiness(ctx)
	status := "not_ready"
	statusCode := http.StatusServiceUnavailable
	if readiness.Ready {
		status = "ready"
		statusCode = http.StatusOK
	}
	s.writeJSON(w, r, statusCode, protocol.HealthResponse{
		ProtocolVersion: protocol.Version,
		Status:          status,
		Agent:           protocol.HealthAgent{Driver: "codex", AuthMode: "linked", ProfileIsolated: true},
		Limits:          protocol.HealthLimits{MaxBodyBytes: s.cfg.MaxBodyBytes, MaxConcurrentRuns: s.cfg.MaxConcurrentRuns},
		Checks:          readiness.Checks,
	})
}

func (s *Server) chat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		s.writeError(w, r, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only POST is supported.", false, "")
		return
	}
	var req protocol.ChatRequest
	if err := s.decode(r, &req); err != nil {
		s.writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "The request body is invalid.", false, req.RequestID)
		return
	}
	if err := req.Validate(); err != nil {
		s.writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", err.Error(), false, req.RequestID)
		return
	}
	if err := s.readinessError(r.Context()); err != nil {
		s.writeAgentError(w, r, err, req.RequestID)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), s.cfg.ChatTimeout)
	defer cancel()
	response, err := s.service.Chat(ctx, req)
	if err != nil {
		s.writeAgentError(w, r, err, req.RequestID)
		return
	}
	s.writeJSON(w, r, http.StatusOK, response)
}

func (s *Server) decide(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		s.writeError(w, r, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Only POST is supported.", false, "")
		return
	}
	var req protocol.GameDecisionRequest
	if err := s.decode(r, &req); err != nil {
		s.writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "The request body is invalid.", false, req.RequestID)
		return
	}
	if err := req.Validate(); err != nil {
		s.writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", err.Error(), false, req.RequestID)
		return
	}
	if err := s.readinessError(r.Context()); err != nil {
		s.writeAgentError(w, r, err, req.RequestID)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), s.cfg.GameTimeout)
	defer cancel()
	response, err := s.service.Decide(ctx, req)
	if err != nil {
		s.writeAgentError(w, r, err, req.RequestID)
		return
	}
	s.writeJSON(w, r, http.StatusOK, response)
}

func (s *Server) notFound(w http.ResponseWriter, r *http.Request) {
	s.writeError(w, r, http.StatusNotFound, "NOT_FOUND", "The requested endpoint does not exist.", false, "")
}

func (s *Server) security(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set(headerProtocol, protocol.Version)
		w.Header().Set(headerRequestID, newRequestID())
		origin := r.Header.Get("Origin")
		if origin == s.cfg.AllowedOrigin {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Expose-Headers", strings.Join([]string{headerProtocol, headerRequestID, headerRequestNonce, headerContentSHA256, headerSignature, headerAgentDebugProfile}, ", "))
			w.Header().Set("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			s.preflight(w, r)
			return
		}
		if origin != s.cfg.AllowedOrigin {
			s.writeError(w, r, http.StatusForbidden, "ORIGIN_DENIED", "The request origin is not allowed.", false, "")
			return
		}
		if !s.authenticate(w, r) {
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) preflight(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") != s.cfg.AllowedOrigin {
		s.writeError(w, r, http.StatusForbidden, "ORIGIN_DENIED", "The request origin is not allowed.", false, "")
		return
	}
	requestedMethod := r.Header.Get("Access-Control-Request-Method")
	if requestedMethod != http.MethodGet && requestedMethod != http.MethodPost {
		s.writeError(w, r, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "The requested method is not allowed.", false, "")
		return
	}
	allowed := map[string]struct{}{
		"content-type": {}, "x-aios-protocol-version": {}, "x-aios-timestamp": {}, "x-aios-nonce": {},
		"x-aios-content-sha256": {}, "x-aios-signature": {},
	}
	for _, header := range strings.Split(r.Header.Get("Access-Control-Request-Headers"), ",") {
		name := strings.ToLower(strings.TrimSpace(header))
		if name == "" {
			continue
		}
		if _, ok := allowed[name]; !ok {
			s.writeError(w, r, http.StatusForbidden, "HEADER_DENIED", "A requested header is not allowed.", false, "")
			return
		}
	}
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-AIOS-Protocol-Version, X-AIOS-Timestamp, X-AIOS-Nonce, X-AIOS-Content-SHA256, X-AIOS-Signature")
	w.Header().Set("Access-Control-Max-Age", "600")
	s.writeSignedBytes(w, r, http.StatusNoContent, nil, "")
}

func (s *Server) authenticate(w http.ResponseWriter, r *http.Request) bool {
	if r.Header.Get(headerProtocol) != protocol.Version {
		s.writeError(w, r, http.StatusUpgradeRequired, "PROTOCOL_MISMATCH", "The client protocol version is not supported.", false, "")
		return false
	}
	if r.URL.RawQuery != "" || r.URL.Fragment != "" {
		s.writeError(w, r, http.StatusBadRequest, "INVALID_TARGET", "Request queries and fragments are not supported.", false, "")
		return false
	}
	timestampText := r.Header.Get(headerTimestamp)
	nonce := r.Header.Get(headerNonce)
	declaredHash := r.Header.Get(headerContentSHA256)
	signature := r.Header.Get(headerSignature)
	if len(timestampText) < 1 || len(timestampText) > 16 || !hexNoncePattern.MatchString(nonce) || !hexHashPattern.MatchString(declaredHash) || !hexHashPattern.MatchString(signature) {
		s.writeError(w, r, http.StatusUnauthorized, "UNAUTHORIZED", "Request authentication failed.", false, "")
		return false
	}
	timestamp, err := strconv.ParseInt(timestampText, 10, 64)
	if err != nil {
		s.writeError(w, r, http.StatusUnauthorized, "UNAUTHORIZED", "Request authentication failed.", false, "")
		return false
	}
	now := s.now().UnixMilli()
	window := authenticationWindow.Milliseconds()
	if timestamp < now-window || timestamp > now+window {
		s.writeError(w, r, http.StatusUnauthorized, "STALE_REQUEST", "Request authentication timestamp is outside the accepted window.", true, "")
		return false
	}
	select {
	case s.authSlots <- struct{}{}:
		defer func() { <-s.authSlots }()
	default:
		s.writeError(w, r, http.StatusTooManyRequests, "AUTH_BUSY", "The authentication concurrency limit is reached.", true, "")
		return false
	}
	body, tooLarge, err := readBoundedBody(r.Body, s.cfg.MaxBodyBytes)
	if err != nil {
		s.writeError(w, r, http.StatusBadRequest, "INVALID_REQUEST", "The request body could not be read.", false, "")
		return false
	}
	if tooLarge {
		s.writeError(w, r, http.StatusRequestEntityTooLarge, "REQUEST_TOO_LARGE", "The request body exceeds the configured limit.", false, "")
		return false
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	actualHash := sha256Hex(body)
	if !secureEqual(actualHash, declaredHash) {
		s.writeError(w, r, http.StatusUnauthorized, "UNAUTHORIZED", "Request authentication failed.", false, "")
		return false
	}
	canonical := requestCanonical(r.Method, s.transportAuthority(), r.URL.EscapedPath(), s.cfg.AllowedOrigin, protocol.Version, timestampText, nonce, declaredHash)
	expected := hmacHex(s.cfg.Token, canonical)
	if !secureEqual(expected, signature) {
		s.writeError(w, r, http.StatusUnauthorized, "UNAUTHORIZED", "Request authentication failed.", false, "")
		return false
	}
	replayed, full := s.nonces.add(nonce, timestamp+window, now)
	if replayed {
		s.writeError(w, r, http.StatusConflict, "REPLAY_DETECTED", "The authenticated request nonce was already used.", false, "")
		return false
	}
	if full {
		s.writeError(w, r, http.StatusServiceUnavailable, "AUTH_CAPACITY_REACHED", "The authentication replay window is temporarily full.", true, "")
		return false
	}
	return true
}

func readBoundedBody(body io.ReadCloser, limit int64) ([]byte, bool, error) {
	if body == nil {
		return nil, false, nil
	}
	defer body.Close()
	data, err := io.ReadAll(io.LimitReader(body, limit+1))
	if err != nil {
		return nil, false, err
	}
	return data, int64(len(data)) > limit, nil
}

func (s *Server) readinessError(parent context.Context) error {
	ctx, cancel := context.WithTimeout(parent, s.cfg.ReadinessTimeout)
	defer cancel()
	return classifyReadiness(s.service.Readiness(ctx))
}

func (s *Server) decode(r *http.Request, dst any) error {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return errors.New("content type must be application/json")
	}
	data, err := io.ReadAll(r.Body)
	if err != nil {
		return err
	}
	if len(data) == 0 {
		return errors.New("request body is empty")
	}
	return protocol.DecodeStrict(data, dst)
}

func (s *Server) writeAgentError(w http.ResponseWriter, r *http.Request, err error, requestID string) {
	classified := classifyAgentError(err)
	s.writeError(w, r, classified.status, classified.body.Code, classified.body.Message, classified.body.Retryable, requestID)
}

func (s *Server) writeError(w http.ResponseWriter, r *http.Request, status int, code, message string, retryable bool, requestID string) {
	if requestID == "" {
		requestID = w.Header().Get(headerRequestID)
	}
	s.writeJSON(w, r, status, protocol.ErrorEnvelope{Error: protocol.ErrorBody{Code: code, Message: message, RequestID: requestID, Retryable: retryable}})
}

func (s *Server) writeJSON(w http.ResponseWriter, r *http.Request, status int, value any) {
	body, err := json.Marshal(value)
	if err != nil {
		body = []byte(`{"error":{"code":"INTERNAL_ERROR","message":"The response could not be encoded.","requestId":"request-unavailable","retryable":true}}`)
		status = http.StatusInternalServerError
	}
	body = append(body, '\n')
	s.writeSignedBytes(w, r, status, body, "application/json; charset=utf-8")
}

func (s *Server) writeSignedBytes(w http.ResponseWriter, r *http.Request, status int, body []byte, contentType string) {
	requestNonce := boundedRequestNonce(r.Header.Get(headerNonce))
	requestID := w.Header().Get(headerRequestID)
	bodyHash := sha256Hex(body)
	canonical := responseCanonical(requestNonce, requestID, status, bodyHash, protocol.Version)
	w.Header().Set(headerRequestNonce, requestNonce)
	w.Header().Set(headerContentSHA256, bodyHash)
	w.Header().Set(headerSignature, hmacHex(s.cfg.Token, canonical))
	if contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.WriteHeader(status)
	if len(body) > 0 {
		_, _ = w.Write(body)
	}
}

func boundedRequestNonce(value string) string {
	if hexNoncePattern.MatchString(value) {
		return value
	}
	return ""
}

func (s *Server) transportAuthority() string {
	_, port, _ := net.SplitHostPort(s.cfg.ListenAddress)
	portNumber, _ := strconv.Atoi(port)
	return "http://127.0.0.1:" + strconv.Itoa(portNumber)
}

func requestCanonical(method, authority, path, origin, version, timestamp, nonce, bodyHash string) string {
	return strings.Join([]string{requestSignatureContext, method, authority, path, origin, version, timestamp, nonce, bodyHash}, "\n")
}

func responseCanonical(nonce, requestID string, status int, bodyHash, version string) string {
	return strings.Join([]string{responseSignatureContext, nonce, requestID, strconv.Itoa(status), bodyHash, version}, "\n")
}

func hmacHex(secret, canonical string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(canonical))
	return hex.EncodeToString(mac.Sum(nil))
}

func sha256Hex(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

func secureEqual(left, right string) bool {
	leftHash, rightHash := sha256.Sum256([]byte(left)), sha256.Sum256([]byte(right))
	return subtle.ConstantTimeCompare(leftHash[:], rightHash[:]) == 1
}

func newRequestID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return fmt.Sprintf("request-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(value[:])
}
