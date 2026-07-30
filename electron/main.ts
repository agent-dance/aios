import {
  app,
  BrowserWindow,
  net,
  protocol,
  session,
  WebContentsView,
  type Session,
} from 'electron';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerWeChatIpc } from './main/ipcRouter.js';
import { hardenWeChatSession } from './main/sessionPolicy.js';
import {
  ApplicationSessionPersistence,
  ApplicationStorageExitGate,
  BrowserSessionPersistence,
  WeChatSessionPersistence,
} from './main/sessionPersistence.js';
import { WeChatViewController } from './main/WeChatViewController.js';
import { registerApplicationControlIpc } from './main/application-control/ipcRouter.js';
import { createNativeApplicationApproval } from './main/application-control/nativeApproval.js';
import { shouldRejectWeChatClientCertificateRequest } from './main/application-control/clientCertificatePolicy.js';
import { WeChatMessageAdapter } from './main/application-control/wechat/WeChatMessageAdapter.js';
import type { ApplicationControlService } from './main/application-control/applicationControlService.js';
import { createApplicationControlService } from './main/application-control/createApplicationControlService.js';
import {
  isAllowedShellNavigation,
  parseLoopbackDevServerUrl,
  WECHAT_SESSION_PARTITION,
} from './shared/navigationPolicy.js';
import {
  cloneWeChatState,
  WECHAT_IPC_CHANNELS,
  type WeChatState,
} from './shared/wechatProtocol.js';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const PERIODIC_STORAGE_CHECKPOINT_MS = 30_000;
const shellSessionPolicies = new WeakSet<Session>();

let mainWindow: BrowserWindow | null = null;
let weChatController: WeChatViewController | null = null;
let unregisterWeChatIpc: (() => void) | null = null;
let unregisterApplicationControlIpc: (() => void) | null = null;
let applicationControlHost: ApplicationControlService | null = null;
let weChatSessionPersistence: WeChatSessionPersistence | null = null;
let applicationSessionPersistence: ApplicationSessionPersistence | null = null;
let applicationStorageExitGate: ApplicationStorageExitGate | null = null;
let periodicStorageCheckpoint: ReturnType<typeof setInterval> | null = null;

app.enableSandbox();
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
  },
}]);

async function registerShellProtocol(): Promise<void> {
  const distributionRoot = resolve(app.getAppPath(), 'dist');
  await protocol.handle('app', async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    let requestUrl: URL;
    let decodedPath: string;
    try {
      requestUrl = new URL(request.url);
      decodedPath = decodeURIComponent(requestUrl.pathname);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    if (
      requestUrl.protocol !== 'app:'
      || requestUrl.hostname !== 'alsniper'
      || requestUrl.username !== ''
      || requestUrl.password !== ''
      || requestUrl.port !== ''
      || decodedPath.includes('\0')
    ) {
      return new Response('Forbidden', { status: 403 });
    }

    const normalizedPath = decodedPath === '/' ? '/index.html' : decodedPath;
    const targetPath = resolve(distributionRoot, `.${normalizedPath}`);
    const targetRelativePath = relative(distributionRoot, targetPath);
    if (targetRelativePath.startsWith('..') || isAbsolute(targetRelativePath)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      return await net.fetch(pathToFileURL(targetPath).href, { method: request.method });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}

function getDevServerUrl(): URL | null {
  const argumentsWithPrefix = process.argv.filter((argument) => argument.startsWith('--dev-url='));
  if (argumentsWithPrefix.length === 0) {
    return null;
  }
  if (argumentsWithPrefix.length !== 1) {
    throw new Error('Only one --dev-url argument is allowed.');
  }

  const parsed = parseLoopbackDevServerUrl(argumentsWithPrefix[0]?.slice('--dev-url='.length));
  if (parsed === null) {
    throw new Error('The desktop development URL must be an exact loopback HTTP origin.');
  }
  return parsed;
}

function hardenShellSession(shellSession: Session): void {
  if (shellSessionPolicies.has(shellSession)) {
    return;
  }
  shellSessionPolicies.add(shellSession);

  shellSession.setPermissionCheckHandler(() => false);
  shellSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  shellSession.setDevicePermissionHandler(() => false);
  shellSession.on('will-download', (event) => event.preventDefault());
}

function publishWeChatState(shellWindow: BrowserWindow, state: WeChatState): void {
  if (!shellWindow.isDestroyed() && !shellWindow.webContents.isDestroyed()) {
    shellWindow.webContents.send(WECHAT_IPC_CHANNELS.stateChanged, cloneWeChatState(state));
  }
}

function createWeChatView(wechatSession: Session): WebContentsView {
  return new WebContentsView({
    webPreferences: {
      session: wechatSession,
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
      spellcheck: true,
    },
  });
}

function secureShellWebContents(shellWindow: BrowserWindow, shellUrl: URL): void {
  shellWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  shellWindow.webContents.on('will-navigate', (event) => {
    if (!isAllowedShellNavigation(event.url, shellUrl)) {
      event.preventDefault();
    }
  });
  shellWindow.webContents.on('will-redirect', (event) => {
    if (!isAllowedShellNavigation(event.url, shellUrl)) {
      event.preventDefault();
    }
  });
  shellWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

async function createMainWindow(): Promise<BrowserWindow> {
  const devServerUrl = getDevServerUrl();
  const shellUrl = devServerUrl ?? new URL('app://alsniper/index.html');
  const preloadPath = join(moduleDirectory, 'preload.cjs');

  const shellWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0a0d14',
    title: 'AlSniper OS',
    webPreferences: {
      preload: preloadPath,
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
      spellcheck: true,
    },
  });
  // Bind the trusted native window before renderer IPC can become reachable.
  mainWindow = shellWindow;

  hardenShellSession(shellWindow.webContents.session);
  secureShellWebContents(shellWindow, shellUrl);

  const wechatSession = session.fromPartition(WECHAT_SESSION_PARTITION, { cache: true });
  hardenWeChatSession(wechatSession);
  let sessionPersistence = weChatSessionPersistence;
  if (sessionPersistence === null) {
    sessionPersistence = new WeChatSessionPersistence(wechatSession);
    weChatSessionPersistence = sessionPersistence;
    const shellSessionPersistence = new BrowserSessionPersistence(shellWindow.webContents.session, {
      storageLabel: 'AlSniper OS shell',
    });
    applicationSessionPersistence = new ApplicationSessionPersistence([
      { name: 'AlSniper OS shell', checkpoint: shellSessionPersistence },
      { name: 'embedded WeChat', checkpoint: sessionPersistence },
    ]);
    applicationStorageExitGate = new ApplicationStorageExitGate(app, applicationSessionPersistence);
    periodicStorageCheckpoint = setInterval(() => {
      if (applicationSessionPersistence !== null) {
        void applicationSessionPersistence.flush('periodic');
      }
    }, PERIODIC_STORAGE_CHECKPOINT_MS);
    periodicStorageCheckpoint.unref();
  }

  const controller = new WeChatViewController({
    hostWindow: shellWindow,
    createView: () => createWeChatView(wechatSession),
    checkpointStorage: async () => {
      await sessionPersistence.flush('view-unmount');
    },
    publishState: (state) => publishWeChatState(shellWindow, state),
  });
  weChatController = controller;
  unregisterWeChatIpc = registerWeChatIpc(shellWindow, controller);

  let controlHost = applicationControlHost;
  if (controlHost === null) {
    controlHost = await createApplicationControlService({
      journalPath: join(
        app.getPath('userData'),
        'trust',
        'application-control-v1.jsonl',
      ),
      approval: createNativeApplicationApproval(() => mainWindow),
      adapters: [new WeChatMessageAdapter(() => weChatController?.getAutomationTarget() ?? null)],
      logger: { error: (message) => console.error(message) },
    });
    applicationControlHost = controlHost;
  }
  unregisterApplicationControlIpc = registerApplicationControlIpc(shellWindow, shellUrl, controlHost);

  shellWindow.on('resize', () => controller.handleHostResize());
  shellWindow.on('blur', () => controller.handleHostVisibilityLoss());
  shellWindow.on('hide', () => controller.handleHostVisibilityLoss());
  shellWindow.on('minimize', () => controller.handleHostVisibilityLoss());
  shellWindow.on('focus', () => controller.reconcileHostVisibility());
  shellWindow.on('show', () => controller.reconcileHostVisibility());
  shellWindow.on('restore', () => controller.reconcileHostVisibility());
  shellWindow.on('query-session-end', () => {
    // Windows does not emit before-quit during shutdown/logoff. Calling flush
    // starts the synchronous DOMStorage checkpoint before this handler returns;
    // the periodic fence limits cookie exposure without blocking OS shutdown.
    if (applicationSessionPersistence !== null) {
      applicationSessionPersistence.flushDomStorageNow();
      void applicationSessionPersistence.flush('system-session-end');
    }
  });
  shellWindow.on('session-end', () => {
    if (applicationSessionPersistence !== null) {
      applicationSessionPersistence.flushDomStorageNow();
      void applicationSessionPersistence.flush('system-session-end');
    }
  });
  shellWindow.webContents.on('render-process-gone', () => {
    if (applicationSessionPersistence !== null) {
      void applicationSessionPersistence.flush('renderer-crash');
    }
  });
  shellWindow.once('ready-to-show', () => {
    if (!shellWindow.isDestroyed()) {
      shellWindow.show();
    }
  });
  shellWindow.on('close', (event) => {
    if (
      applicationStorageExitGate !== null
      && !applicationStorageExitGate.handleWindowClose(event, shellWindow, () => controller.dispose())
    ) {
      return;
    }
    controller.dispose();
  });
  shellWindow.once('closed', () => {
    unregisterApplicationControlIpc?.();
    unregisterApplicationControlIpc = null;
    unregisterWeChatIpc?.();
    unregisterWeChatIpc = null;
    weChatController = null;
    mainWindow = null;
  });

  if (devServerUrl !== null) {
    await shellWindow.loadURL(devServerUrl.href);
  } else {
    await shellWindow.loadURL(shellUrl.href);
  }

  return shellWindow;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on('certificate-error', (event, _webContents, _url, _error, _certificate, callback) => {
    event.preventDefault();
    if (weChatController?.ownsWebContents(_webContents) === true) {
      weChatController.handleCertificateError(_webContents);
    }
    callback(false);
  });

  app.on('select-client-certificate', (event, webContents, url, _certificateList, callback) => {
    if (shouldRejectWeChatClientCertificateRequest(
      weChatController?.ownsWebContents(webContents) === true,
    )) {
      event.preventDefault();
      callback();
    }
  });

  app.whenReady()
    .then(async () => {
      await registerShellProtocol();
      mainWindow = await createMainWindow();

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          void createMainWindow()
            .then((window) => {
              mainWindow = window;
            })
            .catch((error: unknown) => {
              console.error('Failed to recreate the AlSniper OS desktop window.', error);
              app.quit();
            });
        }
      });
    })
    .catch((error: unknown) => {
      console.error('Failed to start the AlSniper OS desktop host.', error);
      app.quit();
    });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', (event) => {
    const prepareForQuit = (): void => {
      if (periodicStorageCheckpoint !== null) {
        clearInterval(periodicStorageCheckpoint);
        periodicStorageCheckpoint = null;
      }
      unregisterWeChatIpc?.();
      unregisterWeChatIpc = null;
      unregisterApplicationControlIpc?.();
      unregisterApplicationControlIpc = null;
      weChatController?.dispose();
      weChatController = null;
      if (applicationControlHost !== null) {
        void applicationControlHost.close();
        applicationControlHost = null;
      }
    };
    if (
      applicationStorageExitGate !== null
      && !applicationStorageExitGate.handleBeforeQuit(event, prepareForQuit)
    ) {
      return;
    }
    prepareForQuit();
  });
}
