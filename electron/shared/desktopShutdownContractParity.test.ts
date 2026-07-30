import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DESKTOP_SHUTDOWN_PIPE_ENV,
  DESKTOP_SHUTDOWN_READY_HANDSHAKE,
  DESKTOP_SHUTDOWN_SECRET_ENV,
} from '../main/desktopShutdown.js';

describe('desktop supervisor protocol parity', () => {
  const launcherProtocolSource = readFileSync(
    fileURLToPath(new URL('../../tools/local-runtime/desktop-shutdown-channel.mjs', import.meta.url)),
    'utf8',
  );

  it('keeps the Electron and launcher environment contract aligned', () => {
    const pipeMatch = /export const DESKTOP_SHUTDOWN_PIPE_ENV = '([^']+)'/u.exec(launcherProtocolSource);
    const secretMatch = /export const DESKTOP_SHUTDOWN_SECRET_ENV = '([^']+)'/u.exec(
      launcherProtocolSource,
    );
    expect(pipeMatch?.[1]).toBe(DESKTOP_SHUTDOWN_PIPE_ENV);
    expect(secretMatch?.[1]).toBe(DESKTOP_SHUTDOWN_SECRET_ENV);
  });

  it('keeps the fixed versioned readiness handshake aligned', () => {
    const match = /export const DESKTOP_SHUTDOWN_READY_HANDSHAKE = '([^']+)';/u.exec(
      launcherProtocolSource,
    );
    expect(match?.[1]?.replace('\\n', '\n')).toBe(DESKTOP_SHUTDOWN_READY_HANDSHAKE);
  });
});
