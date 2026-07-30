import { dialog, type BrowserWindow } from 'electron';
import type { TrustedApplicationApprovalPort } from './ApplicationControlHost.js';

export function createNativeApplicationApproval(
  getShellWindow: () => BrowserWindow | null,
): TrustedApplicationApprovalPort {
  return Object.freeze({
    request: async ({ description }: Parameters<TrustedApplicationApprovalPort['request']>[0]) => {
      const shellWindow = getShellWindow();
      if (shellWindow === null) return false;
      if (shellWindow.isDestroyed()) return false;
      const result = await dialog.showMessageBox(shellWindow, {
        type: 'warning',
        title: description.title,
        message: description.message,
        detail: description.detail,
        buttons: ['取消', description.confirmLabel],
        cancelId: 0,
        defaultId: 0,
        noLink: true,
        normalizeAccessKeys: false,
      });
      return result.response === 1;
    },
  });
}
