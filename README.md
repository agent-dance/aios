# AlSniper OS

AlSniper OS is a polished browser-native desktop environment inspired by the spatial clarity of modern macOS while using its own instrument-grade visual language.

## Run locally

The desktop host is the supported runtime for embedded applications such as WeChat:

```powershell
npm install
npm run desktop:dev
```

Install 微信 from App Store, then double-click its desktop icon. The official
`https://wx.qq.com/` client is rendered inside the AlSniper OS window through an
isolated Electron `WebContentsView`; it does not open an external tab or launch
the Windows WeChat executable. Tencent still controls QR login, account
eligibility, regional availability, and the web client's feature set.

Build and start the production desktop host, or create a Windows package:

```powershell
npm run desktop:start
npm run desktop:package
```

The packaged application is written beneath `release/`. The remote WeChat page
has no Node.js or preload access, uses a dedicated persistent session, and is
restricted by exact navigation, network, permission, popup, and download
policies. See [the desktop host runbook](./electron/README.md).

Browser-only development remains available for ordinary web UI work:

```bash
npm install
npm run dev
```

Browser mode cannot host `WebContentsView`; the WeChat app reports that the
desktop runtime is required and never falls back to an external URL.

### Run with the local Codex Agent

The temporary trusted launcher runs a locally built `alsniper-agent.exe` beside
the production Electron shell. It requires Windows x64, Go 1.26.5 or newer, and
the security-audited local `codex-cli 0.145.0` build:

```powershell
npm run local-runtime:build
npm run local-runtime:launch
```

The build fails unless the executable's own Go metadata proves that it embeds
the unreplaced `agent-adaptor v1.0.0` module. It records a local SHA-256 manifest
under ignored `release/local-agent-runtime/`, and launch verifies both the hash
and embedded dependency again. The launcher starts the packaged `AlSniper OS`
executable so its existing `%APPDATA%/AlSniper OS` WeChat partition and other
desktop data remain continuous. Independent fresh 256-bit secrets protect the
sidecar protocol and desktop lifecycle handshake; they are passed only through
child-process environments and never enter arguments, logs, browser storage,
or disk. The desktop is created only after an HMAC-authenticated sidecar health
exchange and PID-bound desktop named-pipe possession proof succeed. Closing the desktop,
sidecar, or foreground launcher stops the complete local runtime.

The sidecar derives an isolated profile from the operator's Codex profile:
supported settings are cloned while `auth.json` is linked so local OAuth
rotation continues to work without copying credentials. If a turn returns
`AGENT_AUTH_REQUIRED`, run `codex login`, restart the local runtime, and retry.
Codex CLI and credentials are not included in the desktop package. See the
[trusted local runtime runbook](./tools/local-runtime/README.md) for build,
integrity, startup, and shutdown details.

See [the sidecar runbook](./sidecar/README.md) and [Agent Runtime architecture](./docs/architecture/agent-runtime-sidecar.md) for exact-Origin binding, configuration, capability approval, A2UI, game-seat isolation, failure behavior, and the upstream SDK license release blocker.

Full repository verification:

```bash
npm run verify
npm audit
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
- Install-on-demand desktop shortcuts that appear automatically and open on double-click, including the official WeChat Web client embedded inside the Electron desktop host
- Cosmic Vanguard, a deterministic 3D space shooter with keyboard, pointer, pause, restart and fullscreen controls
- Reusable game platform and atomic scaffold generator for future browser games
- Local Codex desktop assistant with a procedural Three.js companion, text/hold-to-talk interaction, restricted A2UI, and receipt-backed OS controls
- Installable declarative domain Agents whose activation is capability-scoped and user-approved
- 斗地主 and Cosmic Vanguard Agent co-play, including concurrent background matches and mixed human/Agent seats

## Game controls

- Move: `WASD` or arrow keys
- Fire: mouse or `Space`
- Pause/resume: `P`
- Fullscreen: `F` (exit with `Esc`)
- Restart after defeat: `R`

The Terminal intentionally runs an allowlisted browser simulation and never exposes the host shell, filesystem or arbitrary code execution.
