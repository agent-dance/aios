import { app, BrowserWindow, protocol, session, type Session } from 'electron';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, resolve, sep } from 'node:path';
import {
  ApplicationSessionPersistence,
  BrowserSessionPersistence,
  WeChatSessionPersistence,
} from './main/sessionPersistence.js';
import { WECHAT_SESSION_PARTITION } from './shared/navigationPolicy.js';

const SMOKE_SCHEME = 'alsniper-persistence-smoke';
const SMOKE_URL = `${SMOKE_SCHEME}://state/index.html`;
const COOKIE_URL = 'https://alsniper-persistence-smoke.invalid/';
const COOKIE_NAME = 'alsniper_persistence_marker';

protocol.registerSchemesAsPrivileged([{
  scheme: SMOKE_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
  },
}]);

function readArgument(name: string): string {
  const prefix = `--${name}=`;
  const matches = process.argv.filter((argument) => argument.startsWith(prefix));
  if (matches.length !== 1) {
    throw new Error(`Persistence smoke requires exactly one ${prefix} argument.`);
  }
  const value = matches[0]?.slice(prefix.length) ?? '';
  if (value.length === 0) {
    throw new Error(`Persistence smoke argument ${name} cannot be empty.`);
  }
  return value;
}

const phaseArgument = readArgument('phase');
if (phaseArgument !== 'write' && phaseArgument !== 'read') {
  throw new Error('Persistence smoke phase must be write or read.');
}
const phase: 'read' | 'write' = phaseArgument;
const marker = readArgument('marker');
const profileArgument = readArgument('profile');
if (!isAbsolute(profileArgument)) {
  throw new Error('Persistence smoke profile must be an absolute path.');
}
const profilePath = resolve(profileArgument);
const resolvedTemporaryRoot = resolve(tmpdir());
if (
  !profilePath.startsWith(`${resolvedTemporaryRoot}${sep}`)
  || !basename(profilePath).startsWith('alsniper-persistence-smoke-')
) {
  throw new Error('Persistence smoke profile must be an owned temporary directory.');
}
app.setPath('userData', profilePath);
app.setPath('sessionData', profilePath);

function registerSmokeProtocol(targetSession: Session): void {
  targetSession.protocol.handle(SMOKE_SCHEME, () => new Response(
    '<!doctype html><meta charset="utf-8"><title>Persistence smoke</title>',
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  ));
}

function createHiddenWindow(targetSession: Session): BrowserWindow {
  return new BrowserWindow({
    show: false,
    webPreferences: {
      session: targetSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
}

function storageScript(operation: 'read' | 'write', expectedMarker: string): string {
  return `(async function () {
    const operation = ${JSON.stringify(operation)};
    const marker = ${JSON.stringify(expectedMarker)};
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('alsniper-persistence-smoke', 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('markers')) {
          request.result.createObjectStore('markers');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (operation === 'write') {
      localStorage.setItem('marker', marker);
      await new Promise((resolve, reject) => {
        const transaction = database.transaction('markers', 'readwrite');
        transaction.objectStore('markers').put(marker, 'marker');
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => reject(transaction.error);
      });
      const cache = await caches.open('alsniper-persistence-smoke');
      await cache.put(new Request('https://alsniper-persistence-smoke.invalid/cache-marker'), new Response(marker));
      database.close();
      return { localStorage: marker, indexedDb: marker, cacheStorage: marker };
    }
    const localStorageMarker = localStorage.getItem('marker');
    const indexedDbMarker = await new Promise((resolve, reject) => {
      const transaction = database.transaction('markers', 'readonly');
      const request = transaction.objectStore('markers').get('marker');
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
    const cache = await caches.open('alsniper-persistence-smoke');
    const cachedResponse = await cache.match(new Request('https://alsniper-persistence-smoke.invalid/cache-marker'));
    const cacheStorageMarker = cachedResponse === undefined ? null : await cachedResponse.text();
    database.close();
    return {
      localStorage: localStorageMarker,
      indexedDb: indexedDbMarker,
      cacheStorage: cacheStorageMarker,
    };
  })()`;
}

async function operateStorage(window: BrowserWindow, operation: 'read' | 'write'): Promise<void> {
  const result = await window.webContents.executeJavaScript(storageScript(operation, marker), true) as {
    localStorage: unknown;
    indexedDb: unknown;
    cacheStorage: unknown;
  };
  if (
    result.localStorage !== marker
    || result.indexedDb !== marker
    || result.cacheStorage !== marker
  ) {
    throw new Error(`Persistence smoke ${operation} mismatch: ${JSON.stringify(result)}`);
  }
}

async function operateCookie(targetSession: Session, operation: 'read' | 'write'): Promise<void> {
  if (operation === 'write') {
    await targetSession.cookies.set({
      url: COOKIE_URL,
      name: COOKIE_NAME,
      value: marker,
      expirationDate: Math.floor(Date.now() / 1_000) + 86_400,
      secure: true,
      sameSite: 'no_restriction',
    });
    return;
  }
  const cookies = await targetSession.cookies.get({ url: COOKIE_URL, name: COOKIE_NAME });
  if (cookies.length !== 1 || cookies[0]?.value !== marker) {
    throw new Error('Persistence smoke cookie marker was not restored.');
  }
}

async function main(): Promise<void> {
  await app.whenReady();
  const shellSession = session.defaultSession;
  const wechatSession = session.fromPartition(WECHAT_SESSION_PARTITION, { cache: true });
  registerSmokeProtocol(shellSession);
  registerSmokeProtocol(wechatSession);

  const shellWindow = createHiddenWindow(shellSession);
  const wechatWindow = createHiddenWindow(wechatSession);
  const applicationPersistence = new ApplicationSessionPersistence([
    {
      name: 'AlSniper OS shell smoke',
      checkpoint: new BrowserSessionPersistence(shellSession, { storageLabel: 'shell smoke' }),
    },
    {
      name: 'embedded WeChat smoke',
      checkpoint: new WeChatSessionPersistence(wechatSession),
    },
  ]);

  await Promise.all([shellWindow.loadURL(SMOKE_URL), wechatWindow.loadURL(SMOKE_URL)]);
  await Promise.all([
    operateStorage(shellWindow, phase),
    operateStorage(wechatWindow, phase),
    operateCookie(shellSession, phase),
    operateCookie(wechatSession, phase),
  ]);
  const liveCheckpoint = await applicationPersistence.flush(
    phase === 'write' ? 'window-close' : 'application-quit',
  );
  if (!liveCheckpoint.successful) {
    throw new Error(`Persistence smoke live checkpoint failed: ${JSON.stringify(liveCheckpoint)}`);
  }

  shellWindow.close();
  wechatWindow.close();
  const finalCheckpoint = await applicationPersistence.flush('application-quit');
  if (!finalCheckpoint.successful) {
    throw new Error(`Persistence smoke final checkpoint failed: ${JSON.stringify(finalCheckpoint)}`);
  }
  console.log(JSON.stringify({ event: 'PERSISTENCE_SMOKE_OK', phase, marker }));
  app.quit();
}

void main().catch((error: unknown) => {
  console.error('PERSISTENCE_SMOKE_FAILED', error);
  app.exit(1);
});
