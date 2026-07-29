import type { WebContents, WebFrameMain } from 'electron';

/**
 * The official Web WeChat stylesheet constrains the signed-in application to a
 * centered, max-width canvas and makes the login root independently scrollable.
 * Those rules are appropriate in a normal browser tab, but leave unused bands
 * inside a dedicated desktop application surface.
 *
 * Keep this policy deliberately narrow: it only owns the remote document roots
 * and Web WeChat's outer application shells. Conversation panes and contact
 * lists retain their own overflow rules and therefore remain scrollable.
 */
export const WECHAT_FULL_BLEED_CSS = `
html,
body {
  box-sizing: border-box !important;
  width: 100% !important;
  height: 100% !important;
  min-width: 0 !important;
  min-height: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: hidden !important;
  overscroll-behavior: none !important;
}

.main {
  box-sizing: border-box !important;
  position: fixed !important;
  inset: 0 !important;
  width: 100% !important;
  height: 100% !important;
  min-width: 0 !important;
  min-height: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: hidden !important;
}

.main_inner {
  box-sizing: border-box !important;
  position: absolute !important;
  inset: 0 !important;
  width: 100% !important;
  max-width: none !important;
  min-width: 0 !important;
  height: 100% !important;
  margin: 0 !important;
  border-radius: 0 !important;
}

.main .copyright {
  display: none !important;
}

.login {
  box-sizing: border-box !important;
  width: 100% !important;
  height: 100% !important;
  min-width: 0 !important;
  min-height: 0 !important;
  margin: 0 !important;
  overflow: hidden !important;
  overscroll-behavior: none !important;
}
`;

export const WECHAT_LAYOUT_VERIFICATION_TIMEOUT_MS = 5_000;
export const WECHAT_LAYOUT_RETRY_INTERVAL_MS = 100;

const WECHAT_LAYOUT_ATTESTATION_SOURCE = `(() => {
  const root = document.documentElement;
  const body = document.body;
  const main = document.querySelector('.main');
  const mainInner = document.querySelector('.main_inner');
  const login = document.querySelector('.login');
  if (!(root instanceof HTMLElement) || !(body instanceof HTMLElement)) return false;
  const rootStyle = getComputedStyle(root);
  const bodyStyle = getComputedStyle(body);
  const edgesAreZero = (style) => style.top === '0px'
    && style.right === '0px'
    && style.bottom === '0px'
    && style.left === '0px';
  const coversViewport = (element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && (
      Math.abs(rect.left) <= 1
      && Math.abs(rect.top) <= 1
      && Math.abs(rect.width - innerWidth) <= 1
      && Math.abs(rect.height - innerHeight) <= 1
    );
  };
  const baseReady = rootStyle.overflowX === 'hidden'
    && rootStyle.overflowY === 'hidden'
    && bodyStyle.overflowX === 'hidden'
    && bodyStyle.overflowY === 'hidden';
  const mainReady = main instanceof HTMLElement
    && mainInner instanceof HTMLElement
    && (() => {
      const mainStyle = getComputedStyle(main);
      const mainInnerStyle = getComputedStyle(mainInner);
      return mainStyle.position === 'fixed'
        && edgesAreZero(mainStyle)
        && mainStyle.minWidth === '0px'
        && mainStyle.minHeight === '0px'
        && mainStyle.padding === '0px'
        && mainStyle.overflowX === 'hidden'
        && mainStyle.overflowY === 'hidden'
        && mainInnerStyle.position === 'absolute'
        && edgesAreZero(mainInnerStyle)
        && mainInnerStyle.maxWidth === 'none'
        && mainInnerStyle.minWidth === '0px'
        && mainInnerStyle.margin === '0px'
        && coversViewport(main)
        && coversViewport(mainInner);
    })();
  const loginReady = login instanceof HTMLElement
    && (() => {
      const loginStyle = getComputedStyle(login);
      return loginStyle.minWidth === '0px'
        && loginStyle.minHeight === '0px'
        && loginStyle.overflowX === 'hidden'
        && loginStyle.overflowY === 'hidden'
        && coversViewport(login);
    })();
  return baseReady && (mainReady || loginReady);
})()`;

export async function applyWeChatDocumentLayout(
  contents: Pick<WebContents, 'insertCSS' | 'mainFrame'> | WeChatLayoutTarget,
  options: WeChatDocumentLayoutOptions = {},
): Promise<string> {
  const timeoutMs = resolvePositiveDuration(
    options.verificationTimeoutMs,
    WECHAT_LAYOUT_VERIFICATION_TIMEOUT_MS,
  );
  const retryIntervalMs = resolvePositiveDuration(
    options.retryIntervalMs,
    WECHAT_LAYOUT_RETRY_INTERVAL_MS,
  );
  const deadline = Date.now() + timeoutMs;
  const key = await settleBeforeDeadline(
    contents.insertCSS(WECHAT_FULL_BLEED_CSS, { cssOrigin: 'user' }),
    deadline,
  );

  while (Date.now() < deadline) {
    const frame = contents.mainFrame;
    if (frame.isDestroyed()) {
      throw new Error('The embedded WeChat main frame was destroyed before layout verification.');
    }
    try {
      const verified = await settleBeforeDeadline(
        frame.executeJavaScript(WECHAT_LAYOUT_ATTESTATION_SOURCE, false),
        deadline,
      );
      if (verified === true) {
        return key;
      }
    } catch (error) {
      if (Date.now() >= deadline) {
        throw createVerificationTimeoutError(error);
      }
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await delay(Math.min(retryIntervalMs, remainingMs));
    }
  }

  throw createVerificationTimeoutError();
}

export interface WeChatLayoutTarget {
  insertCSS(css: string, options?: Electron.InsertCSSOptions): Promise<string>;
  readonly mainFrame: Pick<WebFrameMain, 'executeJavaScript' | 'isDestroyed'>;
}

export interface WeChatDocumentLayoutOptions {
  readonly verificationTimeoutMs?: number;
  readonly retryIntervalMs?: number;
}

function resolvePositiveDuration(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function settleBeforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return Promise.reject(createVerificationTimeoutError());
  }
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(
      () => reject(createVerificationTimeoutError()),
      remainingMs,
    );
    operation.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

function createVerificationTimeoutError(cause?: unknown): Error {
  return new Error(
    'The embedded WeChat document did not satisfy the full-bleed layout contract before the verification deadline.',
    cause === undefined ? undefined : { cause },
  );
}
