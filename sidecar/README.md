# AlSniper OS Agent sidecar

This directory contains the loopback-only Go capability host for the AI-native desktop and its games. It launches the locally authenticated Codex CLI through `github.com/agent-dance/agent-adaptor`, converts model output into closed OS intents or one legal game action, and never sends Codex credentials to the browser.

## Pinned upstream

The dependency is pinned, not branch-floating, to the upstream `cl/opt_examples` branch commit `aac715d492a1defd65525c1639dd6a639e36d384` as Go pseudo-version `v0.12.1-0.20260725141943-aac715d492a1`. That branch name is the actual remote ref corresponding to the requested `cl/opt/examples` work. The upstream repository did not publish license metadata at that commit, so redistribution of its source or binaries requires an explicit legal approval; local development use here does not imply a redistribution license.

## Trust boundary

- The listener accepts only `127.0.0.1`, matching the browser's explicit production CSP transport source. Hostname and IPv6 loopback aliases are rejected so an accepted sidecar configuration is always browser-reachable under that policy.
- Every browser call, including health, requires an exact origin, protocol version, timestamp, unique nonce, body digest, and HMAC-SHA256 signature. The shared secret is never sent over HTTP; CORS never uses a wildcard.
- The sidecar owns a dedicated Codex profile and pins `WithCloneProfileFrom` to `CloneProfileOptions{IncludeSettings:true, IncludeMCP:false, IncludeSkills:false, IncludeAuth:true, AuthMode:CloneProfileAuthLink}`. A non-empty `AuthMode` takes priority over `IncludeAuth`, so `auth.json` is reconciled through a symlink or hardlink and is never copied. The SDK copies missing `config.toml`, `config.json`, and `instructions.md` as opaque complete files; when the clone is missing or stale, the sidecar removes only those fixed targets from its claimed profile before startup reconciliation, validates `config.json` and `instructions.md` exactly and `config.toml` for TOML-semantic equality, and then runs Codex against that cloned profile. The semantic comparison is required because the pinned SDK re-marshals `config.toml` during empty MCP reconciliation. Codex CLI 0.145 consumes the cloned `config.toml` as its native model/provider/settings source instead of a second host projection; the CLI defines whether it consumes the other two files declared by the SDK settings contract. Their generation and the corresponding MCP override are frozen for the process lifetime; a source change fails the next readiness refresh and every execution until the sidecar restarts and reclones. Authentication has an independent generation, so `codex login` rotation is relinked without a restart.
- `IncludeMCP:false` prevents a separate MCP clone pass but cannot strip MCP declarations embedded in the complete settings files. At startup the host derives the settings generation and bounded MCP identifiers from the same twice-matching no-follow snapshot, then applies one immutable `mcp_servers={...enabled=false...}` override that disables every discovered server; more than 128 servers or 16 KiB of override data fail closed. It also forces read-only isolation, ignores only user execpolicy `.rules`, disables hooks and the shell, code-mode, browser, computer-use, image, app, plugin, multi-Agent, Chronicle/screen context, memory, Goals, artifacts, realtime conversation, proxy, permission elicitation, skill/tool discovery, and workspace-dependency surfaces, clears `notify`, denies web search, and default-rejects every permission, plan review, and question decision. `--ignore-rules` does not suppress the cloned `instructions.md`; consumption of that SDK-declared file follows Codex CLI 0.145 semantics. A fail-closed child-environment allowlist clears host secrets and unknown provider variables. These execution ceilings and the browser Capability Broker remain authoritative even though the SDK inherits the settings files in full.
- The host walks native/profile/workspace paths without following symlinks, junctions, or reparse points and claims the isolated profile before permitting SDK reconciliation. Reconciliation holds an exclusive lease; after cloned-settings equivalence and auth `SameFile` checks, model runs use a shared lease and a dedicated selection so multiple game seats can infer concurrently without a remove/relink gap. Immediately before and after every subprocess run, the host revalidates the frozen settings generation, credential identity, host-owned safety arguments, workspace ownership, and exact empty run CWD independently of cached health.
- The profile also holds an OS-enforced, process-lifetime exclusive file lease and a hashed native-home binding. A second sidecar cannot reuse or rewrite that profile while any Agent run is active. Startup, readiness, and every spawn execute a credential-free, bounded, caller-cancelable `codex --version` probe and accept exactly the audited `codex-cli 0.145.0`; a CLI upgrade requires a new feature-surface review.
- Codex runs in a fresh random child of a sidecar-owned workspace root with read-only isolation. On first use the root path must not already exist; the sidecar creates it and an ownership marker. Later starts require that exact regular marker and reject unknown content, linked ancestors, linked markers, junctions, special files, and unsafe `run-*` entries without deleting them. The adapter capability wrapper exists because upstream Codex batch execution is non-interactive and does not advertise rejection itself; it makes the host-enforced reject semantics visible to the SDK while the real driver performs the run.
- Prompts are fixed templates. User text, OS context, observations, labels, and action payloads are explicitly treated as untrusted data.
- The model proposes at most one OS intent. The browser's capability broker applies authorization and optimistic revision checks; a model response is never execution authority.
- Generated Agent packages are declarative manifests. Go injects local-unverified publisher provenance, Codex run/model provenance, contribution metadata, and the SHA-256 of the same stable, key-sorted canonical JSON used by the browser registry.
- Native WeChat is a separate fixed service and is never exposed to Codex, included in prompts, or accepted as a model command. The browser can only request status, accept the fixed package terms, or request launch; it cannot supply a command, package ID, source, executable path, argument, URL, or environment variable.
- If Codex runtime initialization fails, the authenticated loopback service starts in a fail-closed Agent-degraded mode: health reports the fixed `agent_runtime` failure and chat/game execution returns `AGENT_UNAVAILABLE`, while the independent native application routes remain available. Initialization details are not returned or logged.
- Windows installation always invokes the protected `Microsoft.DesktopAppInstaller_8wekyb3d8bbwe` package's Authenticode-verified `winget.exe` directly, without a shell, using exact package `Tencent.WeChat.Universal`, exact source `winget`, and machine scope. The host derives one of two closed internal modes from its own trusted discovery result: `not-installed` uses the normal fixed install arguments, while `invalid` reruns the same official installer with the sole additional WinGet `--force` flag for repair; `installed` remains idempotent and does not run WinGet. The browser cannot select a mode or supply `--force`. The user-writable App Execution Alias is not executed. Output is bounded, the child environment excludes sidecar/provider secrets, the operation is single-flight, and a kill-on-close Job Object contains the full installer process tree on cancellation or timeout.
- A registry value is only a discovery hint from a closed set of Weixin/WeChat keys. Before reporting installed or launching, the host opens the exact `Tencent\\Weixin\\Weixin.exe` or `Tencent\\WeChat\\WeChat.exe` Program Files target without sharing writes/deletes, rejects reparse components, verifies the final handle path, validates WinVerifyTrust, checks the exact Tencent legal-entity signer, and reads the version from that executable. The same handle remains open until direct process creation succeeds. No executable path is returned over HTTP. Other platforms fail closed.
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
- `GET /v1/native-apps/wechat/status` returns the typed trusted-installation state. It has no request body and does not depend on Codex readiness.
- `POST /v1/native-apps/wechat/install` accepts exactly `{ "requestId", "acceptedTerms": true }`, performs the host-selected fixed WinGet install or repair, and independently rediscovers and verifies the executable before returning success. Here, repair means a host-selected forced reinstall with `winget install --force`, not WinGet's native `repair` command; it may install or upgrade to the current official package version and never weakens package hash, source, path, or publisher verification.
- `POST /v1/native-apps/wechat/launch` accepts exactly `{ "requestId" }` and starts only the freshly rediscovered and verified executable.

Native request objects reject unknown, case-variant, and duplicate properties. Install is capped at 9 minutes 30 seconds so a signed timeout response fits within the browser's 10-minute transport deadline; launch is capped at 25 seconds and status at 5 seconds. Native failures use the same signed error envelope as Agent failures and never include registry values, paths, signer details, command output, or underlying system errors.

All endpoints require `X-AIOS-Protocol-Version`, `X-AIOS-Timestamp`, `X-AIOS-Nonce`, `X-AIOS-Content-SHA256`, and `X-AIOS-Signature`. Request signatures bind method, normalized sidecar authority, path, exact origin, protocol, timestamp, nonce, and exact body hash; redirects are rejected. The acceptance window is 30 seconds and each nonce is consumed once through a bounded, fail-closed replay cache. A separate 16-slot fail-closed gate bounds pre-authentication body buffering and hashing.

Every application response, including errors, is signed over the request nonce, generated `X-Request-Id`, HTTP status, exact response-body hash, and protocol version. The browser verifies the response bytes and HMAC before parsing JSON or accepting readiness, intents, A2UI, or game actions. Errors use `{ "error": { "code", "message", "requestId", "retryable" } }` and never include provider stderr. The architecture document contains the normative canonical formats and CORS contract.

The Debug stream is the sole exception to whole-body response signing: it authenticates every bounded NDJSON frame before delivery and chains each frame MAC to its predecessor. The client accepts a result only after one authenticated terminal frame and EOF. Debug capture is disabled by default, memory-only in the browser, and does not enable the pinned SDK's provider reasoning stream or change Codex's batch, prompt-plus-local-schema-validation, read-only, ephemeral execution path.

## Verification

```powershell
gofmt -w .
go test ./...
go vet ./...
```

Tests use fake runners for HTTP and orchestration behavior and do not consume model tokens. The profile tests exercise the real SDK's complete settings clone, copy-if-missing refresh wrapper, MCP-disable projection, auth link reconciliation, stale credential rotation, host lease boundary, and dedicated execution handoff against temporary profiles without launching a model.

Health readiness verifies the linked native auth file, the frozen settings generation, cloned-settings equivalence, host safety overrides, and the isolated profile allowlist. The `auth_provider` check starts as unverified, becomes verified after a successful model call, and becomes rejected after an authentication rejection. Provider state is bound to an in-memory credential generation and resets to unverified when `codex login` rotates the file. If a protected request returns `AGENT_AUTH_REQUIRED`, run `codex login` and retry; the next readiness or run reconciliation follows the refreshed credential without a restart. Changing `CODEX_HOME`, `config.toml`, `config.json`, or `instructions.md` requires a sidecar restart so it can freeze the new settings generation, rebuild the MCP-disable override, and reclone the complete files.
