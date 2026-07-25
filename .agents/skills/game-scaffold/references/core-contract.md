# Core game-platform contract

## Mandatory dependency direction

Every game must reuse `src/game-platform` with this one-way dependency structure:

```text
pure game domain engine
    → game-platform/runtime
    → game-platform/web and optional game-platform/r3f
    → React game application

game-platform/testkit → domain/runtime verification
```

- The domain engine must be pure TypeScript and must not depend on React, DOM, Three.js, or the OS shell.
- Fixed-step simulation, state/input replacement, publication, reset, and synchronous work budgets must use `game-platform/runtime`.
- Automation, blur/visibility/inactive lifecycle, input cleanup, suspension, and Fullscreen must use `game-platform/web`.
- R3F games must use `game-platform/r3f` for the single frame driver, adaptive DPR, capacity growth, and explicit resource ownership.
- Stable serialization, timeline replay, and time-partition equivalence must use `game-platform/testkit`.
- `src/game-platform` must never import `src/apps` or a concrete game.
- The OS store owns windows and focus only; it must never receive per-frame game state.

The generated renderer is R3F, but R3F is not mandatory for every game. DOM, Canvas2D, or another renderer may replace the render layer while retaining the generated domain/runtime/web/testkit boundaries, one simulation clock, lifecycle, and automation contracts. A reusable adapter for another renderer belongs in `game-platform` with tests; do not duplicate it across games.

## Prohibited bypasses

Without a user-approved exception, do not:

- implement another fixed-step accumulator or runtime;
- add an independent `requestAnimationFrame`, second simulation clock, or parallel simulation loop;
- install incompatible `window.advanceTime` or `window.render_game_to_text` globals;
- duplicate blur, visibility, inactive, Fullscreen, adaptive-DPR, resource-disposal, or capacity-growth infrastructure;
- write React state or global Zustand state on a per-frame path;
- retain input after blur, hidden, inactive, suspend, restart, or unmount;
- read wall-clock time, DOM, React state, or the Three.js scene from simulation;
- call `Math.random()` from simulation. Store an explicit seeded random generator in domain state instead.

Runtime state/input values are transferred by reference and exposed as shallow read-only views. Games and simulations must not mutate transferred values in place, because doing so breaks batch atomicity.

Collision, gameplay entities, HUD, levels, key mapping, physics, ECS, networking, and asset pipelines remain game-level choices and must not be added to the shared baseline without demonstrated reuse.

## Runtime invariants

Every game must preserve:

- one simulation clock; an R3F game has one visible Canvas and one automatic render loop;
- realtime stepping only while active and playing; ready, paused, inactive, and completed states use `frameloop="demand"`;
- shared-bridge `window.advanceTime(ms)` performs synchronous deterministic valid-time advancement;
- `window.render_game_to_text()` returns concise JSON with coordinates and player-visible decision state;
- the first React render checks `__vt_pending`, with a synchronous ref closing the bridge-effect / React-commit race;
- `onManualClockRequested` is idempotent, and manual-clock ownership remains sticky for the component mount; realtime simulation never resumes between `advanceTime()` calls;
- the default 240-tick / 4000ms budget, including exact equivalence between one `advanceTime(2000)` (120 ticks at 60Hz) and two 1000ms partitions;
- input cleanup on blur, hidden, inactive, suspend, restart, and unmount;
- `F` toggles Fullscreen for the game target, while Escape follows the browser Fullscreen contract;
- explicit, idempotent disposal ownership for dynamic Three.js resources.
