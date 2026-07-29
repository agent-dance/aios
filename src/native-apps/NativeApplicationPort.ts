import type {
  NativeApplicationId,
  NativeApplicationInstallResult,
  NativeApplicationLaunchResult,
  NativeApplicationStatus,
} from '../agent-platform/protocol';
import type { NativeApplicationSidecarClient, RequestOptions } from '../agent-platform/sidecarClient';

export interface NativeApplicationCallOptions {
  readonly signal?: AbortSignal;
}

export interface NativeApplicationInstallCommand {
  readonly acceptedTerms: true;
}

export interface NativeApplicationPort {
  getStatus(
    appId: NativeApplicationId,
    options?: NativeApplicationCallOptions,
  ): Promise<NativeApplicationStatus>;
  install(
    appId: NativeApplicationId,
    command: NativeApplicationInstallCommand,
    options?: NativeApplicationCallOptions,
  ): Promise<NativeApplicationInstallResult>;
  launch(
    appId: NativeApplicationId,
    options?: NativeApplicationCallOptions,
  ): Promise<NativeApplicationLaunchResult>;
}

type NativeApplicationTransport = Pick<
  NativeApplicationSidecarClient,
  'nativeApplicationStatus' | 'installNativeApplication' | 'launchNativeApplication'
>;

export interface NativeApplicationPortOptions {
  readonly requestId?: () => string;
}

const defaultRequestId = (): string => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let id = 'native-';
  for (const byte of bytes) id += byte.toString(16).padStart(2, '0');
  return id;
};

const transportOptions = (options?: NativeApplicationCallOptions): RequestOptions | undefined =>
  options?.signal === undefined ? undefined : { signal: options.signal };

export const createNativeApplicationPort = (
  transport: NativeApplicationTransport,
  options: NativeApplicationPortOptions = {},
): NativeApplicationPort => {
  const requestId = options.requestId ?? defaultRequestId;
  const port: NativeApplicationPort = {
    getStatus: (appId, callOptions) =>
      transport.nativeApplicationStatus(appId, transportOptions(callOptions)),
    install: (appId, command, callOptions) =>
      transport.installNativeApplication(
        appId,
        { requestId: requestId(), acceptedTerms: command.acceptedTerms },
        transportOptions(callOptions),
      ),
    launch: (appId, callOptions) =>
      transport.launchNativeApplication(
        appId,
        { requestId: requestId() },
        transportOptions(callOptions),
      ),
  };
  return Object.freeze(port);
};
