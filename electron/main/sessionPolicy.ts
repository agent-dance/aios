import type { Session } from 'electron';
import {
  isAllowedWeChatNavigation,
  isAllowedWeChatResourceUrl,
  sanitizeElectronUserAgent,
} from '../shared/navigationPolicy.js';

const configuredSessions = new WeakSet<Session>();

export function hardenWeChatSession(wechatSession: Session): void {
  if (configuredSessions.has(wechatSession)) {
    return;
  }
  configuredSessions.add(wechatSession);

  wechatSession.setPermissionCheckHandler(() => false);
  wechatSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  wechatSession.setDevicePermissionHandler(() => false);

  wechatSession.on('will-download', (event) => {
    event.preventDefault();
  });

  wechatSession.webRequest.onBeforeRequest((details, callback) => {
    if (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') {
      callback({ cancel: !isAllowedWeChatNavigation(details.url, details.resourceType === 'mainFrame') });
      return;
    }

    callback({ cancel: !isAllowedWeChatResourceUrl(details.url) });
  });

  const hardenedUserAgent = sanitizeElectronUserAgent(wechatSession.getUserAgent());
  if (hardenedUserAgent.length > 0) {
    wechatSession.setUserAgent(hardenedUserAgent);
  }
}
