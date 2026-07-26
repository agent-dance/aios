# AlSniper OS Agent sidecar

This directory contains the loopback-only Go capability host for the AI-native desktop and its games. It launches the locally authenticated Codex CLI through `github.com/agent-dance/agent-adaptor`, converts model output into closed OS intents or one legal game action, and never sends Codex credentials to the browser.

## Pinned upstream

The dependency is pinned, not branch-floating, to the upstream `cl/opt_examples` branch commit `aac715d492a1defd65525c1639dd6a639e36d384` as Go pseudo-version `v0.12.1-0.20260725141943-aac715d492a1`. That branch name is the actual remote ref corresponding to the requested `cl/opt/examples` work. The upstream repository did not publish license metadata at that commit, so redistribution of its source or binaries requires an explicit legal approval; local development use here does not imply a redistribution license.

## Trust boundary

- The listener accepts only `127.0.0.1`, matching the browser's explicit production CSP transport source. Hostname and IPv6 loopback aliases are rejected so an accepted sidecar configuration is always browser-reachable under that policy.
- Every browser call, including health, requires an exact origin, protocol version, timestamp, unique nonce, body digest, and HMAC-SHA256 signature. The shared secret is never sent over HTTP; CORS never uses a wildcard.
- The sidecar owns a dedicated Codex profile and gives the SDK only `WithDedicatedProfile`; the SDK never receives clone/reconcile authority over `auth.json`. Before any SDK call, the host walks the native/profile/workspace paths without following symlinks, junctions, or other reparse points, claims only a newly created profile, and creates the native authentication link without replacement. Immediately before every subprocess run it revalidates the native/profile auth identity, workspace ownership, and the exact run CWD, independently of cached health. An existing profile is accepted only when it is sidecar-owned or already links the exact native authentication file and contains only the closed runtime allowlist. Settings, MCP servers, instructions, and user-installed skills are not inherited.
- Codex runs in a fresh random child of a sidecar-owned workspace root with read-only isolation. On first use the root path must not already exist; the sidecar creates it and an ownership marker. Later starts require that exact regular marker and reject unknown content, linked ancestors, linked markers, junctions, special files, and unsafe `run-*` entries without deleting them. User config/rules and the shell, code-mode, browser, computer-use, image, app, plugin, and multi-Agent tool surfaces are disabled at the CLI boundary; web search is denied; every permission, plan review, and question decision is default-rejected. The adapter capability wrapper exists because upstream Codex batch execution is non-interactive and does not advertise rejection itself; it makes the host-enforced reject semantics visible to the SDK while the real driver performs the run.
- Prompts are fixed templates. User text, OS context, observations, labels, and action payloads are explicitly treated as untrusted data.
- The model proposes at most one OS intent. The browser's capability broker applies authorization and optimistic revision checks; a model response is never execution authority.
- Generated Agent packages are declarative manifests. Go injects local-unverified publisher provenance, Codex run/model provenance, contribution metadata, and the SHA-256 of the same stable, key-sorted canonical JSON used by the browser registry.
- Game decisions return only an `actionId`, which the sidecar proves belongs to the exact supplied legal set. The AGAP Host remains the gameplay and seat-authorization authority.
- Request bodies, run duration, headers, and global concurrency are bounded. A chat thread and each `(game, match, seat)` are individually single-flight; distinct games and seats can run in parallel. Codex runs statelessly with `--ephemeral`, without SDK resume or local rollout retention; the browser may supply only a strictly bounded in-memory recent conversation window. Disconnecting the HTTP request cancels the Codex subprocess through its context.
- Operational logs contain no prompt, observation, raw model stream, profile path, auth material, or hidden game state.

## Configuration

Required:

```powershell
$env:AIOS_SIDECAR_TOKEN = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
```

Defaults and optional overrides are listed in [.env.example](./.env.example). The process reads environment variables directly; the example file is documentation rather than an automatic dotenv loader.

`AIOS_SIDECAR_PROFILE_DIR` and `AIOS_SIDECAR_WORKSPACE_DIR` are sidecar-owned paths, not existing user or project directories. Their final directories must not exist on first use; the sidecar creates and claims them only after every existing parent component passes no-follow validation. Later starts require the ownership/allowlist invariants. Unknown content is rejected and never removed.

Run from this directory:

```powershell
go run ./cmd/alsniper-agent
```

Go 1.26.5 or newer is required; this patch floor closes reachable standard-library vulnerabilities present in earlier Go 1.26 releases.

The default browser origin is `http://localhost:5173` and the default endpoint is `http://127.0.0.1:4317`. `AIOS_SIDECAR_TOKEN` is the ephemeral HMAC secret shared through the trusted browser bootstrap. It is never sent as a Bearer token and must never be persisted in app-local storage, chat history, URLs, or logs.

## HTTP protocol v1

- `GET /v1/health` returns sanitized readiness, limits, and profile/auth-link status.
- `POST /v1/chat` accepts a user message plus a revisioned OS context and returns a typed assistant turn, zero or one closed intent, and an optional restricted A2UI surface.
- `POST /v1/chat/trace` is the explicit `agent-debug.v1` mode. It streams only allowlisted lifecycle and categorical decision-summary frames, each authenticated by a forward HMAC chain, and terminates with the same typed assistant response. It never forwards raw model reasoning, prompts, provider output, tool data, paths, credentials, or hidden game state.
- `POST /v1/game/decide` accepts one seat projection and its complete legal actions and returns one member `actionId`.

All endpoints require `X-AIOS-Protocol-Version`, `X-AIOS-Timestamp`, `X-AIOS-Nonce`, `X-AIOS-Content-SHA256`, and `X-AIOS-Signature`. Request signatures bind method, normalized sidecar authority, path, exact origin, protocol, timestamp, nonce, and exact body hash; redirects are rejected. The acceptance window is 30 seconds and each nonce is consumed once through a bounded, fail-closed replay cache. A separate 16-slot fail-closed gate bounds pre-authentication body buffering and hashing.

Every application response, including errors, is signed over the request nonce, generated `X-Request-Id`, HTTP status, exact response-body hash, and protocol version. The browser verifies the response bytes and HMAC before parsing JSON or accepting readiness, intents, A2UI, or game actions. Errors use `{ "error": { "code", "message", "requestId", "retryable" } }` and never include provider stderr. The architecture document contains the normative canonical formats and CORS contract.

The Debug stream is the sole exception to whole-body response signing: it authenticates every bounded NDJSON frame before delivery and chains each frame MAC to its predecessor. The client accepts a result only after one authenticated terminal frame and EOF. Debug capture is disabled by default, memory-only in the browser, and does not enable the pinned SDK's provider reasoning stream or change Codex's batch, strict-output, read-only, ephemeral execution path.

## Verification

```powershell
gofmt -w .
go test ./...
go vet ./...
```

Tests use fake runners for HTTP and orchestration behavior and do not consume model tokens. The profile tests exercise the real SDK's dedicated-profile path and the host-owned, no-replacement auth link against temporary profiles without launching a model.

Health readiness verifies that the native auth file is linked and isolated; it cannot prove that an API key or account token is still accepted without making a model call. If a protected request returns the sanitized `AGENT_FAILED` response while health is ready, refresh the native profile with `codex login` and retry.
