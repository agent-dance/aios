# Agent Runtime sidecar architecture

## Purpose and status

AlSniper OS treats an Agent as both a system participant and an installable software package. The implementation deliberately separates model execution from browser authority:

- the Go sidecar owns Codex process execution, authentication linkage, structured-output enforcement, invocation isolation, and concurrency limits;
- the browser owns the OS capability broker, user approval, application state, Agent package registry, and A2UI rendering;
- each game remains its own gameplay authority and exposes only a seat-bound AGAP capability to an Agent.

This is a local sidecar architecture, not an in-browser model runtime. The local Codex CLI may in turn use a remote model provider. No model credential, native Codex profile path, prompt transcript, or hidden game state is returned to browser code.

## Component boundaries

```text
trusted desktop launcher
  | injects endpoint + ephemeral HMAC secret at runtime
  v
browser shell
  +-- Labubu AssistantHost (voice/text and visible state)
  +-- official A2UI v0.9.1 processor + React renderer
  +-- Capability Broker -> OS/store/settings/Agent registry ports
  +-- AGAP ParticipantPort -> game authority
  |
  | HTTP protocol 1.0.0, exact Origin, mutually authenticated messages
  v
Go sidecar (127.0.0.1 by default)
  +-- request/schema validation and bounded HTTP server
  +-- chat and per-seat game orchestration
  +-- agent-adaptor structured-output SDK
  +-- isolated Codex profile + read-only empty workspace
  |
  | linked local auth only
  v
native Codex authentication
```

The dependency direction is intentional. Codex can propose an intent or select an opaque legal-action reference, but it cannot invoke an OS port or mutate a match. The browser and game authorities validate again at their respective boundaries.

## Pinned execution SDK

The Go module uses `github.com/agent-dance/agent-adaptor` from the requested `cl/opt/examples` line. The upstream repository publishes that work under the actual ref `refs/heads/cl/opt_examples`. The dependency is fixed rather than branch-floating:

| Item | Value |
| --- | --- |
| Remote | `https://github.com/agent-dance/agent-adaptor.git` |
| Upstream ref | `refs/heads/cl/opt_examples` |
| Commit | `aac715d492a1defd65525c1639dd6a639e36d384` |
| Go version | `v0.12.1-0.20260725141943-aac715d492a1` |
| AlSniper OS minimum Go toolchain | Go 1.26.5 |

The SDK is reused for Codex driver lifecycle, typed binding, dedicated-profile selection, run policy, environment/profile diagnostics, and native strict JSON Schema output. Go 1.26.5 is the minimum because earlier 1.26 patch releases contain reachable standard-library vulnerabilities. The sidecar adds the OS-specific HTTP, authorization, validation, scheduling, and authority boundaries that the SDK intentionally does not provide.

## Transport and authentication

The sidecar uses `127.0.0.1:4317` and configuration rejects hostnames, IPv6 aliases, wildcard addresses, and every other IP. This intentionally matches the browser production CSP's only HTTP sidecar source. Development keeps explicit `ws://localhost:*` and `ws://127.0.0.1:*` sources solely for the Vite HMR transport; they are not accepted sidecar HTTP endpoints.

The HTTP contract is versioned as `1.0.0`:

| Endpoint | Authentication | Purpose |
| --- | --- | --- |
| `GET /v1/health` | Request HMAC + exact Origin + protocol | Readiness, resource limits, Codex driver and profile-link state |
| `POST /v1/chat` | Request HMAC + exact Origin + protocol | Structured assistant response, at most one OS intent, optional restricted A2UI surface |
| `POST /v1/game/decide` | Request HMAC + exact Origin + protocol | Exactly one opaque `actionId` from the supplied legal set |

Every non-preflight call carries `X-AIOS-Protocol-Version`, `X-AIOS-Timestamp` (Unix milliseconds), a fresh 128-bit lowercase-hex `X-AIOS-Nonce`, `X-AIOS-Content-SHA256`, and `X-AIOS-Signature`. The shared secret is never placed in an HTTP header or body. The request signature is lowercase-hex HMAC-SHA256 over this exact UTF-8 canonical value, with no final newline:

```text
AIOS1-REQUEST\n<METHOD>\n<SIDECAR_AUTHORITY>\n<PATH>\n<EXACT_ORIGIN>\n<PROTOCOL>\n<TIMESTAMP>\n<NONCE>\n<BODY_SHA256>
```

`SIDECAR_AUTHORITY` is the normalized `http://127.0.0.1:<port>` endpoint, so a signed request cannot be redirected or relayed to a different sidecar port. Browser fetches also set `redirect: "error"`. The server requires the exact configured Origin, recomputes the body digest, compares authentication values in constant time, accepts timestamps only within a 30-second clock window, and atomically consumes each nonce once. Its replay cache is bounded to 4,096 live nonces and fails closed when full; entries remain until the signed timestamp can no longer be accepted. Request headers are structurally bounded, the Go HTTP server limits aggregate headers to 16 KiB, request bodies retain the configured hard limit, and at most 16 requests may concurrently occupy the pre-authentication body-read/hash stage. Excess authentication work fails closed with a signed retryable error.

All application responses, including authentication, validation, readiness, and model errors, contain `X-Request-Id`, `X-AIOS-Request-Nonce`, `X-AIOS-Content-SHA256`, and `X-AIOS-Signature`. The response signature is HMAC-SHA256 over:

```text
AIOS1-RESPONSE\n<REQUEST_NONCE>\n<REQUEST_ID>\n<HTTP_STATUS>\n<BODY_SHA256>\n<PROTOCOL>
```

The browser reads at most 4 MiB, verifies the exact response bytes and signature with Web Crypto before JSON parsing, readiness handling, A2UI rendering, or intent execution. Therefore a process occupying the expected loopback port cannot forge `ready`, an Agent action, or an OS intent without the session secret. CORS allows only the authentication/content headers above and exposes only the five response-verification headers; it never uses a wildcard. `OPTIONS` is transport preflight rather than an application response, carries no request nonce, returns no application data, and is signed against an empty nonce for consistent diagnostics.

The HMAC secret is a local session capability rather than a user identity or Agent seat credential. It must be randomly generated with at least 32 bytes, kept out of HTTP messages, URLs, browser persistence, chat data, diagnostics, and source control, and scoped to one launcher/session. Exact cross-language canonical vectors are enforced in both the browser and Go test suites.

### Browser configuration rule

`VITE_AIOS_SIDECAR_URL` and `VITE_AIOS_SIDECAR_TOKEN` are supported only for local browser development. The runtime reads them only when `import.meta.env.DEV` is true; production bundles ignore this fallback. Vite substitutes development values into delivered JavaScript, so a development token is observable by any code or user with access to that page.

Production packaging must use a trusted desktop launcher or WebView host to inject the ephemeral runtime value before React mounts:

```ts
window.__AIOS_SIDECAR_CONFIG__ = {
  baseUrl: 'http://127.0.0.1:4317',
  token: '<ephemeral local capability>',
  origin: window.location.origin,
};
```

The host must also configure `AIOS_SIDECAR_ORIGIN` to that exact browser origin. Shipping a production static bundle containing `VITE_AIOS_SIDECAR_TOKEN` is not a supported deployment mode.

## Codex authentication and process isolation

The host creates and owns a dedicated sidecar Codex profile, then selects it through `agent-adaptor`'s `WithDedicatedProfile`. The SDK is deliberately not given clone/reconcile authority. The host creates the native `auth.json` link with create-new semantics and never deletes or replaces an existing target. Readiness requires the sidecar entry and native entry to identify the same file; a failed or replaced link makes the runtime not ready before the SDK may inspect the profile.

Before any directory creation or SDK call, the host walks every existing component of the native Codex home, isolated profile, and workspace paths with no-follow metadata checks. Symlinks, Windows junctions/reparse points, special files, filesystem-root targets, containment, and canonical filesystem aliases fail closed. A new profile/workspace target is created one component at a time only beneath validated real parents and receives a sidecar ownership marker. Existing unclaimed directories are rejected; an existing profile additionally requires the exact native auth file and the closed runtime allowlist. Workspace markers and every retained `run-*` directory are revalidated without following links. Cached readiness is never execution authority: the adapter repeats the native/profile/auth, workspace-root, and exact run-CWD checks immediately before every real driver invocation.

Only authentication is inherited. The profile readiness check rejects unexpected files, user-installed skills, settings, instructions, or MCP resources while allowing the provider-created `.system` skill directory and bounded Codex runtime databases. Each sidecar start creates a fresh child beneath the fail-closed workspace root; unknown root contents prevent startup instead of being deleted or executed. Codex executes there with:

- `IsolationReadOnly` and `--sandbox read-only`;
- web search and browser features denied;
- permission, plan review, and question decisions automatically rejected;
- rejection and timeout configured to abort the run;
- strict JSON Schema output for both chat and game decisions.
- stateless `--ephemeral` execution, so Codex does not write conversation, speech transcript, or game-observation rollouts to the isolated profile.

The browser never receives the linked profile location or authentication material. Operational logs include request identifiers and sanitized status, but not prompts, observations, raw model streams, provider stderr, profile paths, or hidden state.

## Invocation isolation, cancellation, and parallelism

Every model process is stateless and ephemeral: the sidecar does not configure an SDK SessionStore, does not request Codex resume, and passes `--ephemeral` on every spawn. To preserve useful multi-turn behavior, the browser supplies at most 12 prior user/assistant messages, with 2,000 UTF-16 units per message and 12,000 in aggregate; this window lives only in the mounted assistant UI and is validated again by both client and sidecar. Conversation text, speech transcripts, and seat-projected observations are not retained as local Codex rollouts. Provider-side processing and retention remain governed by the configured Codex provider and account policy.

The service applies two independent controls:

1. a global bounded semaphore limits all simultaneous model runs;
2. a single-flight key rejects overlapping turns for one chat thread or one `(game, match, seat)` tuple.

Distinct chat threads, matches, games, and seats can therefore run concurrently up to `AIOS_SIDECAR_MAX_CONCURRENT`, while one participant cannot race itself. Browser abort, window lifecycle cancellation, or HTTP disconnect propagates through request context to the Codex run. Chat and game requests have separate bounded deadlines.

`seatKey` is an opaque invocation-partition value, not AGAP authorization. The game host retains the actual seat binding and validates the returned action against the captured revision, phase, nonce, and complete legal set.

## OS control plane

### Structured intent flow

For a desktop chat turn, the browser captures an OS revision and a bounded context projection: locale, active application, theme, installed apps, full read-only system telemetry, and running-game identifiers. Domain-Agent instructions are never mixed into this desktop principal. A domain Agent is invoked explicitly with `/agent <id> <message>`; the Host binds exactly that installed, enabled package before the request, sends only its descriptor, and executes every returned intent through that package's capability-limited Broker even if the model omits `activeAgentId`. The sidecar treats both user text and context JSON as untrusted input. Codex may return at most one intent from the closed union:

- open, close, focus, or minimize an application;
- install a signed built-in application listing;
- update supported preferences;
- update only controllable system fields such as Wi-Fi, Bluetooth, energy mode, brightness, and volume; health and storage telemetry remain read-only;
- install a declarative Agent manifest.

The sidecar stamps the intent with the observed revision. In the browser, the Capability Broker revalidates the payload, checks the optimistic revision, computes risk, applies policy, asks through a trusted Host approval surface for high-risk operations, calls the typed OS port, advances the revision, and emits a receipt. Install operations require explicit trusted approval in the current composition. A2UI cannot draw or impersonate that approval surface.

Model output is a proposal. A reply must not be interpreted as proof that an operation ran; only a Broker receipt proves an accepted OS effect.

### A2UI surfaces

The model-facing surface is a restricted AIOS IR containing bounded text, headings, buttons, stacks/groups, status fields, and lists. Validation rejects unknown keys, duplicate identifiers, missing children, graph cycles, excessive depth, excessive expanded nodes, and buttons that do not reference an intent from the same response.

After narrowing, the browser delegates message processing and rendering to the official A2UI `v0.9.1` API exported by the pinned `@a2ui/web_core` and `@a2ui/react` packages. The processor uses the basic catalog; client actions are mapped back to the already validated intent ID. The model does not emit arbitrary HTML, script, CSS, URLs, React components, or approval UI.

### Installable Agent packages

Generated Agents are declarative packages, not executable browser or Go plugins. A manifest contains identity, semantic version, bounded instructions, requested capabilities, publisher provenance, contribution kinds, generator provenance, and a content digest.

The sidecar replaces model-supplied trust data with:

- publisher trust `local-unverified`;
- Codex provider, model when known, and run ID;
- normalized contribution metadata;
- `sha256:` digest of stable key-sorted canonical JSON with the digest field omitted.

The browser recomputes the same canonical digest before installation, rejects content mismatch, downgrade, and same-version/different-content replacement, and verifies persisted records when loading. SemVer precedence uses exact integer comparison. A `first-party` claim requires a trusted publisher-verification port; SHA-256 alone never establishes publisher identity. A corrupted registry is discarded fail-closed.

`capabilities` is a requested upper bound only. Every installed package records `grantedCapabilities: []`; stored grants are rejected. Enabled domain-Agent instructions are routed into the fixed desktop-assistant policy only as bounded domain expertise. A response identifies the active package, and the browser binds the operation to that package's versioned/digested principal. Undeclared capabilities are denied and every domain-Agent OS effect requires a fresh trusted user approval. Enabling a package therefore activates its contribution without silently granting authority.

## Labubu desktop assistant

The assistant is a shell-level system surface rather than an application window. `LabubuAvatar` uses one React Three Fiber Canvas for the modeled character and exposes a native button overlay for keyboard and assistive-technology interaction. Reduced-motion and WebGL fallback paths keep the assistant usable without continuous decorative animation.

Clicking the avatar opens the text conversation. On the desktop, holding Space starts browser speech recognition and releasing it submits the final transcript. When a game is active, plain Space remains owned by the game; push-to-talk uses Alt/Option+Space or the clickable assistant instead. Editable controls, composition input, modal surfaces, window blur, document hiding, and unmount are respected so push-to-talk cannot retain capture unexpectedly.

Speech recognition is a browser capability and may be unavailable or backed by browser-vendor services. Before first use, a trusted focus-trapped disclosure explains that boundary and requires an explicit decision; only that decision is persisted. The UI exposes availability and permission state and retains the text path as the deterministic fallback. Audio is not sent to the Go sidecar; recognized text can remain only in the mounted bounded conversation window described above and may be sent again as recent context. Closing or refreshing the browser discards that local window; provider-side handling is disclosed separately from local retention.

## Game participation plane

The generic browser controller serializes only one seat-projected `SeatObservation` and the exact same-window `LegalActionSet`. It assigns decision-local opaque action references before transport. The sidecar sees legal payloads only for the requesting seat, returns one reference, and verifies membership in the supplied set. The browser resolves that reference back to the original action object and constructs an `ActRequest` using the original revision, phase, and nonce. It never re-observes and wraps an old result in a new decision window.

AGAP remains authoritative for participant binding, legal-action completeness, information projection, idempotency, stale-window rejection, event privacy, and human/Agent parity. The unauthenticated `window.advanceTime` and `window.render_game_to_text` development bridges are never supplied to the sidecar.

### 斗地主

斗地主 exposes three independent participant seats. The default local match binds seat 0 to a human and seats 1 and 2 to Agents. Each Agent seat has its own controller, opaque key, abort signal, and single-flight boundary, so seats can coexist with Agent seats in other matches and games.

An asynchronous decision freezes the observation, complete legal set, revision, phase, and turn nonce before the model call. A returned action is submitted only against that frozen window. Cancellation and stale results do not act. For sidecar failure, timeout, or invalid output, the match's explicit `on-error-or-timeout` policy selects a deterministic heuristic from that same legal window; caller cancellation and stale-window replacement do not trigger a hidden action. Deterministic `window.advanceTime` automation stays entirely on the local heuristic path and never waits for a model.

### Cosmic Vanguard

The real-time space game exposes one `pilot` seat with a finite composite action set: movement, fire state, and quantized aim, plus lifecycle actions. In connected `assist` mode, human input and Agent planning enter the same authoritative action reducer; no device-event or frame-level control bypass exists.

The Agent replans on a bounded 250–500 ms cadence and critical phase, health, or wave changes rather than at 60 Hz. Observation ticks may advance without invalidating every plan; AGAP revision and nonce rotate at the control window. Inactivity, hiding, unmount, or suspension aborts planning and clears lifecycle-owned input. A sidecar error does not synthesize an unvalidated fallback action: the last accepted latched control remains until another valid authority transition, and planning continues on the bounded scheduler.

斗地主 seats and the space-game pilot use independent canonical invocation keys and may run concurrently subject to the global sidecar limit. Open games keep their Agent simulation active even when another window has keyboard focus; only the focused game receives human device input and automation ownership. Browser hiding, explicit pause, window close, and unmount still stop or cancel their lifecycle work. OS assistant threads likewise have independent single-flight keys.

## Configuration and startup

The sidecar reads environment variables directly; `.env.example` is a reference and is not automatically loaded.

| Variable | Default | Constraint / effect |
| --- | --- | --- |
| `AIOS_SIDECAR_TOKEN` | none | Required; sidecar and browser accept 32–512 bytes |
| `AIOS_SIDECAR_LISTEN` | `127.0.0.1:4317` | Exact CSP-authorized IPv4 loopback and valid port |
| `AIOS_SIDECAR_ORIGIN` | `http://localhost:5173` | One exact HTTP(S) origin without path/query/fragment |
| `AIOS_SIDECAR_PROFILE_DIR` | per-user AlSniper OS config directory | New sidecar-owned isolated profile path; existing paths require the ownership/allowlist and exact native-auth identity; must not overlap workspace or native profile |
| `AIOS_SIDECAR_WORKSPACE_DIR` | per-user AlSniper OS config directory | New sidecar-owned workspace-root path; later reuse requires its exact ownership marker and safe `run-*` directories |
| `AIOS_CODEX_COMMAND` | `codex` | Codex executable or explicit command path |
| `AIOS_AGENT_MODEL` | native profile default | Optional model override |
| `AIOS_AGENT_REASONING_EFFORT` | native profile default | Empty, `low`, `medium`, `high`, or `xhigh` |
| `AIOS_SIDECAR_MAX_BODY_BYTES` | `262144` | 1 KiB–4 MiB |
| `AIOS_SIDECAR_MAX_CONCURRENT` | `8` | 1–64 model runs |
| `AIOS_SIDECAR_CHAT_TIMEOUT` | `90s` | 1 second–10 minutes |
| `AIOS_SIDECAR_GAME_TIMEOUT` | `30s` | 1 second–10 minutes |

Use the single-session PowerShell launcher in the root [README](../../README.md#run-with-the-local-codex-agent). It generates one in-memory token, injects it into a managed sidecar job and Vite, and cleans the development environment on exit. Production launchers must use the runtime `window.__AIOS_SIDECAR_CONFIG__` injection described above.

## Readiness and failure semantics

The browser starts in an unconfigured state when no runtime configuration exists. If configuration, health, profile, CLI, or network checks fail, it switches to offline state without exposing the underlying secret or provider stderr. System applications and local games continue to work.

The sanitized health response is `ready` only when the Codex CLI is available, the dedicated profile is selected, authentication is linked to the native entry, and no forbidden profile resources are present. This is structural readiness: an expired or revoked provider credential is discovered by the first real model request and should be repaired with `codex login`. A failed check prevents sidecar controllers from being attached by the OS composition root; the browser polls health and reconnects or degrades without a reload.

Operational behavior is explicit:

- unavailable assistant: keeps the text/voice shell visible and reports that the trusted local runtime is not connected;
- interrupted chat: aborts the request and applies no pending intent;
- stale OS intent: Broker rejects it before the port call and reports a retryable stale revision;
- denied approval: no effect is committed and a rejected receipt is shown;
- malformed model output: sidecar returns a sanitized stable error, never partially executes;
- global saturation: request fails fast as retryable busy rather than building an unbounded queue;
- duplicate in-flight invocation key: request fails as a conflict;
- 斗地主 decision failure: uses its declared same-window deterministic fallback except for cancellation/staleness;
- space assist failure: retains only the last already accepted control and retries later; it does not invent a new action;
- sidecar offline: 斗地主 uses its built-in heuristic controllers and Cosmic Vanguard remains human-controlled because the composition root attaches sidecar control only after ready health.

## Verification

Run the Go gates from `sidecar`:

```powershell
gofmt -w .
go test ./...
go vet ./...
```

Run browser and integration gates from the repository root:

```powershell
npm run typecheck
npm test
npm run build
```

Sidecar unit tests use injected fake runners and do not consume model tokens. The profile test invokes the real SDK profile-clone path against temporary profiles without starting a model. Browser tests cover transport validation, Origin and protocol mismatch, A2UI graph/action restrictions, capability policy/revision/idempotency, manifest digest/persistence, push-to-talk routing, game decision capture, lifecycle cancellation, and game-specific AGAP parity. Release validation additionally exercises one minimal real Codex structured chat/game call through the loopback sidecar and the official browser workflow, without logging credentials or prompt contents.

## Supply-chain release gate

The pinned upstream `agent-adaptor` commit currently contains no `LICENSE`, `COPYING`, or `NOTICE` file and no usable license grant in its root documentation. This is a release legal blocker, not merely missing attribution. AlSniper OS must not redistribute the dependency's source or a binary containing it until the rights holder supplies a compatible explicit license or legal counsel documents a separate redistribution grant.

Local technical evaluation and dependency pinning do not create redistribution rights. See [sidecar/THIRD_PARTY_PROVENANCE.md](../../sidecar/THIRD_PARTY_PROVENANCE.md) for the recorded source identity and verification procedure.
