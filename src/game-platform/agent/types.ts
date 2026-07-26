/**
 * Agent Game Access Protocol (AGAP) v1.
 *
 * These values deliberately stay transport-neutral and JSON-shaped. Concrete
 * games may use richer TypeScript types, but values crossing this boundary are
 * validated and copied by the host.
 */
export const AGAP_PROTOCOL_NAME = 'AGAP' as const;
export const AGAP_PROTOCOL_VERSION = '1.0.0' as const;

export type ParticipantKind = 'human' | 'agent';
export type TurnModel = 'sequential' | 'simultaneous';
export type InformationModel = 'perfect' | 'imperfect';

export interface SeatDescriptor<SeatId extends string = string> {
  readonly id: SeatId;
  readonly label: string;
  readonly teamId?: string;
}

export interface GameDescriptor<SeatId extends string = string, Metadata = unknown> {
  readonly protocol: {
    readonly name: typeof AGAP_PROTOCOL_NAME;
    readonly version: typeof AGAP_PROTOCOL_VERSION;
  };
  readonly gameId: string;
  readonly gameVersion: string;
  readonly displayName: string;
  readonly turnModel: TurnModel;
  readonly informationModel: InformationModel;
  readonly seats: readonly SeatDescriptor<SeatId>[];
  /** Machine-readable rules, schemas, limits, or game-specific capabilities. */
  readonly metadata: Metadata;
}

export interface DecisionWindow<
  SeatId extends string = string,
  Phase extends string = string,
  Mode extends TurnModel = TurnModel,
> {
  readonly mode: Mode;
  readonly phase: Phase;
  readonly activeSeatIds: readonly SeatId[];
  /** Opaque token identifying this exact decision window. */
  readonly turnNonce: string;
}

export interface SeatObservation<
  SeatId extends string = string,
  Phase extends string = string,
  Observation = unknown,
  Mode extends TurnModel = TurnModel,
> {
  readonly matchId: string;
  readonly seatId: SeatId;
  readonly revision: number;
  readonly terminal: boolean;
  readonly decision: DecisionWindow<SeatId, Phase, Mode>;
  readonly observation: Observation;
}

export interface LegalAction<Action = unknown> {
  readonly action: Action;
  readonly label: string;
  readonly description?: string;
}

export interface LegalActionSet<
  SeatId extends string = string,
  Phase extends string = string,
  Action = unknown,
  Mode extends TurnModel = TurnModel,
> {
  readonly matchId: string;
  readonly seatId: SeatId;
  readonly revision: number;
  readonly terminal: boolean;
  readonly decision: DecisionWindow<SeatId, Phase, Mode>;
  readonly actions: readonly LegalAction<Action>[];
}

export interface ActRequest<Phase extends string = string, Action = unknown> {
  /** Unique within a seat for the lifetime of the match. */
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly expectedPhase: Phase;
  readonly turnNonce: string;
  readonly action: Action;
}

export interface ActionReceipt<
  SeatId extends string = string,
  Phase extends string = string,
  Mode extends TurnModel = TurnModel,
> {
  readonly requestId: string;
  readonly matchId: string;
  readonly seatId: SeatId;
  readonly accepted: true;
  readonly disposition: 'committed';
  readonly previousRevision: number;
  readonly revision: number;
  readonly terminal: boolean;
  readonly decision: DecisionWindow<SeatId, Phase, Mode>;
}

/**
 * Reserved v1 receipt shape for a future simultaneous host. A sealed action is
 * accepted at the current revision but does not resolve the shared state yet.
 */
export interface SealedActionReceipt<SeatId extends string = string, Phase extends string = string> {
  readonly requestId: string;
  readonly matchId: string;
  readonly seatId: SeatId;
  readonly accepted: true;
  readonly disposition: 'sealed';
  readonly revision: number;
  readonly terminal: false;
  readonly decision: DecisionWindow<SeatId, Phase, 'simultaneous'>;
}

export type SimultaneousActionReceipt<SeatId extends string = string, Phase extends string = string> =
  | ActionReceipt<SeatId, Phase, 'simultaneous'>
  | SealedActionReceipt<SeatId, Phase>;

export type ProtocolEventKind = 'match.started' | 'game.event' | 'state.advanced' | 'match.ended';

interface ParticipantEventBase<
  SeatId extends string = string,
  Phase extends string = string,
> {
  /** Gapless and private to this seat's event channel. */
  readonly sequence: number;
  readonly matchId: string;
  readonly revision: number;
  readonly phase: Phase;
}

export type ParticipantEvent<
  SeatId extends string = string,
  Phase extends string = string,
  Event = unknown,
  Mode extends TurnModel = TurnModel,
> =
  | (ParticipantEventBase<SeatId, Phase> & { readonly kind: 'match.started'; readonly data: null })
  | (ParticipantEventBase<SeatId, Phase> & { readonly kind: 'game.event'; readonly data: Event })
  | (ParticipantEventBase<SeatId, Phase> & {
      readonly kind: 'state.advanced';
      readonly data: StateAdvancedEvent<SeatId, Phase, Mode>;
    })
  | (ParticipantEventBase<SeatId, Phase> & { readonly kind: 'match.ended'; readonly data: null });

export interface StateAdvancedEvent<
  SeatId extends string = string,
  Phase extends string = string,
  Mode extends TurnModel = TurnModel,
> {
  /** One actor for sequential commits; one or more for simultaneous resolve. */
  readonly actorSeatIds: readonly SeatId[];
  readonly terminal: boolean;
  readonly decision: DecisionWindow<SeatId, Phase, Mode>;
}

export interface ReadEventsOptions {
  /** Return events whose sequence is strictly greater than this cursor. */
  readonly afterSequence?: number;
  /** Positive safe integer; omitted means all currently available events. */
  readonly limit?: number;
}

/**
 * A capability bound to exactly one seat. None of these calls accept a seat
 * argument, so an untrusted participant cannot substitute another seat id.
 */
export interface ParticipantPort<
  SeatId extends string = string,
  Phase extends string = string,
  Observation = unknown,
  Action = unknown,
  Event = unknown,
  Metadata = unknown,
  Mode extends TurnModel = TurnModel,
> {
  getDescriptor(): GameDescriptor<SeatId, Metadata>;
  observe(): SeatObservation<SeatId, Phase, Observation, Mode>;
  listLegalActions(): LegalActionSet<SeatId, Phase, Action, Mode>;
  act(request: ActRequest<Phase, Action>): ActionReceipt<SeatId, Phase, Mode>;
  readEvents(options?: ReadEventsOptions): readonly ParticipantEvent<SeatId, Phase, Event, Mode>[];
}

export interface ParticipantBinding<SeatId extends string = string> {
  readonly seatId: SeatId;
  /** Auditing metadata only; it never changes authorization or game semantics. */
  readonly kind: ParticipantKind;
  readonly participantId: string;
}

export type EventAudience<SeatId extends string = string> =
  | { readonly kind: 'all' }
  | { readonly kind: 'seats'; readonly seatIds: readonly SeatId[] };

export interface EmittedGameEvent<SeatId extends string = string, Event = unknown> {
  readonly audience: EventAudience<SeatId>;
  readonly data: Event;
}

export interface SequentialTransition<State, SeatId extends string = string, Event = unknown> {
  readonly state: State;
  readonly events?: readonly EmittedGameEvent<SeatId, Event>[];
}

export interface SequentialGameAdapter<
  State,
  SeatId extends string = string,
  Phase extends string = string,
  Observation = unknown,
  Action = unknown,
  Event = unknown,
  Metadata = unknown,
> {
  readonly descriptor: GameDescriptor<SeatId, Metadata> & { readonly turnModel: 'sequential' };
  createInitialState(): State;
  getPhase(state: Readonly<State>): Phase;
  isTerminal(state: Readonly<State>): boolean;
  /** Must return null exactly when the state is terminal. */
  getActiveSeatId(state: Readonly<State>): SeatId | null;
  observe(state: Readonly<State>, seatId: SeatId): Observation;
  legalActions(state: Readonly<State>, seatId: SeatId): readonly LegalAction<Action>[];
  transition(state: Readonly<State>, seatId: SeatId, action: Readonly<Action>): SequentialTransition<State, SeatId, Event>;
}

export interface CreateSequentialAgentGameHostOptions<
  State,
  SeatId extends string = string,
  Phase extends string = string,
  Observation = unknown,
  Action = unknown,
  Event = unknown,
  Metadata = unknown,
> {
  readonly matchId: string;
  readonly adapter: SequentialGameAdapter<State, SeatId, Phase, Observation, Action, Event, Metadata>;
  /** Fail closed instead of evicting receipts and weakening at-most-once semantics. */
  readonly maxReceipts?: number;
  /** Per-seat event capacity. The host fails closed instead of dropping cursors. */
  readonly maxEventsPerSeat?: number;
}

export interface AgentGameHost<
  SeatId extends string = string,
  Phase extends string = string,
  Observation = unknown,
  Action = unknown,
  Event = unknown,
  Metadata = unknown,
> {
  getDescriptor(): GameDescriptor<SeatId, Metadata>;
  bindParticipant(binding: ParticipantBinding<SeatId>): ParticipantPort<SeatId, Phase, Observation, Action, Event, Metadata>;
}

export interface SequentialAgentGameHost<
  SeatId extends string = string,
  Phase extends string = string,
  Observation = unknown,
  Action = unknown,
  Event = unknown,
  Metadata = unknown,
> extends AgentGameHost<SeatId, Phase, Observation, Action, Event, Metadata> {
  getDescriptor(): GameDescriptor<SeatId, Metadata> & { readonly turnModel: 'sequential' };
  bindParticipant(
    binding: ParticipantBinding<SeatId>,
  ): ParticipantPort<SeatId, Phase, Observation, Action, Event, Metadata, 'sequential'>;
}

/** Contract reserved for a future sealed-submit/atomic-resolve host. */
export interface SimultaneousParticipantPort<
  SeatId extends string = string,
  Phase extends string = string,
  Observation = unknown,
  Action = unknown,
  Event = unknown,
  Metadata = unknown,
> extends Omit<
    ParticipantPort<SeatId, Phase, Observation, Action, Event, Metadata, 'simultaneous'>,
    'getDescriptor' | 'act'
  > {
  getDescriptor(): GameDescriptor<SeatId, Metadata> & { readonly turnModel: 'simultaneous' };
  act(request: ActRequest<Phase, Action>): SimultaneousActionReceipt<SeatId, Phase>;
}

/** Type-level boundary only; AGAP v1 currently ships no simultaneous factory. */
export interface SimultaneousAgentGameHost<
  SeatId extends string = string,
  Phase extends string = string,
  Observation = unknown,
  Action = unknown,
  Event = unknown,
  Metadata = unknown,
> {
  getDescriptor(): GameDescriptor<SeatId, Metadata> & { readonly turnModel: 'simultaneous' };
  bindParticipant(
    binding: ParticipantBinding<SeatId>,
  ): SimultaneousParticipantPort<SeatId, Phase, Observation, Action, Event, Metadata>;
}
