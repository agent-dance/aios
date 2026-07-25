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

export interface ${typeName}State {
  mode: ${typeName}Mode;
  playerX: number;
  elapsedMs: number;
  score: number;
}

export interface ${typeName}Input {
  moveX: number;
}

const PLAYER_SPEED_PER_MS = 0.006;
const WORLD_LIMIT = 4.5;

export const createInitial${typeName}State = (): ${typeName}State => ({
  mode: 'ready',
  playerX: 0,
  elapsedMs: 0,
  score: 0,
});

export const createInitial${typeName}Input = (): ${typeName}Input => ({ moveX: 0 });

export function simulate${typeName}(
  state: Readonly<${typeName}State>,
  input: Readonly<${typeName}Input>,
  context: { deltaMs: number },
): ${typeName}State {
  if (state.mode !== 'playing') return state as ${typeName}State;
  const playerX = Math.max(
    -WORLD_LIMIT,
    Math.min(WORLD_LIMIT, state.playerX + input.moveX * PLAYER_SPEED_PER_MS * context.deltaMs),
  );
  return { ...state, playerX, elapsedMs: state.elapsedMs + context.deltaMs };
}

const round = (value: number) => Math.round(value * 100) / 100;

export function render${typeName}ToText(state: Readonly<${typeName}State>) {
  return JSON.stringify({
    coordinateSystem: 'origin:center,+x:right,+y:up,+z:toward-camera',
    mode: state.mode,
    player: { x: round(state.playerX), y: 0, z: 0 },
    elapsedMs: round(state.elapsedMs),
    score: state.score,
  });
}
`;
}

function appTemplate(id, displayName, typeName) {
  return `import { Canvas, useFrame } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type * as THREE from 'three';
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
  createInitial${typeName}Input,
  createInitial${typeName}State,
  render${typeName}ToText,
  simulate${typeName},
  type ${typeName}Input,
  type ${typeName}State,
} from './${typeName}Engine';

const shellStyle: CSSProperties = {
  width: '100%', height: '100%', minHeight: 360, position: 'relative', overflow: 'hidden',
  background: '#07111f', color: '#f4fbff', fontFamily: 'system-ui, sans-serif',
};

const GAME_NAME = ${JSON.stringify(displayName)};

function Player({ runtime }: { runtime: ReturnType<typeof create${typeName}Runtime> }) {
  const meshRef = useRef<THREE.Mesh>(null);
  useFrame(() => {
    if (meshRef.current) meshRef.current.position.x = runtime.getState().playerX;
  });
  return (
    <mesh ref={meshRef}>
      <boxGeometry args={[1, 1, 1]} />
      <meshLambertMaterial color="#6ff7d8" />
    </mesh>
  );
}

function create${typeName}Runtime() {
  return createFixedStepRuntime<${typeName}State, ${typeName}Input>({
    createInitialState: createInitial${typeName}State,
    createInitialInput: createInitial${typeName}Input,
    simulate: simulate${typeName},
  });
}

export interface ${typeName}AppProps { isActive?: boolean }

export function ${typeName}App({ isActive = true }: ${typeName}AppProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<ReturnType<typeof create${typeName}Runtime> | null>(null);
  if (!runtimeRef.current) runtimeRef.current = create${typeName}Runtime();
  const runtime = runtimeRef.current;
  const pressedRef = useRef(new Set<string>());
  const [snapshot, setSnapshot] = useState(() => runtime.getState());
  // The official client installs its marker before React mounts. Taking clock
  // ownership during the first render prevents a real R3F tick from racing the
  // passive effect that installs the automation bridge.
  const [manualClock, setManualClock] = useState(
    () => typeof window !== 'undefined'
      && hasVirtualTimeMarker(window as GameAutomationTarget),
  );
  const manualClockRef = useRef(manualClock);

  const publish = useCallback(() => setSnapshot({ ...runtime.getState() }), [runtime]);
  const resetInput = useCallback(() => {
    pressedRef.current.clear();
    runtime.resetInput();
  }, [runtime]);
  const pause = useCallback(() => {
    const current = runtime.getState();
    if (current.mode === 'playing') {
      runtime.replaceState({ ...current, mode: 'paused' });
      publish();
    }
  }, [publish, runtime]);

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
    renderGameToText: () => render${typeName}ToText(runtime.getState()),
    advanceTime: (ms) => { runtime.advance(ms); publish(); },
    onManualClockRequested: requestManualClock,
  });

  const { toggle: toggleFullscreen } = useFullscreenController({ target: shellRef });

  const updateMovement = useCallback(() => {
    const pressed = pressedRef.current;
    runtime.replaceInput({ moveX: (pressed.has('d') || pressed.has('arrowright') ? 1 : 0) - (pressed.has('a') || pressed.has('arrowleft') ? 1 : 0) });
  }, [runtime]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isActive) return;
      const key = event.key.toLowerCase();
      if (key === 'f' && !event.repeat) { event.preventDefault(); void toggleFullscreen(); return; }
      if (key === 'p' && !event.repeat) { event.preventDefault(); pause(); return; }
      if (['a', 'd', 'arrowleft', 'arrowright'].includes(key)) {
        event.preventDefault(); pressedRef.current.add(key); updateMovement();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      pressedRef.current.delete(event.key.toLowerCase()); updateMovement();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      resetInput();
    };
  }, [isActive, pause, resetInput, toggleFullscreen, updateMovement]);

  const start = useCallback(() => {
    resetInput(); runtime.resetClock();
    runtime.replaceState({ ...createInitial${typeName}State(), mode: 'playing' }); publish();
  }, [publish, resetInput, runtime]);

  const resume = useCallback(() => {
    runtime.replaceState({ ...runtime.getState(), mode: 'playing' }); publish();
  }, [publish, runtime]);

  const driver = useMemo(() => (
    <FixedStepDriver
      enabled={isActive && snapshot.mode === 'playing'}
      manual={manualClock}
      onFrame={(elapsedMs) => {
        // The ref closes the interval between advanceTime requesting manual
        // ownership and React committing the manualClock state update.
        if (manualClockRef.current) return;
        const before = runtime.getState();
        runtime.advance(elapsedMs);
        const after = runtime.getState();
        if (before.mode !== after.mode || before.score !== after.score) publish();
      }}
    />
  ), [isActive, manualClock, publish, runtime, snapshot.mode]);

  return (
    <div ref={shellRef} id="${id}-shell" style={shellStyle}>
      <Canvas frameloop={isActive && snapshot.mode === 'playing' ? 'always' : 'demand'}
        camera={{ position: [0, 2, 8], fov: 48 }} gl={{ antialias: false, powerPreference: 'high-performance' }}>
        {driver}
        <color attach="background" args={['#07111f']} />
        <ambientLight intensity={1.2} />
        <directionalLight position={[4, 6, 8]} intensity={2} />
        <Player runtime={runtime} />
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
            <p>Move with A/D or arrow keys. Press P to pause and F for fullscreen.</p>
            <button id="start-btn" type="button" onClick={snapshot.mode === 'paused' ? resume : start}>
              {snapshot.mode === 'paused' ? 'Resume' : 'Start'}
            </button>
          </div>
        </div>
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
  createInitial${typeName}Input,
  createInitial${typeName}State,
  simulate${typeName},
} from './${typeName}Engine';

const createRuntime = (maxStepsPerAdvance?: number) => createFixedStepRuntime({
  createInitialState: () => ({ ...createInitial${typeName}State(), mode: 'playing' as const }),
  createInitialInput: createInitial${typeName}Input,
  simulate: simulate${typeName},
  ...(maxStepsPerAdvance === undefined ? {} : { maxStepsPerAdvance }),
});

describe('${typeName} deterministic simulation', () => {
  it('produces the same state for equivalent time partitions', () => {
    const whole = createRuntime();
    const partitioned = createRuntime();
    const explicitlyBudgeted = createRuntime(120);
    whole.replaceInput({ moveX: 1 });
    partitioned.replaceInput({ moveX: 1 });
    explicitlyBudgeted.replaceInput({ moveX: 1 });
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

  it('does not simulate while paused', () => {
    const runtime = createRuntime();
    runtime.replaceState({ ...runtime.getState(), mode: 'paused' });
    const before = stableSerialize(runtime.getState());
    runtime.advance(1_000);
    expect(stableSerialize(runtime.getState())).toBe(before);
  });
});
`;
}

function readmeTemplate(id, displayName, typeName) {
  return `# ${displayName}

Generated with the AlSniper OS production game scaffold.

## Files

- \`${typeName}Engine.ts\` contains deterministic, renderer-independent simulation.
- \`${typeName}App.tsx\` owns the R3F scene and web lifecycle integration.
- \`${typeName}Engine.test.ts\` verifies deterministic time partitioning.
- \`index.ts\` is the application boundary.

## Integration

Register \`${id}\` by following \`docs/games/README.md\`. Keep gameplay state out of the global OS store. The shell only owns window lifecycle; this app receives activity through \`isActive\`.

The automation contract is available as \`window.render_game_to_text()\` and \`window.advanceTime(ms)\` while the game is mounted. Use the official \`develop-web-game\` client for browser validation.

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
    [`${typeName}App.tsx`, appTemplate(id, displayName, typeName)],
    [`${typeName}Engine.test.ts`, testTemplate(typeName)],
    ['index.ts', `export { ${typeName}App as default, ${typeName}App } from './${typeName}App';\nexport * from './${typeName}Engine';\n`],
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
