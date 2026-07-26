# Verification, exceptions, and completion evidence

## Required verification loop

For every meaningful game change, follow the installed `develop-web-game` loop: implement → act → pause → observe → correct.

Before completion, run:

```powershell
npm run typecheck
npm test
npm run build
```

Also complete all applicable checks:

- deterministic partition equivalence, one-call/two-part two-second advancement, paused/inactive freezing, applicable restart/new-match behavior, and affected gameplay outcomes;
- when in-match restart is supported: restart through human- and Agent-bound ports, initial authoritative result, new revision/projection, and separate presentation clock/input cleanup with no gameplay copy in runtime;
- when terminal New Match/New Round is supported: a fresh Host/match id/seed, new participant bindings, an unchanged terminal prior Host, and no reused hidden state;
- AGAP descriptor/schema checks, per-seat information projection, complete formal-action enumeration, illegal/stale/wrong-seat rejection, and human/Agent parity through bound `ParticipantPort` instances;
- a same-action timeline for human- and Agent-bound seats that compares projected observations, legal actions, receipts/outcomes, and visible events after every transition;
- official-client interaction for start, primary movement/actions, pause/resume, applicable restart/new-match controls, Fullscreen, inactive/recovery, and key gameplay transitions;
- visually open the latest screenshots and compare them with `render_game_to_text()`;
- repeat identical input and virtual-time workflows at least twice and compare stable state or hashes;
- inspect and fix all new console errors and page errors;
- reset between scenarios to prevent state contamination;
- for performance changes, record renderer, viewport, production game chunk/hash, FPS, P50/P95/P99, applicable renderer draw calls, Long Task/LoAF, and restart/new-match latency. Absolute FPS claims require a hardware renderer.

Unit tests, typecheck, or one screenshot alone never establish completion.

## Exception process

An exception is allowed only when the shared platform is proven unable to meet a requirement. Before bypassing the platform, the Agent must:

1. identify the incompatible API/constraint and provide reproduction evidence;
2. compare extending the shared platform, using a mature framework, and a game-local special case;
3. explain dependency, determinism, performance, testing, and maintenance effects;
4. request and receive explicit user approval.

No reply, schedule pressure, convenience, or existing code is approval. Never assume an exception or report it only after implementation. Unless separately approved, shared automation, lifecycle cleanup, and all quality gates remain mandatory.

## Completion evidence

Record auditable evidence in the target game's `progress.md` and final result:

- the scaffold command for a new game, or the platform reuse/migration map for an existing game;
- generation, verification, and precise cleanup of temporary directories when applicable;
- actual reuse of runtime/web/r3f/testkit and explicit registration locations;
- actual reuse of `game-platform/agent`, the descriptor and seat projection, the human UI-to-port wiring, and AGAP parity/security test results;
- typecheck, test, build, official-client, screenshot, text-state, and error-check results;
- deterministic repeat results, performance evidence, and production artifact hash;
- every approved exception and its approval basis.

The task is incomplete while any required evidence, TODO, dead code, duplicate platform, failing gate, unresolved error, or temporary generated directory remains.
