package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/buthim/alsniper-os/sidecar/internal/agent"
	"github.com/buthim/alsniper-os/sidecar/internal/config"
	"github.com/buthim/alsniper-os/sidecar/internal/protocol"
)

type runner struct {
	output []byte
	ready  bool
	wait   bool
	err    error
}

func (f runner) Run(ctx context.Context, _ agent.RunRequest) (agent.RunResult, error) {
	if f.wait {
		<-ctx.Done()
		return agent.RunResult{}, ctx.Err()
	}
	if f.err != nil {
		return agent.RunResult{}, f.err
	}
	return agent.RunResult{RunID: "run-1", JSON: f.output}, nil
}
func (f runner) Readiness(context.Context) agent.Readiness {
	return agent.Readiness{Ready: f.ready, Checks: []protocol.HealthCheck{{Code: "test", Status: map[bool]string{true: "pass", false: "fail"}[f.ready], Message: "test readiness"}}}
}

func testConfig(t *testing.T) config.Config {
	return config.Config{ListenAddress: "127.0.0.1:4317", Token: strings.Repeat("t", 32), AllowedOrigin: "http://localhost:5173", ProfileDir: filepath.Join(t.TempDir(), "profile"), WorkspaceDir: filepath.Join(t.TempDir(), "workspace"), CodexCommand: "codex", MaxBodyBytes: 1024, MaxConcurrentRuns: 2, ChatTimeout: time.Second, GameTimeout: time.Second, ReadinessTimeout: time.Second}
}
func handler(t *testing.T, r runner, cfg config.Config) http.Handler {
	t.Helper()
	service, err := agent.NewService(r, cfg.MaxConcurrentRuns)
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(cfg, service)
	if err != nil {
		t.Fatal(err)
	}
	return server.Handler()
}
func request(method, path, body string, cfg config.Config) *http.Request {
	return requestAt(method, path, body, cfg, time.Now().UnixMilli(), "00112233445566778899aabbccddeeff")
}
func requestAt(method, path, body string, cfg config.Config, timestamp int64, nonce string) *http.Request {
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	req.Header.Set("Origin", cfg.AllowedOrigin)
	req.Header.Set(headerProtocol, protocol.Version)
	timestampText := strconv.FormatInt(timestamp, 10)
	bodyHash := sha256Hex([]byte(body))
	req.Header.Set(headerTimestamp, timestampText)
	req.Header.Set(headerNonce, nonce)
	req.Header.Set(headerContentSHA256, bodyHash)
	req.Header.Set(headerSignature, hmacHex(cfg.Token, requestCanonical(method, (&Server{cfg: cfg}).transportAuthority(), path, cfg.AllowedOrigin, protocol.Version, timestampText, nonce, bodyHash)))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	return req
}

func verifySignedResponse(t *testing.T, rec *httptest.ResponseRecorder, cfg config.Config, nonce string) {
	t.Helper()
	if rec.Header().Get(headerRequestNonce) != nonce {
		t.Fatalf("response nonce = %q", rec.Header().Get(headerRequestNonce))
	}
	bodyHash := sha256Hex(rec.Body.Bytes())
	if rec.Header().Get(headerContentSHA256) != bodyHash {
		t.Fatalf("response body hash mismatch")
	}
	expected := hmacHex(cfg.Token, responseCanonical(nonce, rec.Header().Get(headerRequestID), rec.Code, bodyHash, rec.Header().Get(headerProtocol)))
	if !hmac.Equal([]byte(expected), []byte(rec.Header().Get(headerSignature))) {
		t.Fatal("response signature mismatch")
	}
}
func decodeError(t *testing.T, rec *httptest.ResponseRecorder) protocol.ErrorEnvelope {
	t.Helper()
	var value protocol.ErrorEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestHealthAndCORSPreflight(t *testing.T) {
	cfg := testConfig(t)
	h := handler(t, runner{ready: true, output: []byte(`{"message":"hello","mood":"helpful","intents":[]}`)}, cfg)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, request(http.MethodGet, "/v1/health", "", cfg))
	if rec.Code != http.StatusOK {
		t.Fatalf("health status %d: %s", rec.Code, rec.Body.String())
	}
	var health protocol.HealthResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &health); err != nil {
		t.Fatal(err)
	}
	if health.Status != "ready" || health.ProtocolVersion != protocol.Version {
		t.Fatalf("bad health: %+v", health)
	}
	verifySignedResponse(t, rec, cfg, "00112233445566778899aabbccddeeff")
	exposed := strings.ToLower(rec.Header().Get("Access-Control-Expose-Headers"))
	for _, required := range []string{"x-aios-protocol-version", "x-request-id", "x-aios-request-nonce", "x-aios-content-sha256", "x-aios-signature", "x-aios-stream-profile"} {
		if !strings.Contains(exposed, required) {
			t.Fatalf("browser cannot read %s response header: %q", required, exposed)
		}
	}
	preflight := httptest.NewRequest(http.MethodOptions, "/v1/chat", nil)
	preflight.Header.Set("Origin", cfg.AllowedOrigin)
	preflight.Header.Set("Access-Control-Request-Method", "POST")
	preflight.Header.Set("Access-Control-Request-Headers", "content-type,x-aios-protocol-version,x-aios-timestamp,x-aios-nonce,x-aios-content-sha256,x-aios-signature")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, preflight)
	if rec.Code != http.StatusNoContent || rec.Header().Get("Access-Control-Allow-Origin") != cfg.AllowedOrigin {
		t.Fatalf("bad preflight: %d %+v", rec.Code, rec.Header())
	}
	verifySignedResponse(t, rec, cfg, "")

	withoutOrigin := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/health", nil)
	h.ServeHTTP(withoutOrigin, req)
	if withoutOrigin.Header().Get("Access-Control-Expose-Headers") != "" {
		t.Fatal("CORS response headers were exposed without the exact allowed origin")
	}
}

func TestProtectedEndpointsRejectAuthOriginProtocolAndOversize(t *testing.T) {
	cfg := testConfig(t)
	h := handler(t, runner{ready: true}, cfg)
	body := `{"requestId":"r-1","threadId":"t-1","message":"hello","context":{"osRevision":0}}`
	tests := []struct {
		name   string
		body   string
		mutate func(*http.Request)
		want   int
		code   string
	}{
		{"auth", body, func(r *http.Request) { r.Header.Set(headerSignature, strings.Repeat("0", 64)) }, http.StatusUnauthorized, "UNAUTHORIZED"},
		{"origin", body, func(r *http.Request) { r.Header.Set("Origin", "http://evil.invalid") }, http.StatusForbidden, "ORIGIN_DENIED"},
		{"protocol", body, func(r *http.Request) { r.Header.Set(headerProtocol, "0.0.0") }, http.StatusUpgradeRequired, "PROTOCOL_MISMATCH"},
		{"unknown-field", strings.TrimSuffix(body, "}") + `,"extra":true}`, func(*http.Request) {}, http.StatusBadRequest, "INVALID_REQUEST"},
		{"oversize", strings.Repeat("x", 2048), func(*http.Request) {}, http.StatusRequestEntityTooLarge, "REQUEST_TOO_LARGE"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := request(http.MethodPost, "/v1/chat", test.body, cfg)
			test.mutate(req)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != test.want {
				t.Fatalf("got %d: %s", rec.Code, rec.Body.String())
			}
			if got := decodeError(t, rec).Error.Code; got != test.code {
				t.Fatalf("got code %s", got)
			}
			verifySignedResponse(t, rec, cfg, "00112233445566778899aabbccddeeff")
		})
	}
}

func TestHealthRequiresAuthenticationAndPreflightRejectsBearerHeader(t *testing.T) {
	cfg := testConfig(t)
	h := handler(t, runner{ready: true}, cfg)
	unsigned := httptest.NewRequest(http.MethodGet, "/v1/health", nil)
	unsigned.Header.Set("Origin", cfg.AllowedOrigin)
	unsigned.Header.Set(headerProtocol, protocol.Version)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, unsigned)
	if rec.Code != http.StatusUnauthorized || decodeError(t, rec).Error.Code != "UNAUTHORIZED" {
		t.Fatalf("unsigned health: %d %s", rec.Code, rec.Body.String())
	}
	verifySignedResponse(t, rec, cfg, "")

	preflight := httptest.NewRequest(http.MethodOptions, "/v1/health", nil)
	preflight.Header.Set("Origin", cfg.AllowedOrigin)
	preflight.Header.Set("Access-Control-Request-Method", http.MethodGet)
	preflight.Header.Set("Access-Control-Request-Headers", "authorization,x-aios-signature")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, preflight)
	if rec.Code != http.StatusForbidden || decodeError(t, rec).Error.Code != "HEADER_DENIED" {
		t.Fatalf("Bearer preflight: %d %s", rec.Code, rec.Body.String())
	}
	verifySignedResponse(t, rec, cfg, "")
}

func TestChatSuccessAndInvalidGameAction(t *testing.T) {
	cfg := testConfig(t)
	h := handler(t, runner{ready: true, output: []byte(`{"message":"hello","mood":"helpful","intents":[]}`)}, cfg)
	body := `{"requestId":"r-1","threadId":"t-1","message":"hello","context":{"osRevision":0}}`
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, request(http.MethodPost, "/v1/chat", body, cfg))
	if rec.Code != http.StatusOK {
		t.Fatalf("chat: %d %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("X-AIOS-Protocol-Version") != protocol.Version {
		t.Fatal("missing protocol response header")
	}
	gameHandler := handler(t, runner{ready: true, output: []byte(`{"actionId":"invented"}`)}, cfg)
	game := `{"requestId":"r-2","gameId":"doudizhu","gameVersion":"1.0.0","matchId":"m-1","seatId":"seat-1","observation":{"revision":1,"terminal":false,"decision":{"mode":"sequential","phase":"play","activeSeatIds":["seat-1"],"turnNonce":"n-1"},"observation":{"cards":[]}},"legalActions":[{"id":"pass","label":"Pass","action":{"type":"pass"}}]}`
	rec = httptest.NewRecorder()
	gameHandler.ServeHTTP(rec, request(http.MethodPost, "/v1/game/decide", game, cfg))
	if rec.Code != http.StatusBadGateway || decodeError(t, rec).Error.Code != "INVALID_AGENT_OUTPUT" {
		t.Fatalf("illegal action response: %d %s", rec.Code, rec.Body.String())
	}
}

func TestChatAuthenticatesAdvertisedApplicationActionResponse(t *testing.T) {
	cfg := testConfig(t)
	output := []byte(`{"message":"Prepared.","mood":"focused","intents":[{"id":"send-1","type":"execute_app_action","appId":"wechat","actionId":"wechat.message.send_to_current","arguments":{"text":"line 1\r\nline 2 \ud83d\ude00"}}]}`)
	h := handler(t, runner{ready: true, output: output}, cfg)
	body := `{"requestId":"r-action","threadId":"t-action","message":"send it","context":{"osRevision":9,"availableApplicationActions":[{"appId":"wechat","actionId":"wechat.message.send_to_current","argumentSchemaId":"wechat.message.send_to_current.arguments@1"}]}}`
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, request(http.MethodPost, "/v1/chat", body, cfg))
	if rec.Code != http.StatusOK {
		t.Fatalf("application action chat: %d %s", rec.Code, rec.Body.String())
	}
	verifySignedResponse(t, rec, cfg, "00112233445566778899aabbccddeeff")
	var response protocol.ChatResponse
	if err := protocol.DecodeStrict(rec.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Intents) != 1 || response.Intents[0].ExpectedRevision == nil || *response.Intents[0].ExpectedRevision != 9 {
		t.Fatalf("invalid application action response: %+v", response.Intents)
	}
	var arguments protocol.WeChatSendToCurrentArguments
	if err := protocol.DecodeStrict(response.Intents[0].Arguments, &arguments); err != nil {
		t.Fatal(err)
	}
	if arguments.Text != "line 1\nline 2 😀" || strings.ContainsRune(arguments.Text, '\ufffd') {
		t.Fatalf("application action arguments were not normalized: %q", arguments.Text)
	}
}

func TestChatRejectsInvalidWeChatUnicodeBeforeSignedResponse(t *testing.T) {
	cfg := testConfig(t)
	body := `{"requestId":"r-action","threadId":"t-action","message":"send it","context":{"osRevision":9,"availableApplicationActions":[{"appId":"wechat","actionId":"wechat.message.send_to_current","argumentSchemaId":"wechat.message.send_to_current.arguments@1"}]}}`
	for _, test := range []struct {
		name string
		text string
	}{
		{name: "lone high surrogate", text: `bad \ud83d`},
		{name: "lone low surrogate", text: `bad \ude00`},
		{name: "bidi override", text: `bad \u202e display`},
		{name: "control character", text: `bad \u0007 display`},
		{name: "BOM-only text", text: `\ufeff`},
	} {
		t.Run(test.name, func(t *testing.T) {
			output := []byte(`{"message":"Prepared.","mood":"focused","intents":[{"id":"send-1","type":"execute_app_action","appId":"wechat","actionId":"wechat.message.send_to_current","arguments":{"text":"` + test.text + `"}}]}`)
			h := handler(t, runner{ready: true, output: output}, cfg)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, request(http.MethodPost, "/v1/chat", body, cfg))
			if rec.Code != http.StatusBadGateway || decodeError(t, rec).Error.Code != "INVALID_AGENT_OUTPUT" {
				t.Fatalf("invalid WeChat Unicode response: %d %s", rec.Code, rec.Body.String())
			}
			verifySignedResponse(t, rec, cfg, "00112233445566778899aabbccddeeff")
		})
	}
}

func TestCancellationMapsToStableError(t *testing.T) {
	cfg := testConfig(t)
	h := handler(t, runner{ready: true, wait: true}, cfg)
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(time.Millisecond); cancel() }()
	rec := httptest.NewRecorder()
	req := request(http.MethodPost, "/v1/chat", `{"requestId":"r-1","threadId":"t-1","message":"hello","context":{"osRevision":0}}`, cfg).WithContext(ctx)
	h.ServeHTTP(rec, req)
	if rec.Code != 499 || decodeError(t, rec).Error.Code != "REQUEST_CANCELLED" {
		t.Fatalf("timeout response: %d %s", rec.Code, rec.Body.String())
	}
}

func TestAuthenticationRejectsReplayStaleAndTampering(t *testing.T) {
	cfg := testConfig(t)
	h := handler(t, runner{ready: true, output: []byte(`{"message":"hello","mood":"helpful","intents":[]}`)}, cfg)
	body := `{"requestId":"r-1","threadId":"t-1","message":"hello","context":{"osRevision":0}}`
	nonce := "11223344556677889900aabbccddeeff"

	valid := requestAt(http.MethodPost, "/v1/chat", body, cfg, time.Now().UnixMilli(), nonce)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, valid)
	if rec.Code != http.StatusOK {
		t.Fatalf("first authenticated request: %d %s", rec.Code, rec.Body.String())
	}

	replay := requestAt(http.MethodPost, "/v1/chat", body, cfg, time.Now().UnixMilli(), nonce)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, replay)
	if rec.Code != http.StatusConflict || decodeError(t, rec).Error.Code != "REPLAY_DETECTED" {
		t.Fatalf("replay: %d %s", rec.Code, rec.Body.String())
	}
	verifySignedResponse(t, rec, cfg, nonce)

	staleNonce := "21223344556677889900aabbccddeeff"
	stale := requestAt(http.MethodPost, "/v1/chat", body, cfg, time.Now().Add(-time.Minute).UnixMilli(), staleNonce)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, stale)
	if rec.Code != http.StatusUnauthorized || decodeError(t, rec).Error.Code != "STALE_REQUEST" {
		t.Fatalf("stale: %d %s", rec.Code, rec.Body.String())
	}
	verifySignedResponse(t, rec, cfg, staleNonce)

	tamperedBodyNonce := "31223344556677889900aabbccddeeff"
	tamperedBody := requestAt(http.MethodPost, "/v1/chat", body, cfg, time.Now().UnixMilli(), tamperedBodyNonce)
	tamperedBody.Body = io.NopCloser(bytes.NewBufferString(body + " "))
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, tamperedBody)
	if rec.Code != http.StatusUnauthorized || decodeError(t, rec).Error.Code != "UNAUTHORIZED" {
		t.Fatalf("tampered body: %d %s", rec.Code, rec.Body.String())
	}
	verifySignedResponse(t, rec, cfg, tamperedBodyNonce)

	tamperedPathNonce := "41223344556677889900aabbccddeeff"
	tamperedPath := requestAt(http.MethodGet, "/v1/health", "", cfg, time.Now().UnixMilli(), tamperedPathNonce)
	tamperedPath.URL.Path = "/v1/not-health"
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, tamperedPath)
	if rec.Code != http.StatusUnauthorized || decodeError(t, rec).Error.Code != "UNAUTHORIZED" {
		t.Fatalf("tampered path: %d %s", rec.Code, rec.Body.String())
	}
	verifySignedResponse(t, rec, cfg, tamperedPathNonce)

	wrongAuthorityNonce := "51223344556677889900aabbccddeeff"
	wrongAuthority := cfg
	wrongAuthority.ListenAddress = "127.0.0.1:4318"
	req := requestAt(http.MethodGet, "/v1/health", "", wrongAuthority, time.Now().UnixMilli(), wrongAuthorityNonce)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized || decodeError(t, rec).Error.Code != "UNAUTHORIZED" {
		t.Fatalf("wrong authority: %d %s", rec.Code, rec.Body.String())
	}
	verifySignedResponse(t, rec, cfg, wrongAuthorityNonce)
}

func TestCanonicalHMACGoldenVectors(t *testing.T) {
	secret := "0123456789abcdef0123456789abcdef"
	bodyHash := sha256Hex([]byte(`{"x":1}`))
	if bodyHash != "5041bf1f713df204784353e82f6a4a535931cb64f1f4b4a5aeaffcb720918b22" {
		t.Fatalf("request body hash = %s", bodyHash)
	}
	requestMAC := hmacHex(secret, requestCanonical(
		http.MethodPost, "http://127.0.0.1:4317", "/v1/chat", "http://localhost:5173", protocol.Version, "1785038400000",
		"00112233445566778899aabbccddeeff", bodyHash,
	))
	if requestMAC != "6cd2cc6a2b370b5c7bb4a9fac7e4e5776f5c030dd665f14247dc3d7b511102de" {
		t.Fatalf("request HMAC = %s", requestMAC)
	}
	responseHash := sha256Hex([]byte("{\"ok\":true}\n"))
	if responseHash != "e5f1eb4d806641698a35efe20e098efd20d7d57a9b90ee69079d5bb650920726" {
		t.Fatalf("response body hash = %s", responseHash)
	}
	responseMAC := hmacHex(secret, responseCanonical(
		"00112233445566778899aabbccddeeff", "request-vector-1", http.StatusOK, responseHash, protocol.Version,
	))
	if responseMAC != "bb51b81e958fa8dc4780f03481a75a2a5a156b84f95b64aa32341e34b4e2293e" {
		t.Fatalf("response HMAC = %s", responseMAC)
	}
}

func TestTransportAuthorityNormalizesPorts(t *testing.T) {
	for _, test := range []struct {
		listen string
		want   string
	}{
		{"127.0.0.1:04317", "http://127.0.0.1:4317"},
		{"127.0.0.1:80", "http://127.0.0.1:80"},
	} {
		if got := (&Server{cfg: config.Config{ListenAddress: test.listen}}).transportAuthority(); got != test.want {
			t.Fatalf("authority for %q = %q, want %q", test.listen, got, test.want)
		}
	}
}

func TestReplayCacheIsBoundedAndRetainsNonceThroughItsAcceptanceWindow(t *testing.T) {
	cache := newReplayCache()
	now := int64(1_000)
	for index := 0; index < replayCacheCapacity; index++ {
		nonce := fmt.Sprintf("%032x", index)
		if replayed, full := cache.add(nonce, now+100, now); replayed || full {
			t.Fatalf("insert %d: replayed=%v full=%v", index, replayed, full)
		}
	}
	if replayed, full := cache.add(strings.Repeat("f", 32), now+100, now); replayed || !full {
		t.Fatalf("capacity: replayed=%v full=%v", replayed, full)
	}
	if replayed, full := cache.add(strings.Repeat("0", 32), now+100, now); !replayed || full {
		t.Fatalf("existing nonce at capacity: replayed=%v full=%v", replayed, full)
	}
	if replayed, full := cache.add(strings.Repeat("f", 32), now+200, now+101); replayed || full {
		t.Fatalf("expired cache did not reopen: replayed=%v full=%v", replayed, full)
	}
}

func TestAuthenticationConcurrencyIsBoundedBeforeBodyRead(t *testing.T) {
	cfg := testConfig(t)
	service, err := agent.NewService(runner{ready: true}, cfg.MaxConcurrentRuns)
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(cfg, service)
	if err != nil {
		t.Fatal(err)
	}
	for index := 0; index < authConcurrencyLimit; index++ {
		server.authSlots <- struct{}{}
	}
	defer func() {
		for index := 0; index < authConcurrencyLimit; index++ {
			<-server.authSlots
		}
	}()
	nonce := "61223344556677889900aabbccddeeff"
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, requestAt(http.MethodGet, "/v1/health", "", cfg, time.Now().UnixMilli(), nonce))
	if rec.Code != http.StatusTooManyRequests || decodeError(t, rec).Error.Code != "AUTH_BUSY" {
		t.Fatalf("auth capacity: %d %s", rec.Code, rec.Body.String())
	}
	verifySignedResponse(t, rec, cfg, nonce)
}
