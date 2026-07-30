import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:net';

export const DESKTOP_SHUTDOWN_PIPE_ENV = 'AIOS_DESKTOP_SHUTDOWN_PIPE';
export const DESKTOP_SHUTDOWN_SECRET_ENV = 'AIOS_DESKTOP_SHUTDOWN_SECRET';
export const DESKTOP_SHUTDOWN_READY_HANDSHAKE = 'AIOS_DESKTOP_READY_V1\n';

const DESKTOP_SHUTDOWN_PIPE_PATTERN = /^\\\\\.\\pipe\\alsniper-desktop-shutdown-[0-9a-f]{32}$/u;
const DESKTOP_SHUTDOWN_AUTH_CONTEXT = 'AIOS_DESKTOP_SHUTDOWN_AUTH_V1';
const MAX_AUTHENTICATED_HANDSHAKE_BYTES = 128;
const CANDIDATE_HANDSHAKE_TIMEOUT_MS = 2_000;
const MAX_CANDIDATE_CONNECTIONS = 8;

export function createDesktopShutdownPipeName(random = randomBytes) {
  const suffix = random(16).toString('hex');
  if (!/^[0-9a-f]{32}$/u.test(suffix)) {
    throw new Error('The secure random source returned an invalid desktop shutdown pipe suffix.');
  }
  return `\\\\.\\pipe\\alsniper-desktop-shutdown-${suffix}`;
}

function createAuthenticatedHandshake(pipePath, secret, clientPid) {
  const mac = createHmac('sha256', secret)
    .update(`${DESKTOP_SHUTDOWN_AUTH_CONTEXT}\0${pipePath}\0${clientPid}`)
    .digest('hex');
  return Buffer.from(
    `${DESKTOP_SHUTDOWN_READY_HANDSHAKE}PID:${clientPid}\nMAC:${mac}\n`,
    'utf8',
  );
}

/**
 * Creates the one-use supervisor endpoint before Electron is spawned. Invalid,
 * partial, and excess clients are bounded and discarded without consuming the
 * endpoint; only the fixed versioned handshake establishes the lifecycle link.
 */
export async function createDesktopShutdownChannel({ random = randomBytes } = {}) {
  const pipePath = createDesktopShutdownPipeName(random);
  const secret = random(32);
  if (!DESKTOP_SHUTDOWN_PIPE_PATTERN.test(pipePath)) {
    throw new Error('The generated desktop shutdown pipe path is invalid.');
  }
  if (!Buffer.isBuffer(secret) || secret.byteLength !== 32) {
    throw new Error('The secure random source returned an invalid desktop shutdown secret.');
  }
  const secretHex = secret.toString('hex');

  const server = createServer();
  const candidateSockets = new Map();
  let acceptedSocket = null;
  let expectedClientPid = null;
  let settled = false;
  let disposed = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  // Channel shutdown can race a startup failure before the launcher's explicit
  // ready await. Keep that expected rejection observed without changing the
  // original promise's result for its eventual consumer.
  void ready.catch(() => {});

  const rejectBeforeReady = (error) => {
    if (settled) return;
    settled = true;
    rejectReady(error instanceof Error ? error : new Error('Desktop shutdown pipe failed.'));
  };

  server.on('error', rejectBeforeReady);
  server.on('connection', (socket) => {
    if (
      acceptedSocket !== null
      || disposed
      || candidateSockets.size >= MAX_CANDIDATE_CONNECTIONS
    ) {
      socket.destroy();
      return;
    }
    const chunks = [];
    let receivedBytes = 0;
    const handshakeTimeout = setTimeout(() => socket.destroy(), CANDIDATE_HANDSHAKE_TIMEOUT_MS);
    handshakeTimeout.unref();

    const removeCandidate = () => {
      clearTimeout(handshakeTimeout);
      candidateSockets.delete(socket);
    };
    const discardCandidate = () => {
      removeCandidate();
      if (!socket.destroyed) socket.destroy();
    };

    const authenticateCandidate = () => {
      if (settled || disposed) return;
      if (expectedClientPid === null) return;
      const expected = createAuthenticatedHandshake(pipePath, secret, expectedClientPid);
      if (receivedBytes > expected.byteLength) {
        socket.destroy();
        return;
      }
      if (receivedBytes !== expected.byteLength) return;
      const received = Buffer.concat(chunks);
      if (!timingSafeEqual(received, expected)) {
        socket.destroy();
        return;
      }
      settled = true;
      acceptedSocket = socket;
      removeCandidate();
      socket.removeAllListeners('data');
      for (const candidate of candidateSockets.keys()) candidate.destroy();
      candidateSockets.clear();
      server.close();
      secret.fill(0);
      resolveReady();
    };

    candidateSockets.set(socket, authenticateCandidate);
    socket.on('error', removeCandidate);
    socket.once('end', discardCandidate);
    socket.once('close', removeCandidate);
    socket.on('data', (chunk) => {
      if (settled || disposed) return;
      receivedBytes += chunk.byteLength;
      if (receivedBytes > MAX_AUTHENTICATED_HANDSHAKE_BYTES) {
        socket.destroy();
        return;
      }
      chunks.push(chunk);
      authenticateCandidate();
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => rejectListen(error);
    server.once('error', onError);
    server.listen(pipePath, () => {
      server.removeListener('error', onError);
      resolveListen();
    });
  });

  const requestShutdown = () => {
    if (disposed) return;
    disposed = true;
    rejectBeforeReady(new Error('Desktop shutdown was requested before readiness.'));
    if (server.listening) server.close();
    for (const candidate of candidateSockets.keys()) candidate.destroy();
    candidateSockets.clear();
    if (acceptedSocket !== null && !acceptedSocket.destroyed) acceptedSocket.end();
    secret.fill(0);
  };

  const expectClientPid = (clientPid) => {
    if (
      expectedClientPid !== null
      || !Number.isSafeInteger(clientPid)
      || clientPid < 1
      || clientPid > 0xffff_ffff
    ) {
      throw new Error('Invalid or duplicate desktop shutdown client process identifier.');
    }
    expectedClientPid = clientPid;
    for (const authenticateCandidate of candidateSockets.values()) authenticateCandidate();
  };

  const dispose = () => {
    requestShutdown();
    if (acceptedSocket !== null && !acceptedSocket.destroyed) acceptedSocket.destroy();
  };

  return Object.freeze({
    pipePath,
    secret: secretHex,
    ready,
    expectClientPid,
    requestShutdown,
    dispose,
  });
}
