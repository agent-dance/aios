# Existing games and platform changes

## Existing game migration or refactor

- The generator refuses to overwrite an existing directory. Never delete an existing game and regenerate it as a migration strategy.
- Preserve gameplay and UI while replacing duplicated infrastructure layer by layer with the generated contract.
- Audit the existing game against the current generated template before implementation.
- The audit must enumerate every human-visible decision and control, then prove each maps to an AGAP action available through the same seat's `ParticipantPort`; direct UI-only state mutations must be migrated to the shared reducer/validator.
- When an executable comparison is needed, generate an unregistered baseline with a unique temporary id. Verify it, resolve the exact path, delete only that directory, and record the cleanup result.
- Never copy infrastructure from another concrete game.

## Platform or scaffold work

- Changes to `src/game-platform/**` or the scaffold do not require generating a game before implementation.
- Public AGAP changes must preserve seat authorization, information projection, idempotency, stale-window rejection, event privacy, and human/Agent action parity. Do not substitute the unauthenticated browser automation bridge for AGAP.
- When a public platform or template contract changes, completion requires generating a unique temporary game, running its typecheck/tests/build against the real public APIs, and precisely cleaning it up.
- Missing reusable capability must be implemented backward-compatibly in `src/game-platform` with tests. Do not add a near-duplicate to one game.
