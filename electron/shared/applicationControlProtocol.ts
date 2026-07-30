export const APPLICATION_CONTROL_PROTOCOL_VERSION = 1 as const;

export const APPLICATION_CONTROL_IPC_CHANNELS = Object.freeze({
  listCapabilities: 'alsniper-desktop:application-control:list-capabilities',
  execute: 'alsniper-desktop:application-control:execute',
  getReceipt: 'alsniper-desktop:application-control:get-receipt',
} as const);

export const APPLICATION_EFFECT_STATUSES = [
  'committed',
  'rejected',
  'failed',
  'unknown',
  'noop',
] as const;

export const APPLICATION_CONTROL_RISK_LEVELS = ['R0', 'R1', 'R2', 'R3', 'R4'] as const;

export const APPLICATION_CONTROL_ERROR_CODES = [
  'ADAPTER_UNAVAILABLE',
  'ACTION_UNAVAILABLE',
  'APPROVAL_DENIED',
  'APPROVAL_UNAVAILABLE',
  'OUTCOME_UNKNOWN_AFTER_DISPATCH_FENCE',
  'IDEMPOTENCY_CONFLICT',
  'INTERNAL_ERROR',
  'INVALID_ARGUMENT',
  'JOURNAL_UNAVAILABLE',
  'PRECONDITION_FAILED',
  'RECONCILIATION_FAILED',
  'REPLAY_REJECTED',
] as const;

export type ApplicationEffectStatus = (typeof APPLICATION_EFFECT_STATUSES)[number];
export type ApplicationControlRiskLevel = (typeof APPLICATION_CONTROL_RISK_LEVELS)[number];
export type ApplicationControlErrorCode = (typeof APPLICATION_CONTROL_ERROR_CODES)[number];

export type ApplicationControlJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ApplicationControlJsonValue[]
  | Readonly<{ [key: string]: ApplicationControlJsonValue }>;

export interface ApplicationControlPrincipal {
  readonly kind: 'agent';
  readonly instanceId: string;
  readonly packageId: string;
  readonly userId: string;
}

export interface ApplicationControlExecuteRequest {
  readonly protocolVersion: typeof APPLICATION_CONTROL_PROTOCOL_VERSION;
  /** Host-owned effect correlation identifier; never the model-local intent ID. */
  readonly intentId: string;
  /** Principal-scoped durable replay key. In v1 the Host binds it to intentId. */
  readonly idempotencyKey: string;
  readonly principal: ApplicationControlPrincipal;
  readonly appId: string;
  readonly actionId: string;
  readonly arguments: Readonly<Record<string, ApplicationControlJsonValue>>;
  readonly expectedRevision: number;
}

export interface ApplicationActionCapability {
  readonly appId: string;
  readonly actionId: string;
  readonly adapterVersion: string;
  readonly risk: ApplicationControlRiskLevel;
  readonly requiresApproval: boolean;
}

export interface ApplicationControlReceipt {
  readonly protocolVersion: typeof APPLICATION_CONTROL_PROTOCOL_VERSION;
  readonly receiptId: string;
  readonly intentId: string;
  readonly idempotencyKey: string;
  readonly appId: string;
  readonly actionId: string;
  readonly status: ApplicationEffectStatus;
  readonly approvedByUser: boolean;
  readonly retryable: boolean;
  readonly occurredAt: string;
  /** Zero is reserved for a fail-closed refusal when the durable journal is unavailable. */
  readonly journalSequence: number;
  readonly errorCode?: ApplicationControlErrorCode;
  readonly reconcilesReceiptId?: string;
}

export interface ApplicationControlReceiptLookup {
  readonly protocolVersion: typeof APPLICATION_CONTROL_PROTOCOL_VERSION;
  readonly idempotencyKey: string;
  /** Provenance scope only in v1; it is not an authorization credential. */
  readonly principal: ApplicationControlPrincipal;
}

export class ApplicationControlContractError extends Error {
  readonly code = 'INVALID_ARGUMENT' as const;

  constructor(message = 'Invalid application-control bridge argument.') {
    super(message);
    this.name = 'ApplicationControlContractError';
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const PRINCIPAL_IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:@#-]{0,511})$/u;
const APP_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const ACTION_ID_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const MAX_JSON_DEPTH = 20;
const MAX_OBJECT_PROPERTIES = 256;
const MAX_ARRAY_ITEMS = 512;
const MAX_STRING_LENGTH = 32_768;
const MAX_ARGUMENT_BYTES = 65_536;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const permitted = new Set([...required, ...optional]);
  if (
    Object.keys(value).some((key) => !permitted.has(key))
    || required.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new ApplicationControlContractError('Object contains missing or unexpected fields.');
  }
}

function parseIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new ApplicationControlContractError(`${label} must be a bounded opaque identifier.`);
  }
  return value;
}

function parseApplicationIdentifier(value: unknown, label: string, pattern: RegExp): string {
  if (typeof value !== 'string' || value.length > 128 || !pattern.test(value)) {
    throw new ApplicationControlContractError(`${label} is outside the application-control identifier grammar.`);
  }
  return value;
}

function parsePrincipal(value: unknown): ApplicationControlPrincipal {
  if (!isRecord(value)) throw new ApplicationControlContractError('Invalid principal provenance.');
  assertExactKeys(value, ['kind', 'instanceId', 'packageId', 'userId']);
  if (value.kind !== 'agent') throw new ApplicationControlContractError('Only Agent principal provenance is accepted.');
  const parsePart = (part: unknown, label: string): string => {
    if (typeof part !== 'string' || !PRINCIPAL_IDENTIFIER_PATTERN.test(part)) {
      throw new ApplicationControlContractError(`${label} must be a bounded canonical Runtime principal identifier.`);
    }
    return part;
  };
  return Object.freeze({
    kind: 'agent',
    instanceId: parsePart(value.instanceId, 'principal.instanceId'),
    packageId: parsePart(value.packageId, 'principal.packageId'),
    userId: parsePart(value.userId, 'principal.userId'),
  });
}

function cloneJsonValue(value: unknown, depth = 0): ApplicationControlJsonValue {
  if (depth > MAX_JSON_DEPTH) {
    throw new ApplicationControlContractError('Action arguments exceed the structural limits.');
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ApplicationControlContractError('Action arguments must contain finite numbers.');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) throw new ApplicationControlContractError('Action argument string is too long.');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) throw new ApplicationControlContractError('Action argument array is too large.');
    return Object.freeze(value.map((entry) => cloneJsonValue(entry, depth + 1)));
  }
  if (!isRecord(value)) throw new ApplicationControlContractError('Action arguments must be JSON values.');
  if (Object.keys(value).length > MAX_OBJECT_PROPERTIES) {
    throw new ApplicationControlContractError('Action argument object has too many properties.');
  }
  const result: Record<string, ApplicationControlJsonValue> = Object.create(null) as Record<string, ApplicationControlJsonValue>;
  for (const [key, entry] of Object.entries(value)) {
    if (key.length === 0 || key.length > 128 || key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new ApplicationControlContractError('Action argument object contains an invalid key.');
    }
    result[key] = cloneJsonValue(entry, depth + 1);
  }
  return Object.freeze(result);
}

export function parseApplicationControlExecuteRequest(value: unknown): ApplicationControlExecuteRequest {
  if (!isRecord(value)) throw new ApplicationControlContractError();
  assertExactKeys(value, [
    'protocolVersion',
    'intentId',
    'idempotencyKey',
    'principal',
    'appId',
    'actionId',
    'arguments',
    'expectedRevision',
  ]);
  if (value.protocolVersion !== APPLICATION_CONTROL_PROTOCOL_VERSION) {
    throw new ApplicationControlContractError('Unsupported application-control protocol version.');
  }
  if (!isRecord(value.arguments)) throw new ApplicationControlContractError('Action arguments must be an object.');
  if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) {
    throw new ApplicationControlContractError('expectedRevision must be a non-negative safe integer.');
  }
  const argumentsClone = cloneJsonValue(value.arguments) as Readonly<Record<string, ApplicationControlJsonValue>>;
  if (new TextEncoder().encode(JSON.stringify(argumentsClone)).byteLength > MAX_ARGUMENT_BYTES) {
    throw new ApplicationControlContractError('Canonical action arguments exceed 64 KiB.');
  }
  return Object.freeze({
    protocolVersion: APPLICATION_CONTROL_PROTOCOL_VERSION,
    intentId: parseIdentifier(value.intentId, 'intentId'),
    idempotencyKey: parseIdentifier(value.idempotencyKey, 'idempotencyKey'),
    principal: parsePrincipal(value.principal),
    appId: parseApplicationIdentifier(value.appId, 'appId', APP_ID_PATTERN),
    actionId: parseApplicationIdentifier(value.actionId, 'actionId', ACTION_ID_PATTERN),
    arguments: argumentsClone,
    expectedRevision: value.expectedRevision as number,
  });
}

export function cloneApplicationActionCapability(value: unknown): ApplicationActionCapability {
  if (!isRecord(value)) throw new ApplicationControlContractError('Invalid application action capability.');
  assertExactKeys(value, ['appId', 'actionId', 'adapterVersion', 'risk', 'requiresApproval']);
  if (
    typeof value.adapterVersion !== 'string'
    || !VERSION_PATTERN.test(value.adapterVersion)
    || !APPLICATION_CONTROL_RISK_LEVELS.includes(value.risk as ApplicationControlRiskLevel)
    || typeof value.requiresApproval !== 'boolean'
  ) {
    throw new ApplicationControlContractError('Invalid application action capability.');
  }
  return Object.freeze({
    appId: parseApplicationIdentifier(value.appId, 'appId', APP_ID_PATTERN),
    actionId: parseApplicationIdentifier(value.actionId, 'actionId', ACTION_ID_PATTERN),
    adapterVersion: value.adapterVersion,
    risk: value.risk as ApplicationControlRiskLevel,
    requiresApproval: value.requiresApproval,
  });
}

export function cloneApplicationControlReceipt(value: unknown): ApplicationControlReceipt {
  if (!isRecord(value)) throw new ApplicationControlContractError('Invalid application-control receipt.');
  assertExactKeys(
    value,
    ['protocolVersion', 'receiptId', 'intentId', 'idempotencyKey', 'appId', 'actionId', 'status', 'approvedByUser', 'retryable', 'occurredAt', 'journalSequence'],
    ['errorCode', 'reconcilesReceiptId'],
  );
  if (
    value.protocolVersion !== APPLICATION_CONTROL_PROTOCOL_VERSION
    || !APPLICATION_EFFECT_STATUSES.includes(value.status as ApplicationEffectStatus)
    || typeof value.approvedByUser !== 'boolean'
    || typeof value.retryable !== 'boolean'
    || typeof value.occurredAt !== 'string'
    || !Number.isSafeInteger(value.journalSequence)
    || (value.journalSequence as number) < 0
    || (value.errorCode !== undefined && !APPLICATION_CONTROL_ERROR_CODES.includes(value.errorCode as ApplicationControlErrorCode))
  ) {
    throw new ApplicationControlContractError('Invalid application-control receipt.');
  }
  const status = value.status as ApplicationEffectStatus;
  const hasError = value.errorCode !== undefined;
  if (
    ((status === 'committed' || status === 'noop')
      && (value.approvedByUser !== true || value.retryable !== false || hasError))
    || (status === 'unknown'
      && (value.approvedByUser !== true || value.retryable !== false || !hasError))
    || (status === 'rejected'
      && (value.approvedByUser !== false || value.retryable !== false || !hasError))
    || (status === 'failed' && !hasError)
  ) {
    throw new ApplicationControlContractError('Receipt status fields form an impossible application-control outcome.');
  }
  if (
    ((value.journalSequence as number) === 0
      && !(
        status === 'rejected'
        && value.errorCode === 'JOURNAL_UNAVAILABLE'
        && value.reconcilesReceiptId === undefined
      ))
    || ((value.journalSequence as number) > 0
      && status === 'rejected' && value.errorCode === 'JOURNAL_UNAVAILABLE')
  ) {
    throw new ApplicationControlContractError('Journal sequence zero is reserved for a journal-unavailable refusal.');
  }
  const occurredAt = new Date(value.occurredAt);
  if (Number.isNaN(occurredAt.valueOf()) || occurredAt.toISOString() !== value.occurredAt) {
    throw new ApplicationControlContractError('Receipt timestamp must be canonical ISO-8601.');
  }
  return Object.freeze({
    protocolVersion: APPLICATION_CONTROL_PROTOCOL_VERSION,
    receiptId: parseIdentifier(value.receiptId, 'receiptId'),
    intentId: parseIdentifier(value.intentId, 'intentId'),
    idempotencyKey: parseIdentifier(value.idempotencyKey, 'idempotencyKey'),
    appId: parseApplicationIdentifier(value.appId, 'appId', APP_ID_PATTERN),
    actionId: parseApplicationIdentifier(value.actionId, 'actionId', ACTION_ID_PATTERN),
    status,
    approvedByUser: value.approvedByUser,
    retryable: value.retryable,
    occurredAt: value.occurredAt,
    journalSequence: value.journalSequence as number,
    ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode as ApplicationControlErrorCode }),
    ...(value.reconcilesReceiptId === undefined ? {} : {
      reconcilesReceiptId: parseIdentifier(value.reconcilesReceiptId, 'reconcilesReceiptId'),
    }),
  });
}

export function parseApplicationControlReceiptLookup(value: unknown): ApplicationControlReceiptLookup {
  if (!isRecord(value)) throw new ApplicationControlContractError('Invalid receipt lookup.');
  assertExactKeys(value, ['protocolVersion', 'idempotencyKey', 'principal']);
  if (value.protocolVersion !== APPLICATION_CONTROL_PROTOCOL_VERSION) {
    throw new ApplicationControlContractError('Unsupported application-control protocol version.');
  }
  return Object.freeze({
    protocolVersion: APPLICATION_CONTROL_PROTOCOL_VERSION,
    idempotencyKey: parseIdentifier(value.idempotencyKey, 'idempotencyKey'),
    principal: parsePrincipal(value.principal),
  });
}
