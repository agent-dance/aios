import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  APPLICATION_CONTROL_PROTOCOL_VERSION,
  cloneApplicationControlReceipt,
  parseApplicationControlExecuteRequest,
  parseApplicationControlReceiptLookup,
  type ApplicationControlExecuteRequest,
  type ApplicationControlReceipt,
} from '../../shared/applicationControlProtocol.js';
import type { ApplicationControlService } from './applicationControlService.js';

/**
 * Fail-closed service used when the authoritative journal cannot be verified.
 * It deliberately advertises no capabilities and never invokes an adapter.
 */
export class UnavailableApplicationControlService implements ApplicationControlService {
  readonly #memoryKey = randomBytes(32);
  readonly #refusals = new Map<string, {
    readonly fingerprint: string;
    readonly principalFingerprint: string;
    readonly receipt: ApplicationControlReceipt;
  }>();

  listCapabilities(): readonly [] {
    return Object.freeze([]);
  }

  async execute(candidate: unknown): Promise<ApplicationControlReceipt> {
    const request = parseApplicationControlExecuteRequest(candidate);
    const fingerprint = this.#fingerprint(request);
    const scope = this.#scope(request.idempotencyKey, request.principal);
    const prior = this.#refusals.get(scope);
    if (prior?.fingerprint === fingerprint) return prior.receipt;
    if (prior !== undefined) {
      return cloneApplicationControlReceipt({
        ...prior.receipt,
        intentId: request.intentId,
        idempotencyKey: request.idempotencyKey,
        appId: request.appId,
        actionId: request.actionId,
      });
    }
    const receipt = this.#createRefusal(request);
    if (prior === undefined) this.#refusals.set(scope, {
      fingerprint,
      principalFingerprint: this.#principalFingerprint(request.principal),
      receipt,
    });
    return receipt;
  }

  getReceipt(candidate: unknown): ApplicationControlReceipt | null {
    const lookup = parseApplicationControlReceiptLookup(candidate);
    const refusal = this.#refusals.get(this.#scope(lookup.idempotencyKey, lookup.principal));
    return refusal?.principalFingerprint === this.#principalFingerprint(lookup.principal) ? refusal.receipt : null;
  }

  async close(): Promise<void> {
    this.#refusals.clear();
    this.#memoryKey.fill(0);
  }

  #fingerprint(request: ApplicationControlExecuteRequest): string {
    return createHmac('sha256', this.#memoryKey).update(JSON.stringify(request), 'utf8').digest('hex');
  }

  #principalFingerprint(principal: ApplicationControlExecuteRequest['principal']): string {
    return createHmac('sha256', this.#memoryKey).update(JSON.stringify(principal), 'utf8').digest('hex');
  }

  #scope(idempotencyKey: string, principal: ApplicationControlExecuteRequest['principal']): string {
    return `${idempotencyKey}\0${this.#principalFingerprint(principal)}`;
  }

  #createRefusal(
    request: ApplicationControlExecuteRequest,
  ): ApplicationControlReceipt {
    return cloneApplicationControlReceipt({
      protocolVersion: APPLICATION_CONTROL_PROTOCOL_VERSION,
      receiptId: randomUUID(),
      intentId: request.intentId,
      idempotencyKey: request.idempotencyKey,
      appId: request.appId,
      actionId: request.actionId,
      status: 'rejected',
      approvedByUser: false,
      retryable: false,
      occurredAt: new Date().toISOString(),
      journalSequence: 0,
      errorCode: 'JOURNAL_UNAVAILABLE',
    });
  }
}
