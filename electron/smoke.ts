import { app, BrowserWindow, session, WebContentsView } from 'electron';
import { hardenWeChatSession } from './main/sessionPolicy.js';
import {
  isAllowedWeChatMainFrameUrl,
  isAllowedWeChatNavigation,
  WECHAT_ENTRY_URL,
} from './shared/navigationPolicy.js';

interface RemoteProbe {
  readonly title: string;
  readonly bodyTextLength: number;
  readonly documentMarkupLength: number;
  readonly hasLoginSurface: boolean;
  readonly hasQrSurface: boolean;
  readonly requireType: string;
  readonly processType: string;
}

const SMOKE_TIMEOUT_MS = 45_000;
const REMOTE_PROBE_SOURCE = `(() => {
  const bodyText = document.body?.innerText ?? '';
  const qrSelector = [
    '.qrcode',
    '.qrcode-img',
    '[class*="qrcode"]',
    'img[src*="qrcode"]',
    'img[src*="login.weixin.qq.com"]'
  ].join(',');
  const loginSelector = [
    '.login',
    '[class*="login"]',
    '[ng-controller*="login"]',
    'form'
  ].join(',');
  return {
    title: document.title,
    bodyTextLength: bodyText.trim().length,
    documentMarkupLength: document.documentElement?.outerHTML.length ?? 0,
    hasLoginSurface: Boolean(document.querySelector(loginSelector)),
    hasQrSurface: Boolean(document.querySelector(qrSelector)),
    requireType: typeof globalThis.require,
    processType: typeof globalThis.process
  };
})()`;

app.enableSandbox();

function safeHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname || '(no-host)';
  } catch {
    return '(invalid-url)';
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForRemoteSurface(view: WebContentsView, isProbeReady: () => boolean): Promise<RemoteProbe> {
  const deadline = Date.now() + SMOKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (
      isProbeReady()
      && !view.webContents.isDestroyed()
      && isAllowedWeChatMainFrameUrl(view.webContents.getURL())
    ) {
      const probe = await Promise.race([
        view.webContents.executeJavaScript(REMOTE_PROBE_SOURCE, true) as Promise<RemoteProbe>,
        delay(5_000).then(() => {
          throw new Error('WeChat DOM execution timed out after the QR resource loaded.');
        }),
      ]);
      if (
        probe.documentMarkupLength >= 100
        && (probe.hasLoginSurface || probe.hasQrSurface || probe.bodyTextLength > 0)
      ) {
        return probe;
      }
    }
    await delay(500);
  }
  throw new Error(`WeChat DOM probe timed out after ${SMOKE_TIMEOUT_MS}ms.`);
}

async function runSmoke(): Promise<void> {
  const smokeSession = session.fromPartition('alsniper-wechat-smoke', { cache: false });
  hardenWeChatSession(smokeSession);
  let qrResourceLoaded = false;
  let stopForProbe: (() => void) | null = null;
  const proxy = await smokeSession.resolveProxy(WECHAT_ENTRY_URL);
  console.log(JSON.stringify({ event: 'proxy', modes: proxy.split(';').map((entry) => entry.trim().split(/\s+/u)[0]) }));

  smokeSession.webRequest.onCompleted((details) => {
    if (
      safeHost(details.url) === 'login.weixin.qq.com'
      && details.resourceType === 'image'
      && details.statusCode >= 200
      && details.statusCode < 300
    ) {
      qrResourceLoaded = true;
      stopForProbe?.();
    }
    if (details.resourceType === 'mainFrame' || safeHost(details.url).includes('login')) {
      console.log(JSON.stringify({
        event: 'request-completed',
        host: safeHost(details.url),
        resourceType: details.resourceType,
        statusCode: details.statusCode,
      }));
    }
  });
  smokeSession.webRequest.onErrorOccurred((details) => {
    console.error(JSON.stringify({
      event: 'request-error',
      host: safeHost(details.url),
      resourceType: details.resourceType,
      error: details.error,
    }));
  });

  const hostWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });
  const view = new WebContentsView({
    webPreferences: {
      session: smokeSession,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      safeDialogs: true,
      backgroundThrottling: false,
    },
  });
  hostWindow.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1024, height: 768 });
  view.setVisible(false);
  let domReady = false;
  let stoppedForProbe = false;
  stopForProbe = () => {
    if (domReady && qrResourceLoaded && !stoppedForProbe && !view.webContents.isDestroyed()) {
      stoppedForProbe = true;
      view.webContents.stop();
    }
  };

  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  view.webContents.on('will-frame-navigate', (event) => {
    if (!isAllowedWeChatNavigation(event.url, event.isMainFrame)) {
      event.preventDefault();
    }
  });
  view.webContents.on('will-redirect', (event) => {
    if (!isAllowedWeChatNavigation(event.url, event.isMainFrame)) {
      event.preventDefault();
    }
  });
  view.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) {
      domReady = false;
    }
  });
  view.webContents.on('dom-ready', () => {
    domReady = true;
    console.log(JSON.stringify({ event: 'dom-ready', host: safeHost(view.webContents.getURL()) }));
    stopForProbe?.();
  });
  view.webContents.on('did-finish-load', () => {
    console.log(JSON.stringify({ event: 'did-finish-load', host: safeHost(view.webContents.getURL()) }));
  });
  view.webContents.on('did-fail-load', (_event, errorCode, _description, validatedUrl, isMainFrame) => {
    console.error(JSON.stringify({
      event: 'did-fail-load',
      host: safeHost(validatedUrl),
      isMainFrame,
      errorCode,
    }));
  });

  try {
    void view.webContents.loadURL(WECHAT_ENTRY_URL).catch((error: unknown) => {
      console.error(JSON.stringify({
        event: 'load-url-rejected',
        error: error instanceof Error ? error.name : 'UnknownError',
      }));
    });
    const probe = await waitForRemoteSurface(view, () => domReady && qrResourceLoaded && stoppedForProbe);
    const finalUrl = view.webContents.getURL();
    if (!isAllowedWeChatMainFrameUrl(finalUrl)) {
      throw new Error('WeChat smoke ended outside the main-frame allowlist.');
    }

    if (probe.requireType !== 'undefined' || probe.processType !== 'undefined') {
      throw new Error('Remote WeChat content can access a Node.js global.');
    }
    if (
      probe.title.trim().length === 0
      || probe.documentMarkupLength < 100
      || (!probe.hasLoginSurface && !probe.hasQrSurface && !qrResourceLoaded)
    ) {
      throw new Error('WeChat did not render a meaningful login or service surface.');
    }

    console.log(JSON.stringify({
      ok: true,
      finalUrl,
      title: probe.title,
      bodyTextLength: probe.bodyTextLength,
      documentMarkupLength: probe.documentMarkupLength,
      hasLoginSurface: probe.hasLoginSurface,
      hasQrSurface: probe.hasQrSurface,
      qrResourceLoaded,
      requireType: probe.requireType,
      processType: probe.processType,
    }));
  } finally {
    hostWindow.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) {
      view.webContents.close();
    }
    if (!hostWindow.isDestroyed()) {
      hostWindow.destroy();
    }
  }
}

app.whenReady()
  .then(runSmoke)
  .then(() => app.quit())
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Unknown WeChat smoke failure.');
    app.exit(1);
  });
