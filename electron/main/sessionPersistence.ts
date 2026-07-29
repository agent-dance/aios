import type { App, BrowserWindow, Event, Session } from 'electron';

const DEFAULT_COOKIE_FLUSH_TIMEOUT_MS = 5_000;

export type SessionFlushReason =
  | 'application-quit'
  | 'periodic'
  | 'renderer-crash'
  | 'system-session-end'
  | 'view-unmount'
  | 'window-close';

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
  readonly storageLabel?: string;
}

const defaultLogger: SessionPersistenceLogger = {
  error: (message, error) => console.error(message, error),
  warn: (message) => console.warn(message),
};

export interface SessionStorageCheckpoint {
  flush(reason: SessionFlushReason): Promise<unknown>;
  flushDomStorageNow?(): boolean;
}

export interface NamedSessionFlushOutcome {
  readonly name: string;
  readonly outcome: unknown;
  readonly successful: boolean;
}

export interface ApplicationFlushOutcome {
  readonly reason: SessionFlushReason;
  readonly sessions: readonly NamedSessionFlushOutcome[];
  readonly successful: boolean;
}

function sessionFlushSucceeded(outcome: SessionFlushOutcome): boolean {
  return outcome.domStorageFlushed && outcome.cookiesFlushed && !outcome.cookiesTimedOut;
}

function checkpointSucceeded(outcome: unknown): boolean {
  if (outcome === null || typeof outcome !== 'object') return outcome !== null;
  if ('successful' in outcome && typeof outcome.successful === 'boolean') {
    return outcome.successful;
  }
  if (
    'domStorageFlushed' in outcome
    && 'cookiesFlushed' in outcome
    && typeof outcome.domStorageFlushed === 'boolean'
    && typeof outcome.cookiesFlushed === 'boolean'
  ) {
    return outcome.domStorageFlushed && outcome.cookiesFlushed;
  }
  return true;
}

/** Flushes browser-managed state without ever clearing or replacing it. */
export class BrowserSessionPersistence implements SessionStorageCheckpoint {
  readonly #session: Session;
  readonly #cookieFlushTimeoutMs: number;
  readonly #logger: SessionPersistenceLogger;
  readonly #storageLabel: string;

  #queueTail: Promise<void> | null = null;
  #backgroundFlush: Promise<SessionFlushOutcome> | null = null;

  constructor(session: Session, options: SessionPersistenceOptions = {}) {
    const timeout = options.cookieFlushTimeoutMs ?? DEFAULT_COOKIE_FLUSH_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout <= 0) {
      throw new RangeError('The browser session cookie flush timeout must be a positive integer.');
    }

    this.#session = session;
    this.#cookieFlushTimeoutMs = timeout;
    this.#logger = options.logger ?? defaultLogger;
    this.#storageLabel = options.storageLabel?.trim() || 'browser session';
  }

  flush(reason: SessionFlushReason): Promise<SessionFlushOutcome> {
    if (reason === 'periodic' && this.#backgroundFlush !== null) {
      return this.#backgroundFlush;
    }

    const start = (): Promise<SessionFlushOutcome> => this.#flushWithRetry(reason).catch((error: unknown) => {
      this.#logErrorSafely(`Unexpected ${this.#storageLabel} storage checkpoint failure.`, error);
      return {
        reason,
        domStorageFlushed: false,
        cookiesFlushed: false,
        cookiesTimedOut: false,
      };
    });
    const operation = this.#queueTail === null ? start() : this.#queueTail.then(start, start);
    const queueEntry = operation.then(() => undefined, () => undefined);
    this.#queueTail = queueEntry;
    void queueEntry.then(() => {
      if (this.#queueTail === queueEntry) {
        this.#queueTail = null;
      }
    });
    if (reason === 'periodic') {
      this.#backgroundFlush = operation;
      void operation.then(() => {
        if (this.#backgroundFlush === operation) {
          this.#backgroundFlush = null;
        }
      }, () => {
        if (this.#backgroundFlush === operation) {
          this.#backgroundFlush = null;
        }
      });
    }
    return operation;
  }

  flushDomStorageNow(): boolean {
    try {
      this.#session.flushStorageData();
      return true;
    } catch (error) {
      this.#logErrorSafely(`Failed to synchronously flush the ${this.#storageLabel} DOM storage.`, error);
      return false;
    }
  }

  async #flushWithRetry(reason: SessionFlushReason): Promise<SessionFlushOutcome> {
    const firstAttempt = await this.#flushOnce(reason);
    if (reason === 'periodic' || sessionFlushSucceeded(firstAttempt)) {
      return firstAttempt;
    }
    this.#logWarningSafely(`Retrying the ${this.#storageLabel} ${reason} storage checkpoint once.`);
    return this.#flushOnce(reason);
  }

  async #flushOnce(reason: SessionFlushReason): Promise<SessionFlushOutcome> {
    let domStorageFlushed = false;
    try {
      // Electron exposes this as a synchronous Chromium storage checkpoint.
      this.#session.flushStorageData();
      domStorageFlushed = true;
    } catch (error) {
      this.#logErrorSafely(`Failed to flush the ${this.#storageLabel} DOM storage.`, error);
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
        this.#logWarningSafely(`Timed out while flushing ${this.#storageLabel} cookies; shutdown will continue.`);
      } else {
        cookiesFlushed = true;
      }
    } catch (error) {
      this.#logErrorSafely(`Failed to flush the ${this.#storageLabel} cookie store.`, error);
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

/** Fixed-label facade for the persistent embedded WeChat partition. */
export class WeChatSessionPersistence extends BrowserSessionPersistence {
  constructor(session: Session, options: SessionPersistenceOptions = {}) {
    super(session, { ...options, storageLabel: 'embedded WeChat' });
  }
}

export interface NamedSessionStorageCheckpoint {
  readonly name: string;
  readonly checkpoint: SessionStorageCheckpoint;
}

/**
 * Coordinates the system shell and embedded-app checkpoints as one
 * never-rejecting application storage barrier.
 */
export class ApplicationSessionPersistence implements SessionStorageCheckpoint {
  readonly #checkpoints: readonly NamedSessionStorageCheckpoint[];
  readonly #logger: SessionPersistenceLogger;

  constructor(
    checkpoints: readonly NamedSessionStorageCheckpoint[],
    logger: SessionPersistenceLogger = defaultLogger,
  ) {
    if (checkpoints.length === 0) {
      throw new RangeError('Application session persistence requires at least one checkpoint.');
    }
    const names = new Set<string>();
    this.#checkpoints = checkpoints.map(({ name, checkpoint }) => {
      const normalizedName = name.trim();
      if (normalizedName.length === 0 || names.has(normalizedName)) {
        throw new TypeError('Application session persistence checkpoint names must be unique and non-empty.');
      }
      names.add(normalizedName);
      return { name: normalizedName, checkpoint };
    });
    this.#logger = logger;
  }

  async flush(reason: SessionFlushReason): Promise<ApplicationFlushOutcome> {
    const sessions = await Promise.all(this.#checkpoints.map(async ({ name, checkpoint }) => {
      try {
        const outcome = await checkpoint.flush(reason);
        return { name, outcome, successful: checkpointSucceeded(outcome) };
      } catch (error) {
        this.#logErrorSafely(`Unexpected rejection while checkpointing ${name} storage.`, error);
        return { name, outcome: null, successful: false };
      }
    }));
    return {
      reason,
      sessions,
      successful: sessions.every((sessionOutcome) => sessionOutcome.successful),
    };
  }

  flushDomStorageNow(): boolean {
    let successful = true;
    for (const { checkpoint } of this.#checkpoints) {
      if (checkpoint.flushDomStorageNow?.() === false) {
        successful = false;
      }
    }
    return successful;
  }

  #logErrorSafely(message: string, error: unknown): void {
    try {
      this.#logger.error(message, error);
    } catch {
      // Logging is diagnostic and cannot be allowed to break the exit barrier.
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
export class ApplicationStorageExitGate {
  readonly #app: QuitApplication;
  readonly #persistence: SessionStorageCheckpoint;
  readonly #logger: SessionPersistenceLogger;

  readonly #allowedWindows = new WeakSet<ClosableWindow>();
  readonly #windowFlushes = new WeakMap<ClosableWindow, Promise<void>>();
  #allowApplicationQuit = false;
  #applicationFlush: Promise<void> | null = null;

  constructor(
    appInstance: Pick<App, 'quit'>,
    persistence: SessionStorageCheckpoint,
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
    if (this.#allowApplicationQuit) {
      return true;
    }
    if (this.#allowedWindows.delete(closableWindow)) {
      return true;
    }

    (event as PreventableEvent).preventDefault();
    if (this.#windowFlushes.has(closableWindow)) {
      return false;
    }

    const continueClosing = (): void => {
      this.#allowedWindows.add(closableWindow);
      this.#windowFlushes.delete(closableWindow);
      if (!closableWindow.isDestroyed()) {
        try {
          closableWindow.close();
        } catch (error) {
          this.#allowedWindows.delete(closableWindow);
          this.#logErrorSafely('Failed to resume the Electron window close.', error);
        }
      }
    };
    const operation = this.#checkpointForExit('window-close', prepareForClose).then(
      continueClosing,
      (error: unknown) => {
        this.#logErrorSafely('Unexpected rejection while checkpointing application window storage.', error);
        this.#windowFlushes.delete(closableWindow);
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

    const continueQuitting = (): void => {
      this.#allowApplicationQuit = true;
      try {
        this.#app.quit();
        queueMicrotask(() => {
          // app.quit() synchronously emits its re-entrant before-quit/window
          // close events. If a beforeunload handler cancels that attempt, the
          // next user request must pass through a new storage barrier.
          this.#allowApplicationQuit = false;
          this.#applicationFlush = null;
        });
      } catch (error) {
        this.#allowApplicationQuit = false;
        this.#applicationFlush = null;
        this.#logErrorSafely('Failed to resume Electron application shutdown.', error);
      }
    };
    this.#applicationFlush = this.#checkpointForExit('application-quit', prepareForQuit).then(
      continueQuitting,
      (error: unknown) => {
        this.#logErrorSafely('Unexpected rejection while checkpointing application storage.', error);
        this.#applicationFlush = null;
      },
    );
    return false;
  }

  async #checkpointForExit(reason: 'application-quit' | 'window-close', prepare: () => void): Promise<void> {
    const liveOutcome = await this.#persistence.flush(reason);
    if (!checkpointSucceeded(liveOutcome)) {
      throw new Error(`The live ${reason} storage checkpoint did not complete successfully.`);
    }
    this.#prepareSafely(prepare);
    const finalOutcome = await this.#persistence.flush(reason);
    if (!checkpointSucceeded(finalOutcome)) {
      // The successful live fence is still a safe close boundary. The final
      // post-disposal fence is retried by BrowserSessionPersistence and kept
      // diagnostic so a destroyed embedded surface does not strand the shell.
      this.#logErrorSafely(
        `The final ${reason} storage checkpoint failed after a successful live fence.`,
        finalOutcome,
      );
    }
  }

  #prepareSafely(prepare: () => void): void {
    try {
      prepare();
    } catch (error) {
      this.#logErrorSafely('Failed to prepare application surfaces for shutdown.', error);
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
