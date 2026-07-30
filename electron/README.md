# AlSniper OS Electron host

This host embeds the fixed official WeChat Web entry (`https://wx.qq.com/`) in an Electron `WebContentsView`. The remote page runs in a sandboxed renderer with no Node.js integration, no preload bridge, a dedicated persistent session, denied permissions and downloads, and exact navigation boundaries.

For WeChat lifecycle control, the local React shell receives only `window.alsniperDesktop.wechat`. That closed API supports mount, bounds, visibility, focus, reload, safe back-navigation, unmount, state lookup, and state subscriptions. It cannot supply a URL, IPC channel, partition, or application identifier.

## Semantic application control

The shell also receives a closed `window.alsniperDesktop.applicationControl` bridge for capability discovery, typed execution, and receipt lookup. It does not expose selectors, arbitrary JavaScript, CDP, coordinates, a commit handle, or the embedded WeChat `WebContents`.

The local Agent Runtime is attached only during a trusted desktop launch. The launcher supplies `AIOS_DESKTOP_SIDECAR_URL`, `AIOS_DESKTOP_SIDECAR_TOKEN`, and `AIOS_DESKTOP_SIDECAR_ORIGIN`; the main process validates and deletes all three before creating a renderer. A frame-scoped IPC handler then gives the sandbox preload a fresh, read-only in-memory copy through `window.alsniperDesktop.agentRuntime.getSidecarConfig()`. The production renderer never reads a Vite secret or persists this capability. The only supported production custom origin is exactly `app://alsniper`; development remains bound to the selected loopback HTTP shell origin. The launcher also creates a fresh `\\.\pipe\alsniper-desktop-shutdown-<32 lowercase hex>` endpoint and independent 256-bit secret before spawning Electron, then passes them once through `AIOS_DESKTOP_SHUTDOWN_PIPE` and `AIOS_DESKTOP_SHUTDOWN_SECRET`. The main process validates and deletes both, connects, emits the fixed versioned readiness preface, and returns a PID-bound HMAC-SHA-256 possession proof. Closing the accepted supervisor socket invokes ordinary `app.quit()`, preserving the storage checkpoint lifecycle before the launcher's bounded exact-process-tree fallback. This temporary Node supervisor treats processes in the same Windows user session as one trust domain; OS-enforced peer-PID/DACL isolation remains a requirement for a future hardened native supervisor.

Application Control is owned by Electron main. The first versioned action is `wechat.message.send_to_current` with the exact `{ "text": string }` argument contract. Main prepares against the currently attested WeChat document and chat identity, renders the exact recipient and escaped full message in a native confirmation dialog, persists an HMAC-chained dispatch fence, and only then permits one semantic click. The isolated runtime accepts success or failure only after observing one unique new pending bubble and that same DOM bubble's terminal status; official Web WeChat may migrate its pending LocalID to one server MsgID on success. Navigation, page replacement, crash, timeout, ambiguous evidence, or a post-fence host failure produces non-retryable `unknown`; the system never automatically sends again.

The fixed-schema journal lives under Electron user data, contains no recipient, nickname, username, message body, approval detail, or raw content digest, and is bounded to 64 MiB. Missing keys, corruption, truncation, or an unavailable journal disables application-control capabilities without preventing the shell or normal WeChat use from starting. See [ADR 0004](../docs/decisions/0004-application-control-effect-journal.md).

## Build contract

Compile `electron/tsconfig.json` after the web build. It emits:

- `dist-electron/main.js` — Electron main entry
- `dist-electron/preload.cjs` — self-contained sandbox-compatible shell preload

Start development with a single validated loopback origin:

```text
electron dist-electron/main.js --dev-url=http://127.0.0.1:5173/
```

Production starts without `--dev-url`; the host serves `dist/` through the restricted standard `app://alsniper/` scheme. Requests are confined to that directory and do not expose `file://` navigation.

Run policy and controller unit tests with the repository Vitest command. Electron itself and its Node types must be installed by the root package configuration; this directory intentionally does not carry an independent package manifest.

Run the real subprocess crash-recovery gate with:

```text
npm run desktop:application-control-smoke
```

## Security boundary

- The WeChat target is a main-process constant. Renderer IPC never accepts a URL.
- The partition is fixed to `persist:alsniper-wechat`, is never shared with the local shell, and is not cleared when the WeChat app is unmounted or its window is closed. Chromium keeps browser-managed persistent cookies, local storage, IndexedDB, service workers, and HTTP cache for that partition in Electron's application data directory.
- Navigation, redirects, subframes, popups, permissions, device permissions, and downloads are fail-closed.
- IPC calls require the exact shell `webContents` and its main frame, exact argument counts, and cloned closed-schema values.
- After each official document navigation, the host installs a fixed user-origin stylesheet and verifies the computed outer geometry before revealing the view. It removes only Web WeChat's outer `.main`, `.main_inner`, and `.login` browser-page constraints so the service fills the application body; conversation and contact-pane scrolling remains owned by WeChat.
- Closing or unmounting explicitly detaches the native view and closes its `webContents` without deleting the persistent partition. View unmount, window shutdown, and application shutdown perform a synchronous DOM-storage checkpoint and a bounded cookie-store checkpoint before returning or exiting.

Embedding the official page does not bypass Tencent account eligibility, login risk controls, regional availability, or server-side decisions. The desktop host preserves those controls. The persistent partition can retain only data that WeChat Web actually stores in the browser. Tencent controls server-side chat history, synchronization, retention, and login-token validity, so the host cannot guarantee that every conversation or login remains available indefinitely.
