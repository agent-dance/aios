import type { App, BrowserWindow, Event, Session } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WeChatSessionPersistence,
  WeChatStorageExitGate,
  type SessionPersistenceLogger,
} from './sessionPersistence.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness(cookieFlush: () => Promise<void> = async () => undefined) {
  const fakeSession = {
    flushStorageData: vi.fn(),
    cookies: { flushStore: vi.fn(cookieFlush) },
  } as unknown as Session;
  const logger: SessionPersistenceLogger = {
    error: vi.fn(),
    warn: vi.fn(),
  };
  const persistence = new WeChatSessionPersistence(fakeSession, {
    cookieFlushTimeoutMs: 100,
    logger,
  });
  return { fakeSession, logger, persistence };
}

function createEvent(): Pick<Event, 'preventDefault'> {
  return { preventDefault: vi.fn() };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('WeChatSessionPersistence', () => {
  it('checkpoints DOM storage and cookies', async () => {
    const { fakeSession, persistence } = createHarness();

    await expect(persistence.flush('window-close')).resolves.toEqual({
      reason: 'window-close',
      domStorageFlushed: true,
      cookiesFlushed: true,
      cookiesTimedOut: false,
    });
    expect(fakeSession.flushStorageData).toHaveBeenCalledOnce();
    expect(fakeSession.cookies.flushStore).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent shutdown checkpoints onto one Chromium flush', async () => {
    const cookieFlush = deferred<void>();
    const { fakeSession, persistence } = createHarness(() => cookieFlush.promise);

    const first = persistence.flush('window-close');
    const second = persistence.flush('application-quit');

    expect(first).toBe(second);
    expect(fakeSession.flushStorageData).toHaveBeenCalledOnce();
    cookieFlush.resolve();
    await first;
    expect(fakeSession.cookies.flushStore).toHaveBeenCalledOnce();
  });

  it('reports storage and cookie failures but always settles the shutdown checkpoint', async () => {
    const { fakeSession, logger, persistence } = createHarness(async () => {
      throw new Error('cookie failure');
    });
    vi.mocked(fakeSession.flushStorageData).mockImplementation(() => {
      throw new Error('storage failure');
    });

    await expect(persistence.flush('application-quit')).resolves.toEqual({
      reason: 'application-quit',
      domStorageFlushed: false,
      cookiesFlushed: false,
      cookiesTimedOut: false,
    });
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it('bounds an unresponsive cookie store so shutdown cannot hang indefinitely', async () => {
    vi.useFakeTimers();
    const neverSettles = deferred<void>();
    const { logger, persistence } = createHarness(() => neverSettles.promise);

    const operation = persistence.flush('application-quit');
    await vi.advanceTimersByTimeAsync(100);

    await expect(operation).resolves.toEqual({
      reason: 'application-quit',
      domStorageFlushed: true,
      cookiesFlushed: false,
      cookiesTimedOut: true,
    });
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('rejects invalid timeout configuration', () => {
    const { fakeSession } = createHarness();
    expect(() => new WeChatSessionPersistence(fakeSession, { cookieFlushTimeoutMs: 0 }))
      .toThrow(RangeError);
  });

  it('remains never-reject even when storage, cookies, and the injected logger throw', async () => {
    const fakeSession = {
      flushStorageData: vi.fn(() => {
        throw new Error('storage failure');
      }),
      cookies: {
        flushStore: vi.fn(async () => {
          throw new Error('cookie failure');
        }),
      },
    } as unknown as Session;
    const throwingLogger: SessionPersistenceLogger = {
      error: vi.fn(() => {
        throw new Error('logger failure');
      }),
      warn: vi.fn(() => {
        throw new Error('logger failure');
      }),
    };
    const persistence = new WeChatSessionPersistence(fakeSession, {
      cookieFlushTimeoutMs: 100,
      logger: throwingLogger,
    });

    await expect(persistence.flush('application-quit')).resolves.toEqual({
      reason: 'application-quit',
      domStorageFlushed: false,
      cookiesFlushed: false,
      cookiesTimedOut: false,
    });
  });
});

describe('WeChatStorageExitGate', () => {
  it('prevents window closure until the persistent session is checkpointed', async () => {
    const cookieFlush = deferred<void>();
    const { persistence } = createHarness(() => cookieFlush.promise);
    const app = { quit: vi.fn() } as unknown as Pick<App, 'quit'>;
    const gate = new WeChatStorageExitGate(app, persistence);
    const window = {
      close: vi.fn(),
      isDestroyed: vi.fn(() => false),
    } as unknown as Pick<BrowserWindow, 'close' | 'isDestroyed'>;
    const prepare = vi.fn();
    const event = createEvent();

    expect(gate.handleWindowClose(event, window, prepare)).toBe(false);
    expect(gate.handleWindowClose(event, window, prepare)).toBe(false);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledOnce();
    expect(window.close).not.toHaveBeenCalled();

    cookieFlush.resolve();
    await vi.waitFor(() => expect(window.close).toHaveBeenCalledOnce());

    const retryEvent = createEvent();
    expect(gate.handleWindowClose(retryEvent, window, prepare)).toBe(true);
    expect(retryEvent.preventDefault).not.toHaveBeenCalled();
  });

  it('prevents application quit once, then permits the re-entrant quit and window close', async () => {
    const cookieFlush = deferred<void>();
    const { persistence } = createHarness(() => cookieFlush.promise);
    const app = { quit: vi.fn() } as unknown as Pick<App, 'quit'>;
    const gate = new WeChatStorageExitGate(app, persistence);
    const prepare = vi.fn();
    const event = createEvent();

    expect(gate.handleBeforeQuit(event, prepare)).toBe(false);
    expect(gate.handleBeforeQuit(event, prepare)).toBe(false);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();

    cookieFlush.resolve();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());

    const retryEvent = createEvent();
    expect(gate.handleBeforeQuit(retryEvent, prepare)).toBe(true);
    expect(retryEvent.preventDefault).not.toHaveBeenCalled();

    const windowEvent = createEvent();
    const window = {
      close: vi.fn(),
      isDestroyed: vi.fn(() => false),
    } as unknown as Pick<BrowserWindow, 'close' | 'isDestroyed'>;
    expect(gate.handleWindowClose(windowEvent, window, prepare)).toBe(true);
    expect(windowEvent.preventDefault).not.toHaveBeenCalled();
  });

  it('continues shutdown even if its synchronous preparation callback fails', async () => {
    const { logger, persistence } = createHarness();
    const app = { quit: vi.fn() } as unknown as Pick<App, 'quit'>;
    const gate = new WeChatStorageExitGate(app, persistence, logger);

    expect(gate.handleBeforeQuit(createEvent(), () => {
      throw new Error('dispose failure');
    })).toBe(false);

    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to prepare the embedded WeChat surface for shutdown.',
      expect.any(Error),
    );
  });

  it('resumes a prevented close even if an unexpected checkpoint rejection escapes', async () => {
    const { persistence } = createHarness();
    vi.spyOn(persistence, 'flush').mockRejectedValueOnce(new Error('unexpected rejection'));
    const app = { quit: vi.fn() } as unknown as Pick<App, 'quit'>;
    const logger: SessionPersistenceLogger = { error: vi.fn(), warn: vi.fn() };
    const gate = new WeChatStorageExitGate(app, persistence, logger);
    const window = {
      close: vi.fn(),
      isDestroyed: vi.fn(() => false),
    } as unknown as Pick<BrowserWindow, 'close' | 'isDestroyed'>;

    expect(gate.handleWindowClose(createEvent(), window, vi.fn())).toBe(false);
    await vi.waitFor(() => expect(window.close).toHaveBeenCalledOnce());
    expect(logger.error).toHaveBeenCalledWith(
      'Unexpected rejection while checkpointing WeChat window storage.',
      expect.any(Error),
    );
  });

  it('resumes a prevented application quit even if an unexpected checkpoint rejection escapes', async () => {
    const { persistence } = createHarness();
    vi.spyOn(persistence, 'flush').mockRejectedValueOnce(new Error('unexpected rejection'));
    const app = { quit: vi.fn() } as unknown as Pick<App, 'quit'>;
    const logger: SessionPersistenceLogger = { error: vi.fn(), warn: vi.fn() };
    const gate = new WeChatStorageExitGate(app, persistence, logger);

    expect(gate.handleBeforeQuit(createEvent(), vi.fn())).toBe(false);
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
    expect(logger.error).toHaveBeenCalledWith(
      'Unexpected rejection while checkpointing WeChat application storage.',
      expect.any(Error),
    );
  });
});
