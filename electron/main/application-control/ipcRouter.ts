import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { isAllowedShellNavigation } from '../../shared/navigationPolicy.js';
import { APPLICATION_CONTROL_IPC_CHANNELS } from '../../shared/applicationControlProtocol.js';
import type { ApplicationControlService } from './applicationControlService.js';

function assertAuthorizedSender(event: IpcMainInvokeEvent, shellWindow: BrowserWindow, shellUrl: URL): void {
  const contents = shellWindow.webContents;
  const currentMainFrame = contents.mainFrame;
  const frame = event.senderFrame;
  if (
    shellWindow.isDestroyed()
    || contents.isDestroyed()
    || event.sender !== contents
    || frame === null
    || frame !== currentMainFrame
    || frame.isDestroyed()
    || frame.parent !== null
    || !isAllowedShellNavigation(frame.url, shellUrl)
  ) {
    throw new Error('Unauthorized application-control bridge sender.');
  }
}

function assertArgumentCount(args: readonly unknown[], expected: number): void {
  if (args.length !== expected) throw new Error('Invalid application-control bridge argument count.');
}

export function registerApplicationControlIpc(
  shellWindow: BrowserWindow,
  shellUrl: URL,
  host: ApplicationControlService,
): () => void {
  const frameIpc = shellWindow.webContents.mainFrame.ipc;
  const register = (
    channel: string,
    handler: (args: readonly unknown[]) => unknown,
  ): void => {
    frameIpc.handle(channel, (event, ...args: unknown[]) => {
      assertAuthorizedSender(event, shellWindow, shellUrl);
      return handler(args);
    });
  };

  register(APPLICATION_CONTROL_IPC_CHANNELS.listCapabilities, (args) => {
    assertArgumentCount(args, 0);
    return host.listCapabilities();
  });
  register(APPLICATION_CONTROL_IPC_CHANNELS.execute, (args) => {
    assertArgumentCount(args, 1);
    return host.execute(args[0]);
  });
  register(APPLICATION_CONTROL_IPC_CHANNELS.getReceipt, (args) => {
    assertArgumentCount(args, 1);
    return host.getReceipt(args[0]);
  });

  return () => {
    frameIpc.removeHandler(APPLICATION_CONTROL_IPC_CHANNELS.listCapabilities);
    frameIpc.removeHandler(APPLICATION_CONTROL_IPC_CHANNELS.execute);
    frameIpc.removeHandler(APPLICATION_CONTROL_IPC_CHANNELS.getReceipt);
  };
}
