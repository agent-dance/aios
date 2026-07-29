import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const APP_SOURCE = readFileSync(new URL('./WeChatApp.tsx', import.meta.url), 'utf8');
const APP_STYLES = readFileSync(new URL('./WeChatApp.css', import.meta.url), 'utf8');
const HOOK_SOURCE = readFileSync(new URL('./useEmbeddedWeChatView.ts', import.meta.url), 'utf8');

describe('embedded WeChat renderer contract', () => {
  it('contains no browser redirect, iframe, or native-client launch fallback', () => {
    expect(APP_SOURCE).not.toContain('<iframe');
    expect(APP_SOURCE).not.toContain('window.open');
    expect(APP_SOURCE).not.toContain('xweixin://');
    expect(APP_SOURCE).not.toContain('nativeApplications.launch');
    expect(APP_SOURCE).not.toContain('wx.qq.com');
    expect(APP_SOURCE).not.toContain('dangerouslySetInnerHTML');
  });

  it('states the browser truth boundary without claiming WeChat is available', () => {
    expect(APP_SOURCE).toContain('请使用 AlSniper OS 桌面版');
    expect(APP_SOURCE).toContain('当前环境没有桌面宿主');
    expect(APP_SOURCE).toContain('浏览器版本不会伪装成可用微信');
  });

  it('keeps recovery in the failure overlay without permanent browser chrome', () => {
    expect(APP_SOURCE).toContain("view.runAction('retry')");
    expect(APP_SOURCE).not.toContain('wechat-app__toolbar');
    expect(APP_SOURCE).not.toContain('wechat-app__navigation');
    expect(APP_SOURCE).not.toContain('wechat-app__security');
    expect(APP_SOURCE).not.toContain('<header');
    expect(APP_SOURCE).not.toContain('<footer');
  });

  it('gives the embedded surface the complete renderer area without host scrolling', () => {
    expect(APP_STYLES).toMatch(/\.wechat-app\s*\{[^}]*position:\s*relative;/s);
    expect(APP_STYLES).toMatch(/\.wechat-app\s*\{[^}]*overflow:\s*hidden;/s);
    expect(APP_STYLES).toMatch(/\.wechat-app__surface\s*\{[^}]*position:\s*absolute;/s);
    expect(APP_STYLES).toMatch(/\.wechat-app__surface\s*\{[^}]*inset:\s*0;/s);
    expect(APP_STYLES).toMatch(/\.wechat-app__surface\s*\{[^}]*width:\s*100%;/s);
    expect(APP_STYLES).toMatch(/\.wechat-app__surface\s*\{[^}]*height:\s*100%;/s);
    expect(APP_STYLES).not.toContain('.wechat-app__toolbar');
    expect(APP_STYLES).not.toContain('.wechat-app__security');
  });

  it('synchronizes and strictly cleans every observed browser lifecycle signal', () => {
    expect(HOOK_SOURCE).toContain('new ResizeObserver(handleLayoutChange)');
    expect(HOOK_SOURCE).toContain('resizeObserver?.disconnect()');
    expect(HOOK_SOURCE).toContain("window.addEventListener('resize', handleLayoutChange)");
    expect(HOOK_SOURCE).toContain("window.removeEventListener('resize', handleLayoutChange)");
    expect(HOOK_SOURCE).toContain("document.addEventListener('visibilitychange', handleVisibilityChange)");
    expect(HOOK_SOURCE).toContain("document.removeEventListener('visibilitychange', handleVisibilityChange)");
    expect(HOOK_SOURCE).toContain('unsubscribe()');
    expect(HOOK_SOURCE).toContain('bridge.unmount()');
    expect(HOOK_SOURCE).toContain('bridge.getState()');
  });
});
