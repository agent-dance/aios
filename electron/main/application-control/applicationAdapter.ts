import type {
  ApplicationActionCapability,
  ApplicationControlErrorCode,
  ApplicationControlExecuteRequest,
  ApplicationEffectStatus,
} from '../../shared/applicationControlProtocol.js';
import {
  APPLICATION_CONTROL_ERROR_CODES,
} from '../../shared/applicationControlProtocol.js';

export interface TrustedApprovalDescription {
  /** Trusted title supplied by the adapter, never by Agent-provided display text. */
  readonly title: string;
  readonly message: string;
  /** May contain sensitive recipient/body data. It is memory-only and must never enter logs or journals. */
  readonly detail: string;
  readonly confirmLabel: string;
}

export interface ApplicationControlGrant {
  readonly grantId: string;
  readonly requestFingerprint: string;
  readonly preparedFingerprint: string;
  readonly expiresAt: number;
  readonly consumed: boolean;
  consume(expectedRequestFingerprint: string, expectedPreparedFingerprint: string): void;
}

export interface PreparedApplicationAction<TPrepared = unknown> {
  readonly preparedFingerprint: string;
  readonly approval: TrustedApprovalDescription;
  /** Optional SHA-256 fingerprints used for recovery without persisting recipient/body plaintext. */
  readonly reconciliation?: {
    readonly targetFingerprint: string;
    readonly effectFingerprint: string;
  };
  /** Adapter-owned memory-only state. It must never be serialized by the Host. */
  readonly state: TPrepared;
}

export interface ApplicationAdapterCommitResult {
  readonly status: Exclude<ApplicationEffectStatus, 'rejected'>;
  readonly retryable?: boolean;
  readonly errorCode?: ApplicationControlErrorCode;
}

export interface ApplicationAdapterReconciliationInput {
  readonly appId: string;
  readonly actionId: string;
  readonly requestFingerprint: string;
  readonly effectStartedAt: string;
  readonly matchesTargetFingerprint?: (candidateSha256: string) => boolean;
  readonly matchesEffectFingerprint?: (candidateSha256: string) => boolean;
}

export interface ApplicationAdapterReconciliationResult {
  readonly status: 'committed' | 'failed' | 'unknown' | 'noop';
  readonly retryable?: boolean;
  readonly errorCode?: ApplicationControlErrorCode;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseResultFields(
  value: unknown,
  statuses: readonly string[],
): {
  readonly status: string;
  readonly retryable?: boolean;
  readonly errorCode?: ApplicationControlErrorCode;
} {
  if (!isPlainRecord(value)) throw new Error('Application adapter result must be a plain object.');
  const keys = Object.keys(value);
  if (
    keys.some((key) => key !== 'status' && key !== 'retryable' && key !== 'errorCode')
    || !Object.hasOwn(value, 'status')
    || typeof value.status !== 'string'
    || !statuses.includes(value.status)
    || (value.retryable !== undefined && typeof value.retryable !== 'boolean')
    || (value.errorCode !== undefined
      && !APPLICATION_CONTROL_ERROR_CODES.includes(value.errorCode as ApplicationControlErrorCode))
  ) throw new Error('Application adapter result is outside its closed schema.');
  const status = value.status;
  const retryable = value.retryable;
  const errorCode = value.errorCode as ApplicationControlErrorCode | undefined;
  if (
    ((status === 'committed' || status === 'noop') && (retryable === true || errorCode !== undefined))
    || (status === 'unknown' && retryable === true)
  ) throw new Error('Application adapter result contains an impossible status combination.');
  return Object.freeze({
    status,
    ...(retryable === undefined ? {} : { retryable }),
    ...(errorCode === undefined ? {} : { errorCode }),
  });
}

export function parseApplicationAdapterCommitResult(value: unknown): ApplicationAdapterCommitResult {
  const parsed = parseResultFields(value, ['committed', 'failed', 'unknown', 'noop']);
  return Object.freeze({
    status: parsed.status as ApplicationAdapterCommitResult['status'],
    ...(parsed.retryable === undefined ? {} : { retryable: parsed.retryable }),
    ...(parsed.errorCode === undefined ? {} : { errorCode: parsed.errorCode }),
  });
}

export function parseApplicationAdapterReconciliationResult(
  value: unknown,
): ApplicationAdapterReconciliationResult {
  const parsed = parseResultFields(value, ['committed', 'failed', 'unknown', 'noop']);
  return Object.freeze({
    status: parsed.status as ApplicationAdapterReconciliationResult['status'],
    ...(parsed.retryable === undefined ? {} : { retryable: parsed.retryable }),
    ...(parsed.errorCode === undefined ? {} : { errorCode: parsed.errorCode }),
  });
}

export interface ApplicationAdapter<TPrepared = unknown> {
  readonly appId: string;
  listCapabilities(): readonly ApplicationActionCapability[];
  prepare(request: ApplicationControlExecuteRequest): Promise<PreparedApplicationAction<TPrepared>>;
  commit(input: {
    readonly request: ApplicationControlExecuteRequest;
    readonly prepared: PreparedApplicationAction<TPrepared>;
    readonly grant: ApplicationControlGrant;
  }): Promise<ApplicationAdapterCommitResult>;
  reconcile?(input: ApplicationAdapterReconciliationInput): Promise<ApplicationAdapterReconciliationResult>;
}
