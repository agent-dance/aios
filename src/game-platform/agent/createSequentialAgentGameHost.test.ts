import { describe, expect, it } from 'vitest';
import {
  AGAP_ERROR_CODES,
  AGAP_PROTOCOL_NAME,
  AGAP_PROTOCOL_VERSION,
  AgapError,
  createSequentialAgentGameHost,
  type ActRequest,
  type GameDescriptor,
  type ParticipantPort,
  type SequentialGameAdapter,
} from './index';
import { cloneProtocolValue } from './protocolValue';

type Seat = 'north' | 'south';
type Phase = 'play' | 'finished';
type Card = 'A' | 'K';
type Action = { readonly kind: 'play'; readonly card: Card };
type Observation = {
  readonly ownHand: readonly Card[];
  readonly opponentCardCount: number;
  readonly plays: readonly { readonly seat: Seat; readonly card: Card }[];
};
type GameEvent =
  | { readonly type: 'card.played'; readonly seat: Seat; readonly card: Card }
  | { readonly type: 'hand.remaining'; readonly cards: readonly Card[] };
type State = {
  readonly active: Seat | null;
  readonly phase: Phase;
  readonly hands: Readonly<Record<Seat, readonly Card[]>>;
  readonly plays: readonly { readonly seat: Seat; readonly card: Card }[];
};

const descriptor: GameDescriptor<Seat, { readonly rules: string }> & { readonly turnModel: 'sequential' } = {
  protocol: { name: AGAP_PROTOCOL_NAME, version: AGAP_PROTOCOL_VERSION },
  gameId: 'test.hidden-cards',
  gameVersion: '1.0.0',
  displayName: 'Hidden cards',
  turnModel: 'sequential',
  informationModel: 'imperfect',
  seats: [
    { id: 'north', label: 'North' },
    { id: 'south', label: 'South' },
  ],
  metadata: { rules: 'Each seat plays its only card.' },
};

const adapter: SequentialGameAdapter<State, Seat, Phase, Observation, Action, GameEvent, { readonly rules: string }> = {
  descriptor,
  createInitialState: () => ({
    active: 'north',
    phase: 'play',
    hands: { north: ['A'], south: ['K'] },
    plays: [],
  }),
  getPhase: (state) => state.phase,
  isTerminal: (state) => state.active === null,
  getActiveSeatId: (state) => state.active,
  observe: (state, seatId) => {
    const opponent = seatId === 'north' ? 'south' : 'north';
    return {
      ownHand: [...state.hands[seatId]],
      opponentCardCount: state.hands[opponent].length,
      plays: state.plays.map((play) => ({ ...play })),
    };
  },
  legalActions: (state, seatId) =>
    state.active === seatId
      ? state.hands[seatId].map((card) => ({ action: { kind: 'play' as const, card }, label: `Play ${card}` }))
      : [],
  transition: (state, seatId, action) => {
    const nextHands = {
      ...state.hands,
      [seatId]: state.hands[seatId].filter((card) => card !== action.card),
    };
    const terminal = seatId === 'south';
    return {
      state: {
        active: terminal ? null : 'south',
        phase: terminal ? 'finished' : 'play',
        hands: nextHands,
        plays: [...state.plays, { seat: seatId, card: action.card }],
      },
      events: [
        { audience: { kind: 'all' }, data: { type: 'card.played', seat: seatId, card: action.card } },
        { audience: { kind: 'seats', seatIds: [seatId] }, data: { type: 'hand.remaining', cards: nextHands[seatId] } },
      ],
    };
  },
};

const createPorts = (kindBySeat: Readonly<Record<Seat, 'human' | 'agent'>> = { north: 'human', south: 'agent' }) => {
  const host = createSequentialAgentGameHost({ matchId: 'match-1', adapter });
  const north = host.bindParticipant({ seatId: 'north', participantId: 'p-north', kind: kindBySeat.north });
  const south = host.bindParticipant({ seatId: 'south', participantId: 'p-south', kind: kindBySeat.south });
  return { host, north, south };
};

const requestFor = (
  port: ParticipantPort<Seat, Phase, Observation, Action, GameEvent, { readonly rules: string }>,
  requestId: string,
  action: Action,
): ActRequest<Phase, Action> => {
  const snapshot = port.observe();
  return {
    requestId,
    expectedRevision: snapshot.revision,
    expectedPhase: snapshot.decision.phase,
    turnNonce: snapshot.decision.turnNonce,
    action,
  };
};

const expectCode = (run: () => unknown, code: string) => {
  try {
    run();
    throw new Error('Expected the operation to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(AgapError);
    expect((error as AgapError).code).toBe(code);
  }
};

describe('createSequentialAgentGameHost', () => {
  it('binds a participant capability to one seat and never exposes opponent-private observations', () => {
    const { north, south } = createPorts();

    expect(Object.keys(north).sort()).toEqual(['act', 'getDescriptor', 'listLegalActions', 'observe', 'readEvents']);
    expect(north.observe()).toMatchObject({
      seatId: 'north',
      observation: { ownHand: ['A'], opponentCardCount: 1 },
    });
    expect(south.observe()).toMatchObject({
      seatId: 'south',
      observation: { ownHand: ['K'], opponentCardCount: 1 },
    });
    expect(south.listLegalActions().actions).toEqual([]);
    expectCode(() => south.act(requestFor(south, 'steal-turn', { kind: 'play', card: 'K' })), AGAP_ERROR_CODES.NOT_YOUR_TURN);

    const untypedObserve = north.observe as unknown as (forgedSeatId: Seat) => ReturnType<typeof north.observe>;
    expect(untypedObserve('south').seatId).toBe('north');
    expect(untypedObserve('south').observation.ownHand).toEqual(['A']);
    expectCode(
      () => north.act({
        ...requestFor(north, 'forged-field', { kind: 'play', card: 'A' }),
        seatId: 'south',
      } as unknown as ActRequest<Phase, Action>),
      AGAP_ERROR_CODES.INVALID_REQUEST,
    );
  });

  it('uses identical authorization and action semantics for humans and agents', () => {
    const humanFirst = createPorts({ north: 'human', south: 'agent' });
    const agentFirst = createPorts({ north: 'agent', south: 'human' });

    const humanReceipt = humanFirst.north.act(requestFor(humanFirst.north, 'same', { kind: 'play', card: 'A' }));
    const agentReceipt = agentFirst.north.act(requestFor(agentFirst.north, 'same', { kind: 'play', card: 'A' }));
    expect(agentReceipt).toEqual(humanReceipt);
    expect(agentFirst.north.observe()).toEqual(humanFirst.north.observe());
  });

  it('returns detached descriptor, observation, legal-action, receipt, and event snapshots', () => {
    const { north } = createPorts();
    const firstObservation = north.observe();
    (firstObservation.observation.ownHand as Card[]).push('K');
    (north.getDescriptor().seats as Array<{ id: Seat; label: string }>)[0]!.label = 'tampered';
    const legal = north.listLegalActions();
    (legal.actions as Array<{ action: Action; label: string }>)[0]!.label = 'tampered';

    expect(north.observe().observation.ownHand).toEqual(['A']);
    expect(north.getDescriptor().seats[0]!.label).toBe('North');
    expect(north.listLegalActions().actions[0]!.label).toBe('Play A');

    const receipt = north.act(requestFor(north, 'copy', { kind: 'play', card: 'A' }));
    (receipt.decision.activeSeatIds as Seat[]).push('north');
    const events = north.readEvents();
    (events as unknown as Array<{ kind: string }>)[0]!.kind = 'tampered';
    expect(north.readEvents()[0]!.kind).toBe('match.started');
    expect(north.act({
      requestId: 'copy',
      expectedRevision: 0,
      expectedPhase: 'play',
      turnNonce: 'match-1@0',
      action: { kind: 'play', card: 'A' },
    }).decision.activeSeatIds).toEqual(['south']);
  });

  it('rejects stale revisions, phases, and turn nonces with stable retryable codes', () => {
    const { north } = createPorts();
    const base = requestFor(north, 'guard', { kind: 'play', card: 'A' });
    expectCode(() => north.act({ ...base, expectedRevision: 1 }), AGAP_ERROR_CODES.STALE_REVISION);
    expectCode(() => north.act({ ...base, expectedPhase: 'finished' }), AGAP_ERROR_CODES.PHASE_MISMATCH);
    expectCode(() => north.act({ ...base, turnNonce: 'old-turn' }), AGAP_ERROR_CODES.TURN_NONCE_MISMATCH);
  });

  it('rejects actions that are not in the authoritative legal-action set', () => {
    const { north } = createPorts();
    expectCode(
      () => north.act(requestFor(north, 'illegal', { kind: 'play', card: 'K' })),
      AGAP_ERROR_CODES.ILLEGAL_ACTION,
    );
    expect(north.observe().revision).toBe(0);
  });

  it('replays an identical request but rejects request-id payload conflicts', () => {
    const { north } = createPorts();
    const request = requestFor(north, 'retry-safe', { kind: 'play', card: 'A' });
    const first = north.act(request);
    const replay = north.act(request);
    expect(replay).toEqual(first);
    expect(north.observe().revision).toBe(1);
    expectCode(
      () => north.act({ ...request, action: { kind: 'play', card: 'K' } }),
      AGAP_ERROR_CODES.IDEMPOTENCY_CONFLICT,
    );
  });

  it('keeps per-seat event sequences gapless while filtering private events', () => {
    const { north, south } = createPorts();
    north.act(requestFor(north, 'north-play', { kind: 'play', card: 'A' }));

    const northEvents = north.readEvents();
    const southEvents = south.readEvents();
    expect(northEvents.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(southEvents.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(northEvents.map((event) => event.kind)).toEqual([
      'match.started',
      'game.event',
      'game.event',
      'state.advanced',
    ]);
    expect(
      southEvents.some((event) => event.kind === 'game.event' && event.data.type === 'hand.remaining'),
    ).toBe(false);
    expect(north.readEvents({ afterSequence: 2, limit: 1 })[0]!.sequence).toBe(3);
  });

  it('publishes a terminal receipt and terminal event, then rejects new actions while preserving retries', () => {
    const { north, south } = createPorts();
    const firstRequest = requestFor(north, 'north-play', { kind: 'play', card: 'A' });
    north.act(firstRequest);
    const terminalRequest = requestFor(south, 'south-play', { kind: 'play', card: 'K' });
    const terminalReceipt = south.act(terminalRequest);

    expect(terminalReceipt).toMatchObject({ revision: 2, terminal: true });
    expect(terminalReceipt.decision.activeSeatIds).toEqual([]);
    expect(south.observe()).toMatchObject({ revision: 2, terminal: true });
    expect(south.listLegalActions().actions).toEqual([]);
    expect(south.readEvents().at(-1)?.kind).toBe('match.ended');
    expect(south.act(terminalRequest)).toEqual(terminalReceipt);
    expectCode(
      () => north.act({
        requestId: 'after-end',
        expectedRevision: 2,
        expectedPhase: 'finished',
        turnNonce: 'match-1@2',
        action: { kind: 'play', card: 'A' },
      }),
      AGAP_ERROR_CODES.GAME_TERMINAL,
    );
  });

  it('supports one-seat games with the same human-or-agent capability', () => {
    type SoloState = { readonly terminal: boolean };
    const soloAdapter: SequentialGameAdapter<SoloState, 'solo', 'play' | 'done', { done: boolean }, { kind: 'finish' }> = {
      descriptor: {
        protocol: { name: AGAP_PROTOCOL_NAME, version: AGAP_PROTOCOL_VERSION },
        gameId: 'test.solo',
        gameVersion: '1.0.0',
        displayName: 'Solo',
        turnModel: 'sequential',
        informationModel: 'perfect',
        seats: [{ id: 'solo', label: 'Solo' }],
        metadata: {},
      },
      createInitialState: () => ({ terminal: false }),
      getPhase: (state) => (state.terminal ? 'done' : 'play'),
      isTerminal: (state) => state.terminal,
      getActiveSeatId: (state) => (state.terminal ? null : 'solo'),
      observe: (state) => ({ done: state.terminal }),
      legalActions: (state) => (state.terminal ? [] : [{ action: { kind: 'finish' }, label: 'Finish' }]),
      transition: () => ({ state: { terminal: true } }),
    };
    const host = createSequentialAgentGameHost({ matchId: 'solo-match', adapter: soloAdapter });
    const port = host.bindParticipant({ seatId: 'solo', participantId: 'solo-agent', kind: 'agent' });
    const snapshot = port.observe();
    expect(port.act({
      requestId: 'finish',
      expectedRevision: snapshot.revision,
      expectedPhase: snapshot.decision.phase,
      turnNonce: snapshot.decision.turnNonce,
      action: { kind: 'finish' },
    }).terminal).toBe(true);
  });

  it('atomically rolls back state and all event channels if event publication fails', () => {
    const invalidEventAdapter: typeof adapter = {
      ...adapter,
      transition: (state, seatId, action) => {
        const valid = adapter.transition(state, seatId, action);
        return {
          ...valid,
          events: [
            { audience: { kind: 'all' }, data: { type: 'card.played', seat: seatId, card: action.card } },
            {
              audience: { kind: 'seats', seatIds: ['ghost'] },
              data: { type: 'hand.remaining', cards: [] },
            },
          ] as unknown as typeof valid.events,
        };
      },
    };
    const host = createSequentialAgentGameHost({ matchId: 'atomic-events', adapter: invalidEventAdapter });
    const north = host.bindParticipant({ seatId: 'north', participantId: 'north', kind: 'human' });
    const south = host.bindParticipant({ seatId: 'south', participantId: 'south', kind: 'agent' });
    expectCode(
      () => north.act(requestFor(north, 'bad-event', { kind: 'play', card: 'A' })),
      AGAP_ERROR_CODES.INVALID_PROTOCOL_VALUE,
    );
    expect(north.observe().revision).toBe(0);
    expect(north.readEvents().map((event) => event.kind)).toEqual(['match.started']);
    expect(south.readEvents().map((event) => event.kind)).toEqual(['match.started']);
  });

  it('rejects adapter re-entry without committing nested receipts, state, or events', () => {
    let northPort: ParticipantPort<Seat, Phase, Observation, Action, GameEvent, { readonly rules: string }>;
    let nestedRequest: ActRequest<Phase, Action>;
    let shouldReenter = true;
    const reentrantAdapter: typeof adapter = {
      ...adapter,
      transition: (state, seatId, action) => {
        if (shouldReenter) {
          shouldReenter = false;
          northPort.act(nestedRequest);
        }
        return adapter.transition(state, seatId, action);
      },
    };
    const host = createSequentialAgentGameHost({ matchId: 'no-reentry', adapter: reentrantAdapter });
    northPort = host.bindParticipant({ seatId: 'north', participantId: 'north', kind: 'agent' });
    host.bindParticipant({ seatId: 'south', participantId: 'south', kind: 'human' });
    nestedRequest = requestFor(northPort, 'nested', { kind: 'play', card: 'A' });
    const outerRequest = { ...nestedRequest, requestId: 'outer' };

    expectCode(() => northPort.act(outerRequest), AGAP_ERROR_CODES.REENTRANT_OPERATION);
    expect(northPort.observe().revision).toBe(0);
    expect(northPort.readEvents().map((event) => event.kind)).toEqual(['match.started']);

    expect(northPort.act(nestedRequest)).toMatchObject({ requestId: 'nested', revision: 1 });
  });

  it('holds the single-writer guard across legal-action evaluation', () => {
    let northPort: ParticipantPort<Seat, Phase, Observation, Action, GameEvent, { readonly rules: string }>;
    let nestedRequest: ActRequest<Phase, Action>;
    let shouldReenter = true;
    const reentrantLegalAdapter: typeof adapter = {
      ...adapter,
      legalActions: (state, seatId) => {
        if (shouldReenter) {
          shouldReenter = false;
          northPort.act(nestedRequest);
        }
        return adapter.legalActions(state, seatId);
      },
    };
    const host = createSequentialAgentGameHost({ matchId: 'no-legal-reentry', adapter: reentrantLegalAdapter });
    northPort = host.bindParticipant({ seatId: 'north', participantId: 'north', kind: 'agent' });
    nestedRequest = requestFor(northPort, 'nested-legal', { kind: 'play', card: 'A' });

    expectCode(
      () => northPort.act({ ...nestedRequest, requestId: 'outer-legal' }),
      AGAP_ERROR_CODES.REENTRANT_OPERATION,
    );
    expect(northPort.observe().revision).toBe(0);
    expect(northPort.readEvents()).toHaveLength(1);
    expect(northPort.act(nestedRequest)).toMatchObject({ revision: 1, disposition: 'committed' });
  });

  it('rejects read-side re-entry from adapter callbacks', () => {
    let northPort: ParticipantPort<Seat, Phase, Observation, Action, GameEvent, { readonly rules: string }>;
    const reentrantReadAdapter: typeof adapter = {
      ...adapter,
      transition: (state, seatId, action) => {
        northPort.readEvents();
        return adapter.transition(state, seatId, action);
      },
    };
    const host = createSequentialAgentGameHost({ matchId: 'no-read-reentry', adapter: reentrantReadAdapter });
    northPort = host.bindParticipant({ seatId: 'north', participantId: 'north', kind: 'agent' });
    expectCode(
      () => northPort.act(requestFor(northPort, 'read-reentry', { kind: 'play', card: 'A' })),
      AGAP_ERROR_CODES.REENTRANT_OPERATION,
    );
    expect(northPort.observe().revision).toBe(0);
    expect(northPort.readEvents()).toHaveLength(1);
  });

  it('returns stable request errors for null and malformed runtime inputs', () => {
    const host = createSequentialAgentGameHost({ matchId: 'runtime-inputs', adapter });
    expectCode(
      () => host.bindParticipant(null as unknown as { seatId: Seat; participantId: string; kind: 'human' }),
      AGAP_ERROR_CODES.INVALID_REQUEST,
    );
    const north = host.bindParticipant({ seatId: 'north', participantId: 'north', kind: 'human' });
    expectCode(() => north.act(null as unknown as ActRequest<Phase, Action>), AGAP_ERROR_CODES.INVALID_REQUEST);
    expectCode(() => north.readEvents(null as unknown as {}), AGAP_ERROR_CODES.INVALID_REQUEST);
  });

  it('turns malformed adapter action and transition shapes into stable protocol errors', () => {
    const badLegalAdapter: typeof adapter = {
      ...adapter,
      legalActions: () => [null] as unknown as ReturnType<typeof adapter.legalActions>,
    };
    const badLegalHost = createSequentialAgentGameHost({ matchId: 'bad-legal', adapter: badLegalAdapter });
    const badLegalPort = badLegalHost.bindParticipant({ seatId: 'north', participantId: 'north', kind: 'agent' });
    expectCode(() => badLegalPort.listLegalActions(), AGAP_ERROR_CODES.INVALID_PROTOCOL_VALUE);

    const badTransitionAdapter: typeof adapter = {
      ...adapter,
      transition: () => null as unknown as ReturnType<typeof adapter.transition>,
    };
    const badTransitionHost = createSequentialAgentGameHost({ matchId: 'bad-transition', adapter: badTransitionAdapter });
    const badTransitionPort = badTransitionHost.bindParticipant({ seatId: 'north', participantId: 'north', kind: 'agent' });
    expectCode(
      () => badTransitionPort.act(requestFor(badTransitionPort, 'bad-transition', { kind: 'play', card: 'A' })),
      AGAP_ERROR_CODES.INVALID_PROTOCOL_VALUE,
    );
    expect(badTransitionPort.observe().revision).toBe(0);
  });

  it('does not expose raw adapter failures across a participant boundary', () => {
    const secret = 'authority-only-card-order';
    const failingAdapter: typeof adapter = {
      ...adapter,
      transition: () => {
        const failure = new Error(`adapter failed with ${secret}`);
        Object.assign(failure, { authorityState: { hidden: secret } });
        throw failure;
      },
    };
    const host = createSequentialAgentGameHost({ matchId: 'redacted-adapter-failure', adapter: failingAdapter });
    const port = host.bindParticipant({ seatId: 'north', participantId: 'north', kind: 'agent' });

    try {
      port.act(requestFor(port, 'redacted-failure', { kind: 'play', card: 'A' }));
      throw new Error('Expected an adapter failure.');
    } catch (error) {
      expect(error).toBeInstanceOf(AgapError);
      expect((error as AgapError).code).toBe(AGAP_ERROR_CODES.ADAPTER_FAILURE);
      expect((error as Error).cause).toBeUndefined();
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });

  it('fails closed and rolls back when a seat event channel reaches its explicit capacity', () => {
    const host = createSequentialAgentGameHost({ matchId: 'bounded-events', adapter, maxEventsPerSeat: 2 });
    const north = host.bindParticipant({ seatId: 'north', participantId: 'north', kind: 'human' });
    const south = host.bindParticipant({ seatId: 'south', participantId: 'south', kind: 'agent' });
    expectCode(
      () => north.act(requestFor(north, 'too-many-events', { kind: 'play', card: 'A' })),
      AGAP_ERROR_CODES.EVENT_CAPACITY_EXCEEDED,
    );
    expect(north.observe().revision).toBe(0);
    expect(north.readEvents()).toHaveLength(1);
    expect(south.readEvents()).toHaveLength(1);
  });

  it('keeps receipt capacity fail-closed, replayable, and isolated per seat', () => {
    type LoopState = { readonly count: number };
    const loopAdapter: SequentialGameAdapter<LoopState, 'solo', 'play', { count: number }, { kind: 'increment' }> = {
      descriptor: {
        protocol: { name: AGAP_PROTOCOL_NAME, version: AGAP_PROTOCOL_VERSION },
        gameId: 'test.loop',
        gameVersion: '1.0.0',
        displayName: 'Loop',
        turnModel: 'sequential',
        informationModel: 'perfect',
        seats: [{ id: 'solo', label: 'Solo' }],
        metadata: {},
      },
      createInitialState: () => ({ count: 0 }),
      getPhase: () => 'play',
      isTerminal: () => false,
      getActiveSeatId: () => 'solo',
      observe: (state) => ({ count: state.count }),
      legalActions: () => [{ action: { kind: 'increment' }, label: 'Increment' }],
      transition: (state) => ({ state: { count: state.count + 1 } }),
    };
    const loopHost = createSequentialAgentGameHost({ matchId: 'receipt-limit', adapter: loopAdapter, maxReceipts: 1 });
    const solo = loopHost.bindParticipant({ seatId: 'solo', participantId: 'solo', kind: 'agent' });
    const loopRequest = (requestId: string): ActRequest<'play', { kind: 'increment' }> => {
      const snapshot = solo.observe();
      return {
        requestId,
        expectedRevision: snapshot.revision,
        expectedPhase: snapshot.decision.phase,
        turnNonce: snapshot.decision.turnNonce,
        action: { kind: 'increment' },
      };
    };
    const firstRequest = loopRequest('first');
    const firstReceipt = solo.act(firstRequest);
    expect(solo.act(firstRequest)).toEqual(firstReceipt);
    expectCode(
      () => solo.act(loopRequest('second')),
      AGAP_ERROR_CODES.RECEIPT_CAPACITY_EXCEEDED,
    );
    expect(solo.observe()).toMatchObject({ revision: 1, observation: { count: 1 } });

    const twoSeatHost = createSequentialAgentGameHost({ matchId: 'receipt-seat-scope', adapter, maxReceipts: 1 });
    const north = twoSeatHost.bindParticipant({ seatId: 'north', participantId: 'north', kind: 'human' });
    const south = twoSeatHost.bindParticipant({ seatId: 'south', participantId: 'south', kind: 'agent' });
    north.act(requestFor(north, 'seat-local', { kind: 'play', card: 'A' }));
    expect(south.act(requestFor(south, 'seat-local', { kind: 'play', card: 'K' })).terminal).toBe(true);
  });

  it('allows an exact-fit event capacity including the terminal marker', () => {
    const terminalAdapter: SequentialGameAdapter<
      { readonly terminal: boolean },
      'solo',
      'play' | 'done',
      { readonly terminal: boolean },
      { readonly kind: 'finish' }
    > = {
      descriptor: {
        protocol: { name: AGAP_PROTOCOL_NAME, version: AGAP_PROTOCOL_VERSION },
        gameId: 'test.exact-events',
        gameVersion: '1.0.0',
        displayName: 'Exact events',
        turnModel: 'sequential',
        informationModel: 'perfect',
        seats: [{ id: 'solo', label: 'Solo' }],
        metadata: {},
      },
      createInitialState: () => ({ terminal: false }),
      getPhase: (state) => (state.terminal ? 'done' : 'play'),
      isTerminal: (state) => state.terminal,
      getActiveSeatId: (state) => (state.terminal ? null : 'solo'),
      observe: (state) => ({ terminal: state.terminal }),
      legalActions: () => [{ action: { kind: 'finish' }, label: 'Finish' }],
      transition: () => ({ state: { terminal: true } }),
    };
    const host = createSequentialAgentGameHost({ matchId: 'exact-events', adapter: terminalAdapter, maxEventsPerSeat: 3 });
    const solo = host.bindParticipant({ seatId: 'solo', participantId: 'solo', kind: 'agent' });
    const snapshot = solo.observe();
    solo.act({
      requestId: 'finish',
      expectedRevision: snapshot.revision,
      expectedPhase: snapshot.decision.phase,
      turnNonce: snapshot.decision.turnNonce,
      action: { kind: 'finish' },
    });
    expect(solo.readEvents().map((event) => event.kind)).toEqual([
      'match.started',
      'state.advanced',
      'match.ended',
    ]);
  });

  it('rejects transport-unsafe sparse arrays instead of silently cloning holes', () => {
    const sparse = new Array(1) as unknown[];
    expectCode(() => cloneProtocolValue(sparse), AGAP_ERROR_CODES.INVALID_PROTOCOL_VALUE);
  });
});
