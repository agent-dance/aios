import { app, BrowserWindow, session, WebContentsView } from 'electron';
import {
  applyWeChatDocumentLayout,
  WECHAT_LAYOUT_STYLE_ELEMENT_ID,
} from './main/documentLayoutPolicy.js';
import { hardenWeChatSession } from './main/sessionPolicy.js';
import { WeChatViewController } from './main/WeChatViewController.js';
import {
  isAllowedWeChatMainFrameUrl,
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
  readonly rootClientWidth: number;
  readonly rootClientHeight: number;
  readonly rootScrollWidth: number;
  readonly rootScrollHeight: number;
  readonly bodyClientWidth: number;
  readonly bodyClientHeight: number;
  readonly bodyScrollWidth: number;
  readonly bodyScrollHeight: number;
  readonly bodyOverflowX: string;
  readonly bodyOverflowY: string;
  readonly mainMaxWidth: string | null;
  readonly mainInnerMaxWidth: string | null;
  readonly loginMinHeight: string | null;
  readonly loginOverflowY: string | null;
}

interface FixtureRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

const SMOKE_TIMEOUT_MS = 45_000;
const SIGNED_IN_FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{width:100%;height:100%;margin:0}
.main{display:none;height:80%;min-height:600px;padding-top:100px}
.main_inner{max-width:1000px;min-width:800px;height:100%;margin:0 auto;overflow:hidden}
.panel{position:relative;float:left;width:280px;height:100%;background:#2e3238}
[ui-view="contentView"]{height:100%}
.box{position:relative;width:auto;height:100%;overflow:hidden;background:#eee}
.login{display:block;min-width:860px;min-height:700px;overflow:auto}
.loaded .main{display:block}.loaded .login{display:none}
.unlogin .main{display:none}.unlogin .login{display:block}
</style></head><body class="unlogin">
<section class="login"></section>
<main class="main"><div class="main_inner"><aside class="panel"></aside><div ui-view="contentView"></div></div></main>
</body></html>`;
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
  const root = document.documentElement;
  const body = document.body;
  const bodyStyle = body === null ? null : getComputedStyle(body);
  const main = document.querySelector('.main');
  const mainInner = document.querySelector('.main_inner');
  const login = document.querySelector('.login');
  return {
    title: document.title,
    bodyTextLength: bodyText.trim().length,
    documentMarkupLength: document.documentElement?.outerHTML.length ?? 0,
    hasLoginSurface: Boolean(document.querySelector(loginSelector)),
    hasQrSurface: Boolean(document.querySelector(qrSelector)),
    requireType: typeof globalThis.require,
    processType: typeof globalThis.process,
    rootClientWidth: root?.clientWidth ?? 0,
    rootClientHeight: root?.clientHeight ?? 0,
    rootScrollWidth: root?.scrollWidth ?? 0,
    rootScrollHeight: root?.scrollHeight ?? 0,
    bodyClientWidth: body?.clientWidth ?? 0,
    bodyClientHeight: body?.clientHeight ?? 0,
    bodyScrollWidth: body?.scrollWidth ?? 0,
    bodyScrollHeight: body?.scrollHeight ?? 0,
    bodyOverflowX: bodyStyle?.overflowX ?? '',
    bodyOverflowY: bodyStyle?.overflowY ?? '',
    mainMaxWidth: main === null ? null : getComputedStyle(main).maxWidth,
    mainInnerMaxWidth: mainInner === null ? null : getComputedStyle(mainInner).maxWidth,
    loginMinHeight: login === null ? null : getComputedStyle(login).minHeight,
    loginOverflowY: login === null ? null : getComputedStyle(login).overflowY
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

function near(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 1;
}

async function runSignedInLayoutFixtureSmoke(): Promise<void> {
  const hostWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      backgroundThrottling: false,
    },
  });
  const view = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      backgroundThrottling: false,
    },
  });
  hostWindow.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1024, height: 640 });

  try {
    await view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SIGNED_IN_FIXTURE_HTML)}`);
    await applyWeChatDocumentLayout(view.webContents);
    const geometry = await view.webContents.mainFrame.executeJavaScript(`(() => {
      document.body.className = 'loaded';
      const outlet = document.querySelector('.main_inner > [ui-view="contentView"]');
      if (!(outlet instanceof HTMLElement)) return null;
      outlet.innerHTML = '<section class="box"></section>';
      const rect = (selector) => {
        const node = document.querySelector(selector);
        if (!(node instanceof HTMLElement)) return null;
        const bounds = node.getBoundingClientRect();
        return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height };
      };
      return {
        viewport: { width: innerWidth, height: innerHeight },
        main: rect('.main'),
        inner: rect('.main_inner'),
        panel: rect('.main_inner > .panel'),
        outlet: rect('.main_inner > [ui-view="contentView"]'),
        box: rect('.main_inner > [ui-view="contentView"] > .box'),
        styleElementPresent: document.getElementById(${JSON.stringify(WECHAT_LAYOUT_STYLE_ELEMENT_ID)}) instanceof HTMLStyleElement,
        rootScroll: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }
      };
    })()`, false) as {
      viewport: { width: number; height: number };
      main: FixtureRect;
      inner: FixtureRect;
      panel: FixtureRect;
      outlet: FixtureRect;
      box: FixtureRect;
      styleElementPresent: boolean;
      rootScroll: { width: number; height: number };
    } | null;
    if (
      geometry === null
      || !geometry.styleElementPresent
      || !near(geometry.main.left, 0)
      || !near(geometry.main.right, geometry.viewport.width)
      || !near(geometry.inner.left, 0)
      || !near(geometry.inner.right, geometry.viewport.width)
      || !near(geometry.panel.left, 0)
      || !near(geometry.panel.width, 280)
      || !near(geometry.outlet.left, geometry.panel.right)
      || !near(geometry.outlet.right, geometry.viewport.width)
      || !near(geometry.box.left, geometry.outlet.left)
      || !near(geometry.box.right, geometry.outlet.right)
      || geometry.rootScroll.width > geometry.viewport.width
      || geometry.rootScroll.height > geometry.viewport.height
    ) {
      throw new Error('The signed-in WeChat fixture did not remain full-bleed after its SPA state transition.');
    }
    console.log(JSON.stringify({
      event: 'signed-in-layout-fixture',
      ok: true,
      viewport: `${geometry.viewport.width}x${geometry.viewport.height}`,
      panelWidth: geometry.panel.width,
      contentExtent: `${geometry.outlet.left}-${geometry.outlet.right}`,
      styleElementPresent: geometry.styleElementPresent,
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

async function waitForRemoteSurface(view: WebContentsView, isProbeReady: () => boolean): Promise<RemoteProbe> {
  const deadline = Date.now() + SMOKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (
      isProbeReady()
      && !view.webContents.isDestroyed()
      && isAllowedWeChatMainFrameUrl(view.webContents.getURL())
    ) {
      const probe = await Promise.race([
        view.webContents.mainFrame.executeJavaScript(REMOTE_PROBE_SOURCE, true) as Promise<RemoteProbe>,
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
  hostWindow.setContentSize(1024, 768);
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
  view.webContents.on('dom-ready', () => {
    console.log(JSON.stringify({ event: 'dom-ready', host: safeHost(view.webContents.getURL()) }));
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

  const controller = new WeChatViewController({
    hostWindow,
    createView: () => view,
    checkpointStorage: async () => undefined,
    publishState: (state) => {
      console.log(JSON.stringify({
        event: 'controller-state',
        phase: state.phase,
        errorCode: state.errorCode ?? null,
      }));
    },
  });

  try {
    controller.mount({ x: 0, y: 0, width: 1024, height: 768 });
    const probe = await waitForRemoteSurface(view, () => {
      const state = controller.getState();
      if (state.phase === 'failed') {
        throw new Error(`WeChat controller failed with ${state.errorCode ?? 'UNKNOWN_ERROR'}.`);
      }
      return state.phase === 'ready' && qrResourceLoaded;
    });
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
    if (
      probe.rootClientWidth <= 0
      || probe.rootClientHeight <= 0
      || probe.rootScrollWidth > probe.rootClientWidth
      || probe.rootScrollHeight > probe.rootClientHeight
      || probe.bodyScrollWidth > probe.bodyClientWidth
      || probe.bodyScrollHeight > probe.bodyClientHeight
      || probe.bodyOverflowX !== 'hidden'
      || probe.bodyOverflowY !== 'hidden'
      || (probe.mainInnerMaxWidth !== null && probe.mainInnerMaxWidth !== 'none')
      || (probe.loginMinHeight !== null && probe.loginMinHeight !== '0px')
      || (probe.loginOverflowY !== null && probe.loginOverflowY !== 'hidden')
    ) {
      throw new Error('The official WeChat document did not satisfy the full-bleed layout contract.');
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
      controllerPhase: controller.getState().phase,
      webContentsLoadingAtProbe: view.webContents.isLoading(),
      requireType: probe.requireType,
      processType: probe.processType,
      rootViewport: `${probe.rootClientWidth}x${probe.rootClientHeight}`,
      rootScrollExtent: `${probe.rootScrollWidth}x${probe.rootScrollHeight}`,
      bodyScrollExtent: `${probe.bodyScrollWidth}x${probe.bodyScrollHeight}`,
      mainMaxWidth: probe.mainMaxWidth,
      mainInnerMaxWidth: probe.mainInnerMaxWidth,
      loginMinHeight: probe.loginMinHeight,
      loginOverflowY: probe.loginOverflowY,
    }));
  } finally {
    controller.dispose();
    if (!hostWindow.isDestroyed()) {
      hostWindow.destroy();
    }
  }
}

app.whenReady()
  .then(async () => {
    const keepAliveWindow = new BrowserWindow({ show: false });
    try {
      await runSignedInLayoutFixtureSmoke();
      await runSmoke();
    } finally {
      if (!keepAliveWindow.isDestroyed()) {
        keepAliveWindow.destroy();
      }
    }
  })
  .then(() => app.quit())
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Unknown WeChat smoke failure.');
    app.exit(1);
  });
