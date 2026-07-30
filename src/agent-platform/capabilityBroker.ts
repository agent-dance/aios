import type { AgentManifest, OsCapability } from './agentManifest';
import type { A2uiSurface } from './a2ui';
import {
  capabilityForIntent,
  validateOsIntent,
  validatePublishSurfaceIntent,
  type BrokerIntent,
  type OsIntent,
  type PublishSurfaceIntent,
} from './intents';
import { stableSerialize } from './validation';

export interface AgentPrincipal {
  readonly kind: 'agent';
  readonly instanceId: string;
  readonly packageId: string;
  readonly userId: string;
}

export type IntentRisk = 'low' | 'medium' | 'high';
export type PolicyDecision = 'allow' | 'deny' | 'require-approval';

export interface CapabilityPolicy {
  authorize(input: {
    readonly principal: AgentPrincipal;
    readonly capability: OsCapability;
    readonly risk: IntentRisk;
    readonly intent: BrokerIntent;
  }): PolicyDecision | Promise<PolicyDecision>;
}

export interface TrustedApprovalPort {
  /** This is a trusted Host surface. It must never be implemented by A2UI. */
  request(input: {
    readonly principal: AgentPrincipal;
    readonly capability: OsCapability;
    readonly risk: IntentRisk;
    readonly intent: BrokerIntent;
  }): boolean | Promise<boolean>;
}

export interface OsCapabilityPorts {
  readonly apps: {
    open(appId: string): void | Promise<void>;
    close(appId: string): void | Promise<void>;
    focus(appId: string): void | Promise<void>;
    minimize(appId: string): void | Promise<void>;
  };
  /**
   * Main-owned semantic application control. The Broker, rather than the
   * caller, binds principal, revision, and idempotency to the validated
   * intent immediately before crossing the trusted Host boundary.
   */
  readonly applicationActions: {
    execute(request: ApplicationActionExecutionRequest): ApplicationActionExecutionResult | Promise<ApplicationActionExecutionResult>;
  };
  readonly preferences: {
    update(preferences: Extract<OsIntent, { type: 'set_preferences' }>['preferences']): void | Promise<void>;
  };
  readonly systemStatus: {
    update(statusPatch: Extract<OsIntent, { type: 'set_system_status' }>['statusPatch']): void | Promise<void>;
  };
  readonly store: {
    install(listingId: string): void | Promise<void>;
  };
  readonly agents: {
    install(manifest: AgentManifest): void | Promise<void>;
  };
  readonly surfaces: {
    publish(surface: A2uiSurface, availableIntents: readonly OsIntent[]): void | Promise<void>;
  };
}

export type ApplicationActionExecutionStatus =
  | 'committed'
  | 'noop'
  | 'rejected'
  | 'failed'
  | 'unknown';

export interface ApplicationActionExecutionRequest {
  readonly principal: AgentPrincipal;
  readonly intentId: string;
  readonly idempotencyKey: string;
  readonly appId: string;
  readonly actionId: string;
  readonly arguments: Extract<OsIntent, { type: 'execute_app_action' }>['arguments'];
  readonly expectedRevision: number;
}

export interface ApplicationActionExecutionResult {
  readonly status: ApplicationActionExecutionStatus;
  readonly receiptId: string;
  /** Authoritative approval recorded by the main-owned effect transaction. */
  readonly approvedByUser: boolean;
  readonly retryable: boolean;
  readonly errorCode?: string;
}

export interface CapabilityReceipt {
  readonly intentId: string;
  readonly principal: AgentPrincipal;
  readonly capability: OsCapability;
  readonly risk: IntentRisk;
  readonly accepted: true;
  readonly previousRevision: number;
  readonly revision: number;
  readonly approvedByUser: boolean;
  readonly applicationEffect?: Readonly<{
    readonly status: 'committed' | 'noop';
    readonly receiptId: string;
  }>;
}

export type CapabilityBrokerErrorCode =
  | 'BROKER_INVALID_INTENT'
  | 'BROKER_STALE_REVISION'
  | 'BROKER_CAPABILITY_DENIED'
  | 'BROKER_APPROVAL_REQUIRED'
  | 'BROKER_APPROVAL_DENIED'
  | 'BROKER_IDEMPOTENCY_CONFLICT'
  | 'BROKER_OPERATION_REJECTED'
  | 'BROKER_OPERATION_UNKNOWN'
  | 'BROKER_OPERATION_FAILED';

export class CapabilityBrokerError extends Error {
  readonly code: CapabilityBrokerErrorCode;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(code: CapabilityBrokerErrorCode, message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message);
    this.name = 'CapabilityBrokerError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.cause = options.cause;
  }
}

export interface ExecuteIntentOptions {
  /** Host-captured revision associated with the context supplied to the Agent. */
  readonly expectedRevision?: number;
  /** Host-generated durable key for one application-effect proposal. */
  readonly idempotencyKey?: string;
}

export interface CapabilityBroker {
  getRevision(): number;
  execute(intent: BrokerIntent, options?: ExecuteIntentOptions): Promise<CapabilityReceipt>;
}

export interface CapabilityRevisionClock {
  getRevision(): number;
  bumpRevision(): number;
}

interface CreateCapabilityBrokerOptions {
  readonly principal: AgentPrincipal;
  readonly ports: OsCapabilityPorts;
  readonly policy?: CapabilityPolicy;
  readonly approval?: TrustedApprovalPort;
  readonly initialRevision?: number;
  readonly maxReceipts?: number;
  /** Optional Host clock that also advances for trusted user/system mutations outside this Broker. */
  readonly revisionClock?: CapabilityRevisionClock;
}

const DEFAULT_DENY_POLICY: CapabilityPolicy = Object.freeze({ authorize: () => 'deny' });

export const riskForIntent = (intent: BrokerIntent): IntentRisk => {
  switch (intent.type) {
    case 'open_app':
    case 'focus_app':
    case 'publish_surface': return 'low';
    case 'close_app':
    case 'minimize_app':
    case 'set_preferences': return 'medium';
    case 'set_system_status': return 'medium';
    case 'install_app':
    case 'install_agent':
    case 'execute_app_action': return 'high';
  }
};

const validateBrokerIntent = (candidate: BrokerIntent): BrokerIntent =>
  candidate.type === 'publish_surface'
    ? validatePublishSurfaceIntent(candidate)
    : validateOsIntent(candidate);

const executePort = async (
  ports: OsCapabilityPorts,
  intent: BrokerIntent,
  principal: AgentPrincipal,
  expectedRevision: number,
  idempotencyKey: string,
): Promise<ApplicationActionExecutionResult | undefined> => {
  switch (intent.type) {
    case 'open_app': await ports.apps.open(intent.appId); return undefined;
    case 'close_app': await ports.apps.close(intent.appId); return undefined;
    case 'focus_app': await ports.apps.focus(intent.appId); return undefined;
    case 'minimize_app': await ports.apps.minimize(intent.appId); return undefined;
    case 'execute_app_action': return ports.applicationActions.execute(Object.freeze({
      principal,
      // The model-local intent ID is only UI correlation. Main receives a
      // Host-owned effect identifier so a later model turn may safely reuse
      // the same local ID without aliasing an earlier durable effect.
      intentId: idempotencyKey,
      idempotencyKey,
      appId: intent.appId,
      actionId: intent.actionId,
      arguments: intent.arguments,
      expectedRevision,
    }));
    case 'set_preferences': await ports.preferences.update(intent.preferences); return undefined;
    case 'set_system_status': await ports.systemStatus.update(intent.statusPatch); return undefined;
    case 'install_app': await ports.store.install(intent.listingId); return undefined;
    case 'install_agent': await ports.agents.install(intent.manifest); return undefined;
    case 'publish_surface': await ports.surfaces.publish(intent.surface, intent.availableIntents); return undefined;
  }
};

const validateApplicationActionExecutionResult = (
  result: ApplicationActionExecutionResult,
): ApplicationActionExecutionResult => {
  const permittedKeys = new Set(['status', 'receiptId', 'approvedByUser', 'retryable', 'errorCode']);
  const success = result?.status === 'committed' || result?.status === 'noop';
  const hasError = typeof result?.errorCode === 'string';
  if (
    result === null
    || typeof result !== 'object'
    || Object.keys(result).some((key) => !permittedKeys.has(key))
    || !['status', 'receiptId', 'approvedByUser', 'retryable'].every((key) => Object.hasOwn(result, key))
    || !['committed', 'noop', 'rejected', 'failed', 'unknown'].includes(result.status)
    || typeof result.receiptId !== 'string'
    || result.receiptId.length === 0
    || result.receiptId.length > 128
    || typeof result.approvedByUser !== 'boolean'
    || typeof result.retryable !== 'boolean'
    || (result.errorCode !== undefined && (typeof result.errorCode !== 'string' || result.errorCode.length > 128))
    || (success && (result.approvedByUser !== true || result.retryable !== false || hasError))
    || (result.status === 'unknown'
      && (result.approvedByUser !== true || result.retryable !== false || !hasError))
    || (result.status === 'rejected'
      && (result.approvedByUser !== false || result.retryable !== false || !hasError))
    || (result.status === 'failed' && !hasError)
  ) {
    throw new CapabilityBrokerError('BROKER_OPERATION_FAILED', 'Application control returned an invalid result.');
  }
  return Object.freeze({
    status: result.status,
    receiptId: result.receiptId,
    approvedByUser: result.approvedByUser,
    retryable: result.retryable,
    ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
  });
};

export const createCapabilityBroker = (options: CreateCapabilityBrokerOptions): CapabilityBroker => {
  const principal = Object.freeze({ ...options.principal });
  if (principal.kind !== 'agent' || !principal.instanceId || !principal.packageId || !principal.userId) {
    throw new Error('principal must be a fully bound Agent identity');
  }
  const policy = options.policy ?? DEFAULT_DENY_POLICY;
  const maxReceipts = options.maxReceipts ?? 1_000;
  if (!Number.isSafeInteger(maxReceipts) || maxReceipts < 1) throw new Error('maxReceipts must be a positive safe integer');
  let revision = options.initialRevision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('initialRevision must be a non-negative safe integer');
  const currentRevision = (): number => options.revisionClock?.getRevision() ?? revision;
  const commitRevision = (): number => {
    if (!options.revisionClock) {
      revision += 1;
      return revision;
    }
    const next = options.revisionClock.bumpRevision();
    if (!Number.isSafeInteger(next) || next < 0) throw new CapabilityBrokerError('BROKER_OPERATION_FAILED', 'Host revision clock returned an invalid revision.');
    return next;
  };
  const receipts = new Map<string, { readonly fingerprint: string; readonly receipt: CapabilityReceipt }>();
  let queue: Promise<void> = Promise.resolve();

  const runExclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  return Object.freeze({
    getRevision: currentRevision,
    execute: (candidate: BrokerIntent, executeOptions: ExecuteIntentOptions = {}) => runExclusive(async () => {
      let intent: BrokerIntent;
      try { intent = validateBrokerIntent(candidate); } catch (error) {
        throw new CapabilityBrokerError('BROKER_INVALID_INTENT', 'Intent is outside the OS capability schema.', { cause: error });
      }
      const expectedRevision = intent.expectedRevision ?? executeOptions.expectedRevision;
      if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0) {
        throw new CapabilityBrokerError('BROKER_INVALID_INTENT', 'A Host-bound expected revision is required.');
      }
      const idempotencyKey = intent.type === 'execute_app_action'
        ? executeOptions.idempotencyKey
        : intent.id;
      if (
        typeof idempotencyKey !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(idempotencyKey)
      ) {
        throw new CapabilityBrokerError(
          'BROKER_INVALID_INTENT',
          'A Host-bound idempotency key is required for application actions.',
        );
      }
      const fingerprint = stableSerialize({ principal, intent, expectedRevision, idempotencyKey });
      const prior = receipts.get(idempotencyKey);
      if (prior) {
        if (prior.fingerprint !== fingerprint) {
          throw new CapabilityBrokerError('BROKER_IDEMPOTENCY_CONFLICT', 'The Host-bound idempotency key was reused with a different payload.');
        }
        return prior.receipt;
      }
      if (expectedRevision !== currentRevision()) {
        throw new CapabilityBrokerError('BROKER_STALE_REVISION', 'OS state changed after the Agent observed it.', { retryable: true });
      }
      const capability = capabilityForIntent(intent);
      const risk = riskForIntent(intent);
      let decision: PolicyDecision;
      try { decision = await policy.authorize({ principal, capability, risk, intent }); } catch (error) {
        throw new CapabilityBrokerError('BROKER_CAPABILITY_DENIED', 'Capability policy could not authorize the intent.', { cause: error });
      }
      if (decision !== 'allow' && decision !== 'deny' && decision !== 'require-approval') {
        throw new CapabilityBrokerError('BROKER_CAPABILITY_DENIED', 'Capability policy returned an invalid decision.');
      }
      if (decision === 'deny') throw new CapabilityBrokerError('BROKER_CAPABILITY_DENIED', 'Agent is not authorized for this capability.');
      let approvedByUser = false;
      if (decision === 'require-approval') {
        if (!options.approval) throw new CapabilityBrokerError('BROKER_APPROVAL_REQUIRED', 'A trusted Host approval surface is required.');
        try { approvedByUser = await options.approval.request({ principal, capability, risk, intent }); } catch (error) {
          throw new CapabilityBrokerError('BROKER_APPROVAL_DENIED', 'Trusted approval did not complete.', { cause: error });
        }
        if (!approvedByUser) throw new CapabilityBrokerError('BROKER_APPROVAL_DENIED', 'User denied the requested capability.');
      }
      if (expectedRevision !== currentRevision()) {
        throw new CapabilityBrokerError('BROKER_STALE_REVISION', 'OS state changed while the intent awaited authorization.', { retryable: true });
      }
      let applicationEffect: ApplicationActionExecutionResult | undefined;
      try {
        applicationEffect = await executePort(
          options.ports,
          intent,
          principal,
          expectedRevision as number,
          idempotencyKey,
        );
      } catch (error) {
        if (error instanceof CapabilityBrokerError) throw error;
        throw new CapabilityBrokerError('BROKER_OPERATION_FAILED', 'The OS capability operation failed.', { cause: error });
      }
      let committedApplicationEffect: Readonly<{
        readonly status: 'committed' | 'noop';
        readonly receiptId: string;
        readonly approvedByUser: boolean;
      }> | undefined;
      if (applicationEffect !== undefined) {
        let effect: ApplicationActionExecutionResult;
        try { effect = validateApplicationActionExecutionResult(applicationEffect); } catch (error) {
          if (error instanceof CapabilityBrokerError) throw error;
          throw new CapabilityBrokerError('BROKER_OPERATION_FAILED', 'Application control returned an invalid result.', { cause: error });
        }
        if (effect.status === 'rejected') {
          throw new CapabilityBrokerError(
            'BROKER_OPERATION_REJECTED',
            'The application rejected the requested action.',
            { cause: effect },
          );
        }
        if (effect.status === 'unknown') {
          throw new CapabilityBrokerError(
            'BROKER_OPERATION_UNKNOWN',
            'The application action outcome is unknown. It was not retried to avoid duplicating an external effect.',
            { cause: effect },
          );
        }
        if (effect.status === 'failed') {
          throw new CapabilityBrokerError(
            'BROKER_OPERATION_FAILED',
            'The application action failed.',
            { retryable: effect.retryable, cause: effect },
          );
        }
        committedApplicationEffect = Object.freeze({
          status: effect.status,
          receiptId: effect.receiptId,
          approvedByUser: effect.approvedByUser,
        });
      }
      const previousRevision = expectedRevision;
      revision = commitRevision();
      const receipt = Object.freeze({
        intentId: intent.id,
        principal,
        capability,
        risk,
        accepted: true as const,
        previousRevision,
        revision,
        approvedByUser: committedApplicationEffect?.approvedByUser ?? approvedByUser,
        ...(committedApplicationEffect === undefined ? {} : {
          applicationEffect: Object.freeze({
            status: committedApplicationEffect.status,
            receiptId: committedApplicationEffect.receiptId,
          }),
        }),
      });
      if (receipts.size >= maxReceipts) {
        const oldestIdempotencyKey = receipts.keys().next().value as string | undefined;
        if (oldestIdempotencyKey !== undefined) receipts.delete(oldestIdempotencyKey);
      }
      receipts.set(idempotencyKey, { fingerprint, receipt });
      return receipt;
    }),
  });
};

export const createPublishSurfaceIntent = (
  id: string,
  surface: A2uiSurface,
  availableIntents: readonly OsIntent[],
  expectedRevision: number,
): PublishSurfaceIntent => validatePublishSurfaceIntent({ id, type: 'publish_surface', surface, availableIntents, expectedRevision });
