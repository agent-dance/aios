import { describe, expect, it, vi } from 'vitest';
import { AGAP_ERROR_CODES, AgapError } from '../../game-platform/agent';
import type { DoudizhuAction } from './DoudizhuEngine';
import {
  canCreateNextDoudizhuRound,
  createNextDoudizhuRound,
  createNextDoudizhuRoundAfterTerminal,
  createSecureLocalDoudizhuMatch,
  createStickyManualClockOwnership,
  type SecureRandomFiller,
} from './DoudizhuOrchestration';
import { chooseHeuristicAction } from './DoudizhuProjection';

function deterministicRandom(seedByte: number, idByte: number): SecureRandomFiller {
  return (bytes) => {
    bytes.fill(seedByte, 0, 32);
    bytes.fill(idByte, 32);
    return bytes;
  };
}

function playToTerminal(match: ReturnType<typeof createSecureLocalDoudizhuMatch>): void {
  for (let actionCount = 0; actionCount < 10_000; actionCount += 1) {
    const observation = match.getHumanObservation();
    if (observation.terminal) return;
    const activeSeatId = observation.decision.activeSeatIds[0]!;
    if (match.getControllerKind(activeSeatId) === 'agent') {
      match.driveAgentTurn();
    } else {
      match.submit(activeSeatId, chooseHeuristicAction(observation.observation));
    }
  }
  throw new Error('Deterministic terminal drive exceeded its safety bound');
}

describe('Doudizhu new-round orchestration', () => {
  it('permits New Round only after the old authority reaches terminal state', () => {
    expect(canCreateNextDoudizhuRound(false)).toBe(false);
    expect(canCreateNextDoudizhuRound(true)).toBe(true);
  });

  it('creates a fresh Host/id/seed/bindings and leaves the terminal Host immutable', () => {
    const first = createSecureLocalDoudizhuMatch(0, deterministicRandom(0x11, 0xaa));
    const firstInitialHand = first.getHumanObservation().observation.ownHand;
    const forbiddenFactory = vi.fn(() => createSecureLocalDoudizhuMatch(1, deterministicRandom(0x22, 0xbb)));
    expect(createNextDoudizhuRoundAfterTerminal(0, first, forbiddenFactory)).toBeNull();
    expect(forbiddenFactory).not.toHaveBeenCalled();

    playToTerminal(first);
    const terminalObservation = first.getHumanObservation();
    const terminalEvents = first.getPort('seat-0').readEvents();
    expect(terminalObservation.terminal).toBe(true);

    const requestedRounds: number[] = [];
    const session = createNextDoudizhuRoundAfterTerminal(0, first, (round) => {
      requestedRounds.push(round);
      return createSecureLocalDoudizhuMatch(round, deterministicRandom(0x22, 0xbb));
    })!;
    const nextObservation = session.match.getHumanObservation();

    expect(requestedRounds).toEqual([1]);
    expect(session.round).toBe(1);
    expect(session.match).not.toBe(first);
    expect(session.match.getPort('seat-0')).not.toBe(first.getPort('seat-0'));
    expect(nextObservation).toMatchObject({ revision: 0, terminal: false, seatId: 'seat-0' });
    expect(nextObservation.observation.matchId).toBe(`doudizhu-local-${'bb'.repeat(16)}`);
    expect(nextObservation.observation.matchId).not.toBe(terminalObservation.observation.matchId);
    expect(nextObservation.observation.ownHand).not.toEqual(firstInitialHand);
    expect(first.getHumanObservation()).toEqual(terminalObservation);
    expect(first.getPort('seat-0').readEvents()).toEqual(terminalEvents);

    try {
      first.submit('seat-0', { type: 'bid', score: 0 } satisfies DoudizhuAction, 'terminal-is-immutable');
      throw new Error('Expected the completed Host to reject further actions');
    } catch (error) {
      expect(error).toBeInstanceOf(AgapError);
      expect((error as AgapError).code).toBe(AGAP_ERROR_CODES.GAME_TERMINAL);
    }
  });

  it('rejects unsafe round counters and random fillers that replace the supplied buffer', () => {
    const matchFactory = vi.fn(() => createSecureLocalDoudizhuMatch(0, deterministicRandom(1, 2)));
    expect(() => createNextDoudizhuRound(-1, matchFactory)).toThrow(RangeError);
    expect(() => createNextDoudizhuRound(Number.MAX_SAFE_INTEGER, matchFactory)).toThrow(RangeError);
    expect(matchFactory).not.toHaveBeenCalled();
    expect(() => createSecureLocalDoudizhuMatch(0, () => new Uint8Array(48))).toThrow(TypeError);
  });
});

describe('Doudizhu sticky manual-clock ownership', () => {
  it('closes the timer/state-commit race synchronously and remains sticky', () => {
    const ownership = createStickyManualClockOwnership(false);
    const realtimeTick = vi.fn();
    const intervalCallbackCreatedBeforeTakeover = () => {
      if (ownership.allowsRealtime()) realtimeTick();
    };

    intervalCallbackCreatedBeforeTakeover();
    expect(realtimeTick).toHaveBeenCalledOnce();
    expect(ownership.requestManual()).toBe(true);
    intervalCallbackCreatedBeforeTakeover();
    expect(realtimeTick).toHaveBeenCalledOnce();
    expect(ownership.isManual()).toBe(true);
    expect(ownership.requestManual()).toBe(false);
    expect(ownership.allowsRealtime()).toBe(false);
  });

  it('starts in manual ownership when the virtual-time marker was present', () => {
    const ownership = createStickyManualClockOwnership(true);
    expect(ownership.isManual()).toBe(true);
    expect(ownership.allowsRealtime()).toBe(false);
    expect(ownership.requestManual()).toBe(false);
  });
});
