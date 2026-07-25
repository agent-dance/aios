# Game template contract

The `r3f-basic` template is a deliberately small vertical slice, not a sample-only mock. It compiles against the same public game-platform API used by first-party games and contains a complete start, play, pause, inactive, blur, fullscreen, automation, and deterministic-test path.

## Engine contract

The generated engine exports serializable state and input types, pure initializers, a fixed-step simulation function, and a compact textual renderer. Simulation receives its delta from `createFixedStepRuntime`; engine code must not read wall-clock time, `Math.random`, browser globals, or React state.

When randomness is required, add an explicit seeded generator to state. When external events are required, encode them as input/commands and preserve their deterministic order.

## Application contract

The generated application:

- creates one runtime for the component lifetime;
- renders one R3F Canvas;
- advances simulation through `FixedStepDriver` only;
- selects `always` only while active and playing, and `demand` otherwise;
- mutates Three.js object refs during frames instead of rendering React state at 60 Hz;
- resets input and pauses through `useGameLifecycle`;
- installs and removes the standardized automation bridge through `useGameAutomationBridge`;
- detects the official client's virtual-time marker during the first render and synchronously guards real-time frames with a ref while React commits manual-clock state;
- uses the shared fullscreen controller;
- keeps the shell's `isActive` lifecycle separate from the engine's gameplay mode.

Games may replace the scene, input mapping, UI, simulation schema, and renderer. They must not add an independent `requestAnimationFrame`, a second clock, or a custom incompatible automation hook.

`onManualClockRequested` must remain idempotent and must set the synchronous ref before scheduling React state. Relying on the bridge's passive effect or React state alone reintroduces a first-frame/commit-window race that can leak a nondeterministic real-time tick into automation runs.

Manual-clock ownership is intentionally sticky for the mounted game session. Once the host marker or a valid `advanceTime()` call requests deterministic time, real-time simulation must not resume between later host calls; unmounting and remounting creates a new ownership session. This prevents wall-clock frames from contaminating an automation replay.

## Test contract

The generated tests verify equivalent elapsed-time partitions and frozen paused state using stable serialization. Their two-second single-call path exercises both the default 240-step budget and an exact explicit 120-step budget, preserving this repository's `advanceTime(2000)` compatibility contract. Extend them with gameplay outcomes such as collision, scoring, resource consumption, victory/failure, restart, seeded randomness, and boundary behavior.

Browser checks continue to use the official client shipped with the `develop-web-game` skill. The repository intentionally does not add `@playwright/test` merely for the template.

## Performance budgets

Budgets are game-specific, but every game should record at least active FPS frame-time percentiles, ready/paused/inactive draw calls, active draw calls per frame, long tasks, restart latency, console errors, renderer identity, viewport, and build artifact hash. Measure on a hardware renderer when making absolute FPS claims; software WebGL results are suitable for relative regression checks only.
