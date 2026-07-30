import { app, BrowserWindow, protocol } from 'electron';
import { createServer } from 'node:http';

const EXPECTED_ORIGIN = 'app://alsniper';
const REQUIRED_REQUEST_HEADERS = ['x-aios-nonce', 'x-aios-protocol-version'] as const;

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-gpu');

const observedRequests: Array<Readonly<{
  method: string;
  origin: string | null;
  requestedHeaders: string | null;
}>> = [];

const server = createServer((request, response) => {
  observedRequests.push(Object.freeze({
    method: request.method ?? '',
    origin: request.headers.origin ?? null,
    requestedHeaders: request.headers['access-control-request-headers'] ?? null,
  }));
  response.setHeader('Access-Control-Allow-Origin', EXPECTED_ORIGIN);
  if (request.method === 'OPTIONS') {
    response.statusCode = 204;
    response.setHeader('Access-Control-Allow-Methods', 'GET');
    response.setHeader('Access-Control-Allow-Headers', REQUIRED_REQUEST_HEADERS.join(', '));
    response.end();
    return;
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ requestOrigin: request.headers.origin ?? null }));
});

async function listen(): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Unable to resolve smoke server address.');
  return address.port;
}

async function run(): Promise<void> {
  const port = await listen();
  await app.whenReady();
  await protocol.handle('app', () => new Response(`<!doctype html>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src http://127.0.0.1:*; script-src 'none'">
    <title>Agent Runtime origin smoke</title>` , {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  }));
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  await window.loadURL('app://alsniper/index.html');
  const observation = await window.webContents.executeJavaScript(`(async () => ({
    locationOrigin: window.location.origin,
    response: await (await fetch('http://127.0.0.1:${port}/health', {
      method: 'GET',
      headers: {
        'X-AIOS-Nonce': '00112233445566778899aabbccddeeff',
        'X-AIOS-Protocol-Version': '1.0.0',
      },
    })).json(),
  }))()`, true) as { readonly locationOrigin: unknown; readonly response: { readonly requestOrigin: unknown } };
  const preflight = observedRequests.find((request) => request.method === 'OPTIONS');
  const actualRequest = observedRequests.find((request) => request.method === 'GET');
  const preflightHeaders = new Set(
    preflight?.requestedHeaders?.split(',').map((header) => header.trim().toLowerCase()) ?? [],
  );
  if (
    observation.locationOrigin !== EXPECTED_ORIGIN
    || observation.response.requestOrigin !== EXPECTED_ORIGIN
    || preflight?.origin !== EXPECTED_ORIGIN
    || actualRequest?.origin !== EXPECTED_ORIGIN
    || REQUIRED_REQUEST_HEADERS.some((header) => !preflightHeaders.has(header))
  ) {
    throw new Error(`Unexpected registered-scheme CORS observation: ${JSON.stringify({
      observation,
      observedRequests,
    })}`);
  }
  console.log('Agent Runtime origin smoke passed: app://alsniper is preserved through preflight and fetch.');
  window.destroy();
}

void run()
  .catch((error: unknown) => {
    console.error('Agent Runtime origin smoke failed.', error);
    process.exitCode = 1;
  })
  .finally(() => {
    server.close();
    app.quit();
  });
