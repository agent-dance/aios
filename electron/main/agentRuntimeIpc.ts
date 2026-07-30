import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import {
  AGENT_RUNTIME_SIDECAR_CONFIG_CHANNEL,
  type AgentRuntimeSidecarConfig,
} from '../shared/agentRuntimeProtocol.js';
import { isAllowedShellNavigation } from '../shared/navigationPolicy.js';

function expectedShellOrigin(shellUrl: URL): string {
  return shellUrl.protocol === 'app:' ? 'app://alsniper' : shellUrl.origin;
}

function hasExpectedShellOrigin(rawUrl: string, shellUrl: URL): boolean {
  try {
    const candidate = new URL(rawUrl);
    if (shellUrl.protocol === 'app:') {
      return (
        candidate.protocol === 'app:'
        && candidate.hostname === 'alsniper'
        && candidate.username === ''
        && candidate.password === ''
        && candidate.port === ''
      );
    }
    return candidate.origin === expectedShellOrigin(shellUrl);
  } catch {
    return false;
  }
}

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
    || !hasExpectedShellOrigin(frame.url, shellUrl)
  ) {
    throw new Error('Unauthorized Agent Runtime bridge sender.');
  }
}

/** Registers a main-frame-scoped, read-only capability lookup. */
export function registerAgentRuntimeIpc(
  shellWindow: BrowserWindow,
  shellUrl: URL,
  config: AgentRuntimeSidecarConfig | undefined,
): () => void {
  const frameIpc = shellWindow.webContents.mainFrame.ipc;
  frameIpc.handle(AGENT_RUNTIME_SIDECAR_CONFIG_CHANNEL, (event, ...args: unknown[]) => {
    assertAuthorizedSender(event, shellWindow, shellUrl);
    if (args.length !== 0) throw new Error('Invalid Agent Runtime bridge argument count.');
    if (config === undefined) return undefined;
    // Return a fresh structured-clone source on every call. React remounts can
    // reconnect, while the renderer never writes the capability to storage.
    return { baseUrl: config.baseUrl, token: config.token, origin: config.origin };
  });

  return () => frameIpc.removeHandler(AGENT_RUNTIME_SIDECAR_CONFIG_CHANNEL);
}
