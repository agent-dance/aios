import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, lstat, rename, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  APPLICATION_CONTROL_PROTOCOL_VERSION,
  cloneApplicationControlReceipt,
  type ApplicationControlErrorCode,
  type ApplicationControlExecuteRequest,
  type ApplicationControlPrincipal,
  type ApplicationControlReceipt,
  type ApplicationEffectStatus,
} from '../../shared/applicationControlProtocol.js';

const JOURNAL_SCHEMA_VERSION = 1 as const;
const GENESIS_HASH = '0'.repeat(64);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;

interface JournalHead {
  readonly schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  readonly sequence: number;
  readonly hash: string;
  readonly mac: string;
}

interface JournalPayloadBase {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly receiptId: string;
  readonly intentId: string;
  readonly idempotencyKey: string;
  readonly appId: string;
  readonly actionId: string;
  readonly requestFingerprint: string;
  readonly principalFingerprint: string;
  readonly approvedByUser: boolean;
}

interface DispatchPayload extends JournalPayloadBase {
  readonly kind: 'dispatch-fenced';
  readonly effectStartedAt: string;
  readonly targetFingerprint?: string;
  readonly effectFingerprint?: string;
}

interface ReceiptPayload extends JournalPayloadBase {
  readonly kind: 'receipt';
  readonly status: ApplicationEffectStatus;
  readonly retryable: boolean;
  /** Recovery records retain the durable fence as the public receipt sequence. */
  readonly receiptJournalSequence?: number;
  readonly errorCode?: ApplicationControlErrorCode;
  readonly dispatchReceiptId?: string;
  readonly reconcilesReceiptId?: string;
}

type JournalPayload = DispatchPayload | ReceiptPayload;

interface EncryptedJournalBinding {
  readonly algorithm: 'aes-256-gcm';
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}

interface StoredJournalEntry {
  readonly schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  readonly sequence: number;
  readonly previousHash: string;
  readonly payload: JournalPayload;
  readonly hash: string;
}

export interface EffectJournalDispatchFence {
  readonly sequence: number;
  readonly receiptId: string;
  readonly effectStartedAt: string;
}

export interface EffectJournalBinding {
  readonly intentId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export interface UnresolvedApplicationEffect {
  readonly receipt: ApplicationControlReceipt;
  readonly requestFingerprint: string;
  readonly principalFingerprint: string;
  readonly effectStartedAt: string;
  readonly targetFingerprint?: string;
  readonly effectFingerprint?: string;
}

export interface AppendReconciliationInput {
  readonly unresolved: UnresolvedApplicationEffect;
  readonly status: 'committed' | 'failed' | 'unknown' | 'noop';
  readonly retryable: boolean;
  readonly errorCode?: ApplicationControlErrorCode;
}

export interface AppendTerminalReceiptInput {
  readonly request: ApplicationControlExecuteRequest;
  readonly requestFingerprint: string;
  readonly principalFingerprint: string;
  readonly status: ApplicationEffectStatus;
  readonly approvedByUser: boolean;
  readonly retryable: boolean;
  readonly errorCode?: ApplicationControlErrorCode;
  readonly receiptId?: string;
  readonly dispatchReceiptId?: string;
  readonly reconcilesReceiptId?: string;
}

export class EffectJournalIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EffectJournalIntegrityError';
  }
}

function hmacSha256(key: Uint8Array, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

function journalEncryptionKey(integrityKey: Uint8Array): Buffer {
  return createHmac('sha256', integrityKey)
    .update('application-control/journal-encryption/v1', 'utf8')
    .digest();
}

function encryptJournalBinding(
  plaintext: string,
  field: 'intent' | 'idempotency',
  sequence: number,
  integrityKey: Uint8Array,
): EncryptedJournalBinding {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', journalEncryptionKey(integrityKey), nonce);
  cipher.setAAD(Buffer.from(`application-control/${field}/v1\0${sequence}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Object.freeze({
    algorithm: 'aes-256-gcm',
    nonce: nonce.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  });
}

function decryptJournalBinding(
  value: unknown,
  field: 'intent' | 'idempotency',
  sequence: number,
  integrityKey: Uint8Array,
): string {
  if (
    !isRecord(value)
    || !exactKeys(value, ['algorithm', 'nonce', 'ciphertext', 'tag'])
    || value.algorithm !== 'aes-256-gcm'
    || typeof value.nonce !== 'string'
    || typeof value.ciphertext !== 'string'
    || typeof value.tag !== 'string'
  ) throw new EffectJournalIntegrityError('Journal contains an invalid encrypted binding.');
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      journalEncryptionKey(integrityKey),
      Buffer.from(value.nonce, 'base64url'),
    );
    decipher.setAAD(Buffer.from(`application-control/${field}/v1\0${sequence}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new EffectJournalIntegrityError('Journal encrypted binding authentication failed.');
  }
}

export async function writeAll(
  handle: Pick<FileHandle, 'write'>,
  data: Uint8Array | string,
): Promise<void> {
  const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.write(buffer, offset, buffer.byteLength - offset, null);
    if (result.bytesWritten < 1 || result.bytesWritten > buffer.byteLength - offset) {
      throw new Error('Durable application effect write made no valid forward progress.');
    }
    offset += result.bytesWritten;
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new EffectJournalIntegrityError('Journal contains a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value !== 'object' || value === null) throw new EffectJournalIntegrityError('Journal contains a non-JSON value.');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return Object.keys(record).every((key) => allowed.has(key)) && required.every((key) => Object.hasOwn(record, key));
}

function parseIsoDate(value: unknown): string {
  if (typeof value !== 'string') throw new EffectJournalIntegrityError('Journal timestamp is invalid.');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new EffectJournalIntegrityError('Journal timestamp is not canonical ISO-8601.');
  }
  return value;
}

function parseHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new EffectJournalIntegrityError(`${label} is not a SHA-256 digest.`);
  }
  return value;
}

function parsePayload(value: unknown): JournalPayload {
  if (!isRecord(value)) throw new EffectJournalIntegrityError('Journal payload must be an object.');
  const baseKeys = [
    'kind', 'eventId', 'occurredAt', 'receiptId', 'intentId', 'idempotencyKey', 'appId', 'actionId',
    'requestFingerprint', 'principalFingerprint', 'approvedByUser',
  ] as const;
  if (value.kind === 'dispatch-fenced') {
    if (!exactKeys(value, [...baseKeys, 'effectStartedAt'], ['targetFingerprint', 'effectFingerprint'])) {
      throw new EffectJournalIntegrityError('Dispatch journal payload has invalid fields.');
    }
  } else if (value.kind === 'receipt') {
    if (!exactKeys(
      value,
      [...baseKeys, 'status', 'retryable'],
      ['receiptJournalSequence', 'errorCode', 'dispatchReceiptId', 'reconcilesReceiptId'],
    )) {
      throw new EffectJournalIntegrityError('Receipt journal payload has invalid fields.');
    }
  } else {
    throw new EffectJournalIntegrityError('Journal payload kind is invalid.');
  }

  // The public receipt parser is also the authoritative identifier/status grammar.
  const receiptCandidate = {
    protocolVersion: APPLICATION_CONTROL_PROTOCOL_VERSION,
    receiptId: value.receiptId,
    intentId: value.intentId,
    idempotencyKey: value.idempotencyKey,
    appId: value.appId,
    actionId: value.actionId,
    status: value.kind === 'receipt' ? value.status : 'unknown',
    approvedByUser: value.approvedByUser,
    retryable: value.kind === 'receipt' ? value.retryable : false,
    occurredAt: value.occurredAt,
    journalSequence: value.kind === 'receipt' && value.receiptJournalSequence !== undefined
      ? value.receiptJournalSequence
      : 1,
    ...(value.kind === 'receipt'
      ? (value.errorCode === undefined ? {} : { errorCode: value.errorCode })
      : { errorCode: 'OUTCOME_UNKNOWN_AFTER_DISPATCH_FENCE' }),
    ...(value.kind === 'receipt' && value.reconcilesReceiptId !== undefined ? { reconcilesReceiptId: value.reconcilesReceiptId } : {}),
  };
  cloneApplicationControlReceipt(receiptCandidate);
  if (
    value.kind === 'receipt'
    && value.receiptJournalSequence !== undefined
    && (
      typeof value.receiptJournalSequence !== 'number'
      || !Number.isSafeInteger(value.receiptJournalSequence)
      || value.receiptJournalSequence < 1
    )
  ) throw new EffectJournalIntegrityError('Receipt journal sequence reference is invalid.');
  if (typeof value.eventId !== 'string' || value.eventId.length > 128) {
    throw new EffectJournalIntegrityError('Journal event ID is invalid.');
  }
  parseIsoDate(value.occurredAt);
  parseHash(value.requestFingerprint, 'requestFingerprint');
  parseHash(value.principalFingerprint, 'principalFingerprint');
  if (value.kind === 'dispatch-fenced') {
    parseIsoDate(value.effectStartedAt);
    if (value.targetFingerprint !== undefined) parseHash(value.targetFingerprint, 'targetFingerprint');
    if (value.effectFingerprint !== undefined) parseHash(value.effectFingerprint, 'effectFingerprint');
  }
  return value as unknown as JournalPayload;
}

function parseEntry(
  value: unknown,
  expectedSequence: number,
  expectedPreviousHash: string,
  integrityKey: Uint8Array,
): StoredJournalEntry {
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'sequence', 'previousHash', 'payload', 'hash'])) {
    throw new EffectJournalIntegrityError('Journal entry shape is invalid.');
  }
  if (value.schemaVersion !== JOURNAL_SCHEMA_VERSION || value.sequence !== expectedSequence) {
    throw new EffectJournalIntegrityError('Journal sequence or schema version is invalid.');
  }
  if (value.previousHash !== expectedPreviousHash) throw new EffectJournalIntegrityError('Journal hash chain is broken.');
  const expectedHash = hmacSha256(integrityKey, canonicalize({
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    sequence: expectedSequence,
    previousHash: expectedPreviousHash,
    payload: value.payload,
  }));
  if (value.hash !== expectedHash) throw new EffectJournalIntegrityError('Journal entry digest does not match its content.');
  if (!isRecord(value.payload) || Object.hasOwn(value.payload, 'intentId') || Object.hasOwn(value.payload, 'idempotencyKey')) {
    throw new EffectJournalIntegrityError('Journal contains unprotected caller identifiers.');
  }
  const protectedPayload = value.payload;
  const { intentBinding, idempotencyBinding, ...payloadWithoutBindings } = protectedPayload;
  const payload = parsePayload({
    ...payloadWithoutBindings,
    intentId: decryptJournalBinding(intentBinding, 'intent', expectedSequence, integrityKey),
    idempotencyKey: decryptJournalBinding(idempotencyBinding, 'idempotency', expectedSequence, integrityKey),
  });
  if (
    payload.kind === 'receipt'
    && payload.receiptJournalSequence !== undefined
    && payload.receiptJournalSequence > expectedSequence
  ) throw new EffectJournalIntegrityError('Receipt journal sequence reference points beyond its record.');
  return Object.freeze({
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    sequence: expectedSequence,
    previousHash: expectedPreviousHash,
    payload,
    hash: expectedHash,
  });
}

export class ApplicationEffectJournal {
  readonly #path: string;
  readonly #handle: FileHandle;
  readonly #entries: StoredJournalEntry[];
  readonly #integrityKey: Uint8Array;
  readonly #headPath: string;
  readonly #bindingsByScope = new Map<string, {
    readonly binding: EffectJournalBinding;
    readonly principalFingerprint: string;
    readonly firstEntry: StoredJournalEntry;
  }>();
  readonly #scopesByIdempotencyKey = new Map<string, string[]>();
  readonly #latestReceiptsByScope = new Map<string, StoredJournalEntry>();
  readonly #conflictReceiptsByScope = new Map<string, StoredJournalEntry>();
  readonly #latestDispatchesByScope = new Map<string, StoredJournalEntry & { readonly payload: DispatchPayload }>();
  readonly #resolvedDispatchReceiptIds = new Set<string>();
  #lastHash: string;
  #closed = false;
  #healthy = true;
  #queue: Promise<void> = Promise.resolve();

  private constructor(path: string, handle: FileHandle, entries: StoredJournalEntry[], integrityKey: Uint8Array) {
    this.#path = path;
    this.#handle = handle;
    this.#entries = entries;
    this.#integrityKey = integrityKey;
    this.#headPath = `${path}.head`;
    this.#lastHash = entries.at(-1)?.hash ?? GENESIS_HASH;
    for (const entry of entries) this.#indexEntry(entry);
  }

  static async open(path: string): Promise<ApplicationEffectJournal> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let content = '';
    let journalExists = false;
    try {
      const details = await lstat(path);
      if (!details.isFile() || details.size > MAX_JOURNAL_BYTES) {
        throw new EffectJournalIntegrityError('Effect journal is not a bounded regular file.');
      }
      journalExists = true;
      content = await readFile(path, 'utf8');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const integrityKey = await this.#loadOrCreateIntegrityKey(`${path}.key`, journalExists && content.length > 0);
    const headPath = `${path}.head`;
    const head = await this.#readVerifiedHead(headPath, integrityKey);
    if (head === null && content.length > 0) {
      throw new EffectJournalIntegrityError('Effect journal head is missing.');
    }
    const committedSequence = head?.sequence ?? 0;
    let committedEnd = 0;
    for (let sequence = 0; sequence < committedSequence; sequence += 1) {
      const newline = content.indexOf('\n', committedEnd);
      if (newline < 0) {
        throw new EffectJournalIntegrityError('Effect journal was truncated before its durable head.');
      }
      committedEnd = newline + 1;
    }
    const committedContent = content.slice(0, committedEnd);
    const entries: StoredJournalEntry[] = [];
    let previousHash = GENESIS_HASH;
    const lines = committedContent.length === 0 ? [] : committedContent.slice(0, -1).split('\n');
    for (const [index, line] of lines.entries()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        throw new EffectJournalIntegrityError(`Effect journal record ${index + 1} is not JSON.`);
      }
      const entry = parseEntry(parsed, index + 1, previousHash, integrityKey);
      entries.push(entry);
      previousHash = entry.hash;
    }
    const anchoredHash = entries.at(-1)?.hash ?? GENESIS_HASH;
    if (head !== null && head.hash !== anchoredHash) {
      throw new EffectJournalIntegrityError('Effect journal durable head does not match its committed prefix.');
    }
    if (head === null) {
      await this.#writeHead(headPath, 0, GENESIS_HASH, integrityKey);
    }
    if (committedContent.length !== content.length) {
      const cleanupHandle = await open(path, 'r+');
      try {
        await cleanupHandle.truncate(Buffer.byteLength(committedContent, 'utf8'));
        await cleanupHandle.sync();
      } finally {
        await cleanupHandle.close();
      }
    }
    const handle = await open(path, 'a', 0o600);
    return new ApplicationEffectJournal(path, handle, entries, integrityKey);
  }

  static async #loadOrCreateIntegrityKey(keyPath: string, journalHasRecords: boolean): Promise<Uint8Array> {
    try {
      const details = await lstat(keyPath);
      if (!details.isFile() || details.size !== 32) {
        throw new EffectJournalIntegrityError('Effect journal integrity key is invalid.');
      }
      return new Uint8Array(await readFile(keyPath));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      if (journalHasRecords) {
        throw new EffectJournalIntegrityError('Effect journal integrity key is missing.');
      }
    }

    const key = randomBytes(32);
    let keyHandle: FileHandle;
    try {
      keyHandle = await open(keyPath, 'wx', 0o600);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        const existing = await readFile(keyPath);
        if (existing.byteLength !== 32) throw new EffectJournalIntegrityError('Effect journal integrity key is invalid.');
        return new Uint8Array(existing);
      }
      throw error;
    }
    try {
      await writeAll(keyHandle, key);
      await keyHandle.sync();
    } finally {
      await keyHandle.close();
    }
    return new Uint8Array(key);
  }

  static async #readVerifiedHead(
    headPath: string,
    integrityKey: Uint8Array,
  ): Promise<JournalHead | null> {
    let head: JournalHead | null = null;
    try {
      const details = await lstat(headPath);
      if (!details.isFile() || details.size > 512) throw new EffectJournalIntegrityError('Effect journal head is invalid.');
      const parsed: unknown = JSON.parse(await readFile(headPath, 'utf8')) as unknown;
      if (
        !isRecord(parsed)
        || !exactKeys(parsed, ['schemaVersion', 'sequence', 'hash', 'mac'])
        || parsed.schemaVersion !== JOURNAL_SCHEMA_VERSION
        || !Number.isSafeInteger(parsed.sequence)
        || (parsed.sequence as number) < 0
        || !SHA256_PATTERN.test(parsed.hash as string)
        || !SHA256_PATTERN.test(parsed.mac as string)
      ) throw new EffectJournalIntegrityError('Effect journal head is invalid.');
      head = parsed as unknown as JournalHead;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if (head !== null) {
      const expectedMac = hmacSha256(
        integrityKey,
        `application-control/head/v1\0${head.sequence}\0${head.hash}`,
      );
      if (head.mac !== expectedMac) throw new EffectJournalIntegrityError('Effect journal head authentication failed.');
    }
    return head;
  }

  static async #writeHead(
    headPath: string,
    sequence: number,
    hash: string,
    integrityKey: Uint8Array,
  ): Promise<void> {
    const temporaryHeadPath = `${headPath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporaryHeadPath, 'wx', 0o600);
    try {
      const mac = hmacSha256(integrityKey, `application-control/head/v1\0${sequence}\0${hash}`);
      await writeAll(handle, JSON.stringify({ schemaVersion: JOURNAL_SCHEMA_VERSION, sequence, hash, mac }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Same-directory rename replaces the prior checkpoint atomically. A crash
    // while writing the temporary file leaves the last verified head intact.
    await rename(temporaryHeadPath, headPath);
  }

  get path(): string {
    return this.#path;
  }

  get isHealthy(): boolean {
    return !this.#closed && this.#healthy;
  }

  fingerprintRequest(request: ApplicationControlExecuteRequest): string {
    return hmacSha256(this.#integrityKey, `application-control/request/v1\0${canonicalize(request)}`);
  }

  fingerprintPrincipal(request: ApplicationControlExecuteRequest): string {
    return this.fingerprintPrincipalValue(request.principal);
  }

  fingerprintPrincipalValue(principal: ApplicationControlPrincipal): string {
    return hmacSha256(this.#integrityKey, `application-control/principal/v1\0${canonicalize(principal)}`);
  }

  matchesReconciliationTarget(storedFingerprint: string, candidateSha256: string): boolean {
    return this.#matchesReconciliationFingerprint(
      storedFingerprint,
      candidateSha256,
      'application-control/reconciliation-target/v1',
    );
  }

  matchesReconciliationEffect(storedFingerprint: string, candidateSha256: string): boolean {
    return this.#matchesReconciliationFingerprint(
      storedFingerprint,
      candidateSha256,
      'application-control/reconciliation-effect/v1',
    );
  }

  getBindingByIdempotencyKey(
    idempotencyKey: string,
    expectedPrincipalFingerprint?: string,
  ): EffectJournalBinding | null {
    const scope = this.#resolveScope(idempotencyKey, expectedPrincipalFingerprint);
    return scope === null ? null : (this.#bindingsByScope.get(scope)?.binding ?? null);
  }

  getLatestReceipt(idempotencyKey: string, expectedPrincipalFingerprint?: string): ApplicationControlReceipt | null {
    const binding = this.getBindingByIdempotencyKey(idempotencyKey, expectedPrincipalFingerprint);
    if (binding === null) return null;
    const scope = this.#resolveScope(idempotencyKey, expectedPrincipalFingerprint);
    if (scope === null) return null;
    const receipt = this.#latestReceiptsByScope.get(scope);
    if (receipt !== undefined) return this.#toReceipt(receipt);
    const dispatch = this.#latestDispatchesByScope.get(scope) ?? null;
    return dispatch === null ? null : this.#dispatchAsUnknownReceipt(dispatch);
  }

  getConflictReceipt(
    idempotencyKey: string,
    expectedPrincipalFingerprint: string,
  ): ApplicationControlReceipt | null {
    const scope = this.#resolveScope(idempotencyKey, expectedPrincipalFingerprint);
    const entry = scope === null ? undefined : this.#conflictReceiptsByScope.get(scope);
    return entry === undefined ? null : this.#toReceipt(entry);
  }

  listUnresolvedEffects(): readonly UnresolvedApplicationEffect[] {
    const unresolved: UnresolvedApplicationEffect[] = [];
    for (const [scope, dispatch] of this.#latestDispatchesByScope) {
      const receiptEntry = this.#latestReceiptsByScope.get(scope);
      const receipt = receiptEntry === undefined ? this.#dispatchAsUnknownReceipt(dispatch) : this.#toReceipt(receiptEntry);
      if (receipt?.status !== 'unknown') continue;
      unresolved.push(Object.freeze({
        receipt,
        requestFingerprint: dispatch.payload.requestFingerprint,
        principalFingerprint: dispatch.payload.principalFingerprint,
        effectStartedAt: dispatch.payload.effectStartedAt,
        ...(dispatch.payload.targetFingerprint === undefined ? {} : { targetFingerprint: dispatch.payload.targetFingerprint }),
        ...(dispatch.payload.effectFingerprint === undefined ? {} : { effectFingerprint: dispatch.payload.effectFingerprint }),
      }));
    }
    return Object.freeze(unresolved);
  }

  async recoverInterruptedDispatches(): Promise<readonly ApplicationControlReceipt[]> {
    const recovered: ApplicationControlReceipt[] = [];
    for (const dispatch of [...this.#latestDispatchesByScope.values()]) {
      if (this.#resolvedDispatchReceiptIds.has(dispatch.payload.receiptId)) continue;
      const receipt = await this.#runExclusive(async () => {
        const entry = await this.#append(Object.freeze({
          kind: 'receipt' as const,
          eventId: randomUUID(),
          occurredAt: dispatch.payload.effectStartedAt,
          receiptId: dispatch.payload.receiptId,
          intentId: dispatch.payload.intentId,
          idempotencyKey: dispatch.payload.idempotencyKey,
          appId: dispatch.payload.appId,
          actionId: dispatch.payload.actionId,
          requestFingerprint: dispatch.payload.requestFingerprint,
          principalFingerprint: dispatch.payload.principalFingerprint,
          approvedByUser: dispatch.payload.approvedByUser,
          status: 'unknown' as const,
          retryable: false,
          receiptJournalSequence: dispatch.sequence,
          errorCode: 'OUTCOME_UNKNOWN_AFTER_DISPATCH_FENCE' as const,
          dispatchReceiptId: dispatch.payload.receiptId,
        }));
        return this.#toReceipt(entry);
      });
      recovered.push(receipt);
    }
    return Object.freeze(recovered);
  }

  appendReconciliation(input: AppendReconciliationInput): Promise<ApplicationControlReceipt> {
    const unresolved = input.unresolved;
    const scope = this.#scopeKey(unresolved.receipt.idempotencyKey, unresolved.principalFingerprint);
    const source = this.#bindingsByScope.get(scope)?.firstEntry;
    if (source === undefined) return Promise.reject(new Error('Reconciliation source is not present in the journal.'));
    return this.#runExclusive(async () => {
      const entry = await this.#append(Object.freeze({
        kind: 'receipt' as const,
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        receiptId: randomUUID(),
        intentId: source.payload.intentId,
        idempotencyKey: source.payload.idempotencyKey,
        appId: source.payload.appId,
        actionId: source.payload.actionId,
        requestFingerprint: source.payload.requestFingerprint,
        principalFingerprint: source.payload.principalFingerprint,
        approvedByUser: source.payload.approvedByUser,
        status: input.status,
        retryable: input.status === 'unknown' ? false : input.retryable,
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        reconcilesReceiptId: unresolved.receipt.receiptId,
      }));
      return this.#toReceipt(entry);
    });
  }

  appendDispatchFence(input: {
    readonly request: ApplicationControlExecuteRequest;
    readonly requestFingerprint: string;
    readonly preparedFingerprint: string;
    readonly approvedByUser: boolean;
    readonly targetFingerprint?: string;
    readonly effectFingerprint?: string;
  }): Promise<EffectJournalDispatchFence> {
    parseHash(input.requestFingerprint, 'requestFingerprint');
    parseHash(input.preparedFingerprint, 'preparedFingerprint');
    const receiptId = randomUUID();
    const occurredAt = new Date().toISOString();
    return this.#runExclusive(async () => {
      const entry = await this.#append(Object.freeze({
        kind: 'dispatch-fenced' as const,
        eventId: randomUUID(),
        occurredAt,
        receiptId,
        intentId: input.request.intentId,
        idempotencyKey: input.request.idempotencyKey,
        appId: input.request.appId,
        actionId: input.request.actionId,
        requestFingerprint: input.requestFingerprint,
        principalFingerprint: this.fingerprintPrincipal(input.request),
        approvedByUser: input.approvedByUser,
        effectStartedAt: occurredAt,
        ...(input.targetFingerprint === undefined ? {} : {
          targetFingerprint: hmacSha256(
            this.#integrityKey,
            `application-control/reconciliation-target/v1\0${parseHash(input.targetFingerprint, 'targetFingerprint')}`,
          ),
        }),
        ...(input.effectFingerprint === undefined ? {} : {
          effectFingerprint: hmacSha256(
            this.#integrityKey,
            `application-control/reconciliation-effect/v1\0${parseHash(input.effectFingerprint, 'effectFingerprint')}`,
          ),
        }),
      }));
      return Object.freeze({
        sequence: entry.sequence,
        receiptId,
        effectStartedAt: occurredAt,
      });
    });
  }

  appendTerminalReceipt(input: AppendTerminalReceiptInput): Promise<ApplicationControlReceipt> {
    parseHash(input.requestFingerprint, 'requestFingerprint');
    parseHash(input.principalFingerprint, 'principalFingerprint');
    const receiptId = input.receiptId ?? randomUUID();
    const occurredAt = new Date().toISOString();
    return this.#runExclusive(async () => {
      const entry = await this.#append(Object.freeze({
        kind: 'receipt' as const,
        eventId: randomUUID(),
        occurredAt,
        receiptId,
        intentId: input.request.intentId,
        idempotencyKey: input.request.idempotencyKey,
        appId: input.request.appId,
        actionId: input.request.actionId,
        requestFingerprint: input.requestFingerprint,
        principalFingerprint: input.principalFingerprint,
        approvedByUser: input.approvedByUser,
        status: input.status,
        retryable: input.retryable,
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        ...(input.dispatchReceiptId === undefined ? {} : { dispatchReceiptId: input.dispatchReceiptId }),
        ...(input.reconcilesReceiptId === undefined ? {} : { reconcilesReceiptId: input.reconcilesReceiptId }),
      }));
      return this.#toReceipt(entry);
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#queue;
    await this.#handle.sync();
    await this.#handle.close();
  }

  #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('Application effect journal is closed.'));
    if (!this.#healthy) return Promise.reject(new Error('Application effect journal is unavailable.'));
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  #matchesReconciliationFingerprint(
    storedFingerprint: string,
    candidateSha256: string,
    domain: string,
  ): boolean {
    if (!SHA256_PATTERN.test(storedFingerprint) || !SHA256_PATTERN.test(candidateSha256)) return false;
    return storedFingerprint === hmacSha256(this.#integrityKey, `${domain}\0${candidateSha256}`);
  }

  async #append(payload: JournalPayload): Promise<StoredJournalEntry> {
    if (this.#closed) throw new Error('Application effect journal is closed.');
    const sequence = this.#entries.length + 1;
    this.#validateAppendPayload(payload, sequence);
    const { intentId, idempotencyKey, ...payloadWithoutCallerIdentifiers } = payload;
    const protectedPayload = Object.freeze({
      ...payloadWithoutCallerIdentifiers,
      intentBinding: encryptJournalBinding(intentId, 'intent', sequence, this.#integrityKey),
      idempotencyBinding: encryptJournalBinding(idempotencyKey, 'idempotency', sequence, this.#integrityKey),
    });
    const unsigned = Object.freeze({
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      sequence,
      previousHash: this.#lastHash,
      payload: protectedPayload,
    });
    const hash = hmacSha256(this.#integrityKey, canonicalize(unsigned));
    const storedEntry = Object.freeze({ ...unsigned, hash });
    const encoded = `${JSON.stringify(storedEntry)}\n`;
    try {
      const details = await this.#handle.stat();
      if (details.size + Buffer.byteLength(encoded, 'utf8') > MAX_JOURNAL_BYTES) {
        throw new Error('Application effect journal capacity is exhausted.');
      }
      await writeAll(this.#handle, encoded);
      await this.#handle.sync();
    } catch (error) {
      this.#healthy = false;
      throw error;
    }
    try {
      await ApplicationEffectJournal.#writeHead(this.#headPath, sequence, hash, this.#integrityKey);
    } catch (error) {
      // The head is the authoritative commit boundary. A fully fsynced record
      // that was not atomically anchored remains an uncommitted tail and is
      // discarded by open(); never expose it as a durable receipt or fence.
      this.#healthy = false;
      throw error;
    }
    const entry: StoredJournalEntry = Object.freeze({
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      sequence,
      previousHash: this.#lastHash,
      payload,
      hash,
    });
    this.#entries.push(entry);
    this.#lastHash = hash;
    this.#indexEntry(entry);
    return entry;
  }

  #scopeKey(idempotencyKey: string, principalFingerprint: string): string {
    return `${idempotencyKey}\0${principalFingerprint}`;
  }

  #resolveScope(idempotencyKey: string, expectedPrincipalFingerprint?: string): string | null {
    if (expectedPrincipalFingerprint !== undefined) {
      const scope = this.#scopeKey(idempotencyKey, expectedPrincipalFingerprint);
      return this.#bindingsByScope.has(scope) ? scope : null;
    }
    return this.#scopesByIdempotencyKey.get(idempotencyKey)?.[0] ?? null;
  }

  #indexEntry(entry: StoredJournalEntry): void {
    const payload = entry.payload;
    const scope = this.#scopeKey(payload.idempotencyKey, payload.principalFingerprint);
    let indexedBinding = this.#bindingsByScope.get(scope);
    if (indexedBinding === undefined) {
      indexedBinding = Object.freeze({
        binding: Object.freeze({
          intentId: payload.intentId,
          idempotencyKey: payload.idempotencyKey,
          requestFingerprint: payload.requestFingerprint,
        }),
        principalFingerprint: payload.principalFingerprint,
        firstEntry: entry,
      });
      this.#bindingsByScope.set(scope, indexedBinding);
      const scopes = this.#scopesByIdempotencyKey.get(payload.idempotencyKey) ?? [];
      scopes.push(scope);
      this.#scopesByIdempotencyKey.set(payload.idempotencyKey, scopes);
    }
    if (payload.kind === 'dispatch-fenced' && payload.requestFingerprint === indexedBinding.binding.requestFingerprint) {
      this.#latestDispatchesByScope.set(
        scope,
        entry as StoredJournalEntry & { readonly payload: DispatchPayload },
      );
      return;
    }
    if (payload.kind !== 'receipt') return;
    if (payload.dispatchReceiptId !== undefined) this.#resolvedDispatchReceiptIds.add(payload.dispatchReceiptId);
    if (payload.errorCode === 'IDEMPOTENCY_CONFLICT') {
      if (!this.#conflictReceiptsByScope.has(scope)) this.#conflictReceiptsByScope.set(scope, entry);
      return;
    }
    if (payload.requestFingerprint === indexedBinding.binding.requestFingerprint) {
      this.#latestReceiptsByScope.set(scope, entry);
    }
  }

  #validateAppendPayload(payload: JournalPayload, sequence: number): void {
    if (payload.kind === 'dispatch-fenced') {
      if (!payload.approvedByUser) {
        throw new Error('A dispatch fence requires trusted user approval.');
      }
      return;
    }
    if (
      payload.receiptJournalSequence !== undefined
      && (
        !Number.isSafeInteger(payload.receiptJournalSequence)
        || payload.receiptJournalSequence < 1
        || payload.receiptJournalSequence > sequence
      )
    ) throw new Error('Receipt journal sequence reference is invalid.');
    cloneApplicationControlReceipt({
      protocolVersion: APPLICATION_CONTROL_PROTOCOL_VERSION,
      receiptId: payload.receiptId,
      intentId: payload.intentId,
      idempotencyKey: payload.idempotencyKey,
      appId: payload.appId,
      actionId: payload.actionId,
      status: payload.status,
      approvedByUser: payload.approvedByUser,
      retryable: payload.retryable,
      occurredAt: payload.occurredAt,
      journalSequence: payload.receiptJournalSequence ?? sequence,
      ...(payload.errorCode === undefined ? {} : { errorCode: payload.errorCode }),
      ...(payload.reconcilesReceiptId === undefined ? {} : { reconcilesReceiptId: payload.reconcilesReceiptId }),
    });
  }

  #toReceipt(entry: StoredJournalEntry): ApplicationControlReceipt {
    if (entry.payload.kind !== 'receipt') throw new Error('Journal entry is not a receipt.');
    return cloneApplicationControlReceipt({
      protocolVersion: APPLICATION_CONTROL_PROTOCOL_VERSION,
      receiptId: entry.payload.receiptId,
      intentId: entry.payload.intentId,
      idempotencyKey: entry.payload.idempotencyKey,
      appId: entry.payload.appId,
      actionId: entry.payload.actionId,
      status: entry.payload.status,
      approvedByUser: entry.payload.approvedByUser,
      retryable: entry.payload.retryable,
      occurredAt: entry.payload.occurredAt,
      journalSequence: entry.payload.receiptJournalSequence ?? entry.sequence,
      ...(entry.payload.errorCode === undefined ? {} : { errorCode: entry.payload.errorCode }),
      ...(entry.payload.reconcilesReceiptId === undefined ? {} : { reconcilesReceiptId: entry.payload.reconcilesReceiptId }),
    });
  }

  #dispatchAsUnknownReceipt(entry: StoredJournalEntry & { readonly payload: DispatchPayload }): ApplicationControlReceipt {
    return cloneApplicationControlReceipt({
      protocolVersion: APPLICATION_CONTROL_PROTOCOL_VERSION,
      receiptId: entry.payload.receiptId,
      intentId: entry.payload.intentId,
      idempotencyKey: entry.payload.idempotencyKey,
      appId: entry.payload.appId,
      actionId: entry.payload.actionId,
      status: 'unknown',
      approvedByUser: entry.payload.approvedByUser,
      retryable: false,
      occurredAt: entry.payload.occurredAt,
      journalSequence: entry.sequence,
      errorCode: 'OUTCOME_UNKNOWN_AFTER_DISPATCH_FENCE',
    });
  }
}
