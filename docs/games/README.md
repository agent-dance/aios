# AlSniper OS game foundation

The repository provides one production-oriented browser-game foundation under `src/game-platform` and a zero-dependency generator under `tools/game-scaffold`. New games reuse the platform instead of copying infrastructure out of an existing game.

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
game-platform/runtime
        ↓
game-platform/web    game-platform/r3f
        ↓                   ↓
     React app / single R3F Canvas

game-platform/testkit → domain/runtime verification only
```

- The engine owns gameplay state and deterministic simulation, with no React, DOM, Three.js, or shell imports.
- `runtime` owns exact fixed-step time, state/input replacement, reset semantics, and publication.
- `web` owns automation, blur/visibility/inactive input reset, suspension, and fullscreen.
- `r3f` owns the single render-loop driver, adaptive DPR, resource ownership, and capacity helpers.
- `testkit` owns stable snapshots, timeline replay, and time-partition assertions.
- The OS store owns windows and focus only. It must not receive per-frame game state.

ECS, a physics engine, networking, asset pipelines, and post-processing remain game-level choices. They should be added only when a game needs them, not to the shared baseline preemptively.

## Required quality gate

Every game must preserve these invariants:

- one simulation clock and one R3F frame loop;
- fixed-step simulation with deterministic time partitioning;
- `frameloop="demand"` whenever the game is ready, paused, inactive, or complete;
- no per-frame React state or global Zustand writes for transforms;
- input reset on blur, hidden document, inactive window, unmount, restart, and suspension;
- `window.advanceTime(ms)` and concise `window.render_game_to_text()` automation bridges;
- synchronous virtual-clock ownership on the first React render when the official client's `__vt_pending` marker is present, plus a ref guard that closes the bridge-effect/state-commit race;
- one visible Canvas with the background rendered inside it;
- `F` fullscreen toggle and Escape handled through the browser fullscreen contract;
- deterministic unit tests plus official-client gameplay, screenshot, state, and console validation;
- bounded draw calls and explicit resource ownership for dynamic Three.js objects.

The generated deterministic test advances two seconds (120 ticks at the default 60 Hz) in one call with both the runtime's default 240-step budget and an explicit 120-step budget, then compares it with two one-second partitions. Keep that path within the configured budget to preserve the repository's `advanceTime(2000)` contract without partial or nondeterministic progress.

After the automation host requests manual time, that clock ownership lasts until the game component unmounts. Do not switch a mounted session back to real time between `advanceTime()` calls, because doing so makes replay results depend on host scheduling gaps.

See [template-contract.md](./template-contract.md) for the exact generated guarantees.
