import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const APP_SOURCE = readFileSync(new URL('./WeChatApp.tsx', import.meta.url), 'utf8');
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

  it('offers the complete embedded-view recovery controls', () => {
    expect(APP_SOURCE).toContain('后退');
    expect(APP_SOURCE).toContain('刷新微信');
    expect(APP_SOURCE).toContain("view.runAction('retry')");
    expect(APP_SOURCE).toContain("view.runAction('reload')");
    expect(APP_SOURCE).toContain("view.runAction('back')");
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
