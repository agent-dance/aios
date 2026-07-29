import type { WebContents } from 'electron';

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

export interface WeChatLayoutTarget {
  insertCSS(css: string, options?: Electron.InsertCSSOptions): Promise<string>;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

const WECHAT_LAYOUT_ATTESTATION_SOURCE = `(() => {
  const root = document.documentElement;
  const body = document.body;
  const main = document.querySelector('.main');
  const mainInner = document.querySelector('.main_inner');
  const login = document.querySelector('.login');
  if (!(root instanceof HTMLElement)
    || !(body instanceof HTMLElement)
    || !(main instanceof HTMLElement)
    || !(mainInner instanceof HTMLElement)
    || !(login instanceof HTMLElement)) return false;
  const rootStyle = getComputedStyle(root);
  const bodyStyle = getComputedStyle(body);
  const mainStyle = getComputedStyle(main);
  const mainInnerStyle = getComputedStyle(mainInner);
  const loginStyle = getComputedStyle(login);
  const edgesAreZero = (style) => style.top === '0px'
    && style.right === '0px'
    && style.bottom === '0px'
    && style.left === '0px';
  const coversViewport = (element) => {
    const rect = element.getBoundingClientRect();
    return rect.width <= 0 || rect.height <= 0 || (
      Math.abs(rect.left) <= 1
      && Math.abs(rect.top) <= 1
      && Math.abs(rect.width - innerWidth) <= 1
      && Math.abs(rect.height - innerHeight) <= 1
    );
  };
  return rootStyle.overflowX === 'hidden'
    && rootStyle.overflowY === 'hidden'
    && bodyStyle.overflowX === 'hidden'
    && bodyStyle.overflowY === 'hidden'
    && mainStyle.position === 'fixed'
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
    && loginStyle.minWidth === '0px'
    && loginStyle.minHeight === '0px'
    && loginStyle.overflowX === 'hidden'
    && loginStyle.overflowY === 'hidden'
    && coversViewport(main)
    && coversViewport(mainInner)
    && coversViewport(login);
})()`;

export async function applyWeChatDocumentLayout(
  contents: Pick<WebContents, 'executeJavaScript' | 'insertCSS'> | WeChatLayoutTarget,
): Promise<string> {
  const key = await contents.insertCSS(WECHAT_FULL_BLEED_CSS, { cssOrigin: 'user' });
  const verified = await contents.executeJavaScript(WECHAT_LAYOUT_ATTESTATION_SOURCE, false);
  if (verified !== true) {
    throw new Error('The embedded WeChat document rejected the full-bleed layout contract.');
  }
  return key;
}
