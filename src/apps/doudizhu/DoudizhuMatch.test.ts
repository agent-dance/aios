import { describe, expect, it } from 'vitest';
import { DOUDIZHU_SEAT_IDS, type DoudizhuSeatId } from './DoudizhuAgentAdapter';
import {
  createDoudizhuActRequest,
  createDoudizhuMatch,
  type DoudizhuParticipantConfig,
} from './DoudizhuMatch';
import { createDoudizhuSeed } from './DoudizhuCards';

const testSeed = (value: number) => createDoudizhuSeed(value.toString(16).padStart(64, '0'));

const ALL_AGENTS: Readonly<Record<DoudizhuSeatId, DoudizhuParticipantConfig>> = Object.freeze({
  'seat-0': Object.freeze({ kind: 'agent', participantId: 'agent-0' }),
  'seat-1': Object.freeze({ kind: 'agent', participantId: 'agent-1' }),
  'seat-2': Object.freeze({ kind: 'agent', participantId: 'agent-2' }),
});

describe('DoudizhuMatch', () => {
  it('binds the default human/Agent lineup and stops deterministic driving at the human seat', () => {
    const match = createDoudizhuMatch({ seed: testSeed(1), matchId: 'mixed-match' });

    expect(match.getControllerKind('seat-0')).toBe('human');
    expect(match.getControllerKind('seat-1')).toBe('agent');
    expect(match.getControllerKind('seat-2')).toBe('agent');
    expect(match.getHumanObservation().seatId).toBe('seat-0');
    const result = match.driveAgentsUntilHuman();
    expect(result).toMatchObject({ terminal: false, activeSeatId: 'seat-0', stoppedBecause: 'human-turn' });
    expect(result.actionsTaken).toBeGreaterThan(0);
  });

  it('uses an observation-derived request envelope for a human submission', () => {
    const match = createDoudizhuMatch({ seed: testSeed(123), matchId: 'human-submit' });
    match.driveAgentsUntilHuman();
    const port = match.getPort('seat-0');
    const before = port.observe();
    const action = port.listLegalActions().actions[0]!.action;
    const request = createDoudizhuActRequest(port, action, 'human-request');

    expect(request).toMatchObject({
      expectedRevision: before.revision,
      expectedPhase: before.decision.phase,
      turnNonce: before.decision.turnNonce,
      action,
    });
    expect(port.act(request)).toMatchObject({ accepted: true, previousRevision: before.revision });
  });

  it('resolves human observation by configured seat instead of granting an Agent seat that label', () => {
    const match = createDoudizhuMatch({
      seed: testSeed(1),
      matchId: 'human-at-seat-one',
      participants: {
        'seat-0': { kind: 'agent', participantId: 'agent-0' },
        'seat-1': { kind: 'human', participantId: 'human-1' },
        'seat-2': { kind: 'agent', participantId: 'agent-2' },
      },
    });

    expect(match.getHumanObservation('seat-1').seatId).toBe('seat-1');
    expect(() => match.getHumanObservation()).toThrow(/not controlled by a human/);
  });

  it('allows all three Agent seats to complete a game without authority-state access', () => {
    const match = createDoudizhuMatch({
      seed: testSeed(0x5eed1234),
      matchId: 'all-agent-complete',
      participants: ALL_AGENTS,
    });

    const result = match.driveAgentsUntilHuman();
    expect(result).toMatchObject({ terminal: true, activeSeatId: null, stoppedBecause: 'terminal' });
    expect(result.actionsTaken).toBeGreaterThan(0);
    for (const seatId of DOUDIZHU_SEAT_IDS) {
      const observation = match.getPort(seatId).observe();
      expect(observation.terminal).toBe(true);
      expect(observation.observation.phase).toBe('complete');
      expect(observation.observation.settlement).not.toBeNull();
    }
    expect(Object.keys(match)).not.toContain('state');
    expect(Object.keys(match)).not.toContain('host');

    const exactBoundaryMatch = createDoudizhuMatch({
      seed: testSeed(0x5eed1234),
      matchId: 'all-agent-complete',
      participants: ALL_AGENTS,
    });
    expect(exactBoundaryMatch.driveAgentsUntilHuman(result.actionsTaken)).toEqual(result);
  });

  it('repeats an all-Agent match with identical outcomes, observations, and event streams', () => {
    const play = () => {
      const match = createDoudizhuMatch({
        seed: testSeed(0xdecafbad),
        matchId: 'deterministic-repeat',
        participants: ALL_AGENTS,
      });
      const drive = match.driveAgentsUntilHuman();
      return {
        drive,
        observations: DOUDIZHU_SEAT_IDS.map((seatId) => match.getPort(seatId).observe()),
        events: DOUDIZHU_SEAT_IDS.map((seatId) => match.getPort(seatId).readEvents()),
      };
    };

    expect(play()).toEqual(play());
  });

  it('terminates deterministically across a representative seed set', () => {
    for (const seed of [0, 1, 2, 3, 17, 123, 0x5eed, 0xffffffff]) {
      const match = createDoudizhuMatch({
        seed: testSeed(seed),
        matchId: `seed-termination-${seed}`,
        participants: ALL_AGENTS,
      });
      const result = match.driveAgentsUntilHuman();
      expect(result.terminal, `seed ${seed}`).toBe(true);
      expect(result.actionsTaken, `seed ${seed}`).toBeGreaterThan(0);
    }
  });

  it('validates the synchronous Agent-driving safety bound', () => {
    const match = createDoudizhuMatch({ seed: testSeed(1), matchId: 'safety-bound', participants: ALL_AGENTS });
    expect(() => match.driveAgentsUntilHuman(0)).toThrow(RangeError);
    expect(() => match.driveAgentsUntilHuman(1)).toThrow(/safety bound/);
  });

  it('requires a caller-supplied opaque public match id instead of deriving it from the secret seed', () => {
    const seed = testSeed(0xdecafbad);
    const match = createDoudizhuMatch({ seed, matchId: 'opaque-public-id' });
    const serialized = JSON.stringify(match.getHumanObservation());

    expect(match.matchId).toBe('opaque-public-id');
    expect(serialized).toContain('opaque-public-id');
    expect(serialized).not.toContain(seed);
    expect(() => createDoudizhuMatch({ seed, matchId: '   ' })).toThrow(/non-empty opaque/);
  });
});
