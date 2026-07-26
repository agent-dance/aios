import { isAgapError, type LegalActionSet, type ParticipantPort, type SeatObservation } from '../../game-platform/agent';
import {
  SPACE_GAME_DESCRIPTOR,
  type SpaceGameAction,
  type SpaceGameEvent,
  type SpaceGameMetadata,
  type SpaceGameObservation,
  type SpaceGamePhase,
  type SpaceGameSeatId,
} from './SpaceGameAgentAdapter';

export type SpaceGameParticipantPort = ParticipantPort<
  SpaceGameSeatId,
  SpaceGamePhase,
  SpaceGameObservation,
  SpaceGameAction,
  SpaceGameEvent,
  SpaceGameMetadata,
  'sequential'
>;

export interface SpaceGameAgentDecisionInput {
  readonly gameId: typeof SPACE_GAME_DESCRIPTOR.gameId;
  readonly gameVersion: typeof SPACE_GAME_DESCRIPTOR.gameVersion;
  readonly matchId: string;
  /** Opaque per-binding key. It carries no seat or authority secret. */
  readonly seatKey: string;
  readonly observation: SeatObservation<SpaceGameSeatId, SpaceGamePhase, SpaceGameObservation, 'sequential'>;
  readonly legalActions: LegalActionSet<SpaceGameSeatId, SpaceGamePhase, SpaceGameAction, 'sequential'>;
}

export interface SpaceGameAgentController {
  chooseAction(input: SpaceGameAgentDecisionInput, signal?: AbortSignal): Promise<SpaceGameAction>;
}

export interface SpaceGameAgentDriverOptions {
  readonly controller: SpaceGameAgentController;
  readonly port: SpaceGameParticipantPort;
  readonly seatSessionKey: string;
  readonly replanIntervalMs?: number;
  readonly onError?: (error: unknown) => void;
}

export interface SpaceGameAgentDriver {
  start(): void;
  stop(): void;
  /** Key gameplay changes may request an immediate plan without creating another loop. */
  notifyObservation(observation: SpaceGameObservation): void;
  readonly running: boolean;
}

const MIN_REPLAN_INTERVAL_MS = 250;
const MAX_REPLAN_INTERVAL_MS = 500;
const DEFAULT_REPLAN_INTERVAL_MS = 350;
let driverInstanceSequence = 0;

const criticalSignature = (observation: SpaceGameObservation) =>
  `${observation.mode}:${observation.player.health}:${observation.wave}`;

export const createSpaceGameAgentDriver = (options: SpaceGameAgentDriverOptions): SpaceGameAgentDriver => {
  const replanIntervalMs = options.replanIntervalMs ?? DEFAULT_REPLAN_INTERVAL_MS;
  if (!Number.isFinite(replanIntervalMs) || replanIntervalMs < MIN_REPLAN_INTERVAL_MS || replanIntervalMs > MAX_REPLAN_INTERVAL_MS) {
    throw new RangeError(`replanIntervalMs must be between ${MIN_REPLAN_INTERVAL_MS} and ${MAX_REPLAN_INTERVAL_MS}.`);
  }
  if (!options.seatSessionKey || options.seatSessionKey.length > 256) {
    throw new TypeError('seatSessionKey must be a non-empty opaque string no longer than 256 characters.');
  }

  let active = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abortController: AbortController | null = null;
  let requestSequence = 0;
  let lastCriticalSignature = '';
  driverInstanceSequence += 1;
  const requestPrefix = `agent-driver-${driverInstanceSequence}`;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const schedule = (delayMs: number) => {
    if (!active) return;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void runDecision();
    }, delayMs);
  };

  const runDecision = async () => {
    if (!active || abortController) return;
    const observation = options.port.observe();
    const legalActions = options.port.listLegalActions();
    const controllerAbort = new AbortController();
    abortController = controllerAbort;
    try {
      const action = await options.controller.chooseAction(
        {
          gameId: SPACE_GAME_DESCRIPTOR.gameId,
          gameVersion: SPACE_GAME_DESCRIPTOR.gameVersion,
          matchId: observation.matchId,
          seatKey: options.seatSessionKey,
          observation,
          legalActions,
        },
        controllerAbort.signal,
      );
      if (!active || controllerAbort.signal.aborted) return;
      requestSequence += 1;
      options.port.act({
        requestId: `${requestPrefix}:${requestSequence}`,
        expectedRevision: observation.revision,
        expectedPhase: observation.decision.phase,
        turnNonce: observation.decision.turnNonce,
        action,
      });
    } catch (error) {
      if (!controllerAbort.signal.aborted && !(isAgapError(error) && error.retryable)) options.onError?.(error);
    } finally {
      if (abortController === controllerAbort) abortController = null;
      schedule(replanIntervalMs);
    }
  };

  return {
    get running() {
      return active;
    },
    start() {
      if (active) return;
      active = true;
      schedule(0);
    },
    stop() {
      active = false;
      clearTimer();
      abortController?.abort();
      abortController = null;
    },
    notifyObservation(observation) {
      const nextSignature = criticalSignature(observation);
      if (nextSignature === lastCriticalSignature) return;
      lastCriticalSignature = nextSignature;
      if (active && !abortController) schedule(0);
    },
  };
};
