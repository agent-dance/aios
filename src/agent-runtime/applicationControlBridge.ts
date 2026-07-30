import {
  APPLICATION_CONTROL_PROTOCOL_VERSION,
  cloneApplicationActionCapability,
  cloneApplicationControlReceipt,
  parseApplicationControlExecuteRequest,
  type ApplicationControlExecuteRequest,
  type ApplicationControlReceipt,
  type ApplicationActionCapability,
} from '../../electron/shared/applicationControlProtocol';

export type ApplicationControlExecute = (
  request: ApplicationControlExecuteRequest,
) => Promise<ApplicationControlReceipt>;

interface ApplicationControlBridge {
  readonly listCapabilities: () => Promise<readonly ApplicationActionCapability[]>;
  readonly execute: ApplicationControlExecute;
}

type ApplicationControlHostWindow = Window & {
  readonly alsniperDesktop?: {
    readonly applicationControl?: unknown;
  };
};

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Resolves only semantic capability discovery and execution. The renderer
 * never receives IPC channel names, adapter handles, DOM selectors, or
 * arbitrary script execution authority.
 */
export function resolveApplicationControlBridge(
  hostWindow: ApplicationControlHostWindow | undefined = typeof window === 'undefined'
    ? undefined
    : window as ApplicationControlHostWindow,
): ApplicationControlBridge | null {
  const candidate = hostWindow?.alsniperDesktop?.applicationControl;
  if (
    !isRecord(candidate)
    || typeof candidate.listCapabilities !== 'function'
    || typeof candidate.execute !== 'function'
  ) return null;
  const listCapabilities = candidate.listCapabilities.bind(candidate) as () => Promise<unknown>;
  const execute = candidate.execute.bind(candidate) as (request: unknown) => Promise<unknown>;
  return Object.freeze({
    listCapabilities: async () => {
      const raw = await listCapabilities();
      if (!Array.isArray(raw) || raw.length > 64) {
        throw new Error('Application-control capability catalog is invalid.');
      }
      return Object.freeze(raw.map(cloneApplicationActionCapability));
    },
    execute: async (request: ApplicationControlExecuteRequest) => {
      const trustedRequest = parseApplicationControlExecuteRequest(request);
      const receipt = cloneApplicationControlReceipt(await execute(trustedRequest));
      if (
        receipt.intentId !== trustedRequest.intentId
        || receipt.idempotencyKey !== trustedRequest.idempotencyKey
        || receipt.appId !== trustedRequest.appId
        || receipt.actionId !== trustedRequest.actionId
      ) {
        throw new Error('Application-control receipt does not match the bound request.');
      }
      return receipt;
    },
  });
}

export const executeDesktopApplicationAction: ApplicationControlExecute = async (request) => {
  if (request.protocolVersion !== APPLICATION_CONTROL_PROTOCOL_VERSION) {
    throw new Error('Unsupported application-control protocol version.');
  }
  const bridge = resolveApplicationControlBridge();
  if (bridge === null) throw new Error('The trusted desktop application-control bridge is unavailable.');
  return bridge.execute(request);
};

export const listDesktopApplicationActions = async (): Promise<readonly ApplicationActionCapability[]> => {
  const bridge = resolveApplicationControlBridge();
  if (bridge === null) throw new Error('The trusted desktop application-control bridge is unavailable.');
  return bridge.listCapabilities();
};
