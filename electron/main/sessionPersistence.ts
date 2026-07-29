import type { App, BrowserWindow, Event, Session } from 'electron';

const DEFAULT_COOKIE_FLUSH_TIMEOUT_MS = 5_000;

export type SessionFlushReason = 'application-quit' | 'view-unmount' | 'window-close';

export interface SessionPersistenceLogger {
  error(message: string, error?: unknown): void;
  warn(message: string): void;
}

export interface SessionFlushOutcome {
  readonly reason: SessionFlushReason;
  readonly domStorageFlushed: boolean;
  readonly cookiesFlushed: boolean;
  readonly cookiesTimedOut: boolean;
}

export interface SessionPersistenceOptions {
  readonly cookieFlushTimeoutMs?: number;
  readonly logger?: SessionPersistenceLogger;
}

const defaultLogger: SessionPersistenceLogger = {
  error: (message, error) => console.error(message, error),
  warn: (message) => console.warn(message),
};

/**
 * Flushes the browser-managed state belonging to the fixed persistent WeChat
 * partition. This class never clears, migrates, or replaces that partition.
 */
export class WeChatSessionPersistence {
  readonly #session: Session;
  readonly #cookieFlushTimeoutMs: number;
  readonly #logger: SessionPersistenceLogger;

  #inFlight: Promise<SessionFlushOutcome> | null = null;

  constructor(session: Session, options: SessionPersistenceOptions = {}) {
    const timeout = options.cookieFlushTimeoutMs ?? DEFAULT_COOKIE_FLUSH_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout <= 0) {
      throw new RangeError('The WeChat cookie flush timeout must be a positive integer.');
    }

    this.#session = session;
    this.#cookieFlushTimeoutMs = timeout;
    this.#logger = options.logger ?? defaultLogger;
  }

  flush(reason: SessionFlushReason): Promise<SessionFlushOutcome> {
    if (this.#inFlight !== null) {
      return this.#inFlight;
    }

    const operation = this.#flushOnce(reason).catch((error: unknown) => {
      // This is a final containment boundary: shutdown must not become
      // impossible even if an injected dependency behaves unexpectedly.
      this.#logErrorSafely('Unexpected embedded WeChat storage checkpoint failure.', error);
      return {
        reason,
        domStorageFlushed: false,
        cookiesFlushed: false,
        cookiesTimedOut: false,
      };
    });
    this.#inFlight = operation;
    const clearInFlight = (): void => {
      if (this.#inFlight === operation) {
        this.#inFlight = null;
      }
    };
    // Both handlers are non-throwing, so the intentionally ignored derived
    // promise cannot turn an unexpected rejection into an unhandled one.
    void operation.then(clearInFlight, clearInFlight);
    return operation;
  }

  async #flushOnce(reason: SessionFlushReason): Promise<SessionFlushOutcome> {
    let domStorageFlushed = false;
    try {
      // Electron exposes this as a synchronous Chromium storage checkpoint.
      this.#session.flushStorageData();
      domStorageFlushed = true;
    } catch (error) {
      this.#logErrorSafely('Failed to flush the embedded WeChat DOM storage.', error);
    }

    let cookiesFlushed = false;
    let cookiesTimedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timeoutHandle = setTimeout(() => resolve('timeout'), this.#cookieFlushTimeoutMs);
    });

    try {
      const cookieFlush = Promise.resolve()
        .then(() => this.#session.cookies.flushStore())
        .then(() => 'flushed' as const);
      const result = await Promise.race([cookieFlush, timeout]);
      if (result === 'timeout') {
        cookiesTimedOut = true;
        this.#logWarningSafely('Timed out while flushing embedded WeChat cookies; shutdown will continue.');
      } else {
        cookiesFlushed = true;
      }
    } catch (error) {
      this.#logErrorSafely('Failed to flush the embedded WeChat cookie store.', error);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }

    return { reason, domStorageFlushed, cookiesFlushed, cookiesTimedOut };
  }

  #logErrorSafely(message: string, error: unknown): void {
    try {
      this.#logger.error(message, error);
    } catch {
      // Logging is diagnostic and must never break storage or exit semantics.
    }
  }

  #logWarningSafely(message: string): void {
    try {
      this.#logger.warn(message);
    } catch {
      // Logging is diagnostic and must never break storage or exit semantics.
    }
  }
}

interface ClosableWindow {
  close(): void;
  isDestroyed(): boolean;
}

interface QuitApplication {
  quit(): void;
}

interface PreventableEvent {
  preventDefault(): void;
}

/**
 * Converts Electron's synchronous close events into a bounded asynchronous
 * checkpoint. Re-entrant close/quit events are explicitly allowed after the
 * checkpoint so shutdown cannot loop indefinitely.
 */
export class WeChatStorageExitGate {
  readonly #app: QuitApplication;
  readonly #persistence: WeChatSessionPersistence;
  readonly #logger: SessionPersistenceLogger;

  readonly #allowedWindows = new WeakSet<ClosableWindow>();
  readonly #windowFlushes = new WeakMap<ClosableWindow, Promise<void>>();
  #allowApplicationQuit = false;
  #applicationFlush: Promise<void> | null = null;

  constructor(
    appInstance: Pick<App, 'quit'>,
    persistence: WeChatSessionPersistence,
    logger: SessionPersistenceLogger = defaultLogger,
  ) {
    this.#app = appInstance;
    this.#persistence = persistence;
    this.#logger = logger;
  }

  handleWindowClose(
    event: Pick<Event, 'preventDefault'>,
    window: Pick<BrowserWindow, 'close' | 'isDestroyed'>,
    prepareForClose: () => void,
  ): boolean {
    const closableWindow = window as ClosableWindow;
    if (this.#allowApplicationQuit || this.#allowedWindows.has(closableWindow)) {
      return true;
    }

    (event as PreventableEvent).preventDefault();
    if (this.#windowFlushes.has(closableWindow)) {
      return false;
    }

    this.#prepareSafely(prepareForClose);
    const continueClosing = (): void => {
      this.#allowedWindows.add(closableWindow);
      this.#windowFlushes.delete(closableWindow);
      if (!closableWindow.isDestroyed()) {
        try {
          closableWindow.close();
        } catch (error) {
          this.#logErrorSafely('Failed to resume the Electron window close.', error);
        }
      }
    };
    const operation = this.#persistence.flush('window-close').then(
      continueClosing,
      (error: unknown) => {
        this.#logErrorSafely('Unexpected rejection while checkpointing WeChat window storage.', error);
        continueClosing();
      },
    );
    this.#windowFlushes.set(closableWindow, operation);
    return false;
  }

  handleBeforeQuit(
    event: Pick<Event, 'preventDefault'>,
    prepareForQuit: () => void,
  ): boolean {
    if (this.#allowApplicationQuit) {
      return true;
    }

    (event as PreventableEvent).preventDefault();
    if (this.#applicationFlush !== null) {
      return false;
    }

    this.#prepareSafely(prepareForQuit);
    const continueQuitting = (): void => {
      this.#allowApplicationQuit = true;
      try {
        this.#app.quit();
      } catch (error) {
        this.#logErrorSafely('Failed to resume Electron application shutdown.', error);
      }
    };
    this.#applicationFlush = this.#persistence.flush('application-quit').then(
      continueQuitting,
      (error: unknown) => {
        this.#logErrorSafely('Unexpected rejection while checkpointing WeChat application storage.', error);
        continueQuitting();
      },
    );
    return false;
  }

  #prepareSafely(prepare: () => void): void {
    try {
      prepare();
    } catch (error) {
      this.#logErrorSafely('Failed to prepare the embedded WeChat surface for shutdown.', error);
    }
  }

  #logErrorSafely(message: string, error: unknown): void {
    try {
      this.#logger.error(message, error);
    } catch {
      // A custom logger cannot be allowed to strand a prevented close event.
    }
  }
}
