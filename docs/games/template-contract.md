# Game template contract

The `r3f-basic` template is a deliberately small vertical slice, not a sample-only mock. This document specifies that generated R3F template; renderer-neutral requirements for all games live in [README.md](./README.md). It compiles against the same public game-platform API used by first-party games and contains a complete start, play, pause, inactive, blur, fullscreen, automation, and deterministic-test path.

## Engine contract

The generated engine exports serializable authoritative domain state/actions and separate presentation state/input types. The AGAP Host owns the domain state. `createFixedStepRuntime` advances presentation time only and contains no mode, player position, score, or other rule-bearing field. Engine code must not read wall-clock time, `Math.random`, browser globals, or React state.

When randomness is required, add an explicit seeded generator to state. When external events are required, encode them as input/commands and preserve their deterministic order.

Formal gameplay commands are a closed, serializable action union. The engine exports the sole legal-action enumerator and reducer/validator for that union. Human UI handlers and AGAP adapters both call this domain path; neither may maintain a second rules implementation or mutate authoritative state directly.

## Agent participation contract

Every generated game includes `<Game>AgentAdapter.ts` and its contract test. The adapter declares an AGAP v1 descriptor, one explicit player seat, a player-visible observation projection, the complete legal action set, and transitions through the engine's shared reducer. A factory returns an `AgentGameHost`; callers obtain capabilities only by binding a human or Agent identity to a seat.

The generated React application binds its local human as `kind: 'human'` and sends start, move, pause, resume, and restart through that seat's `ParticipantPort`. The adapter test binds equivalent human and Agent sessions with the same match/request ids, replays the same formal actions, and after every step proves receipt, projected outcome, legal-action, and visible-event parity. A concrete game must extend this test across every formal command and each information boundary.

Restart is legal while playing or paused. The shared domain reducer returns the initial authoritative ready state, so the Host advances revision and publishes it like any other accepted action. Both the visible Restart button and `R` shortcut submit that action. After acceptance, the app separately clears presentation state, fixed-step clock, and input; `runtime.replaceState(createInitialPresentationState())` is allowed only for that presentation-only value and never for gameplay synchronization.

That template behavior is an in-match restart. A game that offers New Match/New Round only after terminal completion must instead create a new Host with a new match id/seed and rebind its participants; the completed Host stays terminal and is never reset by UI code.

The AGAP Host is the generated application's only gameplay authority. UI snapshot state is always the latest bound-seat observation; the scene, HUD, mode overlays, lifecycle decisions, and text renderer consume that projection. No gameplay field is copied into the fixed-step runtime, and the app never synchronizes port results through `runtime.replaceState`.

Games with no hidden information or only one participant are not exempt. They use `informationModel: 'perfect'` and a single seat while retaining the same descriptor, projection, legal-action, receipt, and event contracts. Multiplayer imperfect-information games must return only what the human UI for that seat may know.

The browser automation bridge is deliberately separate. It is an unauthenticated development surface and cannot be reused as an Agent participant API. An Agent receives a bound `ParticipantPort`, never `window`, domain state, a React store, or another seat's projection.

## Application contract

The generated application:

- creates one runtime for the component lifetime;
- keeps only presentation clock/state in that runtime and obtains every gameplay snapshot from the bound `ParticipantPort`;
- renders one R3F Canvas;
- advances simulation through `FixedStepDriver` only;
- selects `always` only while active and playing, and `demand` otherwise;
- mutates Three.js object refs during frames instead of rendering React state at 60 Hz;
- resets input and pauses through `useGameLifecycle`;
- implements restart through `ParticipantPort.act`, then resets only presentation state/clock/input;
- installs and removes the standardized automation bridge through `useGameAutomationBridge`;
- enables that global automation bridge only while the shell marks this game active;
- detects the official client's virtual-time marker during the first render and synchronously guards real-time frames with a ref while React commits manual-clock state;
- uses the shared fullscreen controller;
- keeps the shell's `isActive` lifecycle separate from the engine's gameplay mode.

Games may replace the scene, input mapping, UI, simulation schema, and renderer. They must not add an independent `requestAnimationFrame`, a second clock, or a custom incompatible automation hook.

`onManualClockRequested` must remain idempotent and must set the synchronous ref before scheduling React state. Relying on the bridge's passive effect or React state alone reintroduces a first-frame/commit-window race that can leak a nondeterministic real-time tick into automation runs.

Manual-clock ownership is intentionally sticky for the mounted game session. Once the host marker or a valid `advanceTime()` call requests deterministic time, real-time simulation must not resume between later host calls; unmounting and remounting creates a new ownership session. This prevents wall-clock frames from contaminating an automation replay.

## Test contract

The generated tests verify equivalent presentation-time partitions, prove presentation state contains no authoritative gameplay fields, and verify command outcomes through AGAP. Their two-second single-call path exercises both the default 240-step budget and an exact explicit 120-step budget, preserving this repository's `advanceTime(2000)` compatibility contract. Extend them with gameplay outcomes such as collision, scoring, resource consumption, victory/failure, restart, seeded randomness, and boundary behavior.

Browser checks continue to use the official client shipped with the `develop-web-game` skill. The repository intentionally does not add `@playwright/test` merely for the template.

## Performance budgets

Budgets are game-specific, but every game should record at least active FPS frame-time percentiles, long tasks, applicable restart/new-match latency, console errors, renderer identity, viewport, and build artifact hash. R3F/WebGL games additionally record ready/paused/inactive and active draw calls. Measure on a hardware renderer when making absolute FPS claims; software WebGL results are suitable for relative regression checks only.
