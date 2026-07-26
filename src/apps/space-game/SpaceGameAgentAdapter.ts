import {
  AGAP_ERROR_CODES,
  AGAP_PROTOCOL_NAME,
  AGAP_PROTOCOL_VERSION,
  AgapError,
  type ActRequest,
  type ActionReceipt,
  type GameDescriptor,
  type LegalAction,
  type LegalActionSet,
  type ParticipantBinding,
  type ParticipantEvent,
  type ParticipantPort,
  type ReadEventsOptions,
  type SeatObservation,
} from '../../game-platform/agent';
import { createFixedStepRuntime } from '../../game-platform/runtime';
import {
  WORLD_BOUNDS,
  advanceGame,
  createInitialGameState,
  createInputState,
  restartGame,
  startGame,
  togglePause,
  type GameMode,
  type GameState,
  type InputState,
} from './gameEngine';

export const SPACE_GAME_SEAT_ID = 'pilot' as const;
export type SpaceGameSeatId = typeof SPACE_GAME_SEAT_ID;
export type SpaceGamePhase = GameMode;

export const SPACE_GAME_MOVEMENTS = [
  'neutral',
  'north',
  'north-east',
  'east',
  'south-east',
  'south',
  'south-west',
  'west',
  'north-west',
] as const;
export type SpaceGameMovement = (typeof SPACE_GAME_MOVEMENTS)[number];

export const SPACE_GAME_AIM_COLUMNS = [0, 1, 2, 3, 4] as const;
export const SPACE_GAME_AIM_ROWS = [0, 1, 2] as const;
export type SpaceGameAimColumn = (typeof SPACE_GAME_AIM_COLUMNS)[number];
export type SpaceGameAimRow = (typeof SPACE_GAME_AIM_ROWS)[number];

export interface SpaceGameAimCell {
  readonly column: SpaceGameAimColumn;
  readonly row: SpaceGameAimRow;
}

export type SpaceGameAction =
  | {
      readonly type: 'control';
      readonly movement: SpaceGameMovement;
      readonly fire: boolean;
      readonly aim: SpaceGameAimCell;
    }
  | { readonly type: 'start' }
  | { readonly type: 'pause' }
  | { readonly type: 'resume' }
  | { readonly type: 'restart' };

export interface SpaceGameVisibleEntity {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
}

export interface SpaceGameObservation {
  readonly coordinateSystem: 'origin:center,+x:right,+y:up,+z:away-from-player';
  /** Advances at 60 Hz without invalidating the current Agent decision. */
  readonly observationTick: number;
  readonly mode: GameMode;
  readonly player: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly velocityX: number;
    readonly velocityY: number;
    readonly health: number;
    readonly cooldownMs: number;
  };
  readonly enemies: readonly SpaceGameVisibleEntity[];
  readonly bullets: readonly SpaceGameVisibleEntity[];
  readonly score: number;
  readonly wave: number;
  readonly currentControl: SpaceGameControl;
}

export interface SpaceGameControl {
  readonly movement: SpaceGameMovement;
  readonly fire: boolean;
  readonly aim: SpaceGameAimCell;
}

/**
 * A renderer-only copy of the authoritative state. It deliberately omits the
 * seed, id allocator, spawn schedule, velocities, damage values, and input.
 * Holding this value grants no capability to observe or act through AGAP.
 */
export interface SpaceGameRenderProjection {
  readonly observationTick: number;
  readonly mode: GameMode;
  readonly player: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly health: number;
    readonly cooldownMs: number;
  };
  readonly enemies: readonly SpaceGameVisibleEntity[];
  readonly bullets: readonly SpaceGameVisibleEntity[];
  readonly particles: readonly {
    readonly id: number;
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly radius: number;
    readonly ageMs: number;
    readonly lifeMs: number;
  }[];
  readonly score: number;
  readonly wave: number;
}

export interface SpaceGameEvent {
  readonly type: 'control.changed' | 'mission.started' | 'mission.paused' | 'mission.resumed' | 'mission.restarted';
  readonly action: SpaceGameAction;
}

export interface SpaceGameMetadata {
  readonly rules: 'cosmic-vanguard-survival@1';
  readonly simulationHz: 60;
  readonly controlWindowMs: 250;
  readonly actionSchema: 'space-game-action@1';
  readonly aimGrid: { readonly columns: 5; readonly rows: 3 };
  readonly capabilities: readonly ['start', 'pause', 'resume', 'restart', 'move', 'fire', 'aim'];
}

export const SPACE_GAME_DESCRIPTOR: GameDescriptor<SpaceGameSeatId, SpaceGameMetadata> & {
  readonly turnModel: 'sequential';
} = Object.freeze({
  protocol: Object.freeze({ name: AGAP_PROTOCOL_NAME, version: AGAP_PROTOCOL_VERSION }),
  gameId: 'cosmic-vanguard',
  gameVersion: '1.0.0',
  displayName: 'Cosmic Vanguard',
  turnModel: 'sequential',
  informationModel: 'perfect',
  seats: Object.freeze([Object.freeze({ id: SPACE_GAME_SEAT_ID, label: 'Pilot' })]),
  metadata: Object.freeze({
    rules: 'cosmic-vanguard-survival@1',
    simulationHz: 60,
    controlWindowMs: 250,
    actionSchema: 'space-game-action@1',
    aimGrid: Object.freeze({ columns: 5, rows: 3 }),
    capabilities: Object.freeze([
      'start',
      'pause',
      'resume',
      'restart',
      'move',
      'fire',
      'aim',
    ] as const),
  }),
});

const CONTROL_WINDOW_TICKS = 15;
const DEFAULT_MAX_RECEIPTS = 10_000;
const DEFAULT_MAX_EVENTS = 25_000;

const movementVector: Readonly<Record<SpaceGameMovement, readonly [number, number]>> = Object.freeze({
  neutral: [0, 0],
  north: [0, 1],
  'north-east': [1, 1],
  east: [1, 0],
  'south-east': [1, -1],
  south: [0, -1],
  'south-west': [-1, -1],
  west: [-1, 0],
  'north-west': [-1, 1],
});

const round = (value: number) => Math.round(value * 100) / 100;

const aimCellToWorld = (aim: SpaceGameAimCell) => ({
  aimX: ((aim.column / (SPACE_GAME_AIM_COLUMNS.length - 1)) * 2 - 1) * WORLD_BOUNDS.x,
  aimY: (1 - (aim.row / (SPACE_GAME_AIM_ROWS.length - 1)) * 2) * WORLD_BOUNDS.y,
});

export const quantizeAimToCell = (aimX: number, aimY: number): SpaceGameAimCell => ({
  column: Math.max(0, Math.min(4, Math.round(((aimX / WORLD_BOUNDS.x + 1) / 2) * 4))) as SpaceGameAimColumn,
  row: Math.max(0, Math.min(2, Math.round(((1 - aimY / WORLD_BOUNDS.y) / 2) * 2))) as SpaceGameAimRow,
});

export const movementFromInput = (input: Pick<InputState, 'moveX' | 'moveY'>): SpaceGameMovement => {
  const x = Math.sign(input.moveX);
  const y = Math.sign(input.moveY);
  return SPACE_GAME_MOVEMENTS.find((movement) => {
    const [moveX, moveY] = movementVector[movement];
    return moveX === x && moveY === y;
  }) ?? 'neutral';
};

const createControlAction = (input: Readonly<InputState>): SpaceGameAction => ({
  type: 'control',
  movement: movementFromInput(input),
  fire: input.shootHeld,
  aim: quantizeAimToCell(input.aimX, input.aimY),
});

const isMovement = (value: unknown): value is SpaceGameMovement =>
  typeof value === 'string' && (SPACE_GAME_MOVEMENTS as readonly string[]).includes(value);

const isAimColumn = (value: unknown): value is SpaceGameAimColumn =>
  typeof value === 'number' && (SPACE_GAME_AIM_COLUMNS as readonly number[]).includes(value);

const isAimRow = (value: unknown): value is SpaceGameAimRow =>
  typeof value === 'number' && (SPACE_GAME_AIM_ROWS as readonly number[]).includes(value);

const isSpaceGameAction = (value: unknown): value is SpaceGameAction => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type === 'control') {
    const aim = record.aim;
    return (
      Object.keys(record).length === 4 &&
      isMovement(record.movement) &&
      typeof record.fire === 'boolean' &&
      Boolean(aim) &&
      typeof aim === 'object' &&
      !Array.isArray(aim) &&
      Object.keys(aim as object).length === 2 &&
      isAimColumn((aim as Record<string, unknown>).column) &&
      isAimRow((aim as Record<string, unknown>).row)
    );
  }
  return (
    Object.keys(record).length === 1 &&
    (record.type === 'start' || record.type === 'pause' || record.type === 'resume' || record.type === 'restart')
  );
};

const cloneAction = (action: SpaceGameAction): SpaceGameAction =>
  action.type === 'control'
    ? {
        type: 'control',
        movement: action.movement,
        fire: action.fire,
        aim: { column: action.aim.column, row: action.aim.row },
      }
    : { type: action.type };

const actionFingerprint = (request: ActRequest<SpaceGamePhase, SpaceGameAction>) =>
  JSON.stringify({
    requestId: request.requestId,
    expectedRevision: request.expectedRevision,
    expectedPhase: request.expectedPhase,
    turnNonce: request.turnNonce,
    action: request.action,
  });

const controlLabel = (movement: SpaceGameMovement, fire: boolean, aim: SpaceGameAimCell) =>
  `${movement}; ${fire ? 'fire' : 'hold fire'}; aim ${aim.column + 1},${aim.row + 1}`;

const CONTROL_ACTIONS: readonly LegalAction<SpaceGameAction>[] = Object.freeze(
  SPACE_GAME_MOVEMENTS.flatMap((movement) =>
    [false, true].flatMap((fire) =>
      SPACE_GAME_AIM_ROWS.flatMap((row) =>
        SPACE_GAME_AIM_COLUMNS.map((column) => {
          const aim = Object.freeze({ column, row });
          return Object.freeze({
            action: Object.freeze({ type: 'control' as const, movement, fire, aim }),
            label: controlLabel(movement, fire, aim),
            description: 'Latch this movement, fire, and quantized aim plan until another legal control action is committed.',
          });
        }),
      ),
    ),
  ),
);

const lifecycleAction = (type: 'start' | 'pause' | 'resume' | 'restart', label: string): LegalAction<SpaceGameAction> =>
  Object.freeze({ action: Object.freeze({ type }), label });

const legalActionsForPhase = (phase: SpaceGamePhase): readonly LegalAction<SpaceGameAction>[] => {
  switch (phase) {
    case 'start':
      return Object.freeze([lifecycleAction('start', 'Launch mission')]);
    case 'playing':
      return Object.freeze([
        ...CONTROL_ACTIONS,
        lifecycleAction('pause', 'Pause mission'),
        lifecycleAction('restart', 'Restart mission'),
      ]);
    case 'paused':
      return Object.freeze([
        lifecycleAction('resume', 'Resume mission'),
        lifecycleAction('restart', 'Restart mission'),
      ]);
    case 'game-over':
      return Object.freeze([lifecycleAction('restart', 'Restart mission')]);
  }
};

const actionEquals = (left: SpaceGameAction, right: SpaceGameAction) =>
  JSON.stringify(left) === JSON.stringify(right);

const projectObservation = (
  state: Readonly<GameState>,
  input: Readonly<InputState>,
  observationTick: number,
): SpaceGameObservation => ({
  coordinateSystem: 'origin:center,+x:right,+y:up,+z:away-from-player',
  observationTick,
  mode: state.mode,
  player: {
    x: round(state.player.x),
    y: round(state.player.y),
    z: round(state.player.z),
    velocityX: round(state.player.velocityX),
    velocityY: round(state.player.velocityY),
    health: state.player.health,
    cooldownMs: round(state.player.cooldownMs),
  },
  enemies: state.enemies.map((enemy) => ({
    id: enemy.id,
    x: round(enemy.x),
    y: round(enemy.y),
    z: round(enemy.z),
    radius: round(enemy.radius),
  })),
  bullets: state.bullets.map((bullet) => ({
    id: bullet.id,
    x: round(bullet.x),
    y: round(bullet.y),
    z: round(bullet.z),
    radius: round(bullet.radius),
  })),
  score: state.score,
  wave: state.wave,
  currentControl: {
    movement: movementFromInput(input),
    fire: input.shootHeld,
    aim: quantizeAimToCell(input.aimX, input.aimY),
  },
});

const projectRenderState = (
  state: Readonly<GameState>,
  observationTick: number,
): SpaceGameRenderProjection => ({
  observationTick,
  mode: state.mode,
  player: {
    x: state.player.x,
    y: state.player.y,
    z: state.player.z,
    health: state.player.health,
    cooldownMs: state.player.cooldownMs,
  },
  enemies: state.enemies.map(({ id, x, y, z, radius }) => ({ id, x, y, z, radius })),
  bullets: state.bullets.map(({ id, x, y, z, radius }) => ({ id, x, y, z, radius })),
  particles: state.particles.map(({ id, x, y, z, radius, ageMs, lifeMs }) => ({
    id,
    x,
    y,
    z,
    radius,
    ageMs,
    lifeMs,
  })),
  score: state.score,
  wave: state.wave,
});

export const createInitialSpaceGameRenderProjection = (): SpaceGameRenderProjection =>
  projectRenderState(createInitialGameState(), 0);

export const renderSpaceGameObservationToText = (observation: SpaceGameObservation) =>
  JSON.stringify({
    coordinateSystem: observation.coordinateSystem,
    mode: observation.mode,
    player: {
      x: observation.player.x,
      y: observation.player.y,
      z: observation.player.z,
      vx: observation.player.velocityX,
      vy: observation.player.velocityY,
      health: observation.player.health,
      cooldownMs: observation.player.cooldownMs,
    },
    enemies: observation.enemies.map((enemy) => ({
      id: enemy.id,
      x: enemy.x,
      y: enemy.y,
      z: enemy.z,
      r: enemy.radius,
    })),
    bullets: observation.bullets.map((bullet) => ({
      id: bullet.id,
      x: bullet.x,
      y: bullet.y,
      z: bullet.z,
      r: bullet.radius,
    })),
    score: observation.score,
    health: observation.player.health,
    wave: observation.wave,
    cooldownMs: observation.player.cooldownMs,
    observationTick: observation.observationTick,
    currentControl: {
      movement: observation.currentControl.movement,
      fire: observation.currentControl.fire,
      aim: { ...observation.currentControl.aim },
    },
  });

const safeRequestId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;

interface ReceiptRecord {
  readonly fingerprint: string;
  readonly receipt: ActionReceipt<SpaceGameSeatId, SpaceGamePhase, 'sequential'>;
}

export interface CreateSpaceGameMatchOptions {
  readonly matchId: string;
  readonly maxReceipts?: number;
  readonly maxEvents?: number;
  readonly onPublish?: (projection: Readonly<SpaceGameRenderProjection>) => void;
}

export interface SpaceGameAdvanceResult {
  readonly steps: number;
  readonly observationTick: number;
}

export interface SpaceGameMatch {
  getDescriptor(): typeof SPACE_GAME_DESCRIPTOR;
  bindParticipant(
    binding: ParticipantBinding<SpaceGameSeatId>,
  ): ParticipantPort<
    SpaceGameSeatId,
    SpaceGamePhase,
    SpaceGameObservation,
    SpaceGameAction,
    SpaceGameEvent,
    SpaceGameMetadata,
    'sequential'
  >;
  getPhase(): SpaceGamePhase;
  getCurrentControl(): SpaceGameControl;
  getRenderProjection(): Readonly<SpaceGameRenderProjection>;
  /** Monotonic and cheap to compare; changes only for phase/health/wave. */
  getCriticalObservationVersion(): number;
  advance(elapsedMs: number): SpaceGameAdvanceResult;
  resetClock(): void;
  resetInput(): void;
  renderVisibleState(): string;
}

export const createSpaceGameMatch = (options: CreateSpaceGameMatchOptions): SpaceGameMatch => {
  if (!safeRequestId(options.matchId)) throw new TypeError('matchId must be a non-empty string no longer than 256 characters.');
  const maxReceipts = options.maxReceipts ?? DEFAULT_MAX_RECEIPTS;
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  if (!Number.isSafeInteger(maxReceipts) || maxReceipts <= 0) throw new RangeError('maxReceipts must be a positive safe integer.');
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 3) throw new RangeError('maxEvents must be a safe integer of at least 3.');

  let bound = false;
  let revision = 0;
  let nonceSerial = 0;
  let trackedPhase: SpaceGamePhase = 'start';
  let trackedControlWindow = 0;
  let criticalObservationVersion = 0;
  let trackedCriticalPhase: SpaceGamePhase = 'start';
  let trackedCriticalHealth = createInitialGameState().player.health;
  let trackedCriticalWave = 1;
  let isPublishing = false;
  let latestRenderProjection = createInitialSpaceGameRenderProjection();
  const receipts = new Map<string, ReceiptRecord>();
  const events: ParticipantEvent<SpaceGameSeatId, SpaceGamePhase, SpaceGameEvent, 'sequential'>[] = [];

  const assertParticipantAccessAllowed = () => {
    if (isPublishing) {
      throw new AgapError(
        AGAP_ERROR_CODES.INVALID_REQUEST,
        'Participant capabilities cannot be invoked from the render publish observer.',
      );
    }
  };

  const runtime = createFixedStepRuntime({
    createInitialState: createInitialGameState,
    createInitialInput: createInputState,
    simulate: (state, input, context) => advanceGame(state, input, context.deltaMs),
    onPublish: (state, metadata) => {
      latestRenderProjection = projectRenderState(state, metadata.clock.tick);
      if (!options.onPublish) return;
      isPublishing = true;
      try {
        options.onPublish(latestRenderProjection);
      } finally {
        isPublishing = false;
      }
    },
  });

  const currentPhase = () => runtime.getState().mode;
  const currentControlWindow = () => Math.floor(runtime.getClock().tick / CONTROL_WINDOW_TICKS);
  const turnNonce = () => `${trackedPhase}:${trackedControlWindow}:${nonceSerial}`;

  const rotateDecisionIfNeeded = () => {
    const nextPhase = currentPhase();
    const nextControlWindow = currentControlWindow();
    if (nextPhase !== trackedPhase || (nextPhase === 'playing' && nextControlWindow !== trackedControlWindow)) {
      trackedPhase = nextPhase;
      trackedControlWindow = nextControlWindow;
      revision += 1;
      nonceSerial += 1;
    }
  };

  const refreshCriticalObservationVersion = () => {
    const state = runtime.getState();
    if (
      state.mode === trackedCriticalPhase &&
      state.player.health === trackedCriticalHealth &&
      state.wave === trackedCriticalWave
    ) {
      return;
    }
    trackedCriticalPhase = state.mode;
    trackedCriticalHealth = state.player.health;
    trackedCriticalWave = state.wave;
    criticalObservationVersion += 1;
  };

  const decision = () =>
    Object.freeze({
      mode: 'sequential' as const,
      phase: trackedPhase,
      activeSeatIds: Object.freeze([SPACE_GAME_SEAT_ID]),
      turnNonce: turnNonce(),
    });

  const addEvent = (
    kind: 'match.started' | 'game.event' | 'state.advanced',
    data: SpaceGameEvent | null | {
      readonly actorSeatIds: readonly SpaceGameSeatId[];
      readonly terminal: false;
      readonly decision: ReturnType<typeof decision>;
    },
  ) => {
    events.push(
      Object.freeze({
        sequence: events.length + 1,
        matchId: options.matchId,
        revision,
        phase: trackedPhase,
        kind,
        data,
      }) as ParticipantEvent<SpaceGameSeatId, SpaceGamePhase, SpaceGameEvent, 'sequential'>,
    );
  };

  addEvent('match.started', null);

  const observe = (): SeatObservation<SpaceGameSeatId, SpaceGamePhase, SpaceGameObservation, 'sequential'> => {
    assertParticipantAccessAllowed();
    rotateDecisionIfNeeded();
    return Object.freeze({
      matchId: options.matchId,
      seatId: SPACE_GAME_SEAT_ID,
      revision,
      terminal: false,
      decision: decision(),
      observation: projectObservation(runtime.getState(), runtime.getInput(), runtime.getClock().tick),
    });
  };

  const listLegalActions = (): LegalActionSet<SpaceGameSeatId, SpaceGamePhase, SpaceGameAction, 'sequential'> => {
    assertParticipantAccessAllowed();
    const observation = observe();
    return Object.freeze({
      matchId: observation.matchId,
      seatId: observation.seatId,
      revision: observation.revision,
      terminal: observation.terminal,
      decision: observation.decision,
      actions: legalActionsForPhase(observation.decision.phase).map((entry) => ({
        ...entry,
        action: cloneAction(entry.action),
      })),
    });
  };

  const applyAction = (action: SpaceGameAction) => {
    const phase = currentPhase();
    switch (action.type) {
      case 'start':
        if (phase !== 'start') throw new AgapError(AGAP_ERROR_CODES.ILLEGAL_ACTION, 'start is legal only before launch.');
        runtime.reset({ state: startGame(), input: createInputState() });
        return { type: 'mission.started' as const, action };
      case 'pause':
        if (phase !== 'playing') throw new AgapError(AGAP_ERROR_CODES.ILLEGAL_ACTION, 'pause is legal only while playing.');
        runtime.replaceState(togglePause(runtime.getState()) as GameState);
        runtime.resetInput();
        return { type: 'mission.paused' as const, action };
      case 'resume':
        if (phase !== 'paused') throw new AgapError(AGAP_ERROR_CODES.ILLEGAL_ACTION, 'resume is legal only while paused.');
        runtime.replaceState(togglePause(runtime.getState()) as GameState);
        return { type: 'mission.resumed' as const, action };
      case 'restart':
        runtime.reset({ state: restartGame(), input: createInputState() });
        return { type: 'mission.restarted' as const, action };
      case 'control': {
        if (phase !== 'playing') throw new AgapError(AGAP_ERROR_CODES.ILLEGAL_ACTION, 'control is legal only while playing.');
        const [moveX, moveY] = movementVector[action.movement];
        const aim = aimCellToWorld(action.aim);
        runtime.replaceInput({ moveX, moveY, shootHeld: action.fire, ...aim });
        return { type: 'control.changed' as const, action };
      }
    }
  };

  const act = (
    request: ActRequest<SpaceGamePhase, SpaceGameAction>,
  ): ActionReceipt<SpaceGameSeatId, SpaceGamePhase, 'sequential'> => {
    assertParticipantAccessAllowed();
    if (!request || typeof request !== 'object' || !safeRequestId(request.requestId) || !isSpaceGameAction(request.action)) {
      throw new AgapError(AGAP_ERROR_CODES.INVALID_REQUEST, 'The action request is malformed.');
    }
    const fingerprint = actionFingerprint(request);
    const previousRecord = receipts.get(request.requestId);
    if (previousRecord) {
      if (previousRecord.fingerprint !== fingerprint) {
        throw new AgapError(AGAP_ERROR_CODES.IDEMPOTENCY_CONFLICT, 'requestId was reused with a different payload.');
      }
      return previousRecord.receipt;
    }
    if (receipts.size >= maxReceipts) {
      throw new AgapError(AGAP_ERROR_CODES.RECEIPT_CAPACITY_EXCEEDED, 'The receipt capacity is exhausted.');
    }
    if (events.length + 2 > maxEvents) {
      throw new AgapError(AGAP_ERROR_CODES.EVENT_CAPACITY_EXCEEDED, 'The event capacity is exhausted.');
    }

    rotateDecisionIfNeeded();
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision !== revision) {
      throw new AgapError(AGAP_ERROR_CODES.STALE_REVISION, 'The expected revision is stale.', { retryable: true });
    }
    if (request.expectedPhase !== trackedPhase) {
      throw new AgapError(AGAP_ERROR_CODES.PHASE_MISMATCH, 'The expected phase has changed.', { retryable: true });
    }
    if (request.turnNonce !== turnNonce()) {
      throw new AgapError(AGAP_ERROR_CODES.TURN_NONCE_MISMATCH, 'The decision window has changed.', { retryable: true });
    }
    const legal = legalActionsForPhase(trackedPhase).some((entry) => actionEquals(entry.action, request.action));
    if (!legal) throw new AgapError(AGAP_ERROR_CODES.ILLEGAL_ACTION, 'The action is not legal in the current decision window.');

    const previousRevision = revision;
    const gameEvent = applyAction(cloneAction(request.action));
    trackedPhase = currentPhase();
    trackedControlWindow = currentControlWindow();
    refreshCriticalObservationVersion();
    revision += 1;
    nonceSerial += 1;
    addEvent('game.event', gameEvent);
    addEvent('state.advanced', {
      actorSeatIds: Object.freeze([SPACE_GAME_SEAT_ID]),
      terminal: false,
      decision: decision(),
    });
    const receipt = Object.freeze({
      requestId: request.requestId,
      matchId: options.matchId,
      seatId: SPACE_GAME_SEAT_ID,
      accepted: true as const,
      disposition: 'committed' as const,
      previousRevision,
      revision,
      terminal: false,
      decision: decision(),
    });
    receipts.set(request.requestId, Object.freeze({ fingerprint, receipt }));
    return receipt;
  };

  const readEvents = (readOptions: ReadEventsOptions = {}) => {
    assertParticipantAccessAllowed();
    const afterSequence = readOptions.afterSequence ?? 0;
    const limit = readOptions.limit ?? events.length;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(limit) || limit <= 0) {
      throw new AgapError(AGAP_ERROR_CODES.INVALID_REQUEST, 'Event cursor and limit must be valid safe integers.');
    }
    return events.slice(afterSequence, afterSequence + limit).map((event): ParticipantEvent<
      SpaceGameSeatId,
      SpaceGamePhase,
      SpaceGameEvent,
      'sequential'
    > => {
      if (event.kind === 'match.started' || event.kind === 'match.ended') return { ...event, data: null };
      if (event.kind === 'game.event') {
        return {
          ...event,
          data: { type: event.data.type, action: cloneAction(event.data.action) },
        };
      }
      return {
        ...event,
        data: {
          actorSeatIds: [...event.data.actorSeatIds],
          terminal: event.data.terminal,
          decision: {
            ...event.data.decision,
            activeSeatIds: [...event.data.decision.activeSeatIds],
          },
        },
      };
    });
  };

  const port = Object.freeze({
    getDescriptor: () => SPACE_GAME_DESCRIPTOR,
    observe,
    listLegalActions,
    act,
    readEvents,
  });

  return Object.freeze({
    getDescriptor: () => SPACE_GAME_DESCRIPTOR,
    bindParticipant: (binding: ParticipantBinding<SpaceGameSeatId>) => {
      assertParticipantAccessAllowed();
      if (!binding || binding.seatId !== SPACE_GAME_SEAT_ID) {
        throw new AgapError(AGAP_ERROR_CODES.UNKNOWN_SEAT, 'The requested seat does not exist.');
      }
      if (!safeRequestId(binding.participantId) || (binding.kind !== 'human' && binding.kind !== 'agent')) {
        throw new AgapError(AGAP_ERROR_CODES.INVALID_REQUEST, 'The participant binding is malformed.');
      }
      if (bound) throw new AgapError(AGAP_ERROR_CODES.SEAT_ALREADY_BOUND, 'The pilot seat is already bound.');
      bound = true;
      return port;
    },
    getPhase: currentPhase,
    getCurrentControl: () => {
      const action = createControlAction(runtime.getInput());
      if (action.type !== 'control') throw new Error('Control projection invariant failed.');
      return Object.freeze({
        movement: action.movement,
        fire: action.fire,
        aim: Object.freeze({ ...action.aim }),
      });
    },
    getRenderProjection: () => latestRenderProjection,
    getCriticalObservationVersion: () => criticalObservationVersion,
    advance: (elapsedMs: number) => {
      assertParticipantAccessAllowed();
      if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
        throw new RangeError('elapsedMs must be a finite non-negative number.');
      }
      if (currentPhase() !== 'playing') {
        return Object.freeze({ steps: 0, observationTick: runtime.getClock().tick });
      }
      const result = runtime.advance(elapsedMs);
      rotateDecisionIfNeeded();
      refreshCriticalObservationVersion();
      return Object.freeze({ steps: result.steps, observationTick: result.clock.tick });
    },
    resetClock: () => {
      assertParticipantAccessAllowed();
      runtime.resetClock();
      latestRenderProjection = projectRenderState(runtime.getState(), 0);
    },
    resetInput: () => {
      assertParticipantAccessAllowed();
      runtime.resetInput();
    },
    renderVisibleState: () =>
      renderSpaceGameObservationToText(
        projectObservation(runtime.getState(), runtime.getInput(), runtime.getClock().tick),
      ),
  });
};
