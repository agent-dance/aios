export const AGAP_ERROR_CODES = {
  INVALID_CONFIGURATION: 'AGAP_INVALID_CONFIGURATION',
  INVALID_REQUEST: 'AGAP_INVALID_REQUEST',
  INVALID_PROTOCOL_VALUE: 'AGAP_INVALID_PROTOCOL_VALUE',
  UNKNOWN_SEAT: 'AGAP_UNKNOWN_SEAT',
  SEAT_ALREADY_BOUND: 'AGAP_SEAT_ALREADY_BOUND',
  NOT_YOUR_TURN: 'AGAP_NOT_YOUR_TURN',
  STALE_REVISION: 'AGAP_STALE_REVISION',
  PHASE_MISMATCH: 'AGAP_PHASE_MISMATCH',
  TURN_NONCE_MISMATCH: 'AGAP_TURN_NONCE_MISMATCH',
  ILLEGAL_ACTION: 'AGAP_ILLEGAL_ACTION',
  IDEMPOTENCY_CONFLICT: 'AGAP_IDEMPOTENCY_CONFLICT',
  GAME_TERMINAL: 'AGAP_GAME_TERMINAL',
  RECEIPT_CAPACITY_EXCEEDED: 'AGAP_RECEIPT_CAPACITY_EXCEEDED',
  EVENT_CAPACITY_EXCEEDED: 'AGAP_EVENT_CAPACITY_EXCEEDED',
  REENTRANT_OPERATION: 'AGAP_REENTRANT_OPERATION',
  ADAPTER_FAILURE: 'AGAP_ADAPTER_FAILURE',
} as const;

export type AgapErrorCode = (typeof AGAP_ERROR_CODES)[keyof typeof AGAP_ERROR_CODES];

export class AgapError extends Error {
  readonly code: AgapErrorCode;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: AgapErrorCode,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly details?: Readonly<Record<string, unknown>>;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AgapError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = Object.freeze({ ...(options.details ?? {}) });
  }
}

export const isAgapError = (value: unknown): value is AgapError => value instanceof AgapError;
