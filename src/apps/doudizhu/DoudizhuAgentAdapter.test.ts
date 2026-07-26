import { describe, expect, it } from 'vitest';
import {
  AGAP_ERROR_CODES,
  AgapError,
  createSequentialAgentGameHost,
  type ParticipantKind,
} from '../../game-platform/agent';
import {
  createDoudizhuAgentAdapter,
  DOUDIZHU_AGENT_DESCRIPTOR,
  DOUDIZHU_SEAT_IDS,
  getCompleteDoudizhuLegalActionDescriptors,
  type DoudizhuAgentEvent,
  type DoudizhuSeatId,
} from './DoudizhuAgentAdapter';
import {
  applyDoudizhuAction,
  createInitialDoudizhuState,
  type DoudizhuAction,
  type DoudizhuState,
} from './DoudizhuEngine';
import { createDoudizhuActRequest } from './DoudizhuMatch';
import { createDoudizhuSeed, getCard, sortCards, type CardId } from './DoudizhuCards';
import { chooseHeuristicAction, type LegalActionDescriptor } from './DoudizhuProjection';

const testSeed = (value: number) => createDoudizhuSeed(value.toString(16).padStart(64, '0'));

const createPorts = (kind: ParticipantKind, seedValue = 123) => {
  const seed = testSeed(seedValue);
  const matchId = `adapter-shared-${seedValue}`;
  const adapter = createDoudizhuAgentAdapter({ seed, matchId });
  const host = createSequentialAgentGameHost({ matchId, adapter });
  return Object.fromEntries(DOUDIZHU_SEAT_IDS.map((seatId) => [
    seatId,
    host.bindParticipant({ seatId, participantId: `${kind}-${seatId}`, kind }),
  ])) as unknown as Record<DoudizhuSeatId, ReturnType<typeof host.bindParticipant>>;
};

const expectAgapCode = (operation: () => unknown, code: string) => {
  try {
    operation();
    throw new Error('Expected an AGAP error.');
  } catch (error) {
    expect(error).toBeInstanceOf(AgapError);
    expect((error as AgapError).code).toBe(code);
  }
};

const actionFromProjection = (descriptor: LegalActionDescriptor): DoudizhuAction => {
  switch (descriptor.type) {
    case 'bid': return { type: 'bid', score: descriptor.score };
    case 'commit-defender-double': return { type: 'commit-defender-double', double: descriptor.double };
    case 'landlord-redouble': return { type: 'landlord-redouble', redouble: descriptor.redouble };
    case 'play': return { type: 'play', cards: descriptor.cards };
    case 'pass': return { type: 'pass' };
  }
};

describe('DoudizhuAgentAdapter', () => {
  it('declares a sequential three-seat imperfect-information ruleset', () => {
    expect(DOUDIZHU_AGENT_DESCRIPTOR).toMatchObject({
      protocol: { name: 'AGAP', version: '1.0.0' },
      gameId: 'alsniper.doudizhu',
      turnModel: 'sequential',
      informationModel: 'imperfect',
      metadata: {
        ruleset: 'classic-3p-score-bid@1',
        playerCount: 3,
        fourWithTwoPolicy: {
          singlesMayShareRank: true,
          bothJokersMayBeSingleWings: true,
          pairWingsMustUseDistinctRanks: true,
        },
      },
    });
    expect(DOUDIZHU_AGENT_DESCRIPTOR.seats.map((seat) => seat.id)).toEqual(DOUDIZHU_SEAT_IDS);
  });

  it('gives human and Agent bindings identical capabilities throughout a complete match', () => {
    const humans = createPorts('human');
    const agents = createPorts('agent');
    let actionIndex = 0;
    while (!humans['seat-0'].observe().terminal) {
      for (const seatId of DOUDIZHU_SEAT_IDS) {
        expect(agents[seatId].observe()).toEqual(humans[seatId].observe());
        expect(agents[seatId].listLegalActions()).toEqual(humans[seatId].listLegalActions());
        expect(agents[seatId].readEvents()).toEqual(humans[seatId].readEvents());
      }
      const activeSeatId = humans['seat-0'].observe().decision.activeSeatIds[0]!;
      const humanPort = humans[activeSeatId];
      const agentPort = agents[activeSeatId];
      const action = chooseHeuristicAction(humanPort.observe().observation);
      const requestId = `parity-${actionIndex}`;
      expect(agentPort.act(createDoudizhuActRequest(agentPort, action, requestId)))
        .toEqual(humanPort.act(createDoudizhuActRequest(humanPort, action, requestId)));
      actionIndex += 1;
      expect(actionIndex).toBeLessThan(10_000);
    }
    expect(actionIndex).toBeGreaterThan(0);
  });

  it('expands every concrete canonical CardId choice into observation and protocol legal actions', () => {
    const ports = createPorts('agent');
    const bidder = ports[ports['seat-0'].observe().decision.activeSeatIds[0]!];
    bidder.act(createDoudizhuActRequest(bidder, { type: 'bid', score: 3 }, 'bid'));
    const firstDefender = ports[bidder.observe().decision.activeSeatIds[0]!];
    firstDefender.act(createDoudizhuActRequest(
      firstDefender,
      { type: 'commit-defender-double', double: false },
      'double-1',
    ));
    const secondDefender = ports[firstDefender.observe().decision.activeSeatIds[0]!];
    secondDefender.act(createDoudizhuActRequest(
      secondDefender,
      { type: 'commit-defender-double', double: false },
      'double-2',
    ));
    const port = ports[secondDefender.observe().decision.activeSeatIds[0]!];
    const projectionActions = port.observe().observation.legalActions.map(actionFromProjection);
    const protocolActions = port.listLegalActions().actions.map(({ action }) => action);
    const hand = port.observe().observation.ownHand;
    const rankCounts = new Map<number, number>();
    for (const cardId of hand) {
      const rank = getCard(cardId).strength;
      rankCounts.set(rank, (rankCounts.get(rank) ?? 0) + 1);
    }
    const expectedPairs = [...rankCounts.values()]
      .reduce((total, count) => total + (count >= 2 ? count * (count - 1) / 2 : 0), 0);
    const concretePlays = protocolActions.filter(
      (action): action is Extract<DoudizhuAction, { type: 'play' }> => action.type === 'play',
    );

    expect(protocolActions).toEqual(projectionActions);
    expect(concretePlays.filter((action) => action.cards.length === 1)).toHaveLength(hand.length);
    expect(concretePlays.filter((action) => action.cards.length === 2
      && getCard(action.cards[0]!).strength === getCard(action.cards[1]!).strength)).toHaveLength(expectedPairs);
    expect(protocolActions.every((action) => !('combination' in action))).toBe(true);
  });

  it('exhaustively expands concrete triples, straights, airplanes, and four-with-two choices', () => {
    const advance = (state: DoudizhuState, action: DoudizhuAction): DoudizhuState => (
      applyDoudizhuAction(state, {
        seat: state.currentSeat,
        expectedRevision: state.revision,
        turnNonce: state.turnNonce,
        action,
      })
    );
    let state = createInitialDoudizhuState({ seed: testSeed(0xdecaf), matchId: 'complete-card-id-oracle' });
    state = advance(state, { type: 'bid', score: 3 });
    state = advance(state, { type: 'commit-defender-double', double: true });
    state = advance(state, { type: 'commit-defender-double', double: false });
    state = advance(state, { type: 'landlord-redouble', redouble: false });

    const hand = sortCards([
      'clubs:3', 'diamonds:3', 'hearts:3', 'spades:3',
      'clubs:4', 'diamonds:4', 'hearts:4', 'spades:4',
      'clubs:5', 'diamonds:5', 'clubs:6', 'clubs:7', 'clubs:8',
      'clubs:9', 'clubs:10', 'clubs:J', 'clubs:Q',
    ] satisfies CardId[]);
    const hands = [...state.hands] as [readonly CardId[], readonly CardId[], readonly CardId[]];
    hands[state.currentSeat] = hand;
    const crafted: DoudizhuState = Object.freeze({
      ...state,
      hands: Object.freeze(hands),
      currentTrick: null,
      trickLeaderSeat: state.currentSeat,
      consecutivePasses: 0,
    });
    const plays = getCompleteDoudizhuLegalActionDescriptors(crafted, crafted.currentSeat)
      .filter((action): action is Extract<LegalActionDescriptor, { type: 'play' }> => action.type === 'play');
    const identity = (cards: readonly CardId[]) => sortCards(cards).join('|');
    const playIdentities = new Set(plays.map((play) => identity(play.cards)));

    // Independent combinatorial oracles: C(4,3) for each of ranks 3 and 4;
    // and 4*4*2 suit choices for the exact 3-8 straight.
    expect(plays.filter((play) => play.combination.kind === 'triple')).toHaveLength(8);
    expect(plays.filter((play) => play.combination.kind === 'straight'
      && play.combination.sequenceLength === 6
      && play.combination.mainRank === getCard('clubs:8').strength)).toHaveLength(32);

    const straight = ['spades:3', 'hearts:4', 'diamonds:5', 'clubs:6', 'clubs:7', 'clubs:8'] as const;
    const airplane = [
      'clubs:3', 'diamonds:3', 'hearts:3',
      'clubs:4', 'diamonds:4', 'hearts:4',
      'clubs:9', 'clubs:10',
    ] as const;
    const fourWithTwo = ['clubs:3', 'diamonds:3', 'hearts:3', 'spades:3', 'clubs:9', 'clubs:10'] as const;
    expect(playIdentities).toContain(identity(straight));
    expect(playIdentities).toContain(identity(airplane));
    expect(playIdentities).toContain(identity(fourWithTwo));
    expect(plays.find((play) => identity(play.cards) === identity(airplane))?.combination.kind)
      .toBe('airplane-singles');
    expect(plays.find((play) => identity(play.cards) === identity(fourWithTwo))?.combination.kind)
      .toBe('four-two-singles');

    // A concrete expanded action is accepted by the independent authoritative reducer.
    expect(advance(crafted, { type: 'play', cards: airplane })).toMatchObject({
      revision: crafted.revision + 1,
      currentTrick: { combination: { kind: 'airplane-singles' } },
    });
  });

  it('isolates each seat projection without leaking opponent or hidden-bottom card IDs', () => {
    const seedValue = 0x1234abcd;
    const matchId = `adapter-shared-${seedValue}`;
    const authority = createInitialDoudizhuState({ seed: testSeed(seedValue), matchId });
    const ports = createPorts('agent', seedValue);

    for (const [seat, seatId] of DOUDIZHU_SEAT_IDS.entries()) {
      const serialized = JSON.stringify(ports[seatId].observe());
      for (const opponent of [0, 1, 2].filter((candidate) => candidate !== seat)) {
        for (const cardId of authority.hands[opponent as 0 | 1 | 2]) {
          expect(serialized).not.toContain(`\"${cardId}\"`);
        }
      }
      for (const cardId of authority.bottom) expect(serialized).not.toContain(`\"${cardId}\"`);
      expect(ports[seatId].observe().seatId).toBe(seatId);
    }
  });

  it('maps private domain-history deltas only to the authorized AGAP event channel', () => {
    const ports = createPorts('agent', 123);
    const bidder = ports[ports['seat-0'].observe().decision.activeSeatIds[0]!];
    bidder.act(createDoudizhuActRequest(bidder, { type: 'bid', score: 3 }, 'bid-three'));
    const defenderSeatId = bidder.observe().decision.activeSeatIds[0]!;
    const defender = ports[defenderSeatId];
    defender.act(createDoudizhuActRequest(
      defender,
      { type: 'commit-defender-double', double: true },
      'private-double',
    ));

    const hasCommitment = (seatId: DoudizhuSeatId) => ports[seatId].readEvents()
      .some((event) => event.kind === 'game.event'
        && (event.data as DoudizhuAgentEvent | null)?.type === 'defender-double-committed');
    for (const seatId of DOUDIZHU_SEAT_IDS) {
      expect(hasCommitment(seatId)).toBe(seatId === defenderSeatId);
    }
  });

  it('keeps all-pass redeals observable and routes the next bidding decision deterministically', () => {
    const ports = createPorts('agent', 123);
    const firstObservation = ports['seat-0'].observe();
    const priorBidderStart = firstObservation.observation.bidderStart;
    for (let index = 0; index < DOUDIZHU_SEAT_IDS.length; index += 1) {
      const seatId = ports['seat-0'].observe().decision.activeSeatIds[0]!;
      ports[seatId].act(createDoudizhuActRequest(
        ports[seatId],
        { type: 'bid', score: 0 },
        `all-pass-${index}`,
      ));
    }

    const observation = ports['seat-0'].observe();
    const nextBidderStart = ((priorBidderStart + 1) % 3) as 0 | 1 | 2;
    expect(observation.revision).toBe(3);
    expect(observation.decision.activeSeatIds).toEqual([`seat-${nextBidderStart}`]);
    expect(observation.observation.publicHistory.at(-1)).toMatchObject({
      revision: 3,
      type: 'redealt',
      payload: { dealNumber: 1, bidderStart: nextBidderStart },
    });
    for (const seatId of DOUDIZHU_SEAT_IDS) {
      expect(ports[seatId].readEvents().some((event) => event.kind === 'game.event'
        && (event.data as DoudizhuAgentEvent | null)?.type === 'redealt')).toBe(true);
    }
  });

  it('preserves stale revision/nonce guards and idempotent action receipts', () => {
    const ports = createPorts('agent');
    const activeSeatId = ports['seat-0'].observe().decision.activeSeatIds[0]!;
    const port = ports[activeSeatId];
    const action = port.listLegalActions().actions[0]!.action;
    const request = createDoudizhuActRequest(port, action, 'retry-safe');

    expectAgapCode(() => port.act({ ...request, expectedRevision: 99 }), AGAP_ERROR_CODES.STALE_REVISION);
    expectAgapCode(() => port.act({ ...request, turnNonce: 'expired' }), AGAP_ERROR_CODES.TURN_NONCE_MISMATCH);
    const receipt = port.act(request);
    expect(port.act(request)).toEqual(receipt);
    expectAgapCode(
      () => port.act({ ...request, action: { type: 'bid', score: request.action.type === 'bid' && request.action.score === 0 ? 1 : 0 } }),
      AGAP_ERROR_CODES.IDEMPOTENCY_CONFLICT,
    );
  });
});
