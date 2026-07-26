import {
  AGAP_ERROR_CODES,
  AgapError,
  createSequentialAgentGameHost,
  type ActRequest,
  type ActionReceipt,
  type ParticipantKind,
  type ParticipantPort,
  type SeatObservation,
} from '../../game-platform/agent';
import {
  createDoudizhuAgentAdapter,
  DOUDIZHU_SEAT_IDS,
  type DoudizhuAgentEvent,
  type DoudizhuAgentMetadata,
  type DoudizhuSeatId,
} from './DoudizhuAgentAdapter';
import type { DoudizhuAction, DoudizhuPhase } from './DoudizhuEngine';
import type { DoudizhuSeed } from './DoudizhuCards';
import { chooseHeuristicAction, type SeatProjection } from './DoudizhuProjection';

export type DoudizhuPort = ParticipantPort<
  DoudizhuSeatId,
  DoudizhuPhase,
  SeatProjection,
  DoudizhuAction,
  DoudizhuAgentEvent,
  DoudizhuAgentMetadata
>;

export interface DoudizhuParticipantConfig {
  readonly kind: ParticipantKind;
  readonly participantId: string;
}

export interface DoudizhuAgentControllerBinding {
  readonly gameId: 'alsniper.doudizhu';
  readonly gameVersion: '1.0.0';
  readonly matchId: string;
  readonly seatId: DoudizhuSeatId;
  /** Stable and unique across seats, matches, and concurrently running games. */
  readonly seatKey: string;
}

/**
 * The complete decision payload visible to one bound AGAP seat. It contains no
 * authority state and is safe to serialize to an out-of-process controller.
 */
export interface DoudizhuAgentDecision extends DoudizhuAgentControllerBinding {
  readonly observation: ReturnType<DoudizhuPort['observe']>;
  readonly legalActions: ReturnType<DoudizhuPort['listLegalActions']>;
}

export interface DoudizhuAgentController {
  readonly binding: DoudizhuAgentControllerBinding;
  chooseAction(decision: Readonly<DoudizhuAgentDecision>, signal?: AbortSignal): Promise<DoudizhuAction>;
}

export type DoudizhuAgentControllerFactory = (
  binding: Readonly<DoudizhuAgentControllerBinding>,
) => DoudizhuAgentController;

export type DoudizhuAgentFallbackPolicy = 'never' | 'on-error' | 'on-error-or-timeout';

export interface DriveDoudizhuAgentTurnOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly fallbackPolicy?: DoudizhuAgentFallbackPolicy;
}

export type DoudizhuAsyncDriveResult =
  | Readonly<{
      status: 'committed';
      seatId: DoudizhuSeatId;
      source: 'controller' | 'heuristic-fallback';
      fallbackReason?: 'controller-error' | 'controller-timeout' | 'illegal-action';
      receipt: ActionReceipt<DoudizhuSeatId, DoudizhuPhase>;
    }>
  | Readonly<{
      status: 'skipped';
      seatId: DoudizhuSeatId | null;
      reason: 'not-agent-turn' | 'aborted' | 'controller-error' | 'controller-timeout' | 'illegal-action' | 'stale-window';
    }>;

export interface CreateDoudizhuMatchOptions {
  readonly seed: DoudizhuSeed;
  readonly matchId: string;
  /** Missing seats use the default one-human/two-agent lineup. */
  readonly participants?: Partial<Readonly<Record<DoudizhuSeatId, DoudizhuParticipantConfig>>>;
}

export interface DoudizhuDriveResult {
  readonly actionsTaken: number;
  readonly terminal: boolean;
  readonly activeSeatId: DoudizhuSeatId | null;
  readonly stoppedBecause: 'human-turn' | 'terminal';
}

const DEFAULT_PARTICIPANTS: Readonly<Record<DoudizhuSeatId, DoudizhuParticipantConfig>> = Object.freeze({
  'seat-0': Object.freeze({ kind: 'human', participantId: 'local-human' }),
  'seat-1': Object.freeze({ kind: 'agent', participantId: 'builtin-agent-1' }),
  'seat-2': Object.freeze({ kind: 'agent', participantId: 'builtin-agent-2' }),
});

const DEFAULT_AGENT_TIMEOUT_MS = 20_000;

function cloneProtocolDecision<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}

function actionIdentity(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const action = value as Record<string, unknown>;
  const keys = Object.keys(action).sort();
  switch (action.type) {
    case 'bid':
      if (keys.join('|') !== 'score|type' || ![0, 1, 2, 3].includes(action.score as number)) return null;
      return JSON.stringify({ type: 'bid', score: action.score });
    case 'commit-defender-double':
      if (keys.join('|') !== 'double|type' || typeof action.double !== 'boolean') return null;
      return JSON.stringify({ type: 'commit-defender-double', double: action.double });
    case 'landlord-redouble':
      if (keys.join('|') !== 'redouble|type' || typeof action.redouble !== 'boolean') return null;
      return JSON.stringify({ type: 'landlord-redouble', redouble: action.redouble });
    case 'play':
      if (
        keys.join('|') !== 'cards|type'
        || !Array.isArray(action.cards)
        || !action.cards.every((card) => typeof card === 'string')
      ) return null;
      return JSON.stringify({ type: 'play', cards: action.cards });
    case 'pass':
      return keys.join('|') === 'type' ? JSON.stringify({ type: 'pass' }) : null;
    default:
      return null;
  }
}

function isSameDecisionWindow(
  observation: SeatObservation<DoudizhuSeatId, DoudizhuPhase, SeatProjection>,
  legalActions: ReturnType<DoudizhuPort['listLegalActions']>,
): boolean {
  return observation.matchId === legalActions.matchId
    && observation.seatId === legalActions.seatId
    && observation.revision === legalActions.revision
    && observation.terminal === legalActions.terminal
    && observation.decision.phase === legalActions.decision.phase
    && observation.decision.turnNonce === legalActions.decision.turnNonce
    && observation.decision.activeSeatIds.join('|') === legalActions.decision.activeSeatIds.join('|');
}

class ControllerTimeoutError extends Error {
  constructor() {
    super('Agent controller timed out');
    this.name = 'ControllerTimeoutError';
  }
}

async function decideWithDeadline(
  controller: DoudizhuAgentController,
  decision: DoudizhuAgentDecision,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<unknown> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  const controllerAbort = new AbortController();
  const onAbort = () => controllerAbort.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controllerAbort.abort(new ControllerTimeoutError());
      reject(new ControllerTimeoutError());
    }, timeoutMs);
  });
  const abortPromise = new Promise<never>((_resolve, reject) => {
    controllerAbort.signal.addEventListener('abort', () => {
      if (signal?.aborted) reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
  try {
    try {
      return await Promise.race([
      Promise.resolve().then(() => controller.chooseAction(decision, controllerAbort.signal)),
        timeoutPromise,
        abortPromise,
      ]);
    } catch (cause) {
      if (timedOut) throw new ControllerTimeoutError();
      throw cause;
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

export function createDoudizhuAgentSessionKey(matchId: string, seatId: DoudizhuSeatId): string {
  return `alsniper.doudizhu/${encodeURIComponent(matchId)}/${seatId}`;
}

export const createHeuristicDoudizhuAgentController: DoudizhuAgentControllerFactory = (binding) => Object.freeze({
  binding,
  chooseAction: async (decision: Readonly<DoudizhuAgentDecision>) => (
    chooseHeuristicAction(decision.observation.observation)
  ),
});

function activeSeatFrom(observation: SeatObservation<DoudizhuSeatId, DoudizhuPhase, SeatProjection>) {
  return observation.decision.activeSeatIds[0] ?? null;
}

/** Builds the same optimistic-concurrency envelope for every participant kind. */
export function createDoudizhuActRequest(
  port: DoudizhuPort,
  action: DoudizhuAction,
  requestId: string,
): ActRequest<DoudizhuPhase, DoudizhuAction> {
  const observation = port.observe();
  return {
    requestId,
    expectedRevision: observation.revision,
    expectedPhase: observation.decision.phase,
    turnNonce: observation.decision.turnNonce,
    action,
  };
}

/** Human UI and Agent controllers deliberately share this exact submission path. */
export function submitDoudizhuAction(
  port: DoudizhuPort,
  action: DoudizhuAction,
  requestId: string,
): ActionReceipt<DoudizhuSeatId, DoudizhuPhase> {
  return port.act(createDoudizhuActRequest(port, action, requestId));
}

export class DoudizhuMatch {
  readonly matchId: string;
  private readonly ports: Readonly<Record<DoudizhuSeatId, DoudizhuPort>>;
  private readonly participantKinds: Readonly<Record<DoudizhuSeatId, ParticipantKind>>;
  private requestSequence = 0;

  constructor(options: Readonly<CreateDoudizhuMatchOptions>) {
    this.matchId = options.matchId.trim();
    if (this.matchId.length === 0) throw new TypeError('matchId must be a non-empty opaque identifier');
    const adapter = createDoudizhuAgentAdapter({ seed: options.seed, matchId: this.matchId });
    const host = createSequentialAgentGameHost({ matchId: this.matchId, adapter });
    const configs = Object.fromEntries(DOUDIZHU_SEAT_IDS.map((seatId) => [
      seatId,
      options.participants?.[seatId] ?? DEFAULT_PARTICIPANTS[seatId],
    ])) as unknown as Readonly<Record<DoudizhuSeatId, DoudizhuParticipantConfig>>;

    this.participantKinds = Object.freeze(Object.fromEntries(
      DOUDIZHU_SEAT_IDS.map((seatId) => [seatId, configs[seatId].kind]),
    )) as Readonly<Record<DoudizhuSeatId, ParticipantKind>>;
    this.ports = Object.freeze(Object.fromEntries(DOUDIZHU_SEAT_IDS.map((seatId) => [
      seatId,
      host.bindParticipant({ seatId, ...configs[seatId] }),
    ]))) as Readonly<Record<DoudizhuSeatId, DoudizhuPort>>;
  }

  getPort(seatId: DoudizhuSeatId): DoudizhuPort {
    return this.ports[seatId];
  }

  getHumanObservation(
    seatId: DoudizhuSeatId = 'seat-0',
  ): SeatObservation<DoudizhuSeatId, DoudizhuPhase, SeatProjection> {
    if (this.participantKinds[seatId] !== 'human') {
      throw new Error(`Seat "${seatId}" is not controlled by a human.`);
    }
    return this.ports[seatId].observe();
  }

  getActiveSeatId(): DoudizhuSeatId | null {
    return activeSeatFrom(this.ports['seat-0'].observe());
  }

  getControllerKind(seatId: DoudizhuSeatId): ParticipantKind {
    return this.participantKinds[seatId];
  }

  getAgentControllerBinding(seatId: DoudizhuSeatId): DoudizhuAgentControllerBinding {
    if (this.participantKinds[seatId] !== 'agent') {
      throw new Error(`Seat "${seatId}" is not controlled by an Agent.`);
    }
    return Object.freeze({
      gameId: 'alsniper.doudizhu',
      gameVersion: '1.0.0',
      matchId: this.matchId,
      seatId,
      seatKey: createDoudizhuAgentSessionKey(this.matchId, seatId),
    });
  }

  submit(
    seatId: DoudizhuSeatId,
    action: DoudizhuAction,
    requestId = this.nextRequestId(seatId),
  ): ActionReceipt<DoudizhuSeatId, DoudizhuPhase> {
    return submitDoudizhuAction(this.ports[seatId], action, requestId);
  }

  /** Executes no action unless the current controller is an Agent. */
  driveAgentTurn(): ActionReceipt<DoudizhuSeatId, DoudizhuPhase> | null {
    const activeSeatId = this.getActiveSeatId();
    if (activeSeatId === null || this.participantKinds[activeSeatId] !== 'agent') return null;
    const port = this.ports[activeSeatId];
    const action = chooseHeuristicAction(port.observe().observation);
    return this.submit(activeSeatId, action);
  }

  /**
   * Delegates one captured AGAP decision window to an asynchronous controller.
   * The returned action is always submitted against that original window; a
   * later observation is never used to disguise an out-of-date decision.
   */
  async driveAgentTurnAsync(
    controller: DoudizhuAgentController,
    options: Readonly<DriveDoudizhuAgentTurnOptions> = {},
  ): Promise<DoudizhuAsyncDriveResult> {
    const activeSeatId = this.getActiveSeatId();
    if (activeSeatId === null || this.participantKinds[activeSeatId] !== 'agent') {
      return Object.freeze({ status: 'skipped', seatId: activeSeatId, reason: 'not-agent-turn' });
    }
    const expectedBinding = this.getAgentControllerBinding(activeSeatId);
    if (
      controller.binding.matchId !== expectedBinding.matchId
      || controller.binding.seatId !== expectedBinding.seatId
      || controller.binding.seatKey !== expectedBinding.seatKey
      || controller.binding.gameId !== expectedBinding.gameId
      || controller.binding.gameVersion !== expectedBinding.gameVersion
    ) {
      throw new TypeError('Agent controller is not bound to the active game session and seat.');
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError('timeoutMs must be a positive safe integer.');
    }
    const fallbackPolicy = options.fallbackPolicy ?? 'on-error-or-timeout';
    const port = this.ports[activeSeatId];
    const observation = port.observe();
    const legalActionSet = port.listLegalActions();
    if (!isSameDecisionWindow(observation, legalActionSet)) {
      return Object.freeze({ status: 'skipped', seatId: activeSeatId, reason: 'stale-window' });
    }
    const requestId = this.nextRequestId(activeSeatId);
    const requestWindow = Object.freeze({
      requestId,
      expectedRevision: observation.revision,
      expectedPhase: observation.decision.phase,
      turnNonce: observation.decision.turnNonce,
    });
    const legalByIdentity = new Map(
      legalActionSet.actions.map(({ action }) => [actionIdentity(action), cloneProtocolDecision(action)] as const),
    );
    const fallbackAction = cloneProtocolDecision(chooseHeuristicAction(observation.observation));
    const decision = Object.freeze(cloneProtocolDecision({
      ...expectedBinding,
      observation,
      legalActions: legalActionSet,
    })) as DoudizhuAgentDecision;

    let selectedAction: DoudizhuAction | null = null;
    let failureReason: 'controller-error' | 'controller-timeout' | 'illegal-action' | null = null;
    try {
      const candidate = await decideWithDeadline(controller, decision, options.signal, timeoutMs);
      if (options.signal?.aborted) {
        return Object.freeze({ status: 'skipped', seatId: activeSeatId, reason: 'aborted' });
      }
      const identity = actionIdentity(candidate);
      selectedAction = identity === null ? null : legalByIdentity.get(identity) ?? null;
      if (selectedAction === null) failureReason = 'illegal-action';
    } catch (cause) {
      if (options.signal?.aborted) {
        return Object.freeze({ status: 'skipped', seatId: activeSeatId, reason: 'aborted' });
      }
      failureReason = cause instanceof ControllerTimeoutError ? 'controller-timeout' : 'controller-error';
    }

    if (failureReason !== null) {
      const canFallback = fallbackPolicy === 'on-error-or-timeout'
        || (fallbackPolicy === 'on-error' && failureReason !== 'controller-timeout');
      if (!canFallback) {
        return Object.freeze({ status: 'skipped', seatId: activeSeatId, reason: failureReason });
      }
      selectedAction = fallbackAction;
    }

    try {
      const receipt = port.act({ ...requestWindow, action: selectedAction! });
      return Object.freeze({
        status: 'committed',
        seatId: activeSeatId,
        source: failureReason === null ? 'controller' : 'heuristic-fallback',
        ...(failureReason === null ? {} : { fallbackReason: failureReason }),
        receipt,
      });
    } catch (cause) {
      const staleCodes = new Set<string>([
        AGAP_ERROR_CODES.STALE_REVISION,
        AGAP_ERROR_CODES.PHASE_MISMATCH,
        AGAP_ERROR_CODES.TURN_NONCE_MISMATCH,
        AGAP_ERROR_CODES.NOT_YOUR_TURN,
        AGAP_ERROR_CODES.GAME_TERMINAL,
      ]);
      if (cause instanceof AgapError && staleCodes.has(cause.code)) {
        return Object.freeze({ status: 'skipped', seatId: activeSeatId, reason: 'stale-window' });
      }
      if (cause instanceof AgapError && cause.code === AGAP_ERROR_CODES.ILLEGAL_ACTION) {
        return Object.freeze({ status: 'skipped', seatId: activeSeatId, reason: 'illegal-action' });
      }
      throw cause;
    }
  }

  /** Deterministically advances consecutive Agent seats, stopping at a human decision. */
  driveAgentsUntilHuman(maxActions = 10_000): DoudizhuDriveResult {
    if (!Number.isSafeInteger(maxActions) || maxActions <= 0) {
      throw new RangeError('maxActions must be a positive safe integer.');
    }
    let actionsTaken = 0;
    while (true) {
      const activeSeatId = this.getActiveSeatId();
      if (activeSeatId === null) {
        return { actionsTaken, terminal: true, activeSeatId: null, stoppedBecause: 'terminal' };
      }
      if (this.participantKinds[activeSeatId] === 'human') {
        return { actionsTaken, terminal: false, activeSeatId, stoppedBecause: 'human-turn' };
      }
      if (actionsTaken >= maxActions) {
        throw new Error(`Agent drive exceeded the ${maxActions}-action safety bound.`);
      }
      this.driveAgentTurn();
      actionsTaken += 1;
    }
  }

  private nextRequestId(seatId: DoudizhuSeatId): string {
    this.requestSequence += 1;
    return `${this.matchId}:${seatId}:request-${this.requestSequence}`;
  }
}

export function createDoudizhuMatch(options: Readonly<CreateDoudizhuMatchOptions>): DoudizhuMatch {
  return new DoudizhuMatch(options);
}
