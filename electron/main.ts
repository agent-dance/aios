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
import { WeChatViewController } from './main/WeChatViewController.js';
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
const shellSessionPolicies = new WeakSet<Session>();

let mainWindow: BrowserWindow | null = null;
let weChatController: WeChatViewController | null = null;
let unregisterWeChatIpc: (() => void) | null = null;

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

  hardenShellSession(shellWindow.webContents.session);
  secureShellWebContents(shellWindow, shellUrl);

  const wechatSession = session.fromPartition(WECHAT_SESSION_PARTITION, { cache: true });
  hardenWeChatSession(wechatSession);

  const controller = new WeChatViewController({
    hostWindow: shellWindow,
    createView: () => createWeChatView(wechatSession),
    publishState: (state) => publishWeChatState(shellWindow, state),
  });
  weChatController = controller;
  unregisterWeChatIpc = registerWeChatIpc(shellWindow, controller);

  shellWindow.on('resize', () => controller.handleHostResize());
  shellWindow.on('blur', () => controller.handleHostVisibilityLoss());
  shellWindow.on('hide', () => controller.handleHostVisibilityLoss());
  shellWindow.on('minimize', () => controller.handleHostVisibilityLoss());
  shellWindow.on('focus', () => controller.reconcileHostVisibility());
  shellWindow.on('show', () => controller.reconcileHostVisibility());
  shellWindow.on('restore', () => controller.reconcileHostVisibility());
  shellWindow.once('ready-to-show', () => {
    if (!shellWindow.isDestroyed()) {
      shellWindow.show();
    }
  });
  shellWindow.once('close', () => {
    controller.dispose();
  });
  shellWindow.once('closed', () => {
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

  app.on('before-quit', () => {
    unregisterWeChatIpc?.();
    unregisterWeChatIpc = null;
    weChatController?.dispose();
    weChatController = null;
  });
}
