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
  overflow: hidden !important;
}

.main_inner > .panel {
  box-sizing: border-box !important;
  position: absolute !important;
  inset: 0 auto 0 0 !important;
  float: none !important;
  width: 280px !important;
  height: 100% !important;
  margin: 0 !important;
}

.main_inner > [ui-view="contentView"] {
  box-sizing: border-box !important;
  position: absolute !important;
  inset: 0 0 0 280px !important;
  width: auto !important;
  min-width: 0 !important;
  height: auto !important;
  margin: 0 !important;
  overflow: hidden !important;
}

.main_inner > [ui-view="contentView"] > .box {
  box-sizing: border-box !important;
  width: 100% !important;
  max-width: none !important;
  min-width: 0 !important;
  height: 100% !important;
  margin: 0 !important;
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
export const WECHAT_LAYOUT_STYLE_ELEMENT_ID = 'alsniper-wechat-full-bleed-layout';

const WECHAT_LAYOUT_ATTESTATION_SOURCE = `(() => {
  const root = document.documentElement;
  const body = document.body;
  if (!(root instanceof HTMLElement) || !(body instanceof HTMLElement)) return false;
  const styleId = ${JSON.stringify(WECHAT_LAYOUT_STYLE_ELEMENT_ID)};
  let styleElement = document.getElementById(styleId);
  if (styleElement !== null && !(styleElement instanceof HTMLStyleElement)) {
    styleElement.remove();
    styleElement = null;
  }
  if (styleElement === null) {
    styleElement = document.createElement('style');
    styleElement.id = styleId;
    (document.head ?? root).append(styleElement);
  }
  if (styleElement.textContent !== ${JSON.stringify(WECHAT_FULL_BLEED_CSS)}) {
    styleElement.textContent = ${JSON.stringify(WECHAT_FULL_BLEED_CSS)};
  }
  const main = document.querySelector('.main');
  const mainInner = document.querySelector('.main_inner');
  const login = document.querySelector('.login');
  const rootStyle = getComputedStyle(root);
  const bodyStyle = getComputedStyle(body);
  const within = (left, right, tolerance = 1) => Math.abs(left - right) <= tolerance;
  const edgesAreZero = (style) => style.top === '0px'
    && style.right === '0px'
    && style.bottom === '0px'
    && style.left === '0px';
  const isRendered = (element) => {
    const style = getComputedStyle(element);
    const opacity = Number.parseFloat(style.opacity);
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.visibility !== 'collapse'
      && style.contentVisibility !== 'hidden'
      && (!Number.isFinite(opacity) || opacity > 0)
      && element.getClientRects().length > 0;
  };
  const coversViewport = (element) => {
    const rect = element.getBoundingClientRect();
    return isRendered(element)
      && rect.width > 0
      && rect.height > 0
      && within(rect.left, 0)
      && within(rect.top, 0)
      && within(rect.right, innerWidth)
      && within(rect.bottom, innerHeight);
  };
  const sameRect = (left, right) => within(left.left, right.left)
    && within(left.top, right.top)
    && within(left.right, right.right)
    && within(left.bottom, right.bottom);
  const signedInShellReady = (mainElement, innerElement) => {
    const panel = innerElement.querySelector(':scope > .panel');
    const outlet = innerElement.querySelector(':scope > [ui-view="contentView"]');
    const box = outlet?.querySelector(':scope > .box');
    if (!(panel instanceof HTMLElement)
      || !(outlet instanceof HTMLElement)
      || !(box instanceof HTMLElement)
      || !isRendered(panel)
      || !isRendered(outlet)
      || !isRendered(box)) return false;
    const panelRect = panel.getBoundingClientRect();
    const outletRect = outlet.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    return within(panelRect.left, 0)
      && within(panelRect.top, 0)
      && within(panelRect.width, 280)
      && within(panelRect.bottom, innerHeight)
      && within(outletRect.left, panelRect.right)
      && within(outletRect.top, 0)
      && within(outletRect.right, innerWidth)
      && within(outletRect.bottom, innerHeight)
      && sameRect(boxRect, outletRect)
      && coversViewport(mainElement)
      && coversViewport(innerElement);
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
        && signedInShellReady(main, mainInner);
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
  return styleElement.isConnected && baseReady && (mainReady || loginReady);
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
      if (verified === true && contents.mainFrame === frame && !frame.isDestroyed()) {
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
