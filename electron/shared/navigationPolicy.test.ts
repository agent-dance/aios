import { describe, expect, it } from 'vitest';
import {
  isAllowedShellNavigation,
  isAllowedWeChatMainFrameUrl,
  isAllowedWeChatNavigation,
  isAllowedWeChatResourceUrl,
  parseLoopbackDevServerUrl,
  sanitizeElectronUserAgent,
  WECHAT_ENTRY_URL,
} from './navigationPolicy.js';

describe('WeChat navigation policy', () => {
  it.each([
    WECHAT_ENTRY_URL,
    'https://wx2.qq.com/cgi-bin/mmwebwx-bin/webwxnewloginpage?ticket=opaque',
    'https://web.wechat.com/',
    'https://web2.wechat.com/path#fragment',
  ])('allows an exact HTTPS WeChat web-app host: %s', (url) => {
    expect(isAllowedWeChatMainFrameUrl(url)).toBe(true);
  });

  it.each([
    'http://wx.qq.com/',
    'https://wx.qq.com.evil.example/',
    'https://evil.example/?next=https://wx.qq.com/',
    'https://user@wx.qq.com/',
    'https://wx.qq.com:444/',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'not a url',
  ])('rejects a spoofed or unsafe WeChat main-frame URL: %s', (url) => {
    expect(isAllowedWeChatMainFrameUrl(url)).toBe(false);
  });

  it('allows only explicit auxiliary hosts in subframes', () => {
    expect(isAllowedWeChatNavigation('https://login.weixin.qq.com/qrcode/opaque', false)).toBe(true);
    expect(isAllowedWeChatNavigation('about:blank', false)).toBe(true);
    expect(isAllowedWeChatNavigation('https://login.weixin.qq.com/', true)).toBe(false);
    expect(isAllowedWeChatNavigation('https://cdn.example.com/', false)).toBe(false);
  });

  it('allows only exact WeChat runtime resource hosts and safe local representations', () => {
    expect(isAllowedWeChatResourceUrl('https://res.wx.qq.com/a/wx_fed/webwx/res/app.js')).toBe(true);
    expect(isAllowedWeChatResourceUrl('https://file.wx2.qq.com/cgi-bin/mmwebwx-bin/webwxgetmedia')).toBe(true);
    expect(isAllowedWeChatResourceUrl('wss://webpush.web.wechat.com/sync')).toBe(true);
    expect(isAllowedWeChatResourceUrl('https://webpush.weixin.qq.com/cgi-bin/mmwebwx-bin/synccheck')).toBe(true);
    expect(isAllowedWeChatResourceUrl('blob:https://wx.qq.com/opaque-id')).toBe(true);
    expect(isAllowedWeChatResourceUrl('data:image/png;base64,AAAA')).toBe(true);
    expect(isAllowedWeChatResourceUrl('https://res.wx.qq.com.evil.example/app.js')).toBe(false);
    expect(isAllowedWeChatResourceUrl('https://analytics.example.com/track')).toBe(false);
    expect(isAllowedWeChatResourceUrl('file:///etc/passwd')).toBe(false);
  });

  it('removes only Electron product tokens from the Chromium user agent', () => {
    expect(sanitizeElectronUserAgent('Mozilla/5.0 Chrome/142.0 Electron/43.2.0 Safari/537.36')).toBe(
      'Mozilla/5.0 Chrome/142.0 Safari/537.36',
    );
    expect(sanitizeElectronUserAgent('Mozilla/5.0 Chrome/142.0')).toBe('Mozilla/5.0 Chrome/142.0');
  });
});

describe('shell navigation policy', () => {
  it.each([
    'http://127.0.0.1:5173/',
    'http://localhost:4173/',
    'http://[::1]:5173/',
  ])('accepts an exact loopback development origin: %s', (rawUrl) => {
    expect(parseLoopbackDevServerUrl(rawUrl)?.href).toBe(rawUrl);
  });

  it.each([
    'https://127.0.0.1:5173/',
    'http://0.0.0.0:5173/',
    'http://127.0.0.1:80/',
    'http://127.0.0.1:5173/path',
    'http://127.0.0.1:5173/?url=https://example.com',
    'http://user@127.0.0.1:5173/',
  ])('rejects a widened or ambiguous development URL: %s', (rawUrl) => {
    expect(parseLoopbackDevServerUrl(rawUrl)).toBeNull();
  });

  it('limits shell navigation to the selected dev origin', () => {
    const shellUrl = new URL('http://127.0.0.1:5173/');
    expect(isAllowedShellNavigation('http://127.0.0.1:5173/apps/wechat', shellUrl)).toBe(true);
    expect(isAllowedShellNavigation('http://localhost:5173/', shellUrl)).toBe(false);
    expect(isAllowedShellNavigation('https://wx.qq.com/', shellUrl)).toBe(false);
  });

  it('limits the production shell to the registered app authority', () => {
    const shellUrl = new URL('app://alsniper/index.html');
    expect(isAllowedShellNavigation('app://alsniper/assets/index.js', shellUrl)).toBe(true);
    expect(isAllowedShellNavigation('app://other/index.html', shellUrl)).toBe(false);
    expect(isAllowedShellNavigation('https://alsniper/', shellUrl)).toBe(false);
  });
});
