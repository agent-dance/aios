import { createHmac } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';

export const DESKTOP_SHUTDOWN_PIPE_ENV = 'AIOS_DESKTOP_SHUTDOWN_PIPE' as const;
export const DESKTOP_SHUTDOWN_SECRET_ENV = 'AIOS_DESKTOP_SHUTDOWN_SECRET' as const;
export const DESKTOP_SHUTDOWN_READY_HANDSHAKE = 'AIOS_DESKTOP_READY_V1\n' as const;

const DESKTOP_SHUTDOWN_PIPE_PATTERN = /^\\\\\.\\pipe\\alsniper-desktop-shutdown-[0-9a-f]{32}$/u;
const DESKTOP_SHUTDOWN_SECRET_PATTERN = /^[0-9a-f]{64}$/u;
const DESKTOP_SHUTDOWN_AUTH_CONTEXT = 'AIOS_DESKTOP_SHUTDOWN_AUTH_V1';

export interface DesktopShutdownBootstrap {
  readonly pipePath: string;
  readonly secret: string;
}

interface ShutdownPipeSocket {
  readonly destroyed: boolean;
  once(event: 'connect' | 'end' | 'close' | 'error', listener: () => void): unknown;
  removeListener(event: 'connect' | 'end' | 'close' | 'error', listener: () => void): unknown;
  write(data: string, encoding: BufferEncoding): boolean;
  resume(): unknown;
  destroy(): unknown;
}

type ConnectShutdownPipe = (pipePath: string) => ShutdownPipeSocket;

export function consumeDesktopShutdownPipe(
  environment: Record<string, string | undefined>,
): DesktopShutdownBootstrap | undefined {
  const pipePath = environment[DESKTOP_SHUTDOWN_PIPE_ENV];
  const secret = environment[DESKTOP_SHUTDOWN_SECRET_ENV];
  try {
    if (pipePath === undefined && secret === undefined) return undefined;
    if (
      pipePath === undefined
      || secret === undefined
      || !DESKTOP_SHUTDOWN_PIPE_PATTERN.test(pipePath)
      || !DESKTOP_SHUTDOWN_SECRET_PATTERN.test(secret)
    ) {
      throw new Error('Invalid desktop shutdown pipe configuration.');
    }
    return Object.freeze({ pipePath, secret });
  } finally {
    delete environment[DESKTOP_SHUTDOWN_PIPE_ENV];
    delete environment[DESKTOP_SHUTDOWN_SECRET_ENV];
  }
}

function createReadyProof(pipePath: string, secret: string, clientPid: number): string {
  if (!Number.isSafeInteger(clientPid) || clientPid < 1 || clientPid > 0xffff_ffff) {
    throw new Error('Invalid desktop shutdown client process identifier.');
  }
  const secretBytes = Buffer.from(secret, 'hex');
  try {
    return createHmac('sha256', secretBytes)
      .update(`${DESKTOP_SHUTDOWN_AUTH_CONTEXT}\0${pipePath}\0${clientPid}`)
      .digest('hex');
  } finally {
    secretBytes.fill(0);
  }
}

/**
 * Connects the packaged desktop to its per-launch supervisor endpoint. The
 * supervisor keeps its accepted socket open for the desktop lifetime and
 * closes it to request Electron's ordinary, storage-gated quit lifecycle.
 */
export function bindDesktopShutdownPipe(
  bootstrap: DesktopShutdownBootstrap,
  shutdown: () => void,
  connect: ConnectShutdownPipe = (path) => createConnection(path) as Socket,
  clientPid: number = process.pid,
): () => void {
  if (
    !DESKTOP_SHUTDOWN_PIPE_PATTERN.test(bootstrap.pipePath)
    || !DESKTOP_SHUTDOWN_SECRET_PATTERN.test(bootstrap.secret)
  ) {
    throw new Error('Invalid desktop shutdown pipe bootstrap.');
  }

  const socket = connect(bootstrap.pipePath);
  let disposed = false;
  let shutdownRequested = false;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    socket.removeListener('connect', announceReady);
    socket.removeListener('end', requestShutdown);
    socket.removeListener('close', requestShutdown);
    socket.removeListener('error', requestShutdown);
    if (!socket.destroyed) socket.destroy();
  };
  const requestShutdown = (): void => {
    if (disposed || shutdownRequested) return;
    shutdownRequested = true;
    dispose();
    shutdown();
  };
  const announceReady = (): void => {
    if (disposed) return;
    try {
      socket.write(DESKTOP_SHUTDOWN_READY_HANDSHAKE, 'utf8');
      socket.write(
        `PID:${clientPid}\nMAC:${createReadyProof(bootstrap.pipePath, bootstrap.secret, clientPid)}\n`,
        'utf8',
      );
    } catch {
      requestShutdown();
    }
  };

  socket.once('connect', announceReady);
  socket.once('end', requestShutdown);
  socket.once('close', requestShutdown);
  socket.once('error', requestShutdown);
  socket.resume();
  return dispose;
}
