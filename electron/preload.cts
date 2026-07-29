const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

type Phase = 'idle' | 'loading' | 'ready' | 'failed';
type ErrorCode = 'NAVIGATION_BLOCKED' | 'NETWORK_ERROR' | 'CERTIFICATE_ERROR' | 'VIEW_UNAVAILABLE' | 'RENDERER_CRASHED';

interface State {
  readonly phase: Phase;
  readonly visible: boolean;
  readonly canGoBack: boolean;
  readonly errorCode?: ErrorCode;
}

const CHANNELS = Object.freeze({
  mount: 'alsniper-desktop:wechat:mount',
  setBounds: 'alsniper-desktop:wechat:set-bounds',
  setVisible: 'alsniper-desktop:wechat:set-visible',
  focus: 'alsniper-desktop:wechat:focus',
  reload: 'alsniper-desktop:wechat:reload',
  goBack: 'alsniper-desktop:wechat:go-back',
  unmount: 'alsniper-desktop:wechat:unmount',
  getState: 'alsniper-desktop:wechat:get-state',
  stateChanged: 'alsniper-desktop:wechat:state-changed',
});

const PHASES = new Set<unknown>(['idle', 'loading', 'ready', 'failed']);
const ERROR_CODES = new Set<unknown>([
  'NAVIGATION_BLOCKED',
  'NETWORK_ERROR',
  'CERTIFICATE_ERROR',
  'VIEW_UNAVAILABLE',
  'RENDERER_CRASHED',
]);
const MAX_BOUND_COMPONENT = 32_768;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], allowed = required): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));
}

function cloneBounds(value: unknown): Bounds {
  if (!isRecord(value) || !exactKeys(value, ['x', 'y', 'width', 'height'])) {
    throw new TypeError('Invalid WeChat bounds.');
  }

  const values = [value.x, value.y, value.width, value.height];
  if (
    values.some((item) => typeof item !== 'number' || !Number.isFinite(item) || !Number.isInteger(item))
    || (value.x as number) < 0
    || (value.y as number) < 0
    || (value.width as number) < 1
    || (value.height as number) < 1
    || values.some((item) => (item as number) > MAX_BOUND_COMPONENT)
  ) {
    throw new TypeError('Invalid WeChat bounds.');
  }

  return Object.freeze({
    x: value.x as number,
    y: value.y as number,
    width: value.width as number,
    height: value.height as number,
  });
}

function cloneState(value: unknown): State {
  if (
    !isRecord(value)
    || !exactKeys(value, ['phase', 'visible', 'canGoBack'], ['phase', 'visible', 'canGoBack', 'errorCode'])
    || !PHASES.has(value.phase)
    || typeof value.visible !== 'boolean'
    || typeof value.canGoBack !== 'boolean'
    || (value.errorCode !== undefined && !ERROR_CODES.has(value.errorCode))
    || (value.phase === 'failed') !== (value.errorCode !== undefined)
  ) {
    throw new TypeError('Invalid WeChat state.');
  }

  return Object.freeze({
    phase: value.phase as Phase,
    visible: value.visible,
    canGoBack: value.canGoBack,
    ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode as ErrorCode }),
  });
}

async function invokeState(channel: string, ...args: unknown[]): Promise<State> {
  return cloneState(await ipcRenderer.invoke(channel, ...args));
}

const wechat = Object.freeze({
  mount: (bounds: Bounds): Promise<State> => invokeState(CHANNELS.mount, cloneBounds(bounds)),
  setBounds: (bounds: Bounds): Promise<State> => invokeState(CHANNELS.setBounds, cloneBounds(bounds)),
  setVisible: (visible: boolean): Promise<State> => {
    if (typeof visible !== 'boolean') {
      return Promise.reject(new TypeError('WeChat visibility must be a boolean.'));
    }
    return invokeState(CHANNELS.setVisible, visible);
  },
  focus: (): Promise<State> => invokeState(CHANNELS.focus),
  reload: (): Promise<State> => invokeState(CHANNELS.reload),
  goBack: (): Promise<State> => invokeState(CHANNELS.goBack),
  unmount: async (): Promise<void> => {
    const result: unknown = await ipcRenderer.invoke(CHANNELS.unmount);
    if (result !== undefined) {
      throw new TypeError('Invalid WeChat unmount result.');
    }
  },
  getState: (): Promise<State> => invokeState(CHANNELS.getState),
  onState: (listener: (state: State) => void): (() => void) => {
    if (typeof listener !== 'function') {
      throw new TypeError('WeChat state listener must be a function.');
    }

    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      try {
        listener(cloneState(payload));
      } catch (error) {
        console.error('Rejected invalid WeChat state event.', error);
      }
    };
    ipcRenderer.on(CHANNELS.stateChanged, wrapped);
    return () => {
      ipcRenderer.removeListener(CHANNELS.stateChanged, wrapped);
    };
  },
});

contextBridge.exposeInMainWorld('alsniperDesktop', Object.freeze({ wechat }));
