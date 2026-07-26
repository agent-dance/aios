import { describe, expect, it } from 'vitest';
import { AGAP_ERROR_CODES, AgapError, type ParticipantBinding, type ParticipantKind } from '../../game-platform/agent';
import { stableHash, stableSerialize } from '../../game-platform/testkit';
import {
  SPACE_GAME_DESCRIPTOR,
  SPACE_GAME_SEAT_ID,
  createSpaceGameMatch,
  type SpaceGameAction,
} from './SpaceGameAgentAdapter';
import type { SpaceGameParticipantPort } from './SpaceGameAgentController';

const bind = (kind: ParticipantKind, matchId = 'space-match') => {
  const match = createSpaceGameMatch({ matchId });
  const port = match.bindParticipant({
    seatId: SPACE_GAME_SEAT_ID,
    participantId: `${kind}-pilot`,
    kind,
  });
  return { match, port };
};

const act = (port: SpaceGameParticipantPort, requestId: string, action: SpaceGameAction) => {
  const observation = port.observe();
  return port.act({
    requestId,
    expectedRevision: observation.revision,
    expectedPhase: observation.decision.phase,
    turnNonce: observation.decision.turnNonce,
    action,
  });
};

const control: SpaceGameAction = {
  type: 'control',
  movement: 'north-east',
  fire: true,
  aim: { column: 3, row: 0 },
};

describe('Cosmic Vanguard AGAP match', () => {
  it('publishes a stable single-seat descriptor and complete finite actions', () => {
    const { port } = bind('human');
    expect(port.getDescriptor()).toEqual(SPACE_GAME_DESCRIPTOR);
    expect(SPACE_GAME_DESCRIPTOR).toMatchObject({
      protocol: { name: 'AGAP', version: '1.0.0' },
      gameId: 'cosmic-vanguard',
      turnModel: 'sequential',
      informationModel: 'perfect',
      seats: [{ id: 'pilot' }],
      metadata: { aimGrid: { columns: 5, rows: 3 }, controlWindowMs: 250 },
    });
    expect(port.listLegalActions().actions.map((entry) => entry.action)).toEqual([{ type: 'start' }]);

    act(port, 'start', { type: 'start' });
    const actions = port.listLegalActions().actions.map((entry) => entry.action);
    const controls = actions.filter((action) => action.type === 'control');
    expect(controls).toHaveLength(9 * 2 * 5 * 3);
    expect(actions).toContainEqual(control);
    expect(actions).toContainEqual({ type: 'pause' });
    expect(actions).toContainEqual({ type: 'restart' });
  });

  it('keeps human and Agent timelines protocol-identical', () => {
    const human = bind('human', 'parity-match');
    const agent = bind('agent', 'parity-match');
    const timeline: SpaceGameAction[] = [
      { type: 'start' },
      control,
      { type: 'pause' },
      { type: 'resume' },
      { type: 'restart' },
    ];

    timeline.forEach((action, index) => {
      const humanReceipt = act(human.port, `step-${index}`, action);
      const agentReceipt = act(agent.port, `step-${index}`, action);
      expect(agentReceipt).toEqual(humanReceipt);
      expect(stableSerialize(agent.port.observe())).toBe(stableSerialize(human.port.observe()));
      expect(stableSerialize(agent.port.listLegalActions())).toBe(stableSerialize(human.port.listLegalActions()));
      expect(stableSerialize(agent.port.readEvents())).toBe(stableSerialize(human.port.readEvents()));
      if (action.type === 'control') {
        human.match.advance(500);
        agent.match.advance(500);
        expect(agent.port.observe()).toEqual(human.port.observe());
      }
    });
  });

  it('separates decision revision from per-tick observations and rotates at control windows', () => {
    const { match, port } = bind('agent');
    act(port, 'start', { type: 'start' });
    const before = port.observe();
    match.advance(200);
    const withinWindow = port.observe();
    expect(withinWindow.observation.observationTick).toBe(12);
    expect(withinWindow.revision).toBe(before.revision);
    expect(withinWindow.decision.turnNonce).toBe(before.decision.turnNonce);

    match.advance(50);
    const nextWindow = port.observe();
    expect(nextWindow.observation.observationTick).toBe(15);
    expect(nextWindow.revision).toBe(before.revision + 1);
    expect(nextWindow.decision.turnNonce).not.toBe(before.decision.turnNonce);
  });

  it('rejects stale, wrong-window, illegal, conflicting, and invalid-seat requests', () => {
    const { match, port } = bind('human');
    const startObservation = port.observe();
    const startRequest = {
      requestId: 'start-once',
      expectedRevision: startObservation.revision,
      expectedPhase: startObservation.decision.phase,
      turnNonce: startObservation.decision.turnNonce,
      action: { type: 'start' as const },
    };
    const receipt = port.act(startRequest);
    expect(port.act(startRequest)).toBe(receipt);
    expect(() => port.act({ ...startRequest, action: { type: 'restart' } })).toThrowError(
      expect.objectContaining({ code: AGAP_ERROR_CODES.IDEMPOTENCY_CONFLICT }),
    );
    expect(() =>
      port.act({
        requestId: 'stale',
        expectedRevision: startObservation.revision,
        expectedPhase: 'playing',
        turnNonce: port.observe().decision.turnNonce,
        action: control,
      }),
    ).toThrowError(expect.objectContaining({ code: AGAP_ERROR_CODES.STALE_REVISION }));

    const playing = port.observe();
    expect(() =>
      port.act({
        requestId: 'phase',
        expectedRevision: playing.revision,
        expectedPhase: 'paused',
        turnNonce: playing.decision.turnNonce,
        action: control,
      }),
    ).toThrowError(expect.objectContaining({ code: AGAP_ERROR_CODES.PHASE_MISMATCH }));
    expect(() =>
      port.act({
        requestId: 'nonce',
        expectedRevision: playing.revision,
        expectedPhase: playing.decision.phase,
        turnNonce: 'forged',
        action: control,
      }),
    ).toThrowError(expect.objectContaining({ code: AGAP_ERROR_CODES.TURN_NONCE_MISMATCH }));
    expect(() => act(port, 'illegal', { type: 'resume' })).toThrowError(
      expect.objectContaining({ code: AGAP_ERROR_CODES.ILLEGAL_ACTION }),
    );

    expect(() =>
      match.bindParticipant({ seatId: SPACE_GAME_SEAT_ID, participantId: 'second', kind: 'agent' }),
    ).toThrowError(expect.objectContaining({ code: AGAP_ERROR_CODES.SEAT_ALREADY_BOUND }));
    const unknownSeatMatch = createSpaceGameMatch({ matchId: 'unknown-seat' });
    const bindUnknown = unknownSeatMatch.bindParticipant as unknown as (
      binding: ParticipantBinding<string>,
    ) => unknown;
    expect(() => bindUnknown({ seatId: 'gunner', participantId: 'x', kind: 'agent' })).toThrowError(
      expect.objectContaining({ code: AGAP_ERROR_CODES.UNKNOWN_SEAT }),
    );
  });

  it('exposes only player-visible state and rejects mutation attempts by copy', () => {
    const { match, port } = bind('agent');
    act(port, 'start', { type: 'start' });
    act(port, 'control', control);
    match.advance(500);
    const observed = port.observe();
    expect(observed.observation).not.toHaveProperty('seed');
    expect(observed.observation).not.toHaveProperty('nextId');
    expect(observed.observation).not.toHaveProperty('particles');
    const firstEnemy = observed.observation.enemies[0];
    if (firstEnemy) (firstEnemy as { x: number }).x = 999;
    expect(port.observe().observation.enemies[0]?.x).not.toBe(999);
    const textState = JSON.parse(match.renderVisibleState()) as Record<string, unknown>;
    expect(textState).not.toHaveProperty('seed');
    expect(textState).toHaveProperty('observationTick');
    expect(textState).toHaveProperty('currentControl');

    expect(match).not.toHaveProperty('getState');
    expect(match).not.toHaveProperty('getInput');
    const renderProjection = match.getRenderProjection();
    expect(renderProjection).not.toHaveProperty('seed');
    expect(renderProjection).not.toHaveProperty('nextId');
    expect(renderProjection.player).not.toHaveProperty('velocityX');
    expect(renderProjection.enemies[0]).not.toHaveProperty('speedPerMs');
    (renderProjection.player as { x: number }).x = -999;
    expect(port.observe().observation.player.x).not.toBe(-999);
  });

  it('blocks malicious publish-observer reentrancy without disturbing the outer decision window', () => {
    const reentrantFailures: unknown[] = [];
    let attack = false;
    let port: SpaceGameParticipantPort | undefined;
    const match = createSpaceGameMatch({
      matchId: 'publish-reentrancy',
      onPublish: () => {
        if (!attack || !port) return;
        const calls = [
          () => port!.observe(),
          () => port!.listLegalActions(),
          () =>
            port!.act({
              requestId: 'reentrant-act',
              expectedRevision: 2,
              expectedPhase: 'playing',
              turnNonce: 'forged',
              action: control,
            }),
        ];
        for (const call of calls) {
          try {
            call();
          } catch (error) {
            reentrantFailures.push(error);
          }
        }
      },
    });
    port = match.bindParticipant({ seatId: SPACE_GAME_SEAT_ID, participantId: 'pilot', kind: 'agent' });
    act(port, 'start', { type: 'start' });
    const before = port.observe();
    attack = true;

    expect(match.advance(250)).toEqual({ steps: 15, observationTick: 15 });
    expect(reentrantFailures).toHaveLength(3);
    for (const failure of reentrantFailures) {
      expect(failure).toEqual(expect.objectContaining({ code: AGAP_ERROR_CODES.INVALID_REQUEST }));
    }
    const after = port.observe();
    expect(after.revision).toBe(before.revision + 1);
    expect(after.decision.turnNonce).not.toBe(before.decision.turnNonce);
    expect(port.readEvents()).toHaveLength(3);
  });

  it('uses a lightweight critical version while full observations remain pull-based', () => {
    const { match, port } = bind('agent', 'critical-version');
    const initialVersion = match.getCriticalObservationVersion();
    act(port, 'start', { type: 'start' });
    const playingVersion = match.getCriticalObservationVersion();
    expect(playingVersion).toBe(initialVersion + 1);

    match.advance(200);
    expect(match.getCriticalObservationVersion()).toBe(playingVersion);
    expect(match.getRenderProjection().observationTick).toBe(12);
    match.advance(50);
    expect(match.getCriticalObservationVersion()).toBe(playingVersion);
  });

  it('preserves fixed-step partition equivalence and formal restart semantics', () => {
    const one = bind('human', 'one');
    const two = bind('human', 'two');
    act(one.port, 'start', { type: 'start' });
    act(two.port, 'start', { type: 'start' });
    act(one.port, 'control', control);
    act(two.port, 'control', control);
    one.match.advance(2_000);
    two.match.advance(1_000);
    two.match.advance(1_000);
    expect(stableHash(JSON.parse(two.match.renderVisibleState()))).toBe(
      stableHash(JSON.parse(one.match.renderVisibleState())),
    );

    const previousRevision = one.port.observe().revision;
    act(one.port, 'restart', { type: 'restart' });
    const restarted = one.port.observe();
    expect(restarted.revision).toBeGreaterThan(previousRevision);
    expect(restarted.observation).toMatchObject({
      mode: 'playing',
      observationTick: 0,
      score: 0,
      wave: 1,
      currentControl: { movement: 'neutral', fire: false },
    });
  });

  it('freezes gameplay while paused and clears latched controls on lifecycle reset', () => {
    const { match, port } = bind('human', 'lifecycle');
    act(port, 'start', { type: 'start' });
    act(port, 'control', control);
    match.advance(250);
    act(port, 'pause', { type: 'pause' });
    const pausedState = match.renderVisibleState();
    match.advance(1_000);
    expect(match.renderVisibleState()).toBe(pausedState);
    expect(() => match.advance(Number.NaN)).toThrow(RangeError);
    expect(() => match.advance(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => match.advance(-1)).toThrow(RangeError);
    match.resetInput();
    expect(port.observe().observation.currentControl).toEqual({
      movement: 'neutral',
      fire: false,
      aim: { column: 2, row: 1 },
    });
  });

  it('fails closed before mutating when receipt or event capacity is exhausted', () => {
    const receiptLimited = createSpaceGameMatch({ matchId: 'receipt-limit', maxReceipts: 1 });
    const receiptPort = receiptLimited.bindParticipant({ seatId: 'pilot', participantId: 'pilot', kind: 'human' });
    act(receiptPort, 'start', { type: 'start' });
    const before = receiptPort.observe();
    expect(() => act(receiptPort, 'control', control)).toThrowError(
      expect.objectContaining({ code: AGAP_ERROR_CODES.RECEIPT_CAPACITY_EXCEEDED }),
    );
    expect(receiptPort.observe()).toEqual(before);

    const eventLimited = createSpaceGameMatch({ matchId: 'event-limit', maxEvents: 3 });
    const eventPort = eventLimited.bindParticipant({ seatId: 'pilot', participantId: 'pilot', kind: 'agent' });
    act(eventPort, 'start', { type: 'start' });
    expect(() => act(eventPort, 'control', control)).toThrowError(
      expect.objectContaining({ code: AGAP_ERROR_CODES.EVENT_CAPACITY_EXCEEDED }),
    );
  });

  it('uses stable AgapError instances for expected failures', () => {
    const { port } = bind('agent');
    try {
      act(port, 'bad', control);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(AgapError);
    }
  });
});
