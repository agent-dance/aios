import { Canvas, useFrame } from '@react-three/fiber';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import * as THREE from 'three';
import { createFixedStepRuntime } from '../../game-platform/runtime';
import {
  AdaptiveDpr,
  FixedStepDriver,
  createAdaptiveQualityController,
  nextPowerOfTwoCapacity,
} from '../../game-platform/r3f';
import {
  useFullscreenController,
  useGameAutomationBridge,
  useGameLifecycle,
} from '../../game-platform/web';
import {
  advanceGame,
  createInitialGameState,
  createInputState,
  renderGameToText,
  restartGame,
  startGame,
  togglePause,
  WORLD_BOUNDS,
  type GameMode,
  type GameState,
} from './gameEngine';
import {
  RENDER_QUALITY_PROFILES,
  SPACE_GAME_QUALITY_CONFIG,
  type RenderQuality,
} from './renderQuality';

declare global {
  interface Window {
    render_game_to_text?: () => string;
    advanceTime?: (ms: number) => void;
  }
}

const FIXED_STEP_MS = 1000 / 60;
const MAX_RENDERED_PARTICLES = RENDER_QUALITY_PROFILES.high.maxParticles;
const INITIAL_ENEMY_CAPACITY = 64;
const INITIAL_BULLET_CAPACITY = 32;
const BASE_ENEMY_RADIUS = 0.7;
const BASE_BULLET_RADIUS = 0.18;
const BASE_PARTICLE_RADIUS = 0.07;

const shellStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  minHeight: 420,
  position: 'relative',
  overflow: 'hidden',
  borderRadius: 24,
  background:
    'radial-gradient(circle at top, rgba(112, 246, 255, 0.16), transparent 36%), linear-gradient(180deg, #06101c 0%, #030814 45%, #02050b 100%)',
  fontFamily: '"Segoe UI", "SF Pro Display", sans-serif',
  color: '#eef6ff',
};

const overlayPanelStyle: CSSProperties = {
  padding: '28px 32px',
  maxWidth: 440,
  borderRadius: 24,
  background: 'linear-gradient(180deg, rgba(5, 14, 28, 0.86), rgba(3, 10, 18, 0.92))',
  border: '1px solid rgba(147, 227, 255, 0.2)',
  boxShadow: '0 24px 80px rgba(0, 0, 0, 0.42)',
  backdropFilter: 'blur(12px)',
};

const hudPillStyle: CSSProperties = {
  padding: '10px 14px',
  borderRadius: 16,
  background: 'rgba(3, 12, 20, 0.62)',
  border: '1px solid rgba(143, 227, 255, 0.14)',
  minWidth: 86,
};

const buttonStyle: CSSProperties = {
  padding: '12px 18px',
  border: '1px solid rgba(150, 235, 255, 0.28)',
  borderRadius: 14,
  background: 'linear-gradient(180deg, rgba(55, 205, 255, 0.36), rgba(35, 117, 255, 0.22))',
  color: '#eff7ff',
  fontWeight: 700,
  cursor: 'pointer',
};

const secondaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: 'rgba(6, 16, 28, 0.55)',
};

const formatModeLabel = (mode: GameMode) => {
  switch (mode) {
    case 'start':
      return 'Ready';
    case 'playing':
      return 'Live';
    case 'paused':
      return 'Paused';
    case 'game-over':
      return 'Destroyed';
    default:
      return mode;
  }
};

interface UiSnapshot {
  mode: GameMode;
  score: number;
  health: number;
  wave: number;
  enemyCount: number;
  bulletCount: number;
}

const createUiSnapshot = (state: GameState): UiSnapshot => ({
  mode: state.mode,
  score: state.score,
  health: state.player.health,
  wave: state.wave,
  enemyCount: state.enemies.length,
  bulletCount: state.bullets.length,
});

const uiSnapshotMatchesState = (snapshot: UiSnapshot, state: GameState) =>
  snapshot.mode === state.mode &&
  snapshot.score === state.score &&
  snapshot.health === state.player.health &&
  snapshot.wave === state.wave &&
  snapshot.enemyCount === state.enemies.length &&
  snapshot.bulletCount === state.bullets.length;

type GameStateRef = MutableRefObject<GameState>;
type QualityRef = MutableRefObject<RenderQuality>;

const ShipView = memo(({ stateRef }: { stateRef: GameStateRef }) => {
  const groupRef = useRef<THREE.Group>(null);

  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;
    const player = stateRef.current.player;
    group.position.set(player.x, player.y, player.z);
  });

  return (
    <group ref={groupRef}>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.62, 1.65, 5]} />
        <meshLambertMaterial color="#8cf3ff" emissive="#2ed8ff" emissiveIntensity={1.3} />
      </mesh>
      <mesh position={[0, 0, -0.38]}>
        <boxGeometry args={[1.55, 0.12, 0.9]} />
        <meshLambertMaterial color="#43a6ff" emissive="#2a66ff" emissiveIntensity={0.55} />
      </mesh>
      <mesh position={[0, -0.2, -0.78]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.14, 0.22, 0.55, 12]} />
        <meshLambertMaterial color="#ffdcb0" emissive="#ff8f46" emissiveIntensity={2.1} />
      </mesh>
    </group>
  );
});
ShipView.displayName = 'ShipView';

const EnemyInstances = memo(({ stateRef }: { stateRef: GameStateRef }) => {
  const coresRef = useRef<THREE.InstancedMesh>(null);
  const ringsRef = useRef<THREE.InstancedMesh>(null);
  const transform = useMemo(() => new THREE.Object3D(), []);
  const [capacity, setCapacity] = useState(INITIAL_ENEMY_CAPACITY);

  useEffect(() => {
    coresRef.current?.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    ringsRef.current?.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }, [capacity]);

  useFrame(() => {
    const cores = coresRef.current;
    const rings = ringsRef.current;
    if (!cores || !rings) return;

    const enemies = stateRef.current.enemies;
    if (enemies.length > capacity) {
      setCapacity(nextPowerOfTwoCapacity(enemies.length, INITIAL_ENEMY_CAPACITY));
      return;
    }
    const count = enemies.length;
    for (let index = 0; index < count; index += 1) {
      const enemy = enemies[index]!;
      const scale = enemy.radius / BASE_ENEMY_RADIUS;

      transform.position.set(enemy.x, enemy.y, enemy.z);
      transform.rotation.set(0.4, 0.2, 0);
      transform.scale.setScalar(scale);
      transform.updateMatrix();
      cores.setMatrixAt(index, transform.matrix);

      transform.position.set(enemy.x, enemy.y, enemy.z - 0.52);
      transform.rotation.set(0, 0, 0);
      transform.scale.setScalar(scale);
      transform.updateMatrix();
      rings.setMatrixAt(index, transform.matrix);
    }

    cores.count = count;
    rings.count = count;
    cores.instanceMatrix.needsUpdate = true;
    rings.instanceMatrix.needsUpdate = true;
  });

  return (
    <>
      <instancedMesh key={`cores-${capacity}`} ref={coresRef} args={[undefined, undefined, capacity]} frustumCulled={false}>
        <octahedronGeometry args={[BASE_ENEMY_RADIUS, 0]} />
        <meshLambertMaterial color="#ff7d7d" emissive="#ff5336" emissiveIntensity={0.85} flatShading />
      </instancedMesh>
      <instancedMesh key={`rings-${capacity}`} ref={ringsRef} args={[undefined, undefined, capacity]} frustumCulled={false}>
        <torusGeometry args={[BASE_ENEMY_RADIUS * 0.85, 0.09, 10, 22]} />
        <meshLambertMaterial color="#ffc37c" emissive="#ff8e34" emissiveIntensity={1.15} />
      </instancedMesh>
    </>
  );
});
EnemyInstances.displayName = 'EnemyInstances';

const BulletInstances = memo(({ stateRef }: { stateRef: GameStateRef }) => {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const transform = useMemo(() => new THREE.Object3D(), []);
  const [capacity, setCapacity] = useState(INITIAL_BULLET_CAPACITY);

  useEffect(() => {
    meshRef.current?.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }, [capacity]);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const bullets = stateRef.current.bullets;
    if (bullets.length > capacity) {
      setCapacity(nextPowerOfTwoCapacity(bullets.length, INITIAL_BULLET_CAPACITY));
      return;
    }
    const count = bullets.length;
    for (let index = 0; index < count; index += 1) {
      const bullet = bullets[index]!;
      transform.position.set(bullet.x, bullet.y, bullet.z);
      transform.rotation.set(0, 0, 0);
      transform.scale.setScalar(bullet.radius / BASE_BULLET_RADIUS);
      transform.updateMatrix();
      mesh.setMatrixAt(index, transform.matrix);
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh key={capacity} ref={meshRef} args={[undefined, undefined, capacity]} frustumCulled={false}>
      <sphereGeometry args={[BASE_BULLET_RADIUS, 12, 12]} />
      <meshBasicMaterial color="#fff5bf" />
    </instancedMesh>
  );
});
BulletInstances.displayName = 'BulletInstances';

const ParticleInstances = memo(({ stateRef, qualityRef }: { stateRef: GameStateRef; qualityRef: QualityRef }) => {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const lifeAttributeRef = useRef<THREE.InstancedBufferAttribute>(null);
  const transform = useMemo(() => new THREE.Object3D(), []);
  const lifeValues = useMemo(() => new Float32Array(MAX_RENDERED_PARTICLES), []);

  useEffect(() => {
    meshRef.current?.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }, []);

  useFrame(() => {
    const mesh = meshRef.current;
    const lifeAttribute = lifeAttributeRef.current;
    if (!mesh || !lifeAttribute) return;
    const particles = stateRef.current.particles;
    const budget = RENDER_QUALITY_PROFILES[qualityRef.current].maxParticles;
    const startIndex = Math.max(0, particles.length - budget);
    const count = Math.min(particles.length, budget);
    for (let renderIndex = 0; renderIndex < count; renderIndex += 1) {
      const particle = particles[startIndex + renderIndex]!;
      const lifeRatio = Math.max(0.001, 1 - particle.ageMs / particle.lifeMs);
      transform.position.set(particle.x, particle.y, particle.z);
      transform.rotation.set(0, 0, 0);
      transform.scale.setScalar((particle.radius / BASE_PARTICLE_RADIUS) * lifeRatio);
      transform.updateMatrix();
      mesh.setMatrixAt(renderIndex, transform.matrix);
      lifeAttribute.setX(renderIndex, lifeRatio);
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    lifeAttribute.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, MAX_RENDERED_PARTICLES]} frustumCulled={false}>
      <sphereGeometry args={[BASE_PARTICLE_RADIUS, 8, 8]}>
        <instancedBufferAttribute
          ref={lifeAttributeRef}
          attach="attributes-instanceLife"
          args={[lifeValues, 1]}
          usage={THREE.DynamicDrawUsage}
        />
      </sphereGeometry>
      <meshBasicMaterial
        color="#ffb870"
        transparent
        opacity={1}
        customProgramCacheKey={() => 'space-particle-life-v1'}
        onBeforeCompile={(shader) => {
          shader.vertexShader = shader.vertexShader
            .replace(
              '#include <common>',
              '#include <common>\nattribute float instanceLife;\nvarying float vInstanceLife;',
            )
            .replace(
              '#include <begin_vertex>',
              '#include <begin_vertex>\nvInstanceLife = instanceLife;',
            );
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nvarying float vInstanceLife;')
            .replace(
              '#include <opaque_fragment>',
              'diffuseColor.a *= vInstanceLife;\n#include <opaque_fragment>',
            );
        }}
      />
    </instancedMesh>
  );
});
ParticleInstances.displayName = 'ParticleInstances';

const Starfield = memo(({ qualityRef }: { qualityRef: QualityRef }) => {
  const geometryRef = useRef<THREE.BufferGeometry>(null);
  const appliedCountRef = useRef(0);
  const positions = useMemo(() => {
    const values = new Float32Array(RENDER_QUALITY_PROFILES.high.starCount * 3);
    for (let index = 0; index < RENDER_QUALITY_PROFILES.high.starCount; index += 1) {
      const offset = index * 3;
      values[offset] = (Math.random() - 0.5) * 90;
      values[offset + 1] = (Math.random() - 0.5) * 60;
      values[offset + 2] = Math.random() * 80;
    }
    return values;
  }, []);

  useFrame(() => {
    const count = RENDER_QUALITY_PROFILES[qualityRef.current].starCount;
    if (geometryRef.current && count !== appliedCountRef.current) {
      geometryRef.current.setDrawRange(0, count);
      appliedCountRef.current = count;
    }
  });

  return (
    <points>
      <bufferGeometry ref={geometryRef}>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial color="#b6eaff" size={0.14} sizeAttenuation transparent opacity={0.9} />
    </points>
  );
});
Starfield.displayName = 'Starfield';

const CombatScene = memo(
  ({
    stateRef,
    shouldAnimate,
    manualClock,
    onFrame,
  }: {
    stateRef: GameStateRef;
    shouldAnimate: boolean;
    manualClock: boolean;
    onFrame: (elapsedMs: number, now: number) => void;
  }) => {
    const cameraPosition = useMemo<[number, number, number]>(() => [0, 0.6, 18], []);
    const qualityRef = useRef<RenderQuality>('high');
    const qualityController = useMemo(
      () => createAdaptiveQualityController(SPACE_GAME_QUALITY_CONFIG),
      [],
    );

    return (
      <Canvas
        camera={{ position: cameraPosition, fov: 48, near: 0.1, far: 120 }}
        dpr={[1, 2]}
        frameloop={shouldAnimate ? 'always' : 'demand'}
        // High-DPI rendering and emissive silhouettes already smooth these
        // simple forms; disabling context MSAA avoids its permanent fill-rate
        // and memory cost on integrated GPUs and software renderers.
        gl={{ antialias: false, powerPreference: 'high-performance' }}
        onCreated={({ camera }) => camera.lookAt(0, 0, 8)}
        style={{ width: '100%', height: '100%' }}
      >
        <FixedStepDriver
          enabled={shouldAnimate}
          manual={manualClock}
          maxFrameMs={34}
          onFrame={onFrame}
        />
        <AdaptiveDpr
          controller={qualityController}
          profiles={RENDER_QUALITY_PROFILES}
          enabled={shouldAnimate}
          onTierChange={(quality) => {
            qualityRef.current = quality;
          }}
        />
        <color attach="background" args={['#020814']} />
        <fog attach="fog" args={['#020814', 24, 70]} />
        <ambientLight intensity={0.78} color="#dff6ff" />
        <directionalLight position={[6, 6, 14]} intensity={2.2} color="#d0ebff" />
        <pointLight position={[0, -2.4, 2]} intensity={24} distance={10} color="#ff9f5f" />
        <Starfield qualityRef={qualityRef} />
        <mesh position={[0, -7.3, 15]} rotation={[-Math.PI / 2.6, 0, 0]}>
          <planeGeometry args={[34, 90]} />
          <meshLambertMaterial color="#0a1830" emissive="#08152a" emissiveIntensity={0.25} transparent opacity={0.62} />
        </mesh>
        <ShipView stateRef={stateRef} />
        <EnemyInstances stateRef={stateRef} />
        <BulletInstances stateRef={stateRef} />
        <ParticleInstances stateRef={stateRef} qualityRef={qualityRef} />
      </Canvas>
    );
  },
);
CombatScene.displayName = 'CombatScene';

const OverlayScreen = ({
  title,
  body,
  primaryAction,
  primaryLabel,
  secondaryAction,
  secondaryLabel,
  primaryId,
}: {
  title: string;
  body: string;
  primaryAction: () => void;
  primaryLabel: string;
  secondaryAction?: () => void;
  secondaryLabel?: string;
  primaryId?: string;
}) => (
  <div
    style={{
      position: 'absolute',
      inset: 0,
      display: 'grid',
      placeItems: 'center',
      background: 'linear-gradient(180deg, rgba(2, 6, 11, 0.12), rgba(2, 6, 11, 0.48))',
      pointerEvents: 'none',
    }}
  >
    <div style={{ ...overlayPanelStyle, pointerEvents: 'auto' }}>
      <div style={{ fontSize: 12, letterSpacing: '0.24em', textTransform: 'uppercase', color: '#7fdcf8' }}>Cosmic Vanguard</div>
      <h2 style={{ margin: '10px 0 12px', fontSize: 34, lineHeight: 1.05 }}>{title}</h2>
      <p style={{ margin: 0, fontSize: 15, lineHeight: 1.65, color: '#d7e8f6' }}>{body}</p>
      <div style={{ display: 'flex', gap: 12, marginTop: 20, flexWrap: 'wrap' }}>
        <button id={primaryId} type="button" style={buttonStyle} onClick={primaryAction}>
          {primaryLabel}
        </button>
        {secondaryAction && secondaryLabel ? (
          <button type="button" style={secondaryButtonStyle} onClick={secondaryAction}>
            {secondaryLabel}
          </button>
        ) : null}
      </div>
    </div>
  </div>
);

export interface SpaceGameAppProps {
  isActive?: boolean;
}

export function SpaceGameApp({ isActive = true }: SpaceGameAppProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const cooldownFillRef = useRef<HTMLDivElement | null>(null);
  const telemetryRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<GameState>(createInitialGameState());
  const pressedKeysRef = useRef<Record<string, boolean>>({});
  // The official automation client installs this marker before React mounts;
  // taking clock ownership immediately prevents the start-button delay from
  // leaking one nondeterministic real-time fixed step into scripted runs.
  const [manualClock, setManualClock] = useState(
    () => typeof window !== 'undefined' && '__vt_pending' in window,
  );
  const manualClockRef = useRef(manualClock);
  const initialUiSnapshot = useMemo(() => createUiSnapshot(stateRef.current), []);
  const uiSnapshotRef = useRef(initialUiSnapshot);
  const [uiSnapshot, setUiSnapshot] = useState(initialUiSnapshot);

  const syncLiveHud = useCallback((state: GameState) => {
    if (cooldownFillRef.current) {
      const percentage = Math.max(0, Math.min(100, (1 - state.player.cooldownMs / 220) * 100));
      cooldownFillRef.current.style.width = `${percentage}%`;
    }
    if (telemetryRef.current) {
      telemetryRef.current.textContent = `Player [${state.player.x.toFixed(1)}, ${state.player.y.toFixed(1)}] | Enemies ${state.enemies.length} | Bullets ${state.bullets.length}`;
    }
  }, []);

  const publishState = useCallback(
    (nextState: GameState) => {
      stateRef.current = nextState;
      syncLiveHud(nextState);
      if (!uiSnapshotMatchesState(uiSnapshotRef.current, nextState)) {
        const nextSnapshot = createUiSnapshot(nextState);
        uiSnapshotRef.current = nextSnapshot;
        setUiSnapshot(nextSnapshot);
      }
    },
    [syncLiveHud],
  );

  const runtime = useMemo(
    () =>
      createFixedStepRuntime({
        createInitialState: createInitialGameState,
        createInitialInput: createInputState,
        simulate: (state, input, context) => advanceGame(state, input, context.deltaMs),
        onPublish: publishState,
      }),
    [publishState],
  );

  const fullscreen = useFullscreenController({ target: shellRef });

  const requestManualClock = useCallback(() => {
    if (manualClockRef.current) return;
    manualClockRef.current = true;
    setManualClock(true);
  }, []);

  const recomputeMovement = useCallback(() => {
    const pressedKeys = pressedKeysRef.current;
    const moveX = (pressedKeys.d || pressedKeys.arrowright ? 1 : 0) - (pressedKeys.a || pressedKeys.arrowleft ? 1 : 0);
    const moveY = (pressedKeys.w || pressedKeys.arrowup ? 1 : 0) - (pressedKeys.s || pressedKeys.arrowdown ? 1 : 0);
    runtime.replaceInput({ ...runtime.getInput(), moveX, moveY });
  }, [runtime]);

  const resetInput = useCallback(() => {
    pressedKeysRef.current = {};
    runtime.resetInput();
  }, [runtime]);

  const runFixedSteps = useCallback(
    (elapsedMs: number) => {
      runtime.advance(elapsedMs);
    },
    [runtime],
  );

  const handleAnimationFrame = useCallback(
    (elapsedMs: number, _now: number) => {
      if (!manualClockRef.current) runFixedSteps(elapsedMs);
    },
    [runFixedSteps],
  );

  const beginGame = useCallback(
    (shootOnStart = false) => {
      runtime.resetClock();
      if (shootOnStart) {
        runtime.replaceInput({ ...runtime.getInput(), shootHeld: true });
        runtime.replaceState(startGame());
        runtime.advance(FIXED_STEP_MS);
        return;
      }
      runtime.replaceState(startGame());
    },
    [runtime],
  );

  const restart = useCallback(() => {
    pressedKeysRef.current = {};
    runtime.reset({ state: restartGame() });
  }, [runtime]);

  const togglePauseState = useCallback(() => {
    runtime.replaceState(togglePause(runtime.getState()));
  }, [runtime]);

  const updateAim = useCallback((clientX: number, clientY: number) => {
    const element = shellRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const normalizedX = rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5;
    const normalizedY = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
    runtime.replaceInput({
      ...runtime.getInput(),
      aimX: (normalizedX * 2 - 1) * WORLD_BOUNDS.x,
      aimY: (1 - normalizedY * 2) * WORLD_BOUNDS.y,
    });
  }, [runtime]);

  const lifecycle = useGameLifecycle({
    active: isActive,
    resetInputOnSuspend: true,
    resetInputOnResume: false,
    onResetInput: resetInput,
    onResetClock: runtime.resetClock,
    onSuspend: (snapshot) => {
      if (snapshot.reasons.includes('inactive') && runtime.getState().mode === 'playing') {
        runtime.replaceState(togglePause(runtime.getState()));
      }
    },
  });

  useGameAutomationBridge({
    renderGameToText: () => renderGameToText(runtime.getState()),
    advanceTime: runFixedSteps,
    onManualClockRequested: requestManualClock,
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isActive) return;
      const key = event.key.toLowerCase();

      if (key === 'f' && !event.repeat) {
        event.preventDefault();
        void fullscreen.toggle();
        return;
      }
      if (key === 'escape') {
        if (fullscreen.active) {
          event.preventDefault();
          void fullscreen.exit();
        } else if (runtime.getState().mode === 'playing') {
          event.preventDefault();
          runtime.replaceState(togglePause(runtime.getState()));
        }
        return;
      }
      if (key === 'p' && !event.repeat) {
        event.preventDefault();
        runtime.replaceState(togglePause(runtime.getState()));
        return;
      }
      if (key === 'r' && runtime.getState().mode === 'game-over' && !event.repeat) {
        event.preventDefault();
        restart();
        return;
      }
      if ((key === 'enter' || key === ' ') && runtime.getState().mode === 'start' && !event.repeat) {
        event.preventDefault();
        beginGame(key === ' ');
        return;
      }
      if (key === ' ' && runtime.getState().mode === 'game-over' && !event.repeat) {
        event.preventDefault();
        restart();
        return;
      }
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
        event.preventDefault();
        pressedKeysRef.current[key] = true;
        recomputeMovement();
      }
      if (key === ' ' && runtime.getState().mode === 'playing') {
        event.preventDefault();
        runtime.replaceInput({ ...runtime.getInput(), shootHeld: true });
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
        pressedKeysRef.current[key] = false;
        recomputeMovement();
      }
      if (key === ' ') runtime.replaceInput({ ...runtime.getInput(), shootHeld: false });
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [beginGame, fullscreen, isActive, recomputeMovement, restart, runtime]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => updateAim(event.clientX, event.clientY), [updateAim]);
  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      updateAim(event.clientX, event.clientY);
      if (runtime.getState().mode === 'playing') {
        runtime.replaceInput({ ...runtime.getInput(), shootHeld: true });
      }
    },
    [runtime, updateAim],
  );
  const releaseFire = useCallback(() => {
    runtime.replaceInput({ ...runtime.getInput(), shootHeld: false });
  }, [runtime]);
  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (event.button === 0) releaseFire();
    },
    [releaseFire],
  );

  return (
    <div
      ref={shellRef}
      id="space-game-shell"
      data-testid="space-game-shell"
      style={shellStyle}
      onPointerMove={handlePointerMove}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={releaseFire}
      onPointerCancel={releaseFire}
      onContextMenu={(event) => event.preventDefault()}
    >
      <CombatScene
        stateRef={stateRef}
        shouldAnimate={
          isActive &&
          uiSnapshot.mode === 'playing' &&
          (!lifecycle.suspended || manualClock)
        }
        manualClock={manualClock}
        onFrame={handleAnimationFrame}
      />

      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', pointerEvents: 'none', padding: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {[
              ['Mode', formatModeLabel(uiSnapshot.mode)],
              ['Score', uiSnapshot.score],
              ['Health', uiSnapshot.health],
              ['Wave', uiSnapshot.wave],
            ].map(([label, value]) => (
              <div key={label} style={hudPillStyle}>
                <div style={{ fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase', color: '#8dcde8' }}>{label}</div>
                <div style={{ marginTop: 6, fontSize: 18, fontWeight: 700 }}>{value}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', pointerEvents: 'auto' }}>
            <button type="button" style={secondaryButtonStyle} onClick={togglePauseState}>
              {uiSnapshot.mode === 'paused' ? 'Resume' : 'Pause'}
            </button>
            <button type="button" style={secondaryButtonStyle} onClick={restart}>Restart</button>
            <button type="button" style={secondaryButtonStyle} onClick={() => void fullscreen.toggle()}>
              {fullscreen.active ? 'Exit Fullscreen' : 'Fullscreen'}
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ ...hudPillStyle, minWidth: 230, pointerEvents: 'none' }}>
            <div style={{ fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase', color: '#8dcde8' }}>Cooldown</div>
            <div style={{ marginTop: 8, height: 8, borderRadius: 999, background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
              <div ref={cooldownFillRef} style={{ height: '100%', width: '100%', background: 'linear-gradient(90deg, #ffd16f, #5ef4ff)' }} />
            </div>
            <div style={{ marginTop: 10, fontSize: 13, color: '#d5e9f6' }}>
              WASD / Arrows move, Mouse or Space fires, P pauses, F toggles fullscreen, Esc exits.
            </div>
          </div>
          <div style={{ ...hudPillStyle, minWidth: 230 }}>
            <div style={{ fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase', color: '#8dcde8' }}>Telemetry</div>
            <div ref={telemetryRef} style={{ marginTop: 8, fontSize: 13, lineHeight: 1.6, color: '#d5e9f6' }}>
              Player [0.0, -0.3] | Enemies {uiSnapshot.enemyCount} | Bullets {uiSnapshot.bulletCount}
            </div>
          </div>
        </div>
      </div>

      {uiSnapshot.mode === 'start' ? (
        <OverlayScreen
          title="Intercept the incoming wave"
          body="Slide across the combat lane, aim with the cursor, and keep the enemy swarm from reaching your hull. Space also starts auto-fire once the sortie begins."
          primaryAction={() => beginGame(false)}
          primaryLabel="Launch Mission"
          primaryId="start-btn"
        />
      ) : null}
      {uiSnapshot.mode === 'paused' ? (
        <OverlayScreen
          title="Combat paused"
          body="Your ship is holding position. Resume when ready, or restart the wave sequence from the beginning."
          primaryAction={togglePauseState}
          primaryLabel="Resume"
          secondaryAction={restart}
          secondaryLabel="Restart"
        />
      ) : null}
      {uiSnapshot.mode === 'game-over' ? (
        <OverlayScreen
          title="Hull integrity lost"
          body={`Final score ${uiSnapshot.score}. You reached wave ${uiSnapshot.wave}. Restart to replay the same deterministic encounter pattern.`}
          primaryAction={restart}
          primaryLabel="Restart Run"
        />
      ) : null}
    </div>
  );
}

export default SpaceGameApp;
