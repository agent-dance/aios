#!/usr/bin/env node

import { constants as fsConstants } from 'node:fs';
import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..', '..');

const RESERVED_IDS = new Set([
  'aux',
  'calculator',
  'clock$',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'con',
  'finder',
  'game-platform',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
  'node-modules',
  'nul',
  'prn',
  'settings',
  'space-game',
  'store',
  'terminal',
]);

const KEBAB_CASE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export class ScaffoldError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScaffoldError';
  }
}

export function validateGameId(value) {
  if (typeof value !== 'string' || !KEBAB_CASE_PATTERN.test(value) || value.length > 64) {
    throw new ScaffoldError('Game id must be 1-64 characters of lowercase kebab-case and start with a letter.');
  }
  if (RESERVED_IDS.has(value)) {
    throw new ScaffoldError(`Game id "${value}" is reserved.`);
  }
  return value;
}

export function validateDisplayName(value) {
  if (typeof value !== 'string') {
    throw new ScaffoldError('Display name is required.');
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length === 0 || normalized.length > 80 || CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw new ScaffoldError('Display name must contain 1-80 printable characters.');
  }
  return normalized;
}

export function toPascalCase(id) {
  return id
    .split('-')
    .map((segment) => segment[0].toUpperCase() + segment.slice(1))
    .join('');
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function pathExists(candidate) {
  try {
    await access(candidate, fsConstants.F_OK);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

export function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const equalsIndex = token.indexOf('=');
    const flag = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
    const inlineValue = equalsIndex >= 0 ? token.slice(equalsIndex + 1) : undefined;
    if (flag !== '--id' && flag !== '--name') {
      throw new ScaffoldError(`Unknown argument: ${token}`);
    }
    const key = flag.slice(2);
    if (Object.hasOwn(parsed, key)) {
      throw new ScaffoldError(`Argument ${flag} may only be provided once.`);
    }
    const value = inlineValue ?? argv[++index];
    if (value === undefined || value.startsWith('--')) {
      throw new ScaffoldError(`Argument ${flag} requires a value.`);
    }
    parsed[key] = value;
  }
  return {
    id: validateGameId(parsed.id),
    name: validateDisplayName(parsed.name),
  };
}

function engineTemplate(typeName) {
  return `export type ${typeName}Mode = 'ready' | 'playing' | 'paused';

export type ${typeName}Action =
  | { readonly type: 'start' }
  | { readonly type: 'move'; readonly direction: -1 | 1 }
  | { readonly type: 'pause' }
  | { readonly type: 'resume' }
  | { readonly type: 'restart' };

export interface ${typeName}State {
  mode: ${typeName}Mode;
  playerX: number;
  score: number;
}

export interface ${typeName}PublicView {
  readonly mode: ${typeName}Mode;
  readonly player: { readonly x: number; readonly y: 0; readonly z: 0 };
  readonly score: number;
}

/** Presentation-only state. Authoritative gameplay fields are forbidden here. */
export interface ${typeName}PresentationState {
  readonly elapsedMs: number;
}

export interface ${typeName}PresentationInput {
  readonly reserved: false;
}

const MOVE_DISTANCE = 0.75;
const WORLD_LIMIT = 4.5;

export const createInitial${typeName}State = (): ${typeName}State => ({
  mode: 'ready',
  playerX: 0,
  score: 0,
});

export const createInitial${typeName}PresentationState = (): ${typeName}PresentationState => ({ elapsedMs: 0 });
export const createInitial${typeName}PresentationInput = (): ${typeName}PresentationInput => ({ reserved: false });

export function listLegal${typeName}Actions(
  state: Readonly<${typeName}State>,
): readonly ${typeName}Action[] {
  if (state.mode === 'ready') return [{ type: 'start' }];
  if (state.mode === 'paused') return [{ type: 'resume' }, { type: 'restart' }];
  return [
    { type: 'move', direction: -1 },
    { type: 'move', direction: 1 },
    { type: 'pause' },
    { type: 'restart' },
  ];
}

const isExactAction = (candidate: ${typeName}Action, action: Readonly<${typeName}Action>) =>
  candidate.type === action.type
  && (candidate.type !== 'move'
    || (action.type === 'move' && candidate.direction === action.direction));

/** The only reducer for formal gameplay commands, regardless of participant kind. */
export function reduce${typeName}Action(
  state: Readonly<${typeName}State>,
  action: Readonly<${typeName}Action>,
): ${typeName}State {
  if (!listLegal${typeName}Actions(state).some((candidate) => isExactAction(candidate, action))) {
    throw new Error(\`Illegal ${typeName} action \${JSON.stringify(action)} in mode \${state.mode}.\`);
  }
  if (action.type === 'start') return { ...createInitial${typeName}State(), mode: 'playing' };
  if (action.type === 'restart') return createInitial${typeName}State();
  if (action.type === 'pause') return { ...state, mode: 'paused' };
  if (action.type === 'resume') return { ...state, mode: 'playing' };
  return {
    ...state,
    playerX: Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, state.playerX + action.direction * MOVE_DISTANCE)),
  };
}

export function project${typeName}State(state: Readonly<${typeName}State>): ${typeName}PublicView {
  return {
    mode: state.mode,
    player: { x: state.playerX, y: 0, z: 0 },
    score: state.score,
  };
}

export function simulate${typeName}Presentation(
  state: Readonly<${typeName}PresentationState>,
  _input: Readonly<${typeName}PresentationInput>,
  context: { deltaMs: number },
): ${typeName}PresentationState {
  return { ...state, elapsedMs: state.elapsedMs + context.deltaMs };
}

const round = (value: number) => Math.round(value * 100) / 100;

export function render${typeName}ToText(
  view: Readonly<${typeName}PublicView>,
  presentation: Readonly<${typeName}PresentationState>,
) {
  return JSON.stringify({
    coordinateSystem: 'origin:center,+x:right,+y:up,+z:toward-camera',
    mode: view.mode,
    player: { x: round(view.player.x), y: 0, z: 0 },
    elapsedMs: round(presentation.elapsedMs),
    score: view.score,
  });
}
`;
}

function agentAdapterTemplate(id, displayName, typeName) {
  return `import {
  AGAP_PROTOCOL_NAME,
  AGAP_PROTOCOL_VERSION,
  createSequentialAgentGameHost,
  type GameDescriptor,
  type ParticipantPort,
  type SequentialGameAdapter,
} from '../../game-platform/agent';
import {
  createInitial${typeName}State,
  listLegal${typeName}Actions,
  project${typeName}State,
  reduce${typeName}Action,
  type ${typeName}Action,
  type ${typeName}Mode,
  type ${typeName}PublicView,
  type ${typeName}State,
} from './${typeName}Engine';

export const ${typeName.toUpperCase()}_PLAYER_SEAT_ID = 'player' as const;
export type ${typeName}SeatId = typeof ${typeName.toUpperCase()}_PLAYER_SEAT_ID;

export type ${typeName}Observation = ${typeName}PublicView;

export interface ${typeName}AgentMetadata {
  readonly coordinateSystem: 'origin:center,+x:right,+y:up,+z:toward-camera';
  readonly actionTypes: readonly ['start', 'move', 'pause', 'resume', 'restart'];
  readonly seatProjection: 'player-visible';
}

export type ${typeName}ParticipantPort = ParticipantPort<
  ${typeName}SeatId,
  ${typeName}Mode,
  ${typeName}Observation,
  ${typeName}Action,
  never,
  ${typeName}AgentMetadata
>;

export const ${typeName.toUpperCase()}_AGAP_DESCRIPTOR = Object.freeze({
  protocol: { name: AGAP_PROTOCOL_NAME, version: AGAP_PROTOCOL_VERSION },
  gameId: ${JSON.stringify(id)},
  gameVersion: '1.0.0',
  displayName: ${JSON.stringify(displayName)},
  turnModel: 'sequential',
  informationModel: 'perfect',
  seats: [{ id: ${typeName.toUpperCase()}_PLAYER_SEAT_ID, label: 'Player' }],
  metadata: {
    coordinateSystem: 'origin:center,+x:right,+y:up,+z:toward-camera',
    actionTypes: ['start', 'move', 'pause', 'resume', 'restart'],
    seatProjection: 'player-visible',
  },
} satisfies GameDescriptor<${typeName}SeatId, ${typeName}AgentMetadata> & { readonly turnModel: 'sequential' });

const actionLabel = (action: ${typeName}Action) => {
  if (action.type === 'move') return action.direction < 0 ? 'Move left' : 'Move right';
  if (action.type === 'start') return 'Start';
  if (action.type === 'pause') return 'Pause';
  if (action.type === 'resume') return 'Resume';
  return 'Restart';
};

/** Transport-neutral AGAP adapter. Observation is the information visible to this seat. */
export const ${typeName.toUpperCase()}_AGENT_ADAPTER: SequentialGameAdapter<
  ${typeName}State,
  ${typeName}SeatId,
  ${typeName}Mode,
  ${typeName}Observation,
  ${typeName}Action,
  never,
  ${typeName}AgentMetadata
> = Object.freeze({
  descriptor: ${typeName.toUpperCase()}_AGAP_DESCRIPTOR,
  createInitialState: createInitial${typeName}State,
  getPhase: (state: Readonly<${typeName}State>): ${typeName}Mode => state.mode,
  isTerminal: () => false,
  getActiveSeatId: () => ${typeName.toUpperCase()}_PLAYER_SEAT_ID,
  observe: (
    state: Readonly<${typeName}State>,
    _seatId: ${typeName}SeatId,
  ): ${typeName}Observation => project${typeName}State(state),
  legalActions: (
    state: Readonly<${typeName}State>,
    _seatId: ${typeName}SeatId,
  ) => listLegal${typeName}Actions(state).map((action) => ({
    action,
    label: actionLabel(action),
  })),
  transition: (
    state: Readonly<${typeName}State>,
    _seatId: ${typeName}SeatId,
    action: Readonly<${typeName}Action>,
  ) => ({ state: reduce${typeName}Action(state, action) }),
});

export const create${typeName}AgentGameHost = (matchId: string) => createSequentialAgentGameHost({
  matchId,
  adapter: ${typeName.toUpperCase()}_AGENT_ADAPTER,
});
`;
}

function appTemplate(id, displayName, typeName) {
  return `import { Canvas } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createFixedStepRuntime } from '../../game-platform/runtime';
import { FixedStepDriver } from '../../game-platform/r3f';
import {
  hasVirtualTimeMarker,
  useFullscreenController,
  useGameAutomationBridge,
  useGameLifecycle,
  type GameAutomationTarget,
} from '../../game-platform/web';
import {
  createInitial${typeName}PresentationInput,
  createInitial${typeName}PresentationState,
  render${typeName}ToText,
  simulate${typeName}Presentation,
  type ${typeName}Action,
  type ${typeName}PresentationInput,
  type ${typeName}PresentationState,
} from './${typeName}Engine';
import {
  create${typeName}AgentGameHost,
  ${typeName.toUpperCase()}_PLAYER_SEAT_ID,
  type ${typeName}ParticipantPort,
} from './${typeName}AgentAdapter';

const shellStyle: CSSProperties = {
  width: '100%', height: '100%', minHeight: 360, position: 'relative', overflow: 'hidden',
  background: '#07111f', color: '#f4fbff', fontFamily: 'system-ui, sans-serif',
};

const GAME_NAME = ${JSON.stringify(displayName)};

function Player({ playerX }: { playerX: number }) {
  return (
    <mesh position={[playerX, 0, 0]}>
      <boxGeometry args={[1, 1, 1]} />
      <meshLambertMaterial color="#6ff7d8" />
    </mesh>
  );
}

function create${typeName}Runtime() {
  return createFixedStepRuntime<${typeName}PresentationState, ${typeName}PresentationInput>({
    createInitialState: createInitial${typeName}PresentationState,
    createInitialInput: createInitial${typeName}PresentationInput,
    simulate: simulate${typeName}Presentation,
  });
}

export interface ${typeName}AppProps { isActive?: boolean }

export function ${typeName}App({ isActive = true }: ${typeName}AppProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<ReturnType<typeof create${typeName}Runtime> | null>(null);
  if (!runtimeRef.current) runtimeRef.current = create${typeName}Runtime();
  const runtime = runtimeRef.current;
  const humanPortRef = useRef<${typeName}ParticipantPort | null>(null);
  if (!humanPortRef.current) {
    humanPortRef.current = create${typeName}AgentGameHost('${id}-local').bindParticipant({
      seatId: ${typeName.toUpperCase()}_PLAYER_SEAT_ID,
      kind: 'human',
      participantId: 'local-human',
    });
  }
  const humanPort = humanPortRef.current;
  const requestSequenceRef = useRef(0);
  const [snapshot, setSnapshot] = useState(() => humanPort.observe().observation);
  // The official client installs its marker before React mounts. Taking clock
  // ownership during the first render prevents a real R3F tick from racing the
  // passive effect that installs the automation bridge.
  const [manualClock, setManualClock] = useState(
    () => typeof window !== 'undefined'
      && hasVirtualTimeMarker(window as GameAutomationTarget),
  );
  const manualClockRef = useRef(manualClock);

  const publish = useCallback(() => setSnapshot(humanPort.observe().observation), [humanPort]);
  const resetInput = useCallback(() => {
    runtime.resetInput();
  }, [runtime]);
  const resetPresentation = useCallback(() => {
    runtime.resetInput();
    runtime.resetClock();
    runtime.replaceState(createInitial${typeName}PresentationState());
  }, [runtime]);
  const dispatchAction = useCallback((action: ${typeName}Action) => {
    const before = humanPort.observe();
    humanPort.act({
      requestId: \`local-human-\${++requestSequenceRef.current}\`,
      expectedRevision: before.revision,
      expectedPhase: before.decision.phase,
      turnNonce: before.decision.turnNonce,
      action,
    });
    publish();
  }, [humanPort, publish]);
  const pause = useCallback(() => {
    if (humanPort.observe().observation.mode === 'playing') dispatchAction({ type: 'pause' });
  }, [dispatchAction, humanPort]);

  const requestManualClock = useCallback(() => {
    if (manualClockRef.current) return;
    manualClockRef.current = true;
    setManualClock(true);
  }, []);

  useGameLifecycle({
    active: isActive,
    suspendOnInactive: true,
    suspendOnBlur: true,
    suspendWhenHidden: true,
    resetInputOnSuspend: true,
    onResetInput: resetInput,
    onResetClock: () => runtime.resetClock(),
    onSuspend: pause,
  });

  useGameAutomationBridge({
    enabled: isActive,
    renderGameToText: () => render${typeName}ToText(
      humanPort.observe().observation,
      runtime.getState(),
    ),
    advanceTime: (ms) => {
      if (humanPort.observe().observation.mode === 'playing') runtime.advance(ms);
    },
    onManualClockRequested: requestManualClock,
  });

  const { toggle: toggleFullscreen } = useFullscreenController({ target: shellRef });

  const start = useCallback(() => {
    if (humanPort.observe().observation.mode !== 'ready') return;
    resetPresentation();
    dispatchAction({ type: 'start' });
  }, [dispatchAction, humanPort, resetPresentation]);

  const resume = useCallback(() => {
    if (humanPort.observe().observation.mode !== 'paused') return;
    dispatchAction({ type: 'resume' });
  }, [dispatchAction, humanPort]);

  const restart = useCallback(() => {
    if (humanPort.observe().observation.mode === 'ready') return;
    dispatchAction({ type: 'restart' });
    resetPresentation();
  }, [dispatchAction, humanPort, resetPresentation]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isActive) return;
      const key = event.key.toLowerCase();
      if (key === 'f' && !event.repeat) { event.preventDefault(); void toggleFullscreen(); return; }
      if (key === 'r' && !event.repeat) { event.preventDefault(); restart(); return; }
      if (key === 'p' && !event.repeat) { event.preventDefault(); pause(); return; }
      if (['a', 'd', 'arrowleft', 'arrowright'].includes(key)) {
        if (humanPort.observe().observation.mode !== 'playing') return;
        event.preventDefault();
        dispatchAction({ type: 'move', direction: key === 'a' || key === 'arrowleft' ? -1 : 1 });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      resetInput();
    };
  }, [dispatchAction, humanPort, isActive, pause, resetInput, restart, toggleFullscreen]);

  const driver = useMemo(() => (
    <FixedStepDriver
      enabled={isActive && snapshot.mode === 'playing'}
      manual={manualClock}
      onFrame={(elapsedMs) => {
        // The ref closes the interval between advanceTime requesting manual
        // ownership and React committing the manualClock state update.
        if (manualClockRef.current) return;
        runtime.advance(elapsedMs);
      }}
    />
  ), [isActive, manualClock, runtime, snapshot.mode]);

  return (
    <div ref={shellRef} id="${id}-shell" style={shellStyle}>
      <Canvas frameloop={isActive && snapshot.mode === 'playing' ? 'always' : 'demand'}
        camera={{ position: [0, 2, 8], fov: 48 }} gl={{ antialias: false, powerPreference: 'high-performance' }}>
        {driver}
        <color attach="background" args={['#07111f']} />
        <ambientLight intensity={1.2} />
        <directionalLight position={[4, 6, 8]} intensity={2} />
        <Player playerX={snapshot.player.x} />
        <gridHelper args={[12, 12, '#244966', '#163149']} position={[0, -1, 0]} />
      </Canvas>
      <div style={{ position: 'absolute', inset: 16, pointerEvents: 'none' }}>
        <strong>{GAME_NAME}</strong>
        <span style={{ float: 'right' }}>Score {snapshot.score}</span>
      </div>
      {snapshot.mode !== 'playing' ? (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(2,8,15,.48)' }}>
          <div style={{ padding: 24, borderRadius: 18, background: 'rgba(7,20,34,.92)', textAlign: 'center' }}>
            <h2 style={{ marginTop: 0 }}>{GAME_NAME}</h2>
            <p>Move with A/D or arrow keys. Press P to pause, R to restart, and F for fullscreen.</p>
            <button id="start-btn" type="button" onClick={snapshot.mode === 'paused' ? resume : start}>
              {snapshot.mode === 'paused' ? 'Resume' : 'Start'}
            </button>
          </div>
        </div>
      ) : null}
      {snapshot.mode !== 'ready' ? (
        <button id="restart-btn" type="button" onClick={restart}
          style={{ position: 'absolute', right: 16, top: 48, zIndex: 2 }}>
          Restart
        </button>
      ) : null}
    </div>
  );
}

export default ${typeName}App;
`;
}

function testTemplate(typeName) {
  return `import { describe, expect, it } from 'vitest';
import { createFixedStepRuntime } from '../../game-platform/runtime';
import { stableSerialize } from '../../game-platform/testkit';
import {
  createInitial${typeName}PresentationInput,
  createInitial${typeName}PresentationState,
  createInitial${typeName}State,
  listLegal${typeName}Actions,
  reduce${typeName}Action,
  simulate${typeName}Presentation,
} from './${typeName}Engine';

const createRuntime = (maxStepsPerAdvance?: number) => createFixedStepRuntime({
  createInitialState: createInitial${typeName}PresentationState,
  createInitialInput: createInitial${typeName}PresentationInput,
  simulate: simulate${typeName}Presentation,
  ...(maxStepsPerAdvance === undefined ? {} : { maxStepsPerAdvance }),
});

describe('${typeName} deterministic simulation', () => {
  it('produces the same state for equivalent time partitions', () => {
    const whole = createRuntime();
    const partitioned = createRuntime();
    const explicitlyBudgeted = createRuntime(120);
    const wholeAdvance = whole.advance(2_000);
    partitioned.advance(1_000);
    partitioned.advance(1_000);
    const explicitAdvance = explicitlyBudgeted.advance(2_000);
    expect(wholeAdvance.steps).toBe(120);
    expect(explicitAdvance.steps).toBe(120);
    expect(stableSerialize(partitioned.getState())).toBe(stableSerialize(whole.getState()));
    expect(stableSerialize(explicitlyBudgeted.getState())).toBe(stableSerialize(whole.getState()));
    expect(partitioned.getClock()).toEqual(whole.getClock());
    expect(explicitlyBudgeted.getClock()).toEqual(whole.getClock());
  });

  it('advances presentation time without copying or mutating authoritative gameplay', () => {
    const runtime = createRuntime();
    const authoritative = reduce${typeName}Action(createInitial${typeName}State(), { type: 'start' });
    const before = stableSerialize(authoritative);
    runtime.advance(1_000);
    expect(runtime.getState().elapsedMs).toBeCloseTo(1_000, 10);
    expect(stableSerialize(authoritative)).toBe(before);
    expect(runtime.getState()).not.toHaveProperty('mode');
    expect(runtime.getState()).not.toHaveProperty('playerX');
    expect(runtime.getState()).not.toHaveProperty('score');
  });

  it('validates every formal command through the shared domain reducer', () => {
    const ready = createInitial${typeName}State();
    expect(listLegal${typeName}Actions(ready)).toEqual([{ type: 'start' }]);
    const playing = reduce${typeName}Action(ready, { type: 'start' });
    const moved = reduce${typeName}Action(playing, { type: 'move', direction: 1 });
    expect(moved.playerX).toBeGreaterThan(playing.playerX);
    expect(reduce${typeName}Action(moved, { type: 'restart' })).toEqual(createInitial${typeName}State());
    expect(() => reduce${typeName}Action(ready, { type: 'pause' })).toThrow(/Illegal/);
  });
});
`;
}

function agentAdapterTestTemplate(typeName) {
  return `import { describe, expect, it } from 'vitest';
import { stableSerialize } from '../../game-platform/testkit';
import type { ${typeName}Action } from './${typeName}Engine';
import {
  create${typeName}AgentGameHost,
  ${typeName.toUpperCase()}_AGAP_DESCRIPTOR,
  ${typeName.toUpperCase()}_PLAYER_SEAT_ID,
  type ${typeName}ParticipantPort,
} from './${typeName}AgentAdapter';

const act = (port: ${typeName}ParticipantPort, requestId: string, action: ${typeName}Action) => {
  const observation = port.observe();
  return port.act({
    requestId,
    expectedRevision: observation.revision,
    expectedPhase: observation.decision.phase,
    turnNonce: observation.decision.turnNonce,
    action,
  });
};

const bind = (kind: 'human' | 'agent', matchId: string) => create${typeName}AgentGameHost(matchId).bindParticipant({
  seatId: ${typeName.toUpperCase()}_PLAYER_SEAT_ID,
  kind,
  participantId: \`\${kind}-participant\`,
});

describe('${typeName} AGAP adapter contract', () => {
  it('declares a machine-readable single-seat game contract', () => {
    expect(${typeName.toUpperCase()}_AGAP_DESCRIPTOR.protocol).toEqual({ name: 'AGAP', version: '1.0.0' });
    expect(${typeName.toUpperCase()}_AGAP_DESCRIPTOR.seats).toEqual([{ id: 'player', label: 'Player' }]);
    expect(${typeName.toUpperCase()}_AGAP_DESCRIPTOR.metadata.seatProjection).toBe('player-visible');
  });

  it('gives human and agent participants identical observations and formal actions', () => {
    const human = bind('human', 'parity-contract');
    const agent = bind('agent', 'parity-contract');
    expect(human.listLegalActions().actions.map(({ action }) => action)).toEqual([{ type: 'start' }]);
    expect(agent.listLegalActions().actions.map(({ action }) => action)).toEqual([{ type: 'start' }]);

    const sequence: readonly ${typeName}Action[] = [
      { type: 'start' },
      { type: 'move', direction: 1 },
      { type: 'move', direction: -1 },
      { type: 'pause' },
      { type: 'resume' },
      { type: 'restart' },
    ];
    sequence.forEach((action, index) => {
      const requestId = \`parity-\${index}\`;
      const humanReceipt = act(human, requestId, action);
      const agentReceipt = act(agent, requestId, action);
      expect(stableSerialize(agentReceipt)).toBe(stableSerialize(humanReceipt));
      expect(stableSerialize(agent.observe().observation)).toBe(stableSerialize(human.observe().observation));
      expect(agent.listLegalActions().actions.map(({ action: legal }) => legal))
        .toEqual(human.listLegalActions().actions.map(({ action: legal }) => legal));
      expect(stableSerialize(agent.readEvents())).toBe(stableSerialize(human.readEvents()));
    });
    expect(human.observe().observation).toEqual({
      mode: 'ready',
      player: { x: 0, y: 0, z: 0 },
      score: 0,
    });
    expect(human.listLegalActions().actions.map(({ action }) => action)).toEqual([{ type: 'start' }]);
  });

  it('rejects commands that are not available to the participant', () => {
    const participant = bind('agent', 'illegal-action-contract');
    expect(() => act(participant, 'illegal-1', { type: 'move', direction: 1 })).toThrow();
  });
});
`;
}

function readmeTemplate(id, displayName, typeName) {
  return `# ${displayName}

Generated with the AlSniper OS production game scaffold.

## Files

- \`${typeName}Engine.ts\` contains the deterministic domain reducer plus a separate presentation-clock state machine.
- \`${typeName}AgentAdapter.ts\` declares the AGAP descriptor, seat projection, legal actions, and host factory.
- \`${typeName}App.tsx\` owns the R3F scene and web lifecycle integration.
- \`${typeName}Engine.test.ts\` verifies deterministic time partitioning.
- \`${typeName}AgentAdapter.test.ts\` verifies seat binding plus human/Agent observation, receipt, outcome, legal-action, and event parity.
- \`index.ts\` is the application boundary.

## Integration

Register \`${id}\` by following \`docs/games/README.md\`. Keep gameplay state out of the global OS store. The shell only owns window lifecycle; this app receives activity through \`isActive\`.

The automation contract is available as \`window.render_game_to_text()\` and \`window.advanceTime(ms)\` while the game is mounted. Use the official \`develop-web-game\` client for browser validation.

The local human is bound to the same seat-scoped \`ParticipantPort\` used by an Agent. Human controls and Agent calls therefore share one legal-action enumeration and one domain reducer. Integrate remote or local Agent orchestration through \`create${typeName}AgentGameHost\`; never grant an Agent the unauthenticated browser automation bridge.

The AGAP Host is the sole gameplay authority. React state, R3F, and the fixed-step runtime consume the bound seat projection; they never mirror or write authoritative mode, player position, score, or other rules state. The fixed-step runtime stores presentation time only.

Restart is a formal \`{ type: 'restart' }\` action available from the playing and paused phases. The Restart button and \`R\` key submit it through the bound port; only after Host acceptance does the app clear presentation state, clock, and input.

## Runtime guarantees

- One fixed-step simulation clock and one R3F Canvas loop; ready, paused, and inactive states use demand rendering.
- Blur, document hiding, inactive shell state, restart, suspension, and unmount clear held input.
- The official client's \`__vt_pending\` marker is detected on the first render. A synchronous ref blocks real frames both before bridge installation and while React commits manual-clock state.
- The deterministic test covers the client's two-second virtual-time action with the default 240-step budget and an exact explicit 120-step budget at 60 Hz.
- Fullscreen is owned by the shared controller: \`F\` toggles it and the browser owns the Escape exit contract.
`;
}

export function buildTemplates(id, displayName) {
  const typeName = toPascalCase(id);
  return new Map([
    [`${typeName}Engine.ts`, engineTemplate(typeName)],
    [`${typeName}AgentAdapter.ts`, agentAdapterTemplate(id, displayName, typeName)],
    [`${typeName}App.tsx`, appTemplate(id, displayName, typeName)],
    [`${typeName}Engine.test.ts`, testTemplate(typeName)],
    [`${typeName}AgentAdapter.test.ts`, agentAdapterTestTemplate(typeName)],
    ['index.ts', `export { ${typeName}App as default, ${typeName}App } from './${typeName}App';\nexport * from './${typeName}AgentAdapter';\nexport * from './${typeName}Engine';\n`],
    ['README.md', readmeTemplate(id, displayName, typeName)],
  ]);
}

export async function generateGame({ id: rawId, name: rawName, repositoryRoot = DEFAULT_REPOSITORY_ROOT, beforeCommit } = {}) {
  const id = validateGameId(rawId);
  const name = validateDisplayName(rawName);
  const root = path.resolve(repositoryRoot);
  const appsRoot = path.resolve(root, 'src', 'apps');
  const target = path.resolve(appsRoot, id);
  if (!isWithin(appsRoot, target)) {
    throw new ScaffoldError('Resolved game path escapes src/apps.');
  }
  await mkdir(appsRoot, { recursive: true });
  if (await pathExists(target)) {
    throw new ScaffoldError(`Refusing to overwrite existing path: ${path.relative(root, target)}`);
  }

  let temporaryDirectory;
  try {
    temporaryDirectory = await mkdtemp(path.join(appsRoot, '.game-scaffold-'));
    if (!isWithin(appsRoot, temporaryDirectory)) {
      throw new ScaffoldError('Temporary game path escapes src/apps.');
    }
    for (const [filename, contents] of buildTemplates(id, name)) {
      await writeFile(path.join(temporaryDirectory, filename), contents, { encoding: 'utf8', flag: 'wx' });
    }
    if (beforeCommit) await beforeCommit({ temporaryDirectory, target });
    if (await pathExists(target)) {
      throw new ScaffoldError(`Refusing to overwrite existing path: ${path.relative(root, target)}`);
    }
    await rename(temporaryDirectory, target);
    temporaryDirectory = undefined;
    return { id, name, target, files: [...buildTemplates(id, name).keys()] };
  } finally {
    if (temporaryDirectory && isWithin(appsRoot, temporaryDirectory)) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

async function runCli() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await generateGame(options);
    console.log(`Created ${result.name} in ${path.relative(DEFAULT_REPOSITORY_ROOT, result.target)}`);
    console.log('Next: register the app using docs/games/README.md and run npm test.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await runCli();
}
