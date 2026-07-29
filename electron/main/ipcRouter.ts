import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { WeChatViewController } from './WeChatViewController.js';
import {
  assertNoPayload,
  cloneWeChatState,
  parseWeChatBounds,
  parseWeChatVisibility,
  WECHAT_IPC_CHANNELS,
} from '../shared/wechatProtocol.js';

function assertAuthorizedSender(event: IpcMainInvokeEvent, shellWindow: BrowserWindow): void {
  const shellContents = shellWindow.webContents;
  if (
    shellWindow.isDestroyed()
    || event.sender !== shellContents
    || event.senderFrame !== shellContents.mainFrame
  ) {
    throw new Error('Unauthorized WeChat desktop bridge sender.');
  }
}

function assertArgumentCount(args: readonly unknown[], expected: number): void {
  if (args.length !== expected) {
    throw new Error('Invalid WeChat desktop bridge argument count.');
  }
}

export function registerWeChatIpc(
  shellWindow: BrowserWindow,
  controller: WeChatViewController,
): () => void {
  const register = (
    channel: string,
    handler: (event: IpcMainInvokeEvent, args: readonly unknown[]) => unknown,
  ): void => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      assertAuthorizedSender(event, shellWindow);
      return handler(event, args);
    });
  };

  register(WECHAT_IPC_CHANNELS.mount, (_event, args) => {
    assertArgumentCount(args, 1);
    return cloneWeChatState(controller.mount(parseWeChatBounds(args[0])));
  });
  register(WECHAT_IPC_CHANNELS.setBounds, (_event, args) => {
    assertArgumentCount(args, 1);
    return cloneWeChatState(controller.setBounds(parseWeChatBounds(args[0])));
  });
  register(WECHAT_IPC_CHANNELS.setVisible, (_event, args) => {
    assertArgumentCount(args, 1);
    return cloneWeChatState(controller.setVisible(parseWeChatVisibility(args[0])));
  });
  register(WECHAT_IPC_CHANNELS.focus, (_event, args) => {
    assertArgumentCount(args, 0);
    assertNoPayload(args[0]);
    return cloneWeChatState(controller.focus());
  });
  register(WECHAT_IPC_CHANNELS.reload, (_event, args) => {
    assertArgumentCount(args, 0);
    assertNoPayload(args[0]);
    return cloneWeChatState(controller.reload());
  });
  register(WECHAT_IPC_CHANNELS.goBack, (_event, args) => {
    assertArgumentCount(args, 0);
    assertNoPayload(args[0]);
    return cloneWeChatState(controller.goBack());
  });
  register(WECHAT_IPC_CHANNELS.unmount, (_event, args) => {
    assertArgumentCount(args, 0);
    assertNoPayload(args[0]);
    return controller.unmount();
  });
  register(WECHAT_IPC_CHANNELS.getState, (_event, args) => {
    assertArgumentCount(args, 0);
    assertNoPayload(args[0]);
    return cloneWeChatState(controller.getState());
  });

  return () => {
    ipcMain.removeHandler(WECHAT_IPC_CHANNELS.mount);
    ipcMain.removeHandler(WECHAT_IPC_CHANNELS.setBounds);
    ipcMain.removeHandler(WECHAT_IPC_CHANNELS.setVisible);
    ipcMain.removeHandler(WECHAT_IPC_CHANNELS.focus);
    ipcMain.removeHandler(WECHAT_IPC_CHANNELS.reload);
    ipcMain.removeHandler(WECHAT_IPC_CHANNELS.goBack);
    ipcMain.removeHandler(WECHAT_IPC_CHANNELS.unmount);
    ipcMain.removeHandler(WECHAT_IPC_CHANNELS.getState);
  };
}
