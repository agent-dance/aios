export const WECHAT_ENTRY_URL = 'https://wx.qq.com/' as const;
export const WECHAT_SESSION_PARTITION = 'persist:alsniper-wechat' as const;

const WECHAT_MAIN_FRAME_HOSTS = new Set([
  'web.wechat.com',
  'web2.wechat.com',
  'wx.qq.com',
  'wx2.qq.com',
  'wx8.qq.com',
]);

const WECHAT_SUBFRAME_HOSTS = new Set([
  ...WECHAT_MAIN_FRAME_HOSTS,
  'login.weixin.qq.com',
  'login.wx.qq.com',
  'res.wx.qq.com',
]);

const WECHAT_NETWORK_HOSTS = new Set([
  ...WECHAT_SUBFRAME_HOSTS,
  'file.web.wechat.com',
  'file.web2.wechat.com',
  'file.wx.qq.com',
  'file.wx2.qq.com',
  'file.wx8.qq.com',
  'js.aq.qq.com',
  'login.web.wechat.com',
  'login.web2.wechat.com',
  'login.wx2.qq.com',
  'login.wx8.qq.com',
  'webpush.web.wechat.com',
  'webpush.web2.wechat.com',
  'webpush.weixin.qq.com',
  'webpush.wx.qq.com',
  'webpush.wx2.qq.com',
  'webpush.wx8.qq.com',
]);

function parseSecureUrl(rawUrl: string): URL | null {
  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== 'https:'
      || url.username !== ''
      || url.password !== ''
      || (url.port !== '' && url.port !== '443')
    ) {
      return null;
    }

    return url;
  } catch {
    return null;
  }
}

export function isAllowedWeChatMainFrameUrl(rawUrl: string): boolean {
  const url = parseSecureUrl(rawUrl);
  return url !== null && WECHAT_MAIN_FRAME_HOSTS.has(url.hostname);
}

export function isAllowedWeChatSubframeUrl(rawUrl: string): boolean {
  if (rawUrl === 'about:blank') {
    return true;
  }

  const url = parseSecureUrl(rawUrl);
  return url !== null && WECHAT_SUBFRAME_HOSTS.has(url.hostname);
}

export function isAllowedWeChatNavigation(rawUrl: string, isMainFrame: boolean): boolean {
  return isMainFrame
    ? isAllowedWeChatMainFrameUrl(rawUrl)
    : isAllowedWeChatSubframeUrl(rawUrl);
}

export function isAllowedWeChatResourceUrl(rawUrl: string): boolean {
  if (rawUrl.startsWith('data:')) {
    return true;
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (url.protocol === 'blob:') {
    return isAllowedWeChatMainFrameUrl(`${url.origin}/`);
  }

  if (
    (url.protocol !== 'https:' && url.protocol !== 'wss:')
    || url.username !== ''
    || url.password !== ''
    || (url.port !== '' && url.port !== '443')
  ) {
    return false;
  }

  return WECHAT_NETWORK_HOSTS.has(url.hostname);
}

export function sanitizeElectronUserAgent(userAgent: string): string {
  return userAgent
    .replace(/\sElectron\/[^\s]+/giu, '')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}

export function parseLoopbackDevServerUrl(rawUrl: string | undefined): URL | null {
  if (rawUrl === undefined || rawUrl.length > 2_048) {
    return null;
  }

  try {
    const url = new URL(rawUrl);
    const allowedHost = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    const port = Number(url.port);

    if (
      url.protocol !== 'http:'
      || !allowedHost
      || url.username !== ''
      || url.password !== ''
      || url.pathname !== '/'
      || url.search !== ''
      || url.hash !== ''
      || !Number.isInteger(port)
      || port < 1_024
      || port > 65_535
    ) {
      return null;
    }

    return url;
  } catch {
    return null;
  }
}

export function isAllowedShellNavigation(rawUrl: string, shellUrl: URL): boolean {
  try {
    const candidate = new URL(rawUrl);
    if (shellUrl.protocol === 'file:') {
      return candidate.protocol === 'file:' && candidate.href === shellUrl.href;
    }

    if (shellUrl.protocol === 'app:') {
      return (
        candidate.protocol === 'app:'
        && candidate.hostname === 'alsniper'
        && candidate.username === ''
        && candidate.password === ''
        && candidate.port === ''
      );
    }

    return candidate.origin === shellUrl.origin;
  } catch {
    return false;
  }
}
