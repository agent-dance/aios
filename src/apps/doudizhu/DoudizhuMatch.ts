import {
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
