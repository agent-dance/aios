import { describe, expect, it, vi } from 'vitest';
import {
  isAllowlistedWeChatUrl,
  isAllowlistedWeChatProtocol,
  openOfficialWeChatDestination,
  requestDesktopWeChatLaunch,
  WECHAT_DESKTOP_PROTOCOL,
  WECHAT_OFFICIAL_DESTINATIONS,
  type ExternalWindowOpener,
} from './officialNavigation';

describe('WeChat official navigation boundary', () => {
  it('admits only the exact Tencent-owned destinations declared by the launcher', () => {
    for (const destination of Object.values(WECHAT_OFFICIAL_DESTINATIONS)) {
      expect(isAllowlistedWeChatUrl(destination.url)).toBe(true);
    }

    expect(isAllowlistedWeChatUrl('http://wx.qq.com/')).toBe(false);
    expect(isAllowlistedWeChatUrl('https://wx.qq.com.evil.example/')).toBe(false);
    expect(isAllowlistedWeChatUrl('https://wx.qq.com/redirect?to=https://example.com')).toBe(false);
    expect(isAllowlistedWeChatUrl('https://evil.example/@wx.qq.com/')).toBe(false);
    expect(isAllowlistedWeChatUrl(
      'https://weixin.qq.com/cgi-bin/readtemplate?lang=zh_CN&t=weixin_agreement&s=default',
    )).toBe(true);
    expect(isAllowlistedWeChatUrl(
      'https://weixin.qq.com/cgi-bin/readtemplate?lang=zh_CN&t=weixin_agreement&s=privacy',
    )).toBe(true);
    expect(isAllowlistedWeChatUrl(
      'https://weixin.qq.com/cgi-bin/readtemplate?lang=zh_CN&t=weixin_agreement&s=privacy&redirect=https://evil.example',
    )).toBe(false);
  });

  it('admits only the exact desktop launch protocol', () => {
    expect(isAllowlistedWeChatProtocol('xweixin://')).toBe(true);
    expect(isAllowlistedWeChatProtocol('xweixin:')).toBe(false);
    expect(isAllowlistedWeChatProtocol('xweixin://evil.example')).toBe(false);
    expect(isAllowlistedWeChatProtocol('weixin://')).toBe(false);
    expect(isAllowlistedWeChatProtocol('https://weixin.qq.com/')).toBe(false);
  });

  it('requests the native client synchronously without applying popup return-value semantics', () => {
    const launcher = vi.fn(() => undefined);

    const result = requestDesktopWeChatLaunch(launcher);

    expect(result.ok).toBe(true);
    expect(launcher).toHaveBeenCalledExactlyOnceWith(WECHAT_DESKTOP_PROTOCOL);
    expect(result.message).toContain('已请求系统启动');
  });

  it('surfaces a protocol dispatch exception with official installation fallbacks', () => {
    const result = requestDesktopWeChatLaunch(() => {
      throw new Error('protocol unavailable');
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Microsoft Store');
  });

  it('opens the selected official service with an isolated browsing context', () => {
    const replace = vi.fn();
    const append = vi.fn();
    const openedWindow = {
      opener: { unsafe: true },
      document: {
        createElement: vi.fn(() => ({ name: '', content: '' })),
        head: { append },
      },
      location: { replace },
    } as unknown as Window;
    const opener = vi.fn<ExternalWindowOpener>(() => openedWindow);

    const result = openOfficialWeChatDestination('web', opener);

    expect(result.ok).toBe(true);
    expect(opener).toHaveBeenCalledExactlyOnceWith('', '_blank');
    expect(openedWindow.opener).toBeNull();
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ name: 'referrer', content: 'no-referrer' }));
    expect(replace).toHaveBeenCalledExactlyOnceWith(WECHAT_OFFICIAL_DESTINATIONS.web.url);
  });

  it('returns a visible, actionable failure when the browser blocks the new window', () => {
    const result = openOfficialWeChatDestination('windows', () => null);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('允许此站点打开新窗口');
  });

  it('contains opener failures instead of leaking browser exceptions', () => {
    const result = openOfficialWeChatDestination('mac', () => {
      throw new Error('browser policy failure');
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('新窗口权限');
  });

  it('closes the blank browsing context if isolation cannot be established', () => {
    const close = vi.fn();
    const openedWindow = {
      set opener(_value: unknown) {
        throw new Error('cannot isolate opener');
      },
      close,
    } as unknown as Window;

    const result = openOfficialWeChatDestination('website', () => openedWindow);

    expect(result.ok).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });
});
