import { describe, expect, it } from 'vitest';
import { DOUDIZHU_SEAT_IDS, type DoudizhuSeatId } from './DoudizhuAgentAdapter';
import {
  createDoudizhuActRequest,
  createDoudizhuMatch,
  type DoudizhuAgentController,
  type DoudizhuAgentDecision,
  type DoudizhuParticipantConfig,
} from './DoudizhuMatch';
import { createDoudizhuSeed } from './DoudizhuCards';
import type { DoudizhuAction } from './DoudizhuEngine';

const testSeed = (value: number) => createDoudizhuSeed(value.toString(16).padStart(64, '0'));

const ALL_AGENTS: Readonly<Record<DoudizhuSeatId, DoudizhuParticipantConfig>> = Object.freeze({
  'seat-0': Object.freeze({ kind: 'agent', participantId: 'agent-0' }),
  'seat-1': Object.freeze({ kind: 'agent', participantId: 'agent-1' }),
  'seat-2': Object.freeze({ kind: 'agent', participantId: 'agent-2' }),
});

function createController(
  match: ReturnType<typeof createDoudizhuMatch>,
  seatId: DoudizhuSeatId,
  chooseAction: DoudizhuAgentController['chooseAction'],
): DoudizhuAgentController {
  return { binding: match.getAgentControllerBinding(seatId), chooseAction };
}

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

  it('commits a valid asynchronous controller choice through the captured AGAP window', async () => {
    const match = createDoudizhuMatch({ seed: testSeed(21), matchId: 'async-success', participants: ALL_AGENTS });
    const actor = match.getActiveSeatId()!;
    const before = match.getPort(actor).observe();
    const controller = createController(match, actor, async (decision) => decision.legalActions.actions[0]!.action);

    const result = await match.driveAgentTurnAsync(controller, { fallbackPolicy: 'never' });

    expect(result).toMatchObject({ status: 'committed', seatId: actor, source: 'controller' });
    expect(match.getPort(actor).observe().revision).toBe(before.revision + 1);
  });

  it('rejects a controller result from a stale window instead of re-observing around it', async () => {
    const match = createDoudizhuMatch({ seed: testSeed(22), matchId: 'async-stale', participants: ALL_AGENTS });
    const actor = match.getActiveSeatId()!;
    let captured: DoudizhuAgentDecision | null = null;
    let release!: (action: DoudizhuAction) => void;
    const pendingChoice = new Promise<DoudizhuAction>((resolve) => { release = resolve; });
    let started!: () => void;
    const decisionStarted = new Promise<void>((resolve) => { started = resolve; });
    const controller = createController(match, actor, async (decision) => {
      captured = decision;
      started();
      return pendingChoice;
    });
    const pendingDrive = match.driveAgentTurnAsync(controller, { fallbackPolicy: 'never' });
    await decisionStarted;
    const competingAction = match.getPort(actor).listLegalActions().actions[0]!.action;
    match.submit(actor, competingAction, 'competing-request');
    release(captured!.legalActions.actions[0]!.action);

    await expect(pendingDrive).resolves.toEqual({ status: 'skipped', seatId: actor, reason: 'stale-window' });
  });

  it('cancels an in-flight controller without committing or falling back', async () => {
    const match = createDoudizhuMatch({ seed: testSeed(23), matchId: 'async-abort', participants: ALL_AGENTS });
    const actor = match.getActiveSeatId()!;
    const before = match.getPort(actor).observe();
    let controllerSignal: AbortSignal | undefined;
    let started!: () => void;
    const decisionStarted = new Promise<void>((resolve) => { started = resolve; });
    const controller = createController(match, actor, (_decision, signal) => {
      controllerSignal = signal;
      started();
      return new Promise<DoudizhuAction>(() => undefined);
    });
    const abort = new AbortController();
    const pendingDrive = match.driveAgentTurnAsync(controller, { signal: abort.signal });
    await decisionStarted;
    abort.abort(new DOMException('test cancellation', 'AbortError'));

    await expect(pendingDrive).resolves.toEqual({ status: 'skipped', seatId: actor, reason: 'aborted' });
    expect(controllerSignal?.aborted).toBe(true);
    expect(match.getPort(actor).observe()).toEqual(before);
  });

  it('uses the deterministic heuristic fallback on timeout, failure, and illegal output', async () => {
    const scenarios: readonly {
      readonly id: string;
      readonly choose: DoudizhuAgentController['chooseAction'];
      readonly timeoutMs: number;
      readonly reason: 'controller-timeout' | 'controller-error' | 'illegal-action';
    }[] = [
      {
        id: 'timeout',
        choose: () => new Promise<DoudizhuAction>(() => undefined),
        timeoutMs: 5,
        reason: 'controller-timeout',
      },
      {
        id: 'error',
        choose: async () => { throw new Error('controller unavailable'); },
        timeoutMs: 100,
        reason: 'controller-error',
      },
      {
        id: 'illegal',
        choose: async () => ({ type: 'bid', score: 99 } as unknown as DoudizhuAction),
        timeoutMs: 100,
        reason: 'illegal-action',
      },
    ];

    for (const scenario of scenarios) {
      const match = createDoudizhuMatch({
        seed: testSeed(24),
        matchId: `async-fallback-${scenario.id}`,
        participants: ALL_AGENTS,
      });
      const actor = match.getActiveSeatId()!;
      const result = await match.driveAgentTurnAsync(
        createController(match, actor, scenario.choose),
        { timeoutMs: scenario.timeoutMs },
      );
      expect(result).toMatchObject({
        status: 'committed',
        seatId: actor,
        source: 'heuristic-fallback',
        fallbackReason: scenario.reason,
      });
    }
  });

  it('fails closed on an invalid choice when fallback is disabled', async () => {
    const match = createDoudizhuMatch({ seed: testSeed(25), matchId: 'async-no-fallback', participants: ALL_AGENTS });
    const actor = match.getActiveSeatId()!;
    const before = match.getPort(actor).observe();
    const controller = createController(
      match,
      actor,
      async () => ({ type: 'pass', injected: true } as unknown as DoudizhuAction),
    );

    await expect(match.driveAgentTurnAsync(controller, { fallbackPolicy: 'never' })).resolves.toEqual({
      status: 'skipped',
      seatId: actor,
      reason: 'illegal-action',
    });
    expect(match.getPort(actor).observe()).toEqual(before);
  });

  it('exposes only the bound seat projection and isolated per-seat session keys', async () => {
    const match = createDoudizhuMatch({ seed: testSeed(26), matchId: 'async-seat-isolation', participants: ALL_AGENTS });
    const decisions = new Map<DoudizhuSeatId, DoudizhuAgentDecision>();

    for (let turn = 0; turn < 3; turn += 1) {
      const actor = match.getActiveSeatId()!;
      const controller = createController(match, actor, async (decision) => {
        decisions.set(actor, decision);
        return decision.legalActions.actions[0]!.action;
      });
      await expect(match.driveAgentTurnAsync(controller)).resolves.toMatchObject({ status: 'committed' });
    }

    expect(decisions.size).toBe(3);
    const seatKeys = [...decisions.values()].map((decision) => decision.seatKey);
    expect(new Set(seatKeys).size).toBe(3);
    for (const [seatId, decision] of decisions) {
      expect(decision.seatId).toBe(seatId);
      expect(decision.observation.seatId).toBe(seatId);
      expect(decision.legalActions.seatId).toBe(seatId);
      expect(decision.observation.observation.seat).toBe(Number(seatId.slice(-1)));
      const serialized = JSON.stringify(decision);
      expect(serialized).not.toContain('hands');
      expect(serialized).not.toContain('seed');
      expect(serialized).not.toContain('bottomRevealed');
      expect(serialized).not.toContain('defenderCommitments');
    }
  });
});
