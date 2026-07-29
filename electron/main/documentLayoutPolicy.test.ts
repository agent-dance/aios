import { describe, expect, it, vi } from 'vitest';
import {
  applyWeChatDocumentLayout,
  WECHAT_FULL_BLEED_CSS,
  type WeChatLayoutTarget,
} from './documentLayoutPolicy.js';

function createTarget(executeJavaScript = vi.fn(async () => true)): WeChatLayoutTarget {
  return {
    insertCSS: vi.fn(async () => 'layout-key'),
    mainFrame: {
      executeJavaScript,
      isDestroyed: vi.fn(() => false),
    },
  };
}

describe('Web WeChat document layout policy', () => {
  it('removes only the official outer-shell constraints', () => {
    expect(WECHAT_FULL_BLEED_CSS).toMatch(/html,\s*body\s*\{[^}]*overflow:\s*hidden\s*!important/s);
    expect(WECHAT_FULL_BLEED_CSS).toMatch(/\.main\s*\{[^}]*height:\s*100%\s*!important[^}]*padding:\s*0\s*!important/s);
    expect(WECHAT_FULL_BLEED_CSS).toMatch(/\.main\s*\{[^}]*position:\s*fixed\s*!important[^}]*inset:\s*0\s*!important/s);
    expect(WECHAT_FULL_BLEED_CSS).toMatch(/\.main_inner\s*\{[^}]*width:\s*100%\s*!important[^}]*max-width:\s*none\s*!important/s);
    expect(WECHAT_FULL_BLEED_CSS).toMatch(/\.main_inner\s*\{[^}]*position:\s*absolute\s*!important[^}]*inset:\s*0\s*!important/s);
    expect(WECHAT_FULL_BLEED_CSS).toMatch(/\.login\s*\{[^}]*min-height:\s*0\s*!important[^}]*overflow:\s*hidden\s*!important/s);
    expect(WECHAT_FULL_BLEED_CSS).toMatch(/\.main \.copyright\s*\{[^}]*display:\s*none\s*!important/s);
  });

  it('does not disable scrolling in conversation or contact panes', () => {
    expect(WECHAT_FULL_BLEED_CSS).not.toContain('::-webkit-scrollbar');
    expect(WECHAT_FULL_BLEED_CSS).not.toMatch(/(^|\n)\s*\*/u);
    expect(WECHAT_FULL_BLEED_CSS).not.toMatch(/\.box(?:\s|,|\{)/u);
    expect(WECHAT_FULL_BLEED_CSS).not.toContain('.chat');
    expect(WECHAT_FULL_BLEED_CSS).not.toContain('.contact');
  });

  it('inserts user-origin CSS and attests through WebFrameMain while loading can continue', async () => {
    const executeJavaScript = vi.fn(async () => true);
    const target = createTarget(executeJavaScript);

    await expect(applyWeChatDocumentLayout(target)).resolves.toBe('layout-key');
    expect(target.insertCSS).toHaveBeenCalledWith(WECHAT_FULL_BLEED_CSS, { cssOrigin: 'user' });
    expect(executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('mainInnerStyle.maxWidth'), false);
    expect(executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('mainReady || loginReady'), false);
  });

  it('retries bounded attestation until a delayed login or main shell is ready', async () => {
    const executeJavaScript = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const target = createTarget(executeJavaScript);

    await expect(applyWeChatDocumentLayout(target, {
      verificationTimeoutMs: 100,
      retryIntervalMs: 1,
    })).resolves.toBe('layout-key');
    expect(executeJavaScript).toHaveBeenCalledTimes(2);
  });

  it('fails closed within a hard deadline instead of leaving the host loading forever', async () => {
    const neverSettles = new Promise<unknown>(() => undefined);
    const target = createTarget(vi.fn(() => neverSettles));

    await expect(applyWeChatDocumentLayout(target, {
      verificationTimeoutMs: 20,
      retryIntervalMs: 1,
    })).rejects.toThrow('before the verification deadline');
  });

  it('rejects a destroyed main frame before attempting remote execution', async () => {
    const target = createTarget();
    vi.mocked(target.mainFrame.isDestroyed).mockReturnValue(true);

    await expect(applyWeChatDocumentLayout(target)).rejects.toThrow(
      'main frame was destroyed before layout verification',
    );
    expect(target.mainFrame.executeJavaScript).not.toHaveBeenCalled();
  });
});
