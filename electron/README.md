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
- The partition is fixed to `persist:alsniper-wechat` and is never shared with the local shell.
- Navigation, redirects, subframes, popups, permissions, device permissions, and downloads are fail-closed.
- IPC calls require the exact shell `webContents` and its main frame, exact argument counts, and cloned closed-schema values.
- Closing or unmounting explicitly detaches the native view and closes its `webContents`.

Embedding the official page does not bypass Tencent account eligibility, login risk controls, regional availability, or server-side decisions. The desktop host preserves those controls.
