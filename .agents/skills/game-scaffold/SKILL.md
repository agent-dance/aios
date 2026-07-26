---
name: game-scaffold
description: "Use for every AlSniper OS browser-game or Agent co-play task: creating or modifying games, AGAP/ParticipantPort, human-Agent action parity, gameplay simulation, input, rendering loops, lifecycle, fullscreen, automation, determinism, performance, the game scaffold, or src/game-platform. Requires the repository scaffold and shared runtime/web/testkit, plus r3f when applicable. Do not use for ordinary non-game system apps."
---

# AlSniper OS Game Scaffold

Use this Skill before the first implementation write for every matching task. Its instructions are completion requirements, not suggestions.

## Required reading and routing

Before acting:

1. Read `docs/games/README.md`, `docs/games/template-contract.md`, and the target game's `README.md` / `progress.md` when present.
2. Read the installed `develop-web-game` Skill completely. If it is unavailable, report that fact and perform an equivalent real-browser workflow; unit tests alone are never sufficient.
3. Always read these Skill references completely:
   - `references/core-contract.md`
   - `references/verification.md`
4. Classify the task, then read the matching reference completely:
   - New game: `references/new-game.md`
   - Existing-game migration/refactor or `src/game-platform/**` / scaffold change: `references/existing-and-platform.md`
   - A task spanning categories must read the union of their references.

Do not begin implementation until all required references for the task have been read.

## Authority

- This Skill is the canonical Agent workflow for game development in this repository.
- `docs/games/*` defines the underlying technical contract; this Skill defines how Agents must apply and verify it.
- A user-approved exception may alter only the explicitly approved rule. All other Skill requirements remain active.
