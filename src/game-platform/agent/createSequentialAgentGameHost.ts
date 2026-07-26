import { AGAP_ERROR_CODES, AgapError, isAgapError, type AgapErrorCode } from './errors';
import { canonicalProtocolValue, cloneProtocolValue } from './protocolValue';
import {
  type ActRequest,
  type ActionReceipt,
  type CreateSequentialAgentGameHostOptions,
  type DecisionWindow,
  type EmittedGameEvent,
  type GameDescriptor,
  type LegalAction,
  type LegalActionSet,
  type ParticipantBinding,
  type ParticipantEvent,
  type ParticipantPort,
  type ReadEventsOptions,
  type SeatObservation,
  type SequentialAgentGameHost,
  type SequentialGameAdapter,
  type StateAdvancedEvent,
} from './types';

const DEFAULT_MAX_RECEIPTS = 10_000;
const DEFAULT_MAX_EVENTS_PER_SEAT = 10_000;

const assertNonEmpty = (
  value: string,
  name: string,
  code: AgapErrorCode = AGAP_ERROR_CODES.INVALID_CONFIGURATION,
) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AgapError(code, `${name} must be a non-empty string.`, { details: { name } });
  }
};

const assertExactKeys = (
  value: object,
  allowedKeys: readonly string[],
  name: string,
  code: AgapErrorCode = AGAP_ERROR_CODES.INVALID_REQUEST,
) => {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new AgapError(code, `${name} contains unsupported fields.`, {
      details: { unexpectedFields: unexpected.sort() },
    });
  }
};

const assertPlainRecord: (
  value: unknown,
  name: string,
  code: AgapErrorCode,
) => asserts value is Record<string, unknown> = (value, name, code) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgapError(code, `${name} must be a plain object.`, { details: { name } });
  }
};

const validateLegalActions = <Action>(value: unknown): readonly LegalAction<Action>[] => {
  if (!Array.isArray(value)) {
    throw new AgapError(AGAP_ERROR_CODES.INVALID_PROTOCOL_VALUE, 'legalActions must return an array.');
  }
  for (const [index, candidate] of value.entries()) {
    assertPlainRecord(candidate, `legalActions[${index}]`, AGAP_ERROR_CODES.INVALID_PROTOCOL_VALUE);
    assertExactKeys(
      candidate,
      ['action', 'label', 'description'],
      `legalActions[${index}]`,
      AGAP_ERROR_CODES.INVALID_PROTOCOL_VALUE,
    );
    if (!Object.prototype.hasOwnProperty.call(candidate, 'action')) {
      throw new AgapError(AGAP_ERROR_CODES.INVALID_PROTOCOL_VALUE, `legalActions[${index}] must contain action.`);
    }
    assertNonEmpty(candidate.label as string, `legalActions[${index}].label`, AGAP_ERROR_CODES.INVALID_PROTOCOL_VALUE);
    if (candidate.description !== undefined && typeof candidate.description !== 'string') {
      throw new AgapError(
        AGAP_ERROR_CODES.INVALID_PROTOCOL_VALUE,
        `legalActions[${index}].description must be a string when present.`,
      );
    }
  }
  return value as unknown as readonly LegalAction<Action>[];
};

const adapterCall = <Value>(operation: string, call: () => Value): Value => {
  try {
    return call();
  } catch (cause) {
    if (isAgapError(cause) && cause.code === AGAP_ERROR_CODES.REENTRANT_OPERATION) throw cause;
    throw new AgapError(AGAP_ERROR_CODES.ADAPTER_FAILURE, `Game adapter failed during ${operation}.`, {
      details: { operation },
    });
  }
};

interface StoredReceipt<SeatId extends string, Phase extends string> {
  readonly fingerprint: string;
  readonly receipt: ActionReceipt<SeatId, Phase, 'sequential'>;
}

interface InternalEventBase<Phase extends string> {
  readonly revision: number;
  readonly phase: Phase;
}

type InternalEvent<SeatId extends string, Phase extends string, Event> =
  | (InternalEventBase<Phase> & { readonly kind: 'match.started' | 'match.ended'; readonly data: null })
  | (InternalEventBase<Phase> & { readonly kind: 'game.event'; readonly data: Event })
  | (InternalEventBase<Phase> & {
      readonly kind: 'state.advanced';
      readonly data: StateAdvancedEvent<SeatId, Phase, 'sequential'>;
    });

export const createSequentialAgentGameHost = <
  State,
  SeatId extends string,
  Phase extends string,
  Observation,
  Action,
  Event,
  Metadata,
>(
  options: CreateSequentialAgentGameHostOptions<State, SeatId, Phase, Observation, Action, Event, Metadata>,
): SequentialAgentGameHost<SeatId, Phase, Observation, Action, Event, Metadata> => {
  assertPlainRecord(options, 'CreateSequentialAgentGameHostOptions', AGAP_ERROR_CODES.INVALID_CONFIGURATION);
  assertNonEmpty(options.matchId, 'matchId');
  const maxReceipts = options.maxReceipts ?? DEFAULT_MAX_RECEIPTS;
  if (!Number.isSafeInteger(maxReceipts) || maxReceipts <= 0) {
    throw new AgapError(AGAP_ERROR_CODES.INVALID_CONFIGURATION, 'maxReceipts must be a positive safe integer.');
  }
  const maxEventsPerSeat = options.maxEventsPerSeat ?? DEFAULT_MAX_EVENTS_PER_SEAT;
  if (!Number.isSafeInteger(maxEventsPerSeat) || maxEventsPerSeat <= 0) {
    throw new AgapError(AGAP_ERROR_CODES.INVALID_CONFIGURATION, 'maxEventsPerSeat must be a positive safe integer.');
  }

  const adapter: SequentialGameAdapter<State, SeatId, Phase, Observation, Action, Event, Metadata> = options.adapter;
  assertPlainRecord(adapter, 'adapter', AGAP_ERROR_CODES.INVALID_CONFIGURATION);
  let isAdapterCallbackActive = false;
  let isActionInFlight = false;
  const callAdapter = <Value>(operation: string, call: () => Value): Value => {
    if (isAdapterCallbackActive) {
      throw new AgapError(
        AGAP_ERROR_CODES.REENTRANT_OPERATION,
        'Game adapter callbacks cannot re-enter the AGAP host.',
        { details: { operation } },
      );
    }
    isAdapterCallbackActive = true;
    try {
      return adapterCall(operation, call);
    } finally {
      isAdapterCallbackActive = false;
    }
  };
  const descriptor = cloneProtocolValue(adapter.descriptor, AGAP_ERROR_CODES.INVALID_CONFIGURATION);
  assertPlainRecord(descriptor, 'adapter.descriptor', AGAP_ERROR_CODES.INVALID_CONFIGURATION);
  if (
    typeof descriptor.protocol !== 'object' ||
    descriptor.protocol === null ||
    descriptor.protocol.name !== 'AGAP' ||
    descriptor.protocol.version !== '1.0.0'
  ) {
    throw new AgapError(AGAP_ERROR_CODES.INVALID_CONFIGURATION, 'The adapter must declare AGAP protocol version 1.0.0.');
  }
  if (descriptor.turnModel !== 'sequential') {
    throw new AgapError(AGAP_ERROR_CODES.INVALID_CONFIGURATION, 'A sequential host requires turnModel "sequential".');
  }
  if (descriptor.informationModel !== 'perfect' && descriptor.informationModel !== 'imperfect') {
    throw new AgapError(
      AGAP_ERROR_CODES.INVALID_CONFIGURATION,
      'informationModel must be either "perfect" or "imperfect".',
    );
  }
  assertNonEmpty(descriptor.gameId, 'descriptor.gameId');
  assertNonEmpty(descriptor.gameVersion, 'descriptor.gameVersion');
  assertNonEmpty(descriptor.displayName, 'descriptor.displayName');
  if (!Array.isArray(descriptor.seats) || descriptor.seats.length < 1) {
    throw new AgapError(AGAP_ERROR_CODES.INVALID_CONFIGURATION, 'A game requires at least one seat.');
  }

  const seatIds = new Set<SeatId>();
  for (const seat of descriptor.seats) {
    assertPlainRecord(seat, 'descriptor.seats[]', AGAP_ERROR_CODES.INVALID_CONFIGURATION);
    assertNonEmpty(seat.id as string, 'descriptor.seats[].id');
    assertNonEmpty(seat.label as string, 'descriptor.seats[].label');
    if (seat.teamId !== undefined) assertNonEmpty(seat.teamId as string, 'descriptor.seats[].teamId');
    const seatId = seat.id as SeatId;
    if (seatIds.has(seatId)) {
      throw new AgapError(AGAP_ERROR_CODES.INVALID_CONFIGURATION, `Duplicate seat id "${seatId}".`);
    }
    seatIds.add(seatId);
  }

  let state = cloneProtocolValue(callAdapter('createInitialState', () => adapter.createInitialState()));
  let revision = 0;
  const bindings = new Map<SeatId, ParticipantBinding<SeatId>>();
  const receipts = new Map<SeatId, Map<string, StoredReceipt<SeatId, Phase>>>();
  const eventChannels = new Map<SeatId, ParticipantEvent<SeatId, Phase, Event, 'sequential'>[]>();
  for (const seatId of seatIds) {
    receipts.set(seatId, new Map());
    eventChannels.set(seatId, []);
  }

  const readStateFacts = () => {
    const adapterState = cloneProtocolValue(state);
    const phase = cloneProtocolValue(callAdapter('getPhase', () => adapter.getPhase(adapterState)));
    assertNonEmpty(phase, 'adapter phase', AGAP_ERROR_CODES.INVALID_PROTOCOL_VALUE);
    const terminal = callAdapter('isTerminal', () => adapter.isTerminal(cloneProtocolValue(state)));
    if (typeof terminal !== 'boolean') {
      throw new AgapError(AGAP_ERROR_CODES.INVALID_PROTOCOL_VALUE, 'isTerminal must return a boolean.');
    }
    const activeSeatId = callAdapter('getActiveSeatId', () => adapter.getActiveSeatId(cloneProtocolValue(state)));
    if (terminal && activeSeatId !== null) {
      throw new AgapError(AGAP_ERROR_CODES.INVALID_PROTOCOL_VALUE, 'A terminal state cannot have an active seat.');
    }
    if (!terminal && (activeSeatId === null || !seatIds.has(activeSeatId))) {
      throw new AgapError(AGAP_ERROR_CODES.INVALID_PROTOCOL_VALUE, 'A non-terminal state must have one known active seat.');
    }
    return { phase, terminal, activeSeatId };
  };

  const createDecision = (
    phase: Phase,
    terminal: boolean,
    activeSeatId: SeatId | null,
  ): DecisionWindow<SeatId, Phase, 'sequential'> => ({
    mode: 'sequential',
    phase,
    activeSeatIds: terminal || activeSeatId === null ? [] : [activeSeatId],
    turnNonce: `${options.matchId}@${revision}`,
  });

  let facts = readStateFacts();

  const appendEvent = (seatId: SeatId, event: InternalEvent<SeatId, Phase, Event>) => {
    const channel = eventChannels.get(seatId)!;
    if (channel.length >= maxEventsPerSeat) {
      throw new AgapError(
        AGAP_ERROR_CODES.EVENT_CAPACITY_EXCEEDED,
        `The event capacity for seat "${seatId}" has been reached; no cursor history was dropped.`,
      );
    }
    channel.push(
      cloneProtocolValue({
        sequence: channel.length + 1,
        matchId: options.matchId,
        ...event,
      }) as ParticipantEvent<SeatId, Phase, Event, 'sequential'>,
    );
  };

  const appendToAll = (event: InternalEvent<SeatId, Phase, Event>) => {
    for (const seatId of seatIds) appendEvent(seatId, event);
  };

  appendToAll({ revision, phase: facts.phase, kind: 'match.started', data: null });
  if (facts.terminal) appendToAll({ revision, phase: facts.phase, kind: 'match.ended', data: null });

  const appendGameEvent = (event: EmittedGameEvent<SeatId, Event>) => {
    const cloned = cloneProtocolValue(event);
    assertPlainRecord(cloned, 'emitted event', AGAP_ERROR_CODES.INVALID_PROTOCOL_VALUE);
    assertExactKeys(cloned, ['audience', 'data'], 'emitted event', AGAP_ERROR_CODES.INVALID_PROTOCOL_VALUE);
    assertPlainRecord(cloned.audience, 'emitted event audience', AGAP_ERROR_CODES.INVALID_PROTOCOL_VALUE);
    if (!Object.prototype.hasOwnProperty.call(cloned, 'data')) {
      throw new AgapError(AGAP_ERROR_CODES.INVALID_PROTOCOL_VALUE, 'An emitted event must contain data.');
    }
    if (cloned.audience.kind === 'all') {
      assertExactKeys(cloned.audience, ['kind'], 'public event audience', AGAP_ERROR_CODES.INVALID_PROTOCOL_VALUE);
      appendToAll({ revision, phase: facts.phase, kind: 'game.event', data: cloned.data });
      return;
    }
    if (
      cloned.audience.kind !== 'seats' ||
      !Array.isArray(cloned.audience.seatIds) ||
      cloned.audience.seatIds.length === 0
    ) {
      throw new AgapError(AGAP_ERROR_CODES.INVALID_PROTOCOL_VALUE, 'A private event needs at least one target seat.');
    }
    assertExactKeys(cloned.audience, ['kind', 'seatIds'], 'private event audience', AGAP_ERROR_CODES.INVALID_PROTOCOL_VALUE);
    const uniqueTargets = new Set(cloned.audience.seatIds);
    for (const seatId of uniqueTargets) {
      if (!seatIds.has(seatId)) {
        throw new AgapError(AGAP_ERROR_CODES.INVALID_PROTOCOL_VALUE, `Event targets unknown seat "${seatId}".`);
      }
      appendEvent(seatId, { revision, phase: facts.phase, kind: 'game.event', data: cloned.data });
    }
  };

  const assertNotReentrant = (operation: string) => {
    if (isAdapterCallbackActive || isActionInFlight) {
      throw new AgapError(
        AGAP_ERROR_CODES.REENTRANT_OPERATION,
        `${operation} cannot re-enter an in-flight AGAP operation.`,
        { details: { operation } },
      );
    }
  };

  const getDescriptor = (): GameDescriptor<SeatId, Metadata> & { readonly turnModel: 'sequential' } => {
    assertNotReentrant('getDescriptor');
    return cloneProtocolValue(descriptor);
  };

  const bindParticipant = (
    binding: ParticipantBinding<SeatId>,
  ): ParticipantPort<SeatId, Phase, Observation, Action, Event, Metadata, 'sequential'> => {
    assertNotReentrant('bindParticipant');
    const safeBinding = cloneProtocolValue(binding, AGAP_ERROR_CODES.INVALID_REQUEST);
    assertPlainRecord(safeBinding, 'ParticipantBinding', AGAP_ERROR_CODES.INVALID_REQUEST);
    assertExactKeys(safeBinding, ['seatId', 'kind', 'participantId'], 'ParticipantBinding');
    if (!seatIds.has(safeBinding.seatId)) {
      throw new AgapError(AGAP_ERROR_CODES.UNKNOWN_SEAT, `Unknown seat "${safeBinding.seatId}".`);
    }
    assertNonEmpty(safeBinding.participantId, 'participantId', AGAP_ERROR_CODES.INVALID_REQUEST);
    if (safeBinding.kind !== 'human' && safeBinding.kind !== 'agent') {
      throw new AgapError(AGAP_ERROR_CODES.INVALID_REQUEST, 'Participant kind must be "human" or "agent".');
    }
    if (bindings.has(safeBinding.seatId)) {
      throw new AgapError(AGAP_ERROR_CODES.SEAT_ALREADY_BOUND, `Seat "${safeBinding.seatId}" is already bound.`);
    }
    bindings.set(safeBinding.seatId, safeBinding);
    const seatId = safeBinding.seatId;

    const observe = (): SeatObservation<SeatId, Phase, Observation, 'sequential'> => {
      assertNotReentrant('observe');
      const observation = cloneProtocolValue(
        callAdapter('observe', () => adapter.observe(cloneProtocolValue(state), seatId)),
      );
      return cloneProtocolValue({
        matchId: options.matchId,
        seatId,
        revision,
        terminal: facts.terminal,
        decision: createDecision(facts.phase, facts.terminal, facts.activeSeatId),
        observation,
      });
    };

    const listLegalActions = (): LegalActionSet<SeatId, Phase, Action, 'sequential'> => {
      assertNotReentrant('listLegalActions');
      const actions = facts.terminal || facts.activeSeatId !== seatId
        ? []
        : validateLegalActions<Action>(
            cloneProtocolValue(
              callAdapter('legalActions', () => adapter.legalActions(cloneProtocolValue(state), seatId)),
            ),
          );
      return cloneProtocolValue({
        matchId: options.matchId,
        seatId,
        revision,
        terminal: facts.terminal,
        decision: createDecision(facts.phase, facts.terminal, facts.activeSeatId),
        actions,
      });
    };

    const performAct = (request: ActRequest<Phase, Action>): ActionReceipt<SeatId, Phase, 'sequential'> => {
      const safeRequest = cloneProtocolValue(request, AGAP_ERROR_CODES.INVALID_REQUEST);
      assertPlainRecord(safeRequest, 'ActRequest', AGAP_ERROR_CODES.INVALID_REQUEST);
      assertExactKeys(
        safeRequest,
        ['requestId', 'expectedRevision', 'expectedPhase', 'turnNonce', 'action'],
        'ActRequest',
      );
      assertNonEmpty(safeRequest.requestId, 'requestId', AGAP_ERROR_CODES.INVALID_REQUEST);
      if (!Object.prototype.hasOwnProperty.call(safeRequest, 'action')) {
        throw new AgapError(AGAP_ERROR_CODES.INVALID_REQUEST, 'ActRequest must contain action.');
      }
      const fingerprint = canonicalProtocolValue(safeRequest);
      const seatReceipts = receipts.get(seatId)!;
      const replay = seatReceipts.get(safeRequest.requestId);
      if (replay) {
        if (replay.fingerprint !== fingerprint) {
          throw new AgapError(
            AGAP_ERROR_CODES.IDEMPOTENCY_CONFLICT,
            `requestId "${safeRequest.requestId}" was already used with a different payload.`,
          );
        }
        return cloneProtocolValue(replay.receipt);
      }
      if (!Number.isSafeInteger(safeRequest.expectedRevision) || safeRequest.expectedRevision < 0) {
        throw new AgapError(AGAP_ERROR_CODES.INVALID_REQUEST, 'expectedRevision must be a non-negative safe integer.');
      }
      assertNonEmpty(safeRequest.expectedPhase, 'expectedPhase', AGAP_ERROR_CODES.INVALID_REQUEST);
      assertNonEmpty(safeRequest.turnNonce, 'turnNonce', AGAP_ERROR_CODES.INVALID_REQUEST);

      if (facts.terminal) throw new AgapError(AGAP_ERROR_CODES.GAME_TERMINAL, 'The match is terminal.');
      if (safeRequest.expectedRevision !== revision) {
        throw new AgapError(AGAP_ERROR_CODES.STALE_REVISION, 'The requested revision is stale.', {
          retryable: true,
          details: { expectedRevision: safeRequest.expectedRevision, actualRevision: revision },
        });
      }
      if (safeRequest.expectedPhase !== facts.phase) {
        throw new AgapError(AGAP_ERROR_CODES.PHASE_MISMATCH, 'The requested phase does not match the current phase.', {
          retryable: true,
          details: { expectedPhase: safeRequest.expectedPhase, actualPhase: facts.phase },
        });
      }
      const decision = createDecision(facts.phase, facts.terminal, facts.activeSeatId);
      if (safeRequest.turnNonce !== decision.turnNonce) {
        throw new AgapError(AGAP_ERROR_CODES.TURN_NONCE_MISMATCH, 'The turn nonce does not match the current decision window.', {
          retryable: true,
        });
      }
      if (facts.activeSeatId !== seatId) {
        throw new AgapError(AGAP_ERROR_CODES.NOT_YOUR_TURN, `Seat "${seatId}" is not active.`);
      }

      const legalActions = validateLegalActions<Action>(
        cloneProtocolValue(callAdapter('legalActions', () => adapter.legalActions(cloneProtocolValue(state), seatId))),
      );
      const actionIdentity = canonicalProtocolValue(safeRequest.action);
      const legal = legalActions.some((candidate) => canonicalProtocolValue(candidate.action) === actionIdentity);
      if (!legal) throw new AgapError(AGAP_ERROR_CODES.ILLEGAL_ACTION, 'The action is not legal in the current state.');
      if (seatReceipts.size >= maxReceipts) {
        throw new AgapError(
          AGAP_ERROR_CODES.RECEIPT_CAPACITY_EXCEEDED,
          'The match receipt capacity has been reached; no idempotency record was evicted.',
        );
      }

      const previousRevision = revision;
      const previousChannelLengths = new Map<SeatId, number>();
      for (const [channelSeatId, channel] of eventChannels) previousChannelLengths.set(channelSeatId, channel.length);
      const transition = cloneProtocolValue(
        callAdapter('transition', () =>
          adapter.transition(cloneProtocolValue(state), seatId, cloneProtocolValue(safeRequest.action)),
        ),
      );
      assertPlainRecord(transition, 'transition result', AGAP_ERROR_CODES.INVALID_PROTOCOL_VALUE);
      assertExactKeys(
        transition,
        ['state', 'events'],
        'transition result',
        AGAP_ERROR_CODES.INVALID_PROTOCOL_VALUE,
      );
      if (!Object.prototype.hasOwnProperty.call(transition, 'state')) {
        throw new AgapError(AGAP_ERROR_CODES.INVALID_PROTOCOL_VALUE, 'A transition result must contain state.');
      }
      if (transition.events !== undefined && !Array.isArray(transition.events)) {
        throw new AgapError(AGAP_ERROR_CODES.INVALID_PROTOCOL_VALUE, 'transition.events must be an array when present.');
      }
      const nextState = cloneProtocolValue(transition.state as State);
      const transitionEvents = transition.events as readonly EmittedGameEvent<SeatId, Event>[] | undefined;
      const previousState = state;
      const previousFacts = facts;
      state = nextState;
      revision += 1;
      try {
        facts = readStateFacts();
        for (const event of transitionEvents ?? []) appendGameEvent(event);
        const nextDecision = createDecision(facts.phase, facts.terminal, facts.activeSeatId);
        const advancedData: StateAdvancedEvent<SeatId, Phase, 'sequential'> = {
          actorSeatIds: [seatId],
          terminal: facts.terminal,
          decision: nextDecision,
        };
        appendToAll({ revision, phase: facts.phase, kind: 'state.advanced', data: advancedData });
        if (facts.terminal) appendToAll({ revision, phase: facts.phase, kind: 'match.ended', data: null });

        const receipt: ActionReceipt<SeatId, Phase, 'sequential'> = cloneProtocolValue({
          requestId: safeRequest.requestId,
          matchId: options.matchId,
          seatId,
          accepted: true,
          disposition: 'committed',
          previousRevision,
          revision,
          terminal: facts.terminal,
          decision: nextDecision,
        });
        seatReceipts.set(safeRequest.requestId, { fingerprint, receipt });
        return cloneProtocolValue(receipt);
      } catch (error) {
        state = previousState;
        revision = previousRevision;
        facts = previousFacts;
        for (const [channelSeatId, previousLength] of previousChannelLengths) {
          eventChannels.get(channelSeatId)!.length = previousLength;
        }
        throw error;
      }
    };

    const act = (request: ActRequest<Phase, Action>): ActionReceipt<SeatId, Phase, 'sequential'> => {
      assertNotReentrant('act');
      isActionInFlight = true;
      try {
        return performAct(request);
      } finally {
        isActionInFlight = false;
      }
    };

    const readEvents = (
      readOptions: ReadEventsOptions = {},
    ): readonly ParticipantEvent<SeatId, Phase, Event, 'sequential'>[] => {
      assertNotReentrant('readEvents');
      const safeReadOptions = cloneProtocolValue(readOptions, AGAP_ERROR_CODES.INVALID_REQUEST);
      assertPlainRecord(safeReadOptions, 'ReadEventsOptions', AGAP_ERROR_CODES.INVALID_REQUEST);
      assertExactKeys(safeReadOptions, ['afterSequence', 'limit'], 'ReadEventsOptions');
      const rawAfterSequence = safeReadOptions.afterSequence;
      if (rawAfterSequence !== undefined && typeof rawAfterSequence !== 'number') {
        throw new AgapError(AGAP_ERROR_CODES.INVALID_REQUEST, 'afterSequence must be a number when present.');
      }
      const afterSequence = rawAfterSequence ?? 0;
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
        throw new AgapError(AGAP_ERROR_CODES.INVALID_REQUEST, 'afterSequence must be a non-negative safe integer.');
      }
      const rawLimit = safeReadOptions.limit;
      if (rawLimit !== undefined && typeof rawLimit !== 'number') {
        throw new AgapError(AGAP_ERROR_CODES.INVALID_REQUEST, 'limit must be a number when present.');
      }
      const limit = rawLimit ?? Number.MAX_SAFE_INTEGER;
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new AgapError(AGAP_ERROR_CODES.INVALID_REQUEST, 'limit must be a positive safe integer.');
      }
      return cloneProtocolValue(
        eventChannels
          .get(seatId)!
          .filter((event) => event.sequence > afterSequence)
          .slice(0, limit),
      );
    };

    return Object.freeze({ getDescriptor, observe, listLegalActions, act, readEvents });
  };

  return Object.freeze({ getDescriptor, bindParticipant });
};
