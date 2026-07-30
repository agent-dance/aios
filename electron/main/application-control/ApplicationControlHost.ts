import { randomUUID } from 'node:crypto';
import {
  APPLICATION_CONTROL_ERROR_CODES,
  cloneApplicationActionCapability,
  cloneApplicationControlReceipt,
  parseApplicationControlExecuteRequest,
  parseApplicationControlReceiptLookup,
  type ApplicationActionCapability,
  type ApplicationControlErrorCode,
  type ApplicationControlExecuteRequest,
  type ApplicationControlReceipt,
  type ApplicationControlReceiptLookup,
} from '../../shared/applicationControlProtocol.js';
import type {
  ApplicationAdapter,
  ApplicationControlGrant,
  TrustedApprovalDescription,
} from './applicationAdapter.js';
import {
  parseApplicationAdapterCommitResult,
  parseApplicationAdapterReconciliationResult,
} from './applicationAdapter.js';
import {
  ApplicationEffectJournal,
  type UnresolvedApplicationEffect,
} from './effectJournal.js';
import type { ApplicationControlService } from './applicationControlService.js';
import { UnavailableApplicationControlService } from './UnavailableApplicationControlService.js';

const GRANT_LIFETIME_MS = 30_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export interface TrustedApplicationApprovalPort {
  request(input: {
    readonly capability: ApplicationActionCapability;
    readonly description: TrustedApprovalDescription;
    /** Caller-supplied provenance. It is display context, never authorization. */
    readonly request: ApplicationControlExecuteRequest;
  }): Promise<boolean>;
}

export interface ApplicationControlHostLogger {
  error(message: string): void;
}

export interface ApplicationControlHostOptions {
  readonly journal: ApplicationEffectJournal;
  readonly approval: TrustedApplicationApprovalPort;
  readonly logger?: ApplicationControlHostLogger;
}

interface RegisteredApplicationAdapter {
  readonly adapter: ApplicationAdapter;
  readonly capabilities: readonly ApplicationActionCapability[];
}

const defaultLogger: ApplicationControlHostLogger = {
  error: (message) => console.error(message),
};

class OneShotApplicationControlGrant implements ApplicationControlGrant {
  readonly grantId = randomUUID();
  readonly requestFingerprint: string;
  readonly preparedFingerprint: string;
  readonly expiresAt: number;
  #consumed = false;

  constructor(requestFingerprint: string, preparedFingerprint: string, now = Date.now()) {
    this.requestFingerprint = requestFingerprint;
    this.preparedFingerprint = preparedFingerprint;
    this.expiresAt = now + GRANT_LIFETIME_MS;
  }

  get consumed(): boolean {
    return this.#consumed;
  }

  consume(expectedRequestFingerprint: string, expectedPreparedFingerprint: string): void {
    if (this.#consumed) throw new Error('Application-control grant has already been consumed.');
    if (Date.now() > this.expiresAt) throw new Error('Application-control grant has expired.');
    if (
      expectedRequestFingerprint !== this.requestFingerprint
      || expectedPreparedFingerprint !== this.preparedFingerprint
    ) {
      throw new Error('Application-control grant binding does not match the prepared action.');
    }
    this.#consumed = true;
  }
}

function safeErrorCode(error: unknown, fallback: ApplicationControlErrorCode): ApplicationControlErrorCode {
  if (
    typeof error === 'object'
    && error !== null
    && 'errorCode' in error
    && APPLICATION_CONTROL_ERROR_CODES.includes(error.errorCode as ApplicationControlErrorCode)
  ) {
    return error.errorCode as ApplicationControlErrorCode;
  }
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && APPLICATION_CONTROL_ERROR_CODES.includes(error.code as ApplicationControlErrorCode)
  ) {
    return error.code as ApplicationControlErrorCode;
  }
  return fallback;
}

function preparationFailureStatus(errorCode: ApplicationControlErrorCode): 'rejected' | 'failed' {
  return errorCode === 'INVALID_ARGUMENT'
    || errorCode === 'PRECONDITION_FAILED'
    || errorCode === 'ACTION_UNAVAILABLE'
    || errorCode === 'ADAPTER_UNAVAILABLE'
    ? 'rejected'
    : 'failed';
}

function validateApprovalDescription(value: TrustedApprovalDescription): void {
  const fields = [value.title, value.message, value.detail, value.confirmLabel];
  const unsafeApprovalText = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
  if (
    fields.some((field) => typeof field !== 'string' || field.length === 0 || unsafeApprovalText.test(field))
    || value.title.length > 128
    || value.message.length > 512
    || value.detail.length > 16_384
    || value.confirmLabel.length > 32
  ) {
    throw new Error('Adapter returned an invalid trusted approval description.');
  }
}

export class ApplicationControlHost implements ApplicationControlService {
  readonly #journal: ApplicationEffectJournal;
  readonly #approval: TrustedApplicationApprovalPort;
  readonly #logger: ApplicationControlHostLogger;
  readonly #adapters = new Map<string, RegisteredApplicationAdapter>();
  readonly #unavailable = new UnavailableApplicationControlService();
  readonly #volatileReceipts = new Map<string, {
    readonly requestFingerprint: string;
    readonly receipt: ApplicationControlReceipt;
  }>();
  #queue: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: ApplicationControlHostOptions) {
    this.#journal = options.journal;
    this.#approval = options.approval;
    this.#logger = options.logger ?? defaultLogger;
  }

  async initialize(): Promise<void> {
    this.#assertActive();
    await this.#journal.recoverInterruptedDispatches();
  }

  async registerAdapter(adapter: ApplicationAdapter): Promise<() => void> {
    this.#assertActive();
    const capabilities = this.#validateAdapter(adapter);
    if (this.#adapters.has(adapter.appId)) throw new Error(`Application adapter is already registered: ${adapter.appId}`);
    const registration = Object.freeze({ adapter, capabilities });
    this.#adapters.set(adapter.appId, registration);
    await this.#reconcileAdapter(adapter, capabilities);
    return () => {
      if (this.#adapters.get(adapter.appId) === registration) this.#adapters.delete(adapter.appId);
    };
  }

  listCapabilities(): readonly ApplicationActionCapability[] {
    this.#assertActive();
    if (!this.#journal.isHealthy) return Object.freeze([]);
    const capabilities = [...this.#adapters.values()]
      .flatMap((registration) => registration.capabilities)
      .sort((left, right) => `${left.appId}\0${left.actionId}`.localeCompare(`${right.appId}\0${right.actionId}`));
    return Object.freeze(capabilities);
  }

  execute(candidate: unknown): Promise<ApplicationControlReceipt> {
    let request: ApplicationControlExecuteRequest;
    try {
      request = parseApplicationControlExecuteRequest(candidate);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!this.#journal.isHealthy) return this.#unavailableExecute(request);
    return this.#runExclusive(() => this.#execute(request)).catch((error: unknown) => {
      // A persistence failure before a dispatch fence means no external effect
      // was authorized to start. Convert the first observed failure into the
      // same stable fail-closed refusal used by an unavailable startup journal.
      if (!this.#journal.isHealthy) return this.#unavailableExecute(request);
      throw error;
    });
  }

  getReceipt(candidate: unknown): ApplicationControlReceipt | null {
    this.#assertActive();
    const lookup: ApplicationControlReceiptLookup = parseApplicationControlReceiptLookup(candidate);
    const principalFingerprint = this.#journal.fingerprintPrincipalValue(lookup.principal);
    const receipt = this.#journal.getLatestReceipt(lookup.idempotencyKey, principalFingerprint);
    if (receipt !== null) return cloneApplicationControlReceipt(receipt);
    const volatile = this.#volatileReceipts.get(`${principalFingerprint}\0${lookup.idempotencyKey}`)?.receipt;
    if (volatile !== undefined) return cloneApplicationControlReceipt(volatile);
    return this.#journal.isHealthy ? null : this.#unavailable.getReceipt(lookup);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#queue;
    this.#adapters.clear();
    this.#volatileReceipts.clear();
    await this.#unavailable.close();
    await this.#journal.close();
  }

  async #execute(request: ApplicationControlExecuteRequest): Promise<ApplicationControlReceipt> {
    this.#assertActive();
    if (!this.#journal.isHealthy) return this.#unavailableExecute(request);
    const requestFingerprint = this.#journal.fingerprintRequest(request);
    const principalFingerprint = this.#journal.fingerprintPrincipal(request);
    const keyBinding = this.#journal.getBindingByIdempotencyKey(
      request.idempotencyKey,
      principalFingerprint,
    );
    if (keyBinding !== null) {
      if (keyBinding.requestFingerprint === requestFingerprint) {
        const receipt = this.#journal.getLatestReceipt(request.idempotencyKey, principalFingerprint);
        if (receipt !== null) return receipt;
      }
      const existingConflict = this.#journal.getConflictReceipt(request.idempotencyKey, principalFingerprint);
      if (existingConflict !== null) {
        return cloneApplicationControlReceipt({
          ...existingConflict,
          intentId: request.intentId,
          idempotencyKey: request.idempotencyKey,
          appId: request.appId,
          actionId: request.actionId,
        });
      }
      return this.#journal.appendTerminalReceipt({
        request,
        requestFingerprint,
        principalFingerprint,
        status: 'rejected',
        approvedByUser: false,
        retryable: false,
        errorCode: 'IDEMPOTENCY_CONFLICT',
      });
    }

    const registration = this.#adapters.get(request.appId);
    if (registration === undefined) {
      return this.#journal.appendTerminalReceipt({
        request, requestFingerprint, principalFingerprint,
        status: 'rejected', approvedByUser: false, retryable: false, errorCode: 'ADAPTER_UNAVAILABLE',
      });
    }
    const { adapter } = registration;
    const capability = registration.capabilities
      .find((entry) => entry.appId === request.appId && entry.actionId === request.actionId);
    if (capability === undefined) {
      return this.#journal.appendTerminalReceipt({
        request, requestFingerprint, principalFingerprint,
        status: 'rejected', approvedByUser: false, retryable: false, errorCode: 'ACTION_UNAVAILABLE',
      });
    }

    let prepared;
    try {
      prepared = await adapter.prepare(request);
      if (!SHA256_PATTERN.test(prepared.preparedFingerprint)) {
        throw new Error('Adapter prepared fingerprint is invalid.');
      }
      if (prepared.reconciliation !== undefined) {
        if (
          !SHA256_PATTERN.test(prepared.reconciliation.targetFingerprint)
          || !SHA256_PATTERN.test(prepared.reconciliation.effectFingerprint)
        ) throw new Error('Adapter reconciliation fingerprints are invalid.');
      }
      validateApprovalDescription(prepared.approval);
    } catch (error) {
      const errorCode = safeErrorCode(error, 'PRECONDITION_FAILED');
      return this.#journal.appendTerminalReceipt({
        request, requestFingerprint, principalFingerprint,
        status: preparationFailureStatus(errorCode), approvedByUser: false, retryable: false, errorCode,
      });
    }

    // v1 treats caller principal fields as provenance only. Every effect receives
    // fresh native approval, so spoofing packageId cannot bypass policy.
    let approved: boolean;
    try {
      approved = await this.#approval.request({ capability, description: prepared.approval, request });
    } catch (error) {
      this.#logger.error('Trusted application-control approval failed; details were redacted.');
      return this.#journal.appendTerminalReceipt({
        request, requestFingerprint, principalFingerprint,
        status: 'rejected', approvedByUser: false, retryable: false, errorCode: 'APPROVAL_UNAVAILABLE',
      });
    }
    if (!approved) {
      return this.#journal.appendTerminalReceipt({
        request, requestFingerprint, principalFingerprint,
        status: 'rejected', approvedByUser: false, retryable: false, errorCode: 'APPROVAL_DENIED',
      });
    }

    const grant = new OneShotApplicationControlGrant(requestFingerprint, prepared.preparedFingerprint);
    const fence = await this.#journal.appendDispatchFence({
      request,
      requestFingerprint,
      preparedFingerprint: prepared.preparedFingerprint,
      approvedByUser: true,
      ...(prepared.reconciliation === undefined ? {} : prepared.reconciliation),
    });

    let status: 'committed' | 'failed' | 'unknown' | 'noop';
    let retryable = false;
    let errorCode: ApplicationControlErrorCode | undefined;
    try {
      const result = parseApplicationAdapterCommitResult(
        await adapter.commit({ request, prepared, grant }),
      );
      if (!grant.consumed) throw new Error('Application adapter did not consume its one-shot grant.');
      status = result.status;
      retryable = status === 'unknown' ? false : (result.retryable ?? false);
      errorCode = result.errorCode;
      if (status === 'unknown' && errorCode === undefined) errorCode = 'RECONCILIATION_FAILED';
      if (status === 'failed' && errorCode === undefined) errorCode = 'INTERNAL_ERROR';
      if ((status === 'committed' || status === 'noop') && errorCode !== undefined) {
        throw new Error('Successful adapter result must not contain an error code.');
      }
    } catch (error) {
      // The durable fence exists, therefore a thrown error can never be retried as
      // definitely-not-dispatched. Preserve unknown until explicit reconciliation.
      this.#logger.error('Application adapter failed after its durable dispatch fence; details were redacted.');
      status = 'unknown';
      retryable = false;
      errorCode = safeErrorCode(error, 'INTERNAL_ERROR');
    }

    try {
      return await this.#journal.appendTerminalReceipt({
        request,
        requestFingerprint,
        principalFingerprint,
        receiptId: fence.receiptId,
        status,
        approvedByUser: true,
        retryable,
        ...(errorCode === undefined ? {} : { errorCode }),
        dispatchReceiptId: fence.receiptId,
      });
    } catch (error) {
      this.#logger.error('Application result could not be durably appended after dispatch; details were redacted.');
      const receipt = cloneApplicationControlReceipt({
        protocolVersion: 1,
        receiptId: fence.receiptId,
        intentId: request.intentId,
        idempotencyKey: request.idempotencyKey,
        appId: request.appId,
        actionId: request.actionId,
        status: 'unknown',
        approvedByUser: true,
        retryable: false,
        occurredAt: fence.effectStartedAt,
        journalSequence: fence.sequence,
        errorCode: 'OUTCOME_UNKNOWN_AFTER_DISPATCH_FENCE',
      });
      this.#volatileReceipts.set(`${principalFingerprint}\0${request.idempotencyKey}`, {
        requestFingerprint,
        receipt,
      });
      return receipt;
    }
  }

  #validateAdapter(adapter: ApplicationAdapter): readonly ApplicationActionCapability[] {
    const capabilities = adapter.listCapabilities().map(cloneApplicationActionCapability);
    if (capabilities.length === 0 || capabilities.some((entry) => entry.appId !== adapter.appId)) {
      throw new Error('Application adapter capabilities must be non-empty and match adapter.appId.');
    }
    const actionIds = new Set<string>();
    for (const capability of capabilities) {
      if (actionIds.has(capability.actionId)) throw new Error('Application adapter contains duplicate action IDs.');
      actionIds.add(capability.actionId);
    }
    return Object.freeze(capabilities);
  }

  async #reconcileAdapter(
    adapter: ApplicationAdapter,
    capabilities: readonly ApplicationActionCapability[],
  ): Promise<void> {
    if (adapter.reconcile === undefined) return;
    const legalActions = new Set(capabilities.map((entry) => entry.actionId));
    const effects = this.#journal.listUnresolvedEffects()
      .filter((effect) => effect.receipt.appId === adapter.appId && legalActions.has(effect.receipt.actionId));
    for (const effect of effects) {
      await this.#reconcileEffect(adapter, effect);
    }
  }

  async #reconcileEffect(adapter: ApplicationAdapter, effect: UnresolvedApplicationEffect): Promise<void> {
    let result;
    try {
      const candidate = await adapter.reconcile?.({
        appId: effect.receipt.appId,
        actionId: effect.receipt.actionId,
        requestFingerprint: effect.requestFingerprint,
        effectStartedAt: effect.effectStartedAt,
        ...(effect.targetFingerprint === undefined ? {} : {
          matchesTargetFingerprint: (candidateSha256: string) => (
            this.#journal.matchesReconciliationTarget(effect.targetFingerprint as string, candidateSha256)
          ),
        }),
        ...(effect.effectFingerprint === undefined ? {} : {
          matchesEffectFingerprint: (candidateSha256: string) => (
            this.#journal.matchesReconciliationEffect(effect.effectFingerprint as string, candidateSha256)
          ),
        }),
      });
      result = candidate === undefined
        ? undefined
        : parseApplicationAdapterReconciliationResult(candidate);
    } catch {
      this.#logger.error('Application effect reconciliation failed; details were redacted.');
      // No new evidence exists. Preserve the original immutable Unknown
      // receipt instead of appending an identical Unknown on every launch.
      return;
    }
    if (result === undefined || result.status === 'unknown') return;
    // A durable append failure is a control-plane failure, not an adapter
    // observation failure. Propagate it so startup disables all dispatch.
    const errorCode = result.errorCode ?? (result.status === 'failed' ? 'INTERNAL_ERROR' : undefined);
    await this.#journal.appendReconciliation({
      unresolved: effect,
      status: result.status,
      retryable: result.retryable ?? false,
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  }

  #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertActive();
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  #unavailableExecute(request: ApplicationControlExecuteRequest): Promise<ApplicationControlReceipt> {
    const principalFingerprint = this.#journal.fingerprintPrincipal(request);
    const requestFingerprint = this.#journal.fingerprintRequest(request);
    const binding = this.#journal.getBindingByIdempotencyKey(request.idempotencyKey, principalFingerprint);
    if (binding?.requestFingerprint === requestFingerprint) {
      const durableReceipt = this.#journal.getLatestReceipt(request.idempotencyKey, principalFingerprint);
      if (durableReceipt !== null) return Promise.resolve(durableReceipt);
    }
    const prior = this.#volatileReceipts.get(`${principalFingerprint}\0${request.idempotencyKey}`);
    if (prior?.requestFingerprint === requestFingerprint) {
      return Promise.resolve(prior.receipt);
    }
    return this.#unavailable.execute(request);
  }

  #assertActive(): void {
    if (this.#closed) throw new Error('ApplicationControlHost is closed.');
  }
}
