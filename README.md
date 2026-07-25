# AlSniper OS

AlSniper OS is a polished browser-native desktop environment inspired by the spatial clarity of modern macOS while using its own instrument-grade visual language.

## Run locally

```bash
npm install
npm run dev
```

Production verification:

```bash
npm test
npm run build
npm run preview
```

Create a new game on the shared production foundation:

```bash
npm run game:create -- --id asteroid-run --name "Asteroid Run"
```

The generated game reuses the deterministic runtime, browser lifecycle and automation contracts, single-loop React Three Fiber integration, adaptive quality controls, and replay test utilities. See [the game-foundation guide](./docs/games/README.md) before registering it with the desktop shell.

## Included experiences

- Windowed desktop with draggable, resizable, minimizable, maximizable apps
- Live menu-bar clock, calendar and focus timer
- Control Center for Wi-Fi, Bluetooth, system health, storage, energy, brightness and sound
- Persistent Aurora/Midnight themes, accent colors and accessibility preferences
- Finder, keyboard-friendly calculator, safe simulated terminal, Settings and a trust-aware App Store
- Cosmic Vanguard, a deterministic 3D space shooter with keyboard, pointer, pause, restart and fullscreen controls
- Reusable game platform and atomic scaffold generator for future browser games

## Game controls

- Move: `WASD` or arrow keys
- Fire: mouse or `Space`
- Pause/resume: `P`
- Fullscreen: `F` (exit with `Esc`)
- Restart after defeat: `R`

The Terminal intentionally runs an allowlisted browser simulation and never exposes the host shell, filesystem or arbitrary code execution.
