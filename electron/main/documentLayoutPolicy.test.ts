import { describe, expect, it, vi } from 'vitest';
import {
  applyWeChatDocumentLayout,
  WECHAT_FULL_BLEED_CSS,
  type WeChatLayoutTarget,
} from './documentLayoutPolicy.js';

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

  it('inserts the fixed stylesheet at user cascade origin', async () => {
    const target: WeChatLayoutTarget = {
      insertCSS: vi.fn(async () => 'layout-key'),
      executeJavaScript: vi.fn(async () => true),
    };

    await expect(applyWeChatDocumentLayout(target)).resolves.toBe('layout-key');
    expect(target.insertCSS).toHaveBeenCalledWith(WECHAT_FULL_BLEED_CSS, { cssOrigin: 'user' });
    expect(target.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('mainInnerStyle.maxWidth'), false);
  });

  it('rejects the document instead of revealing an unattested layout', async () => {
    const target: WeChatLayoutTarget = {
      insertCSS: vi.fn(async () => 'layout-key'),
      executeJavaScript: vi.fn(async () => false),
    };

    await expect(applyWeChatDocumentLayout(target)).rejects.toThrow(
      'The embedded WeChat document rejected the full-bleed layout contract.',
    );
  });
});
