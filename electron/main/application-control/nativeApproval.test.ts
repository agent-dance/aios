import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ showMessageBox: vi.fn() }));
vi.mock('electron', () => ({ dialog: { showMessageBox: mocks.showMessageBox } }));

import { createNativeApplicationApproval } from './nativeApproval.js';

const approvalInput = {
  capability: {
    appId: 'wechat', actionId: 'wechat.message.send_to_current', adapterVersion: '1.0.0', risk: 'R3' as const, requiresApproval: true,
  },
  description: {
    title: '确认发送', message: '将发送微信消息', detail: '收件人及正文', confirmLabel: '发送',
  },
  request: {
    protocolVersion: 1 as const,
    intentId: 'intent-1',
    idempotencyKey: 'idem-1',
    principal: { kind: 'agent' as const, instanceId: 'agent-1', packageId: 'package-1', userId: 'user-1' },
    appId: 'wechat',
    actionId: 'wechat.message.send_to_current',
    arguments: { text: 'body' },
    expectedRevision: 1,
  },
};

beforeEach(() => mocks.showMessageBox.mockReset());

describe('native application-control approval', () => {
  it('uses a conservative native dialog and approves only the explicit confirm button', async () => {
    const window = { isDestroyed: () => false } as unknown as BrowserWindow;
    mocks.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
    const approval = createNativeApplicationApproval(() => window);

    await expect(approval.request(approvalInput)).resolves.toBe(true);
    expect(mocks.showMessageBox).toHaveBeenCalledWith(window, expect.objectContaining({
      buttons: ['取消', '发送'],
      cancelId: 0,
      defaultId: 0,
      noLink: true,
      detail: '收件人及正文',
    }));

    mocks.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false });
    await expect(approval.request(approvalInput)).resolves.toBe(false);
  });

  it('fails closed without opening a dialog if no live trusted shell window exists', async () => {
    const missing = createNativeApplicationApproval(() => null);
    await expect(missing.request(approvalInput)).resolves.toBe(false);
    const destroyed = createNativeApplicationApproval(() => ({ isDestroyed: () => true }) as unknown as BrowserWindow);
    await expect(destroyed.request(approvalInput)).resolves.toBe(false);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });
});
