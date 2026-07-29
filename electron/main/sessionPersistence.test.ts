import type { App, BrowserWindow, Event, Session } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApplicationSessionPersistence,
  ApplicationStorageExitGate,
  BrowserSessionPersistence,
  WeChatSessionPersistence,
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

  it('coalesces concurrent background checkpoints onto one Chromium flush', async () => {
    const cookieFlush = deferred<void>();
    const { fakeSession, persistence } = createHarness(() => cookieFlush.promise);

    const first = persistence.flush('periodic');
    const second = persistence.flush('periodic');

    expect(first).toBe(second);
    expect(fakeSession.flushStorageData).toHaveBeenCalledOnce();
    cookieFlush.resolve();
    await first;
    expect(fakeSession.cookies.flushStore).toHaveBeenCalledOnce();
  });

  it('queues a fresh final fence behind an in-flight background checkpoint', async () => {
    const cookieFlush = deferred<void>();
    const { fakeSession, persistence } = createHarness(() => cookieFlush.promise);
    const background = persistence.flush('periodic');
    const finalFence = persistence.flush('application-quit');

    expect(finalFence).not.toBe(background);
    expect(fakeSession.flushStorageData).toHaveBeenCalledOnce();
    cookieFlush.resolve();
    await background;
    await finalFence;
    expect(fakeSession.flushStorageData).toHaveBeenCalledTimes(2);
    expect(fakeSession.cookies.flushStore).toHaveBeenCalledTimes(2);
  });

  it('gives every later final request its own fence even after a queued final starts', async () => {
    const firstCookie = deferred<void>();
    const secondCookie = deferred<void>();
    let cookieCalls = 0;
    const { fakeSession, persistence } = createHarness(() => {
      cookieCalls += 1;
      if (cookieCalls === 1) return firstCookie.promise;
      if (cookieCalls === 2) return secondCookie.promise;
      return Promise.resolve();
    });

    const background = persistence.flush('periodic');
    const firstFinal = persistence.flush('view-unmount');
    firstCookie.resolve();
    await vi.waitFor(() => expect(fakeSession.flushStorageData).toHaveBeenCalledTimes(2));

    const laterFinal = persistence.flush('application-quit');
    expect(laterFinal).not.toBe(firstFinal);
    secondCookie.resolve();
    await Promise.all([background, firstFinal, laterFinal]);
    expect(fakeSession.flushStorageData).toHaveBeenCalledTimes(3);
    expect(fakeSession.cookies.flushStore).toHaveBeenCalledTimes(3);
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
    expect(logger.error).toHaveBeenCalledTimes(4);
  });

  it('bounds an unresponsive cookie store so shutdown cannot hang indefinitely', async () => {
    vi.useFakeTimers();
    const neverSettles = deferred<void>();
    const { logger, persistence } = createHarness(() => neverSettles.promise);

    const operation = persistence.flush('application-quit');
    await vi.advanceTimersByTimeAsync(200);

    await expect(operation).resolves.toEqual({
      reason: 'application-quit',
      domStorageFlushed: true,
      cookiesFlushed: false,
      cookiesTimedOut: true,
    });
    expect(logger.warn).toHaveBeenCalledTimes(3);
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

describe('ApplicationSessionPersistence', () => {
  it('checkpoints the shell and embedded application sessions together', async () => {
    const shellHarness = createHarness();
    const wechatHarness = createHarness();
    const application = new ApplicationSessionPersistence([
      { name: 'shell', checkpoint: shellHarness.persistence },
      { name: 'wechat', checkpoint: wechatHarness.persistence },
    ]);

    await expect(application.flush('window-close')).resolves.toMatchObject({
      reason: 'window-close',
      successful: true,
      sessions: [{ name: 'shell', successful: true }, { name: 'wechat', successful: true }],
    });
    expect(shellHarness.fakeSession.flushStorageData).toHaveBeenCalledOnce();
    expect(wechatHarness.fakeSession.flushStorageData).toHaveBeenCalledOnce();
  });

  it('delegates a final application fence even while a background request is pending', async () => {
    const pending = deferred<void>();
    const checkpoint = { flush: vi.fn(() => pending.promise) };
    const application = new ApplicationSessionPersistence([{ name: 'shell', checkpoint }]);

    const first = application.flush('window-close');
    const second = application.flush('application-quit');
    expect(first).not.toBe(second);
    expect(checkpoint.flush).toHaveBeenCalledTimes(2);

    pending.resolve();
    await Promise.all([first, second]);
  });

  it('contains one failed session while preserving the remaining checkpoint', async () => {
    const logger: SessionPersistenceLogger = { error: vi.fn(), warn: vi.fn() };
    const shell = { flush: vi.fn(async () => 'shell-ok') };
    const wechat = { flush: vi.fn(async () => { throw new Error('failure'); }) };
    const application = new ApplicationSessionPersistence([
      { name: 'shell', checkpoint: shell },
      { name: 'wechat', checkpoint: wechat },
    ], logger);

    await expect(application.flush('application-quit')).resolves.toEqual({
      reason: 'application-quit',
      sessions: [
        { name: 'shell', outcome: 'shell-ok', successful: true },
        { name: 'wechat', outcome: null, successful: false },
      ],
      successful: false,
    });
    expect(logger.error).toHaveBeenCalledWith(
      'Unexpected rejection while checkpointing wechat storage.',
      expect.any(Error),
    );
  });

  it('performs an immediate DOMStorage fence during a pending cookie checkpoint', async () => {
    const cookieFlush = deferred<void>();
    const harness = createHarness(() => cookieFlush.promise);
    const application = new ApplicationSessionPersistence([
      { name: 'shell', checkpoint: harness.persistence },
    ]);

    const periodic = application.flush('periodic');
    expect(harness.fakeSession.flushStorageData).toHaveBeenCalledOnce();
    expect(application.flushDomStorageNow()).toBe(true);
    expect(harness.fakeSession.flushStorageData).toHaveBeenCalledTimes(2);
    cookieFlush.resolve();
    await periodic;
  });

  it('attempts every synchronous DOMStorage fence even when an earlier session fails', () => {
    const first = { flush: vi.fn(async () => undefined), flushDomStorageNow: vi.fn(() => false) };
    const second = { flush: vi.fn(async () => undefined), flushDomStorageNow: vi.fn(() => true) };
    const application = new ApplicationSessionPersistence([
      { name: 'shell', checkpoint: first },
      { name: 'wechat', checkpoint: second },
    ]);

    expect(application.flushDomStorageNow()).toBe(false);
    expect(first.flushDomStorageNow).toHaveBeenCalledOnce();
    expect(second.flushDomStorageNow).toHaveBeenCalledOnce();
  });

  it('rejects missing or duplicate checkpoint identities', () => {
    const checkpoint = new BrowserSessionPersistence(createHarness().fakeSession);
    expect(() => new ApplicationSessionPersistence([])).toThrow(RangeError);
    expect(() => new ApplicationSessionPersistence([
      { name: 'shell', checkpoint },
      { name: ' shell ', checkpoint },
    ])).toThrow(TypeError);
  });
});

describe('ApplicationStorageExitGate', () => {
  it('fails closed and re-arms when the live checkpoint reports an unsuccessful outcome', async () => {
    const checkpoint = { flush: vi.fn(async () => ({ successful: false })) };
    const app = { quit: vi.fn() } as unknown as Pick<App, 'quit'>;
    const logger: SessionPersistenceLogger = { error: vi.fn(), warn: vi.fn() };
    const gate = new ApplicationStorageExitGate(app, checkpoint, logger);
    const window = {
      close: vi.fn(),
      isDestroyed: vi.fn(() => false),
    } as unknown as Pick<BrowserWindow, 'close' | 'isDestroyed'>;
    const prepare = vi.fn();

    expect(gate.handleWindowClose(createEvent(), window, prepare)).toBe(false);
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledOnce());
    expect(checkpoint.flush).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
    expect(window.close).not.toHaveBeenCalled();
    expect(gate.handleWindowClose(createEvent(), window, prepare)).toBe(false);
    await vi.waitFor(() => expect(checkpoint.flush).toHaveBeenCalledTimes(2));
  });

  it('prevents window closure until the persistent session is checkpointed', async () => {
    const cookieFlush = deferred<void>();
    const { persistence } = createHarness(() => cookieFlush.promise);
    const app = { quit: vi.fn() } as unknown as Pick<App, 'quit'>;
    const gate = new ApplicationStorageExitGate(app, persistence);
    const window = {
      close: vi.fn(),
      isDestroyed: vi.fn(() => false),
    } as unknown as Pick<BrowserWindow, 'close' | 'isDestroyed'>;
    const prepare = vi.fn();
    const event = createEvent();

    expect(gate.handleWindowClose(event, window, prepare)).toBe(false);
    expect(gate.handleWindowClose(event, window, prepare)).toBe(false);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(prepare).not.toHaveBeenCalled();
    expect(window.close).not.toHaveBeenCalled();

    cookieFlush.resolve();
    await vi.waitFor(() => expect(window.close).toHaveBeenCalledOnce());
    expect(prepare).toHaveBeenCalledOnce();

    const retryEvent = createEvent();
    expect(gate.handleWindowClose(retryEvent, window, prepare)).toBe(true);
    expect(retryEvent.preventDefault).not.toHaveBeenCalled();
  });

  it('prevents application quit once, then permits the re-entrant quit and window close', async () => {
    const cookieFlush = deferred<void>();
    const { persistence } = createHarness(() => cookieFlush.promise);
    const prepare = vi.fn();
    const reentrantQuitEvent = createEvent();
    const reentrantWindowEvent = createEvent();
    const window = {
      close: vi.fn(),
      isDestroyed: vi.fn(() => false),
    } as unknown as Pick<BrowserWindow, 'close' | 'isDestroyed'>;
    let gate!: ApplicationStorageExitGate;
    let reentrantQuitAllowed = false;
    let reentrantWindowAllowed = false;
    const app = {
      quit: vi.fn(() => {
        reentrantQuitAllowed = gate.handleBeforeQuit(reentrantQuitEvent, prepare);
        reentrantWindowAllowed = gate.handleWindowClose(reentrantWindowEvent, window, prepare);
      }),
    } as unknown as Pick<App, 'quit'>;
    gate = new ApplicationStorageExitGate(app, persistence);
    const event = createEvent();

    expect(gate.handleBeforeQuit(event, prepare)).toBe(false);
    expect(gate.handleBeforeQuit(event, prepare)).toBe(false);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(prepare).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();

    cookieFlush.resolve();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
    expect(prepare).toHaveBeenCalledOnce();
    expect(reentrantQuitAllowed).toBe(true);
    expect(reentrantWindowAllowed).toBe(true);
    expect(reentrantQuitEvent.preventDefault).not.toHaveBeenCalled();
    expect(reentrantWindowEvent.preventDefault).not.toHaveBeenCalled();

    await Promise.resolve();
    const canceledQuitRetry = createEvent();
    expect(gate.handleBeforeQuit(canceledQuitRetry, prepare)).toBe(false);
    expect(canceledQuitRetry.preventDefault).toHaveBeenCalledOnce();
  });

  it('continues shutdown even if its synchronous preparation callback fails', async () => {
    const { logger, persistence } = createHarness();
    const app = { quit: vi.fn() } as unknown as Pick<App, 'quit'>;
    const gate = new ApplicationStorageExitGate(app, persistence, logger);

    expect(gate.handleBeforeQuit(createEvent(), () => {
      throw new Error('dispose failure');
    })).toBe(false);

    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to prepare application surfaces for shutdown.',
      expect.any(Error),
    );
  });

  it('keeps the window open after a rejected live checkpoint and re-arms the barrier', async () => {
    const { persistence } = createHarness();
    vi.spyOn(persistence, 'flush').mockRejectedValueOnce(new Error('unexpected rejection'));
    const app = { quit: vi.fn() } as unknown as Pick<App, 'quit'>;
    const logger: SessionPersistenceLogger = { error: vi.fn(), warn: vi.fn() };
    const gate = new ApplicationStorageExitGate(app, persistence, logger);
    const window = {
      close: vi.fn(),
      isDestroyed: vi.fn(() => false),
    } as unknown as Pick<BrowserWindow, 'close' | 'isDestroyed'>;

    expect(gate.handleWindowClose(createEvent(), window, vi.fn())).toBe(false);
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledWith(
      'Unexpected rejection while checkpointing application window storage.',
      expect.any(Error),
    ));
    expect(window.close).not.toHaveBeenCalled();
    expect(gate.handleWindowClose(createEvent(), window, vi.fn())).toBe(false);
    await vi.waitFor(() => expect(window.close).toHaveBeenCalledOnce());
    expect(logger.error).toHaveBeenCalledWith(
      'Unexpected rejection while checkpointing application window storage.',
      expect.any(Error),
    );
  });

  it('keeps the app open after a rejected live checkpoint and re-arms the quit barrier', async () => {
    const { persistence } = createHarness();
    vi.spyOn(persistence, 'flush').mockRejectedValueOnce(new Error('unexpected rejection'));
    const app = { quit: vi.fn() } as unknown as Pick<App, 'quit'>;
    const logger: SessionPersistenceLogger = { error: vi.fn(), warn: vi.fn() };
    const gate = new ApplicationStorageExitGate(app, persistence, logger);

    expect(gate.handleBeforeQuit(createEvent(), vi.fn())).toBe(false);
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledWith(
      'Unexpected rejection while checkpointing application storage.',
      expect.any(Error),
    ));
    expect(app.quit).not.toHaveBeenCalled();
    expect(gate.handleBeforeQuit(createEvent(), vi.fn())).toBe(false);
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
    expect(logger.error).toHaveBeenCalledWith(
      'Unexpected rejection while checkpointing application storage.',
      expect.any(Error),
    );
  });

  it('re-arms the quit barrier when the resumed application quit throws', async () => {
    const { persistence } = createHarness();
    const app = {
      quit: vi.fn(() => {
        throw new Error('quit failed');
      }),
    } as unknown as Pick<App, 'quit'>;
    const logger: SessionPersistenceLogger = { error: vi.fn(), warn: vi.fn() };
    const gate = new ApplicationStorageExitGate(app, persistence, logger);

    expect(gate.handleBeforeQuit(createEvent(), vi.fn())).toBe(false);
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
    expect(gate.handleBeforeQuit(createEvent(), vi.fn())).toBe(false);
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(2));
  });
});
