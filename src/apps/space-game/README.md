# Cosmic Vanguard

Cosmic Vanguard is AlSniper OS's deterministic real-time space shooter. Its only gameplay authority is `SpaceGameMatch`, which owns the shared `FixedStepRuntime`; React, R3F, human input, Agent control, and browser automation never maintain a second mutable rules state.

## Platform map

- `gameEngine.ts` is the pure deterministic simulation.
- `SpaceGameAgentAdapter.ts` owns the real-time match boundary and publishes the AGAP v1 descriptor, a perfect-information `pilot` projection, the complete finite legal-action set, receipts, and seat-private event stream.
- `SpaceGameAgentController.ts` adapts an asynchronous planner to the bound pilot capability. It replans every 250–500 ms and on critical phase/health/wave changes, while the accepted control remains latched between plans.
- `SpaceGameApp.tsx` maps keyboard, pointer, and visible lifecycle buttons to the same `SpaceGameAction` union used by an Agent. The application continues to reuse `game-platform/runtime`, `game-platform/web`, and `game-platform/r3f`.

## Formal controls

The finite action schema contains:

- one composite control action across nine movement directions, fire on/off, and a 5×3 aim grid;
- start, pause, resume, and in-match restart.

The complete playing legal set contains 270 control combinations plus pause and restart. Composite controls allow a remote LLM to choose a useful latched plan in one inference instead of issuing frame-level device events. Human keyboard and pointer state is quantized into the exact same composite action.

`observationTick` follows the 60 Hz simulation, while AGAP revision and nonce rotate only when the 250 ms control window, phase, or committed input decision changes. An asynchronous controller receives only its seat-bound observation and legal actions; it never receives runtime state, seed, React state, `window.advanceTime`, or another authority capability.

The match exposes a dedicated `SpaceGameRenderProjection` to R3F and the HUD. This copied projection contains only draw/HUD fields and cannot be used to observe or act through AGAP; the authority's full `GameState` and `InputState` accessors remain private. `onPublish` receives this projection without runtime input metadata, and a Host reentrancy barrier rejects participant capability calls made from that observer so a renderer callback cannot rotate revision/nonce or interleave an action with an outer commit.

The render loop compares a lightweight monotonic critical-observation version after fixed-step batches. A full Agent observation is constructed only when the driver actually plans or phase/health/wave changes, rather than on every frame. Browser automation text includes both `observationTick` and `currentControl` so text and visible decision state remain aligned.

`SpaceGameApp` defaults to `controlMode="human"`. A trusted OS composition root may inject a structurally compatible `SpaceGameAgentController` and select `assist` or `agent`. Control mode and participant identity are immutable for the mounted authority session; controller connection is availability only, so disconnect/reconnect never recreates the match or loses progress. Agent-only mode fails over to the same formal human controls while its controller is unavailable. AlSniper OS therefore declares its target `assist` mode continuously and varies only the injected controller.

`isActive` gates foreground human input and automation, while the independent `simulationActive` prop allows an open background window to keep its simulation and Agent seat running. A synchronous capability gate is rechecked by keydown/keyup, pointer, Fullscreen, automation, and both sides of asynchronous Agent planning. Browser blur/hidden, explicit simulation deactivation, and controller replacement synchronously revoke/abort affected work before passive React cleanup. `window.advanceTime` takes sticky manual-clock ownership and stops the wall-clock Agent driver before deterministic advancement; the mounted session never switches back to real time.

For official `develop-web-game` browser validation, use the development-only URL `/?automationGame=space-game`. It mounts the immersive canvas on the first render so the harness's largest-canvas selection cannot cache the smaller desktop-assistant avatar. Production builds ignore this query parameter.
