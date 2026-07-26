import {
  createDoudizhuSeedFromBytes,
} from './DoudizhuCards';
import {
  createDoudizhuMatch,
  type DoudizhuMatch,
} from './DoudizhuMatch';

export type DoudizhuMatchFactory = (round: number) => DoudizhuMatch;
export type SecureRandomFiller = (
  bytes: Uint8Array<ArrayBuffer>,
) => Uint8Array<ArrayBuffer>;

export interface DoudizhuRoundSession {
  readonly round: number;
  readonly match: DoudizhuMatch;
}

export interface StickyManualClockOwnership {
  isManual(): boolean;
  requestManual(): boolean;
  allowsRealtime(): boolean;
}

export interface DoudizhuAgentTurnGate {
  tryBegin(): symbol | null;
  finish(token: symbol): void;
  cancelActive(): void;
  isBusy(): boolean;
}

/** New Round is orchestration after terminal completion, never a live-match reset. */
export function canCreateNextDoudizhuRound(terminal: boolean): boolean {
  return terminal;
}

/**
 * Owns the wall-clock/manual-clock decision outside React state so a timer
 * callback created by an earlier render cannot observe stale ownership.
 */
export function createStickyManualClockOwnership(
  initiallyManual: boolean,
): StickyManualClockOwnership {
  let manual = initiallyManual;
  return Object.freeze({
    isManual: () => manual,
    requestManual: () => {
      if (manual) return false;
      manual = true;
      return true;
    },
    allowsRealtime: () => !manual,
  });
}

/** A token-owned single-flight gate: only the run that acquired it may release it. */
export function createDoudizhuAgentTurnGate(): DoudizhuAgentTurnGate {
  let activeToken: symbol | null = null;
  return Object.freeze({
    tryBegin: () => {
      if (activeToken !== null) return null;
      activeToken = Symbol('doudizhu-agent-turn');
      return activeToken;
    },
    finish: (token: symbol) => {
      if (activeToken === token) activeToken = null;
    },
    cancelActive: () => { activeToken = null; },
    isBusy: () => activeToken !== null,
  });
}

const browserSecureRandom: SecureRandomFiller = (bytes) => globalThis.crypto.getRandomValues(bytes);

/** Creates a new local authority. Seed bytes never appear in its public id. */
export function createSecureLocalDoudizhuMatch(
  _round: number,
  fillRandom: SecureRandomFiller = browserSecureRandom,
): DoudizhuMatch {
  const randomBytes = new Uint8Array(48);
  const filled = fillRandom(randomBytes);
  if (filled !== randomBytes || filled.byteLength !== randomBytes.byteLength) {
    throw new TypeError('Secure random filler must fill and return the supplied 48-byte buffer');
  }
  const seed = createDoudizhuSeedFromBytes(randomBytes.slice(0, 32));
  const opaqueId = Array.from(
    randomBytes.slice(32),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
  return createDoudizhuMatch({ seed, matchId: `doudizhu-local-${opaqueId}` });
}

/**
 * Terminal New Round orchestration: advance the round and ask the factory for
 * an entirely new Host/match rather than mutating the previous authority.
 */
export function createNextDoudizhuRound(
  currentRound: number,
  matchFactory: DoudizhuMatchFactory,
): DoudizhuRoundSession {
  if (!Number.isSafeInteger(currentRound) || currentRound < 0) {
    throw new RangeError('currentRound must be a non-negative safe integer');
  }
  const round = currentRound + 1;
  if (!Number.isSafeInteger(round)) throw new RangeError('round counter exceeded the safe integer range');
  return Object.freeze({ round, match: matchFactory(round) });
}

/**
 * Reads terminal state from the current bound-seat port at invocation time.
 * A stale React projection therefore cannot authorize abandoning a live game.
 */
export function createNextDoudizhuRoundAfterTerminal(
  currentRound: number,
  currentMatch: DoudizhuMatch,
  matchFactory: DoudizhuMatchFactory,
): DoudizhuRoundSession | null {
  if (!canCreateNextDoudizhuRound(currentMatch.getHumanObservation().terminal)) return null;
  return createNextDoudizhuRound(currentRound, matchFactory);
}
