export const WECHAT_OFFICIAL_DESTINATIONS = {
  web: {
    id: 'web',
    label: '微信网页版',
    url: 'https://wx.qq.com/',
  },
  website: {
    id: 'website',
    label: '微信官网',
    url: 'https://weixin.qq.com/',
  },
  windows: {
    id: 'windows',
    label: 'Windows 官方版',
    url: 'https://pc.weixin.qq.com/',
  },
  microsoftStore: {
    id: 'microsoftStore',
    label: 'Microsoft Store 官方版',
    url: 'https://apps.microsoft.com/detail/xpfckbrnfzq62g?gl=CN&hl=zh-CN',
  },
  mac: {
    id: 'mac',
    label: 'macOS 官方版',
    url: 'https://mac.weixin.qq.com/',
  },
  license: {
    id: 'license',
    label: '微信软件许可及服务协议',
    url: 'https://weixin.qq.com/cgi-bin/readtemplate?lang=zh_CN&t=weixin_agreement&s=default',
  },
  privacy: {
    id: 'privacy',
    label: '微信隐私保护指引',
    url: 'https://weixin.qq.com/cgi-bin/readtemplate?lang=zh_CN&t=weixin_agreement&s=privacy',
  },
} as const;

export const WECHAT_DESKTOP_PROTOCOL = 'xweixin://' as const;

export type WeChatDestinationId = keyof typeof WECHAT_OFFICIAL_DESTINATIONS;
export type WeChatOfficialDestination = (typeof WECHAT_OFFICIAL_DESTINATIONS)[WeChatDestinationId];

export type ExternalWindowOpener = (
  url: '',
  target: '_blank',
) => Window | null;

export type DesktopProtocolLauncher = (url: typeof WECHAT_DESKTOP_PROTOCOL) => void;

export interface WeChatNavigationResult {
  readonly ok: boolean;
  readonly destination: WeChatOfficialDestination;
  readonly message: string;
}

export interface WeChatDesktopLaunchResult {
  readonly ok: boolean;
  readonly message: string;
}

const ALLOWED_URLS = new Set<string>(
  Object.values(WECHAT_OFFICIAL_DESTINATIONS).map((destination) => destination.url),
);

/**
 * Exact URL matching is intentional. A hostname suffix check can accidentally
 * admit lookalike hosts, credentials, unexpected paths, or redirect parameters.
 */
export function isAllowlistedWeChatUrl(candidate: string): boolean {
  return ALLOWED_URLS.has(candidate);
}

export function isAllowlistedWeChatProtocol(candidate: string): candidate is typeof WECHAT_DESKTOP_PROTOCOL {
  return candidate === WECHAT_DESKTOP_PROTOCOL;
}

function browserWindowOpener(url: '', target: '_blank'): Window | null {
  return window.open(url, target);
}

function browserProtocolLauncher(url: typeof WECHAT_DESKTOP_PROTOCOL): void {
  window.location.assign(url);
}

/**
 * Custom protocols do not return a WindowProxy, so a null popup result cannot
 * indicate success or failure. This request must run synchronously inside the
 * user's click handler; the operating system owns the eventual launch result.
 */
export function requestDesktopWeChatLaunch(
  launchProtocol: DesktopProtocolLauncher = browserProtocolLauncher,
): WeChatDesktopLaunchResult {
  if (!isAllowlistedWeChatProtocol(WECHAT_DESKTOP_PROTOCOL)) {
    return {
      ok: false,
      message: '安全校验失败：桌面启动协议不在白名单中。',
    };
  }

  try {
    launchProtocol(WECHAT_DESKTOP_PROTOCOL);
    return {
      ok: true,
      message: '已请求系统启动微信桌面客户端。若微信未启动，请使用下方官方安装入口。',
    };
  } catch {
    return {
      ok: false,
      message: '无法请求系统启动微信。请使用下方 Microsoft Store 或腾讯官网下载入口。',
    };
  }
}

export function openOfficialWeChatDestination(
  destinationId: WeChatDestinationId,
  openWindow: ExternalWindowOpener = browserWindowOpener,
): WeChatNavigationResult {
  const destination = WECHAT_OFFICIAL_DESTINATIONS[destinationId];

  if (!isAllowlistedWeChatUrl(destination.url)) {
    return {
      ok: false,
      destination,
      message: '安全校验失败：该地址不在微信官方入口白名单中。',
    };
  }

  let openedWindow: Window | null = null;
  try {
    // Opening a no-opener URL directly can legally return null even when the
    // navigation succeeded. Open a same-origin blank page first so null has the
    // unambiguous meaning "popup blocked", then isolate it before navigation.
    openedWindow = openWindow('', '_blank');
    if (openedWindow === null) {
      return {
        ok: false,
        destination,
        message: `未能打开${destination.label}。请允许此站点打开新窗口后重试。`,
      };
    }

    openedWindow.opener = null;
    const referrerPolicy = openedWindow.document.createElement('meta');
    referrerPolicy.name = 'referrer';
    referrerPolicy.content = 'no-referrer';
    openedWindow.document.head.append(referrerPolicy);
    openedWindow.location.replace(destination.url);

    return {
      ok: true,
      destination,
      message: `已在新的浏览器标签页打开${destination.label}。`,
    };
  } catch {
    try {
      openedWindow?.close();
    } catch {
      // The useful error remains the failed navigation; cleanup is best effort.
    }
    return {
      ok: false,
      destination,
      message: `打开${destination.label}时发生错误。请检查浏览器的新窗口权限后重试。`,
    };
  }
}
