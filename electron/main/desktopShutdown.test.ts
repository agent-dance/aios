import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  bindDesktopShutdownPipe,
  consumeDesktopShutdownPipe,
  DESKTOP_SHUTDOWN_PIPE_ENV,
  DESKTOP_SHUTDOWN_READY_HANDSHAKE,
  DESKTOP_SHUTDOWN_SECRET_ENV,
} from './desktopShutdown.js';

const VALID_PIPE = String.raw`\\.\pipe\alsniper-desktop-shutdown-0123456789abcdef0123456789abcdef`;
const VALID_SECRET = '01'.repeat(32);
const VALID_BOOTSTRAP = Object.freeze({ pipePath: VALID_PIPE, secret: VALID_SECRET });

class FakeSocket extends EventEmitter {
  destroyed = false;
  readonly write = vi.fn(() => true);
  readonly resume = vi.fn();
  readonly destroy = vi.fn(() => { this.destroyed = true; });
}

describe('trusted desktop shutdown pipe', () => {
  it('consumes only an exact random local pipe path and always deletes it', () => {
    const enabled = {
      [DESKTOP_SHUTDOWN_PIPE_ENV]: VALID_PIPE,
      [DESKTOP_SHUTDOWN_SECRET_ENV]: VALID_SECRET,
      unrelated: 'preserved',
    };
    expect(consumeDesktopShutdownPipe(enabled)).toEqual(VALID_BOOTSTRAP);
    expect(enabled).toEqual({ unrelated: 'preserved' });

    const absent = { unrelated: 'preserved' };
    expect(consumeDesktopShutdownPipe(absent)).toBeUndefined();
    expect(absent).toEqual({ unrelated: 'preserved' });

    for (const invalid of [
      '',
      String.raw`\\.\pipe\alsniper-desktop-shutdown-0123`,
      String.raw`\\.\pipe\alsniper-desktop-shutdown-0123456789ABCDEF0123456789ABCDEF`,
      String.raw`\\server\pipe\alsniper-desktop-shutdown-0123456789abcdef0123456789abcdef`,
      String.raw`\\.\pipe\other-0123456789abcdef0123456789abcdef`,
      `${VALID_PIPE}suffix`,
    ]) {
      const environment: Record<string, string | undefined> = {
        [DESKTOP_SHUTDOWN_PIPE_ENV]: invalid,
        [DESKTOP_SHUTDOWN_SECRET_ENV]: VALID_SECRET,
      };
      expect(() => consumeDesktopShutdownPipe(environment)).toThrow('Invalid desktop shutdown pipe');
      expect(environment).toEqual({});
    }

    for (const incompleteOrInvalid of [
      { [DESKTOP_SHUTDOWN_PIPE_ENV]: VALID_PIPE },
      { [DESKTOP_SHUTDOWN_SECRET_ENV]: VALID_SECRET },
      { [DESKTOP_SHUTDOWN_PIPE_ENV]: VALID_PIPE, [DESKTOP_SHUTDOWN_SECRET_ENV]: 'A'.repeat(64) },
    ]) {
      expect(() => consumeDesktopShutdownPipe(incompleteOrInvalid)).toThrow('Invalid desktop shutdown pipe');
      expect(incompleteOrInvalid).toEqual({});
    }
  });

  it('sends the fixed readiness handshake only after connecting', () => {
    const socket = new FakeSocket();
    const shutdown = vi.fn();
    bindDesktopShutdownPipe(VALID_BOOTSTRAP, shutdown, () => socket, 1234);
    expect(socket.resume).toHaveBeenCalledOnce();
    expect(socket.write).not.toHaveBeenCalled();
    socket.emit('connect');
    expect(socket.write).toHaveBeenNthCalledWith(1, DESKTOP_SHUTDOWN_READY_HANDSHAKE, 'utf8');
    expect(socket.write).toHaveBeenNthCalledWith(
      2,
      'PID:1234\nMAC:8df5c76865047d49734d8ad8790a1a272964af77220f1767b1839845d8154176\n',
      'utf8',
    );
    expect(shutdown).not.toHaveBeenCalled();
  });

  it.each(['end', 'close', 'error'] as const)('requests graceful shutdown once on pipe %s', (event) => {
    const socket = new FakeSocket();
    const shutdown = vi.fn();
    bindDesktopShutdownPipe(VALID_BOOTSTRAP, shutdown, () => socket);
    socket.emit(event);
    socket.emit('close');
    expect(shutdown).toHaveBeenCalledOnce();
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(socket.eventNames()).toEqual([]);
  });

  it('supports explicit disposal without requesting shutdown', () => {
    const socket = new FakeSocket();
    const shutdown = vi.fn();
    const dispose = bindDesktopShutdownPipe(VALID_BOOTSTRAP, shutdown, () => socket);
    dispose();
    dispose();
    socket.emit('close');
    expect(shutdown).not.toHaveBeenCalled();
    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  it('fails closed when the readiness write throws', () => {
    const socket = new FakeSocket();
    socket.write.mockImplementation(() => { throw new Error('broken pipe'); });
    const shutdown = vi.fn();
    bindDesktopShutdownPipe(VALID_BOOTSTRAP, shutdown, () => socket);
    socket.emit('connect');
    expect(shutdown).toHaveBeenCalledOnce();
  });
});
