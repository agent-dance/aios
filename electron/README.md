# AlSniper OS Electron host

This host embeds the fixed official WeChat Web entry (`https://wx.qq.com/`) in an Electron `WebContentsView`. The remote page runs in a sandboxed renderer with no Node.js integration, no preload bridge, a dedicated persistent session, denied permissions and downloads, and exact navigation boundaries.

The local React shell receives only `window.alsniperDesktop.wechat`. Its closed API supports mount, bounds, visibility, focus, reload, safe back-navigation, unmount, state lookup, and state subscriptions. It cannot supply a URL, IPC channel, partition, or application identifier.

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

## Security boundary

- The WeChat target is a main-process constant. Renderer IPC never accepts a URL.
- The partition is fixed to `persist:alsniper-wechat`, is never shared with the local shell, and is not cleared when the WeChat app is unmounted or its window is closed. Chromium keeps browser-managed persistent cookies, local storage, IndexedDB, service workers, and HTTP cache for that partition in Electron's application data directory.
- Navigation, redirects, subframes, popups, permissions, device permissions, and downloads are fail-closed.
- IPC calls require the exact shell `webContents` and its main frame, exact argument counts, and cloned closed-schema values.
- After each official document navigation, the host installs a fixed user-origin stylesheet and verifies the computed outer geometry before revealing the view. It removes only Web WeChat's outer `.main`, `.main_inner`, and `.login` browser-page constraints so the service fills the application body; conversation and contact-pane scrolling remains owned by WeChat.
- Closing or unmounting explicitly detaches the native view and closes its `webContents` without deleting the persistent partition. View unmount, window shutdown, and application shutdown perform a synchronous DOM-storage checkpoint and a bounded cookie-store checkpoint before returning or exiting.

Embedding the official page does not bypass Tencent account eligibility, login risk controls, regional availability, or server-side decisions. The desktop host preserves those controls. The persistent partition can retain only data that WeChat Web actually stores in the browser. Tencent controls server-side chat history, synchronization, retention, and login-token validity, so the host cannot guarantee that every conversation or login remains available indefinitely.
