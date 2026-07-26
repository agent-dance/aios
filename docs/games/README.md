# AlSniper OS game foundation

The repository provides one production-oriented browser-game foundation under `src/game-platform` and a zero-dependency generator under `tools/game-scaffold`. New games reuse the platform instead of copying infrastructure out of an existing game.

Repository-aware Agents must load the progressive `$game-scaffold` Skill from `.agents/skills/game-scaffold/SKILL.md` before game implementation. Root `AGENTS.md` intentionally contains only the compact mandatory route so non-game tasks do not pay the full game-policy context cost.

## Create a game

Run from the repository root:

```powershell
npm run game:create -- --id asteroid-run --name "Asteroid Run"
```

The id must be lowercase kebab-case. Existing first-party ids, filesystem device names, path-like values, and an existing destination are rejected. Generation is staged inside `src/apps` and committed with a directory rename, so a failed run never leaves a partially generated game.

The command creates:

```text
src/apps/asteroid-run/
├── AsteroidRunEngine.ts
├── AsteroidRunEngine.test.ts
├── AsteroidRunAgentAdapter.ts
├── AsteroidRunAgentAdapter.test.ts
├── AsteroidRunApp.tsx
├── index.ts
└── README.md
```

## Register the application

Registration is intentionally explicit because it changes OS navigation and window policy:

1. Add the id to `AppId` in `src/system/types.ts`.
2. Add its metadata to `APP_REGISTRY` and, when appropriate, `DOCK_APPS` in `src/system/appRegistry.ts`.
3. Lazy-import the generated app in `src/App.tsx`.
4. Add it to `appContents`, forwarding the shell's `isActive` flag.
5. Run `npm run typecheck`, `npm test`, and `npm run build`.
6. Exercise the game with the official `develop-web-game` Playwright client, inspect gameplay screenshots and `render_game_to_text`, and resolve every console error.

Keeping registration explicit prevents a filesystem generator from silently mutating the closed `AppId` union, choosing an icon, or deciding Dock policy on behalf of the product.

## Architectural boundaries

The foundation is split into one-way layers:

```text
game engine (pure domain)
        ↓
game-platform/runtime        game-platform/agent (AGAP)
        ↓
game-platform/web    game-platform/r3f
        ↓                   ↓
     React app / single R3F Canvas

game-platform/testkit → domain/runtime verification only
```

- The engine owns gameplay state and deterministic simulation, with no React, DOM, Three.js, or shell imports.
- `runtime` owns exact fixed-step time, reset semantics, and presentation/simulation state only inside the match authority boundary. In the generated command template it stores presentation time and no gameplay fields.
- `web` owns automation, blur/visibility/inactive input reset, suspension, and fullscreen.
- `r3f` owns the single render-loop driver, adaptive DPR, resource ownership, and capacity helpers.
- `testkit` owns stable snapshots, timeline replay, and time-partition assertions.
- `agent` owns the transport-neutral AGAP host, seat-bound participant capabilities, revision/nonce checks, idempotent receipts, and private event channels.
- Each concrete game adapter imports its pure engine and `game-platform/agent`; the engine never imports the protocol host, React, or transport code.
- The OS store owns windows and focus only. It must not receive per-frame game state.

## Agent-native participation is mandatory

Every built-in game declares an [AGAP v1](./agent-coplay-contract.md) `GameDescriptor`, including stable game/rules versions, turn and information models, seats, and machine-readable metadata. Every seat exposes only a seat-projected `SeatObservation`, its complete current `LegalActionSet`, receipts, and visible events through a seat-bound `ParticipantPort`. Hidden domain state and another seat's private information never cross that boundary.

The human UI and Agent controller must map intent into the same formal action union and use the same domain reducer/validator. `ParticipantKind` is audit metadata only: it must never change observations, legal actions, authorization, timing, scoring, or outcomes. Add contract tests that run the same match id, request ids, and action timeline through human- and Agent-bound ports and compare receipts, projected outcomes, legal actions, and visible events after every transition.

Start, in-match restart/reset, pause/resume, resign/leave, and every other rule-bearing operation supported by a live match are formal actions. An in-match restart must enter through the participant port, reset authoritative gameplay in the Host reducer, and publish the new revision/projection. UI code may then reset presentation clock/input, but it must never recreate gameplay state locally.

A terminal **New Match/New Round** control is a different orchestration lifecycle: the terminal Host remains immutable and rejects further game actions, while a match factory creates a new authority with a new match id and fresh seed, then rebinds every participant. It is not an action against the old terminal `ParticipantPort`. Tests must prove that the new authority is independent and that no hidden seed/state is reused or copied from the completed match.

This applies to perfect-information and single-player games too. They declare one explicit seat and a single-seat port rather than omitting AGAP. The generated template demonstrates this end-to-end: its local human controls call the bound port rather than mutating engine state directly.

Each match has exactly one gameplay authority. In the generated command-driven template that authority is the AGAP Host: React snapshots, R3F rendering, HUD, and automation text consume `humanPort.observe().observation`, while the fixed-step runtime advances presentation time only. They must not copy `mode`, positions, score, cards, health, inventory, or other rule-bearing state and synchronize it later with `runtime.replaceState`.

Real-time games follow the same single-authority rule. Their deterministic simulation runs behind the authoritative match/AGAP composition and publishes seat projections from that same state. Do not create one mutable simulation in runtime and a second mutable rules state in the AGAP Host; either integrate simulation state into the authority or expose it through an authority-owned adapter, with ParticipantPorts and renderers remaining projections.

`window.render_game_to_text()` and `window.advanceTime(ms)` remain unauthenticated developer/test automation hooks. They are not AGAP, must be enabled only for the active game, and must never be handed to an Agent as a participant capability. Local and remote Agent orchestration bind an authenticated/authorized seat and expose only its `ParticipantPort`.

ECS, a physics engine, networking, asset pipelines, and post-processing remain game-level choices. They should be added only when a game needs them, not to the shared baseline preemptively.

## Required quality gate

Every game must preserve the applicable invariants below. Renderer-specific gates apply only when that renderer is used:

- one simulation clock; R3F games also have exactly one R3F frame loop;
- fixed-step simulation with deterministic time partitioning;
- R3F games use `frameloop="demand"` whenever the game is ready, paused, inactive, or complete;
- no per-frame React state or global Zustand writes for transforms;
- input reset on blur, hidden document, inactive window, unmount, in-match restart/new-match replacement, and suspension;
- when in-match restart is supported, it is a formal ParticipantPort action with authoritative Host reset plus separate presentation clock/input cleanup;
- terminal New Match/New Round creates a fresh Host/match id/seed and participant bindings instead of acting on or mutating the old terminal Host;
- `window.advanceTime(ms)` and concise `window.render_game_to_text()` automation bridges;
- an AGAP descriptor, seat projection, complete formal-action parity, and conformance tests for human/Agent ports;
- exactly one gameplay authority; React, renderers, automation, and presentation clocks are projections rather than synchronized gameplay replicas;
- synchronous virtual-clock ownership on the first React render when the official client's `__vt_pending` marker is present, plus a ref guard that closes the bridge-effect/state-commit race;
- R3F/Canvas games render one visible Canvas with the background inside it; DOM games must not add a placeholder Canvas;
- `F` fullscreen toggle and Escape handled through the browser fullscreen contract;
- deterministic unit tests plus official-client gameplay, screenshot, state, and console validation;
- R3F/Three.js games have bounded draw calls and explicit resource ownership for dynamic objects.

The generated deterministic test advances two seconds (120 ticks at the default 60 Hz) in one call with both the runtime's default 240-step budget and an explicit 120-step budget, then compares it with two one-second partitions. Keep that path within the configured budget to preserve the repository's `advanceTime(2000)` contract without partial or nondeterministic progress.

After the automation host requests manual time, that clock ownership lasts until the game component unmounts. Do not switch a mounted session back to real time between `advanceTime()` calls, because doing so makes replay results depend on host scheduling gaps.

See [template-contract.md](./template-contract.md) for the exact generated guarantees.
