import { Canvas, useFrame } from '@react-three/fiber';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import * as THREE from 'three';
import { isAgapError } from '../../game-platform/agent';
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
  shouldIgnoreGameplayKeyEvent,
} from '../../game-platform/web';
import {
  WORLD_BOUNDS,
  type GameMode,
} from './gameEngine';
import {
  SPACE_GAME_SEAT_ID,
  createInitialSpaceGameRenderProjection,
  createSpaceGameMatch,
  movementFromInput,
  quantizeAimToCell,
  type SpaceGameAction,
  type SpaceGameControl,
  type SpaceGameRenderProjection,
} from './SpaceGameAgentAdapter';
import {
  createSpaceGameAgentDriver,
  type SpaceGameAgentController,
  type SpaceGameAgentDriver,
} from './SpaceGameAgentController';
import {
  SpaceGameCapabilityRevokedError,
  createCapabilityGuardedSpaceGameAgentController,
  createSpaceGameCapabilityGate,
  createSpaceGameControlModeLatch,
  type SpaceGameCapabilityGate,
  type SpaceGameControlMode,
} from './SpaceGameCapabilities';
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

const createUiSnapshot = (state: SpaceGameRenderProjection): UiSnapshot => ({
  mode: state.mode,
  score: state.score,
  health: state.player.health,
  wave: state.wave,
  enemyCount: state.enemies.length,
  bulletCount: state.bullets.length,
});

const uiSnapshotMatchesState = (snapshot: UiSnapshot, state: SpaceGameRenderProjection) =>
  snapshot.mode === state.mode &&
  snapshot.score === state.score &&
  snapshot.health === state.player.health &&
  snapshot.wave === state.wave &&
  snapshot.enemyCount === state.enemies.length &&
  snapshot.bulletCount === state.bullets.length;

type RenderProjectionRef = MutableRefObject<SpaceGameRenderProjection>;
type QualityRef = MutableRefObject<RenderQuality>;

const ShipView = memo(({ stateRef }: { stateRef: RenderProjectionRef }) => {
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

const EnemyInstances = memo(({ stateRef }: { stateRef: RenderProjectionRef }) => {
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

const BulletInstances = memo(({ stateRef }: { stateRef: RenderProjectionRef }) => {
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

const ParticleInstances = memo(({ stateRef, qualityRef }: { stateRef: RenderProjectionRef; qualityRef: QualityRef }) => {
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
    stateRef: RenderProjectionRef;
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
  /** Separates simulation/Agent lifetime from foreground human input focus. */
  simulationActive?: boolean;
  /** Human is the default; assist shares the same formal pilot capability and Agent latches controls between plans. */
  controlMode?: SpaceGameControlMode;
  agentController?: SpaceGameAgentController;
  agentSeatKey?: string;
}

const createLocalMatchId = () => {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('Secure randomness is required to create an opaque game match id.');
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return `space-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

const readInitialLifecycleSuspended = (simulationActive: boolean) => {
  if (!simulationActive || typeof document === 'undefined') return !simulationActive;
  try {
    return document.visibilityState === 'hidden' || (typeof document.hasFocus === 'function' && !document.hasFocus());
  } catch {
    return false;
  }
};

/**
 * Revokes every component-owned capability before React's passive unmount
 * cleanup. Late Agent completions and still-installed automation/key handlers
 * therefore fail closed even when the shell removes the window immediately.
 */
export function revokeSpaceGameCapabilitiesOnUnmount(
  capabilityGate: Pick<
    SpaceGameCapabilityGate,
    'setForeground' | 'setSimulationActive' | 'setLifecycleSuspended'
  >,
  stopAgentDriver: () => void,
  resetInput: () => void,
): void {
  capabilityGate.setForeground(false);
  capabilityGate.setSimulationActive(false);
  capabilityGate.setLifecycleSuspended(true);
  stopAgentDriver();
  resetInput();
}

export function SpaceGameApp({
  isActive = true,
  simulationActive = isActive,
  controlMode = 'human',
  agentController,
  agentSeatKey = 'cosmic-vanguard:pilot',
}: SpaceGameAppProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const cooldownFillRef = useRef<HTMLDivElement | null>(null);
  const telemetryRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<SpaceGameRenderProjection>(createInitialSpaceGameRenderProjection());
  const pressedKeysRef = useRef<Record<string, boolean>>({});
  const keyboardFireLatchedRef = useRef(false);
  const requestSequenceRef = useRef(0);
  const agentDriverRef = useRef<SpaceGameAgentDriver | null>(null);
  const agentControllerRef = useRef(agentController);
  const lastAgentCriticalVersionRef = useRef(-1);
  // The official automation client installs this marker before React mounts;
  // taking clock ownership immediately prevents the start-button delay from
  // leaking one nondeterministic real-time fixed step into scripted runs.
  const [manualClock, setManualClock] = useState(
    () => typeof window !== 'undefined' && '__vt_pending' in window,
  );
  const manualClockRef = useRef(manualClock);
  const capabilityGateRef = useRef<ReturnType<typeof createSpaceGameCapabilityGate> | null>(null);
  if (!capabilityGateRef.current) {
    capabilityGateRef.current = createSpaceGameCapabilityGate({
      foreground: isActive,
      simulationActive,
      lifecycleSuspended: readInitialLifecycleSuspended(simulationActive),
      manualClock,
    });
  }
  const capabilityGate = capabilityGateRef.current;
  capabilityGate.setForeground(isActive);
  capabilityGate.setSimulationActive(simulationActive);
  agentControllerRef.current = agentController;
  const controlModeLatchRef = useRef<ReturnType<typeof createSpaceGameControlModeLatch> | null>(null);
  if (!controlModeLatchRef.current) controlModeLatchRef.current = createSpaceGameControlModeLatch(controlMode);
  const initialUiSnapshot = useMemo(() => createUiSnapshot(stateRef.current), []);
  const uiSnapshotRef = useRef(initialUiSnapshot);
  const [uiSnapshot, setUiSnapshot] = useState(initialUiSnapshot);

  const syncLiveHud = useCallback((state: SpaceGameRenderProjection) => {
    if (cooldownFillRef.current) {
      const percentage = Math.max(0, Math.min(100, (1 - state.player.cooldownMs / 220) * 100));
      cooldownFillRef.current.style.width = `${percentage}%`;
    }
    if (telemetryRef.current) {
      telemetryRef.current.textContent = `Player [${state.player.x.toFixed(1)}, ${state.player.y.toFixed(1)}] | Enemies ${state.enemies.length} | Bullets ${state.bullets.length}`;
    }
  }, []);

  const publishState = useCallback(
    (nextState: SpaceGameRenderProjection) => {
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

  const initialBindingModeRef = useRef(controlMode);
  const matchId = useMemo(createLocalMatchId, []);
  const session = useMemo(() => {
    const nextMatch = createSpaceGameMatch({
      matchId,
      onPublish: publishState,
    });
    const nextPilotPort = nextMatch.bindParticipant({
      seatId: SPACE_GAME_SEAT_ID,
      participantId: initialBindingModeRef.current === 'human' ? 'local-human' : 'desktop-agent',
      kind: initialBindingModeRef.current === 'human' ? 'human' : 'agent',
    });
    return Object.freeze({ match: nextMatch, pilotPort: nextPilotPort });
  }, [matchId, publishState]);
  const { match, pilotPort } = session;
  const controlPolicy = controlModeLatchRef.current.resolve(Boolean(agentController));
  const humanControlEnabledRef = useRef(controlPolicy.humanEnabled);
  const agentPolicyEnabledRef = useRef(controlPolicy.agentEnabled);
  humanControlEnabledRef.current = controlPolicy.humanEnabled;
  agentPolicyEnabledRef.current = controlPolicy.agentEnabled;

  const fullscreen = useFullscreenController({ target: shellRef });

  const stopAgentDriver = useCallback(() => {
    const driver = agentDriverRef.current;
    driver?.stop();
    if (agentDriverRef.current === driver) agentDriverRef.current = null;
  }, []);

  const requestManualClock = useCallback(() => {
    if (manualClockRef.current) {
      stopAgentDriver();
      return;
    }
    if (!capabilityGate.requestManualClock()) {
      throw new SpaceGameCapabilityRevokedError('automation');
    }
    stopAgentDriver();
    manualClockRef.current = true;
    setManualClock(true);
  }, [capabilityGate, stopAgentDriver]);

  const resetInput = useCallback(() => {
    pressedKeysRef.current = {};
    keyboardFireLatchedRef.current = false;
    match.resetInput();
  }, [match]);

  const canUseHumanInput = useCallback(
    () => capabilityGate.canUseHumanInput() && humanControlEnabledRef.current,
    [capabilityGate],
  );

  const assertAutomationAvailable = useCallback(() => {
    if (!capabilityGate.canUseAutomation()) {
      throw new SpaceGameCapabilityRevokedError('automation');
    }
  }, [capabilityGate]);

  const notifyAgentIfCriticalChanged = useCallback(
    (force = false) => {
      const version = match.getCriticalObservationVersion();
      if (!force && version === lastAgentCriticalVersionRef.current) return;
      lastAgentCriticalVersionRef.current = version;
      agentDriverRef.current?.notifyObservation(pilotPort.observe().observation);
    },
    [match, pilotPort],
  );

  const runFixedSteps = useCallback(
    (elapsedMs: number) => {
      match.advance(elapsedMs);
      notifyAgentIfCriticalChanged();
    },
    [match, notifyAgentIfCriticalChanged],
  );

  const handleAnimationFrame = useCallback(
    (elapsedMs: number, _now: number) => {
      if (!manualClockRef.current) runFixedSteps(elapsedMs);
    },
    [runFixedSteps],
  );

  const commitAction = useCallback(
    (action: SpaceGameAction, source: string) => {
      requestSequenceRef.current += 1;
      const requestId = `${source}:${requestSequenceRef.current}`;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const observation = pilotPort.observe();
        try {
          pilotPort.act({
            requestId,
            expectedRevision: observation.revision,
            expectedPhase: observation.decision.phase,
            turnNonce: observation.decision.turnNonce,
            action,
          });
          notifyAgentIfCriticalChanged();
          return true;
        } catch (error) {
          if (!isAgapError(error) || !error.retryable || attempt === 1) return false;
        }
      }
      return false;
    },
    [notifyAgentIfCriticalChanged, pilotPort],
  );

  const commitControl = useCallback(
    (control: SpaceGameControl) => {
      if (!canUseHumanInput()) return false;
      const current = match.getCurrentControl();
      if (
        control.movement === current.movement &&
        control.fire === current.fire &&
        control.aim.column === current.aim.column &&
        control.aim.row === current.aim.row
      ) {
        return true;
      }
      return commitAction(
        {
          type: 'control',
          movement: control.movement,
          fire: control.fire,
          aim: { ...control.aim },
        },
        'human-control',
      );
    },
    [canUseHumanInput, commitAction, match],
  );

  const recomputeMovement = useCallback(() => {
    const pressedKeys = pressedKeysRef.current;
    const moveX = (pressedKeys.d || pressedKeys.arrowright ? 1 : 0) - (pressedKeys.a || pressedKeys.arrowleft ? 1 : 0);
    const moveY = (pressedKeys.w || pressedKeys.arrowup ? 1 : 0) - (pressedKeys.s || pressedKeys.arrowdown ? 1 : 0);
    commitControl({ ...match.getCurrentControl(), movement: movementFromInput({ moveX, moveY }) });
  }, [commitControl, match]);

  const beginGame = useCallback(
    (shootOnStart = false) => {
      if (!canUseHumanInput()) return;
      if (!commitAction({ type: 'start' }, 'human-start')) return;
      if (shootOnStart) {
        commitControl({ ...match.getCurrentControl(), fire: true });
        match.advance(FIXED_STEP_MS);
      }
    },
    [canUseHumanInput, commitAction, commitControl, match],
  );

  const restart = useCallback(() => {
    if (!canUseHumanInput()) return;
    pressedKeysRef.current = {};
    keyboardFireLatchedRef.current = false;
    commitAction({ type: 'restart' }, 'human-restart');
  }, [canUseHumanInput, commitAction]);

  const togglePauseState = useCallback(() => {
    if (!canUseHumanInput()) return;
    const mode = match.getPhase();
    if (mode === 'playing') commitAction({ type: 'pause' }, 'human-pause');
    if (mode === 'paused') commitAction({ type: 'resume' }, 'human-resume');
  }, [canUseHumanInput, commitAction, match]);

  const updateAim = useCallback((clientX: number, clientY: number) => {
    if (!canUseHumanInput()) return;
    const element = shellRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const normalizedX = rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5;
    const normalizedY = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
    commitControl({
      ...match.getCurrentControl(),
      aim: quantizeAimToCell(
        (normalizedX * 2 - 1) * WORLD_BOUNDS.x,
        (1 - normalizedY * 2) * WORLD_BOUNDS.y,
      ),
    });
  }, [canUseHumanInput, commitControl, match]);

  const lifecycle = useGameLifecycle({
    active: simulationActive,
    resetInputOnSuspend: true,
    resetInputOnResume: false,
    onResetInput: resetInput,
    onResetClock: match.resetClock,
    onSuspend: (snapshot) => {
      capabilityGate.setLifecycleSuspended(true);
      stopAgentDriver();
      if (snapshot.reasons.includes('inactive') && match.getPhase() === 'playing') {
        commitAction({ type: 'pause' }, 'lifecycle-pause');
      }
    },
    onResume: () => {
      capabilityGate.setLifecycleSuspended(false);
    },
  });
  capabilityGate.setLifecycleSuspended(lifecycle.suspended);

  useLayoutEffect(() => {
    // React Strict Mode replays layout effects; restore the current mounted
    // capability snapshot after its development-only cleanup rehearsal.
    capabilityGate.setForeground(isActive);
    capabilityGate.setSimulationActive(simulationActive);
    capabilityGate.setLifecycleSuspended(lifecycle.suspended);
    return () => {
      revokeSpaceGameCapabilitiesOnUnmount(capabilityGate, stopAgentDriver, resetInput);
    };
    // These objects are stable for the authority-session lifetime. Prop and
    // lifecycle transitions are synchronously reflected above and by the
    // lifecycle callbacks without turning every focus change into an unmount.
  }, [capabilityGate, resetInput, stopAgentDriver]);

  useGameAutomationBridge({
    enabled: isActive,
    renderGameToText: () => {
      assertAutomationAvailable();
      return match.renderVisibleState();
    },
    advanceTime: (elapsedMs) => {
      assertAutomationAvailable();
      runFixedSteps(elapsedMs);
    },
    onManualClockRequested: requestManualClock,
  });

  useEffect(() => {
    publishState(match.getRenderProjection());
    requestSequenceRef.current = 0;
    lastAgentCriticalVersionRef.current = -1;
  }, [match, publishState]);

  useLayoutEffect(() => {
    if (!isActive) resetInput();
  }, [isActive, resetInput]);

  useLayoutEffect(() => {
    if (simulationActive) return;
    resetInput();
    stopAgentDriver();
  }, [resetInput, simulationActive, stopAgentDriver]);

  useLayoutEffect(() => {
    stopAgentDriver();
  }, [agentController, stopAgentDriver]);

  useEffect(() => {
    const controller = agentController;
    if (
      !controller ||
      !controlPolicy.agentEnabled ||
      !capabilityGate.canUseAgent() ||
      agentControllerRef.current !== controller ||
      manualClockRef.current
    ) {
      stopAgentDriver();
      return;
    }
    const guardedController = createCapabilityGuardedSpaceGameAgentController(
      controller,
      () => agentControllerRef.current === controller && agentPolicyEnabledRef.current,
      capabilityGate,
    );
    const driver = createSpaceGameAgentDriver({
      controller: guardedController,
      port: pilotPort,
      seatSessionKey: agentSeatKey,
    });
    agentDriverRef.current = driver;
    notifyAgentIfCriticalChanged(true);
    driver.start();
    return () => {
      driver.stop();
      if (agentDriverRef.current === driver) agentDriverRef.current = null;
    };
  }, [
    agentController,
    agentSeatKey,
    capabilityGate,
    controlPolicy.agentEnabled,
    lifecycle.suspended,
    manualClock,
    notifyAgentIfCriticalChanged,
    pilotPort,
    simulationActive,
    stopAgentDriver,
  ]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!canUseHumanInput() || shouldIgnoreGameplayKeyEvent(event)) return;
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
        } else if (match.getPhase() === 'playing') {
          event.preventDefault();
          togglePauseState();
        }
        return;
      }
      if (key === 'p' && !event.repeat) {
        event.preventDefault();
        togglePauseState();
        return;
      }
      if (key === 'r' && match.getPhase() === 'game-over' && !event.repeat) {
        event.preventDefault();
        restart();
        return;
      }
      if ((key === 'enter' || key === ' ') && match.getPhase() === 'start' && !event.repeat) {
        event.preventDefault();
        beginGame(key === ' ');
        if (key === ' ' && match.getPhase() === 'playing' && match.getCurrentControl().fire) {
          keyboardFireLatchedRef.current = true;
        }
        return;
      }
      if (key === ' ' && match.getPhase() === 'game-over' && !event.repeat) {
        event.preventDefault();
        restart();
        return;
      }
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
        event.preventDefault();
        pressedKeysRef.current[key] = true;
        recomputeMovement();
      }
      if (key === ' ' && match.getPhase() === 'playing') {
        event.preventDefault();
        if (commitControl({ ...match.getCurrentControl(), fire: true })) {
          keyboardFireLatchedRef.current = true;
        }
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const movementKey = ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key);
      const movementWasLatched = movementKey && Boolean(pressedKeysRef.current[key]);
      const fireWasLatched = key === ' ' && keyboardFireLatchedRef.current;
      if (movementKey) {
        pressedKeysRef.current[key] = false;
      }
      if (key === ' ') keyboardFireLatchedRef.current = false;
      // Modifier/editor keyups that did not originate from gameplay are inert.
      // A previously accepted gameplay key still releases safely to avoid a
      // stuck movement/fire latch when focus changes while it is held.
      if (!movementWasLatched && !fireWasLatched) return;
      if (!canUseHumanInput()) return;
      if (movementWasLatched) recomputeMovement();
      if (fireWasLatched) commitControl({ ...match.getCurrentControl(), fire: false });
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [beginGame, canUseHumanInput, commitControl, fullscreen, match, recomputeMovement, restart, togglePauseState]);

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (canUseHumanInput()) updateAim(event.clientX, event.clientY);
    },
    [canUseHumanInput, updateAim],
  );
  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!canUseHumanInput() || event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      updateAim(event.clientX, event.clientY);
      if (match.getPhase() === 'playing') {
        commitControl({ ...match.getCurrentControl(), fire: true });
      }
    },
    [canUseHumanInput, commitControl, match, updateAim],
  );
  const releaseFire = useCallback(() => {
    if (canUseHumanInput()) commitControl({ ...match.getCurrentControl(), fire: false });
  }, [canUseHumanInput, commitControl, match]);
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
          simulationActive &&
          uiSnapshot.mode === 'playing' &&
          !lifecycle.suspended
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
              [
                'Pilot',
                controlPolicy.mode === 'human'
                  ? 'Human'
                  : controlPolicy.agentEnabled
                    ? controlPolicy.mode === 'assist'
                      ? 'Human + AI'
                      : 'AI'
                    : controlPolicy.usingHumanFallback
                      ? 'Human fallback'
                      : 'Human · AI offline',
              ],
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
            <button
              type="button"
              style={secondaryButtonStyle}
              onClick={() => {
                if (canUseHumanInput()) void fullscreen.toggle();
              }}
            >
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
