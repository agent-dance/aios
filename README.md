# AlSniper OS

AlSniper OS is a polished browser-native desktop environment inspired by the spatial clarity of modern macOS while using its own instrument-grade visual language.

## Run locally

```bash
npm install
npm run dev
```

### Run with the local Codex Agent

The Agent runtime is a loopback-only Go sidecar that requires Go 1.26.5 or newer and reuses the native Codex authentication through an isolated linked profile. From the repository root, this single PowerShell session generates one ephemeral HMAC secret, starts the sidecar as a managed job, and gives the same secret to Vite without printing or persisting it. Browser requests never transmit that secret; they send bounded, timestamped HMAC-SHA256 proofs with unique nonces, and verify every signed response before parsing it:

```powershell
$agentToken = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
$repoPath = (Resolve-Path .).Path
$sidecarJob = Start-Job -ArgumentList $repoPath, $agentToken -ScriptBlock {
  param($repoPath, $agentToken)
  Set-Location -LiteralPath $repoPath
  $env:AIOS_SIDECAR_TOKEN = $agentToken
  go -C sidecar run ./cmd/alsniper-agent
}
$env:VITE_AIOS_SIDECAR_URL = 'http://127.0.0.1:4317'
$env:VITE_AIOS_SIDECAR_TOKEN = $agentToken
try {
  npm run dev
} finally {
  Stop-Job -Job $sidecarJob -ErrorAction SilentlyContinue
  Remove-Job -Job $sidecarJob -Force -ErrorAction SilentlyContinue
  Remove-Item Env:VITE_AIOS_SIDECAR_URL, Env:VITE_AIOS_SIDECAR_TOKEN -ErrorAction SilentlyContinue
  $agentToken = $null
}
```

Vite embeds development environment values in browser code, so this path is for local loopback development only. Production must use a trusted desktop launcher to inject an ephemeral `window.__AIOS_SIDECAR_CONFIG__`; production builds ignore `VITE_AIOS_SIDECAR_TOKEN`. Codex processes run with `--ephemeral`; multi-turn context is a bounded in-memory browser window rather than a persisted rollout. Invoke an installed domain Agent explicitly with `/agent <agent-id> <message>` so the Host binds its package principal before inference. If the first real turn returns `AGENT_FAILED`, refresh the native profile with `codex login`; the health endpoint verifies the auth link and isolation but cannot preflight an expired or revoked provider credential without consuming a model request.

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
