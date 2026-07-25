export type GameMode = 'start' | 'playing' | 'paused' | 'game-over';

export interface Vector3Like {
  x: number;
  y: number;
  z: number;
}

export interface PlayerState extends Vector3Like {
  radius: number;
  health: number;
  speedPerMs: number;
  cooldownMs: number;
  velocityX: number;
  velocityY: number;
}

export interface EnemyState extends Vector3Like {
  id: number;
  radius: number;
  speedPerMs: number;
  value: number;
}

export interface BulletState extends Vector3Like {
  id: number;
  radius: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  ttlMs: number;
}

export interface ParticleState extends Vector3Like {
  id: number;
  radius: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  ageMs: number;
  lifeMs: number;
}

export interface InputState {
  moveX: number;
  moveY: number;
  shootHeld: boolean;
  aimX: number;
  aimY: number;
}

export interface WorldBounds {
  x: number;
  y: number;
  enemySpawnZ: number;
  bulletCullZ: number;
}

export interface GameState {
  mode: GameMode;
  player: PlayerState;
  enemies: EnemyState[];
  bullets: BulletState[];
  particles: ParticleState[];
  score: number;
  wave: number;
  waveRemainingToSpawn: number;
  spawnCooldownMs: number;
  nextId: number;
  seed: number;
}

export const WORLD_BOUNDS: WorldBounds = {
  x: 10,
  y: 6,
  enemySpawnZ: 28,
  bulletCullZ: 34,
};

const INITIAL_SEED = 1337;
const PLAYER_START_Z = 0;
const PLAYER_RADIUS = 0.82;
const PLAYER_SPEED_PER_MS = 0.0135;
const BULLET_SPEED_PER_MS = 0.04;
const BULLET_TTL_MS = 1500;
const BULLET_RADIUS = 0.18;
const SHOOT_COOLDOWN_MS = 220;
const PLAYER_MAX_HEALTH = 100;
const ENEMY_COLLISION_DAMAGE = 18;
const PARTICLES_PER_BURST = 8;

const createPlayer = (): PlayerState => ({
  x: 0,
  y: -0.35,
  z: PLAYER_START_Z,
  radius: PLAYER_RADIUS,
  health: PLAYER_MAX_HEALTH,
  speedPerMs: PLAYER_SPEED_PER_MS,
  cooldownMs: 0,
  velocityX: 0,
  velocityY: 0,
});

const enemiesForWave = (wave: number) => 4 + wave * 2;

const spawnIntervalForWave = (wave: number) => Math.max(320, 1200 - wave * 90);

const baseState = (mode: GameMode): GameState => ({
  mode,
  player: createPlayer(),
  enemies: [],
  bullets: [],
  particles: [],
  score: 0,
  wave: 1,
  waveRemainingToSpawn: enemiesForWave(1),
  spawnCooldownMs: 500,
  nextId: 1,
  seed: INITIAL_SEED,
});

export const createInitialGameState = (): GameState => baseState('start');

export const startGame = (): GameState => baseState('playing');

export const restartGame = (): GameState => startGame();

export const togglePause = (state: GameState): GameState => {
  if (state.mode === 'playing') {
    return { ...state, mode: 'paused' };
  }

  if (state.mode === 'paused') {
    return { ...state, mode: 'playing' };
  }

  return state;
};

export const createInputState = (): InputState => ({
  moveX: 0,
  moveY: 0,
  shootHeld: false,
  aimX: 0,
  aimY: 0,
});

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const round = (value: number) => Math.round(value * 100) / 100;

const distanceSquared = (a: Vector3Like, b: Vector3Like) => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
};

const normalize3 = (vector: Vector3Like): Vector3Like => {
  const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
};

const nextSeed = (seed: number) => (seed * 1664525 + 1013904223) >>> 0;

const randomBetween = (seed: number, min: number, max: number) => {
  const updatedSeed = nextSeed(seed);
  const unit = updatedSeed / 0xffffffff;
  return {
    seed: updatedSeed,
    value: min + unit * (max - min),
  };
};

interface EnemyBroadphaseEntry {
  enemyIndex: number;
  z: number;
}

interface EnemyBroadphase {
  entries: EnemyBroadphaseEntry[];
  maxRadius: number;
}

/**
 * A sweep-and-prune broadphase keeps projectile collision work proportional to
 * nearby enemies instead of comparing every bullet with the entire wave. The
 * final candidate order is restored to entity order so simultaneous overlaps
 * retain the engine's original deterministic resolution semantics.
 */
const createEnemyBroadphase = (enemies: EnemyState[]): EnemyBroadphase => {
  let maxRadius = 0;
  const entries = enemies.map((enemy, enemyIndex) => {
    maxRadius = Math.max(maxRadius, enemy.radius);
    return { enemyIndex, z: enemy.z };
  });
  entries.sort((left, right) => left.z - right.z || left.enemyIndex - right.enemyIndex);
  return { entries, maxRadius };
};

const lowerBoundByZ = (entries: EnemyBroadphaseEntry[], minimumZ: number) => {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (entries[middle]!.z < minimumZ) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
};

const queryEnemyCandidates = (broadphase: EnemyBroadphase, bullet: BulletState, enemies: EnemyState[]) => {
  const reach = bullet.radius + broadphase.maxRadius;
  const maximumZ = bullet.z + reach;
  const candidates: number[] = [];
  let cursor = lowerBoundByZ(broadphase.entries, bullet.z - reach);

  while (cursor < broadphase.entries.length && broadphase.entries[cursor]!.z <= maximumZ) {
    const enemyIndex = broadphase.entries[cursor]!.enemyIndex;
    const enemy = enemies[enemyIndex]!;
    if (Math.abs(enemy.z - bullet.z) <= enemy.radius + bullet.radius) {
      candidates.push(enemyIndex);
    }
    cursor += 1;
  }

  candidates.sort((left, right) => left - right);
  return candidates;
};

// Below this density a contiguous direct scan is measurably cheaper than
// allocating and sorting an index. Dense synthetic/late-wave states cross the
// threshold and avoid quadratic growth.
const BROADPHASE_PAIR_THRESHOLD = 2_048;

const spawnEnemy = (state: GameState): GameState => {
  let seed = state.seed;
  const xRoll = randomBetween(seed, -WORLD_BOUNDS.x * 1.05, WORLD_BOUNDS.x * 1.05);
  seed = xRoll.seed;
  const yRoll = randomBetween(seed, -WORLD_BOUNDS.y * 1.05, WORLD_BOUNDS.y * 1.05);
  seed = yRoll.seed;
  const zRoll = randomBetween(seed, 0, 4);
  seed = zRoll.seed;
  const speedRoll = randomBetween(seed, 0.9, 1.2);
  seed = speedRoll.seed;

  const enemy: EnemyState = {
    id: state.nextId,
    x: xRoll.value,
    y: yRoll.value,
    z: WORLD_BOUNDS.enemySpawnZ + zRoll.value,
    radius: 0.7,
    speedPerMs: (0.0062 + state.wave * 0.00055) * speedRoll.value,
    value: 100 + state.wave * 20,
  };

  return {
    ...state,
    seed,
    nextId: state.nextId + 1,
    waveRemainingToSpawn: state.waveRemainingToSpawn - 1,
    enemies: [...state.enemies, enemy],
  };
};

const appendParticleBurst = (
  particles: ParticleState[],
  center: Vector3Like,
  initialSeed: number,
  initialNextId: number,
) => {
  let seed = initialSeed;
  let nextId = initialNextId;
  for (let index = 0; index < PARTICLES_PER_BURST; index += 1) {
    const xRoll = randomBetween(seed, -1, 1);
    seed = xRoll.seed;
    const yRoll = randomBetween(seed, -1, 1);
    seed = yRoll.seed;
    const zRoll = randomBetween(seed, -1, 1);
    seed = zRoll.seed;
    const speedRoll = randomBetween(seed, 0.0025, 0.0085);
    seed = speedRoll.seed;
    const lifeRoll = randomBetween(seed, 240, 520);
    seed = lifeRoll.seed;
    const direction = normalize3({ x: xRoll.value, y: yRoll.value, z: zRoll.value || 0.35 });

    particles.push({
      id: nextId,
      x: center.x,
      y: center.y,
      z: center.z,
      radius: 0.07,
      velocityX: direction.x * speedRoll.value,
      velocityY: direction.y * speedRoll.value,
      velocityZ: direction.z * speedRoll.value,
      ageMs: 0,
      lifeMs: lifeRoll.value,
    });

    nextId += 1;
  }

  return { seed, nextId };
};

const fireBullet = (state: GameState, input: InputState): GameState => {
  const direction = normalize3({
    x: input.aimX - state.player.x,
    y: input.aimY - state.player.y,
    z: 18,
  });

  const bullet: BulletState = {
    id: state.nextId,
    x: state.player.x,
    y: state.player.y + 0.18,
    z: state.player.z + 1,
    radius: BULLET_RADIUS,
    velocityX: direction.x * BULLET_SPEED_PER_MS,
    velocityY: direction.y * BULLET_SPEED_PER_MS,
    velocityZ: direction.z * BULLET_SPEED_PER_MS,
    ttlMs: BULLET_TTL_MS,
  };

  return {
    ...state,
    nextId: state.nextId + 1,
    bullets: [...state.bullets, bullet],
    player: {
      ...state.player,
      cooldownMs: SHOOT_COOLDOWN_MS,
    },
  };
};

const prepareNextWave = (state: GameState): GameState => {
  const wave = state.wave + 1;
  return {
    ...state,
    wave,
    waveRemainingToSpawn: enemiesForWave(wave),
    spawnCooldownMs: 680,
  };
};

const updatePlayer = (player: PlayerState, input: InputState, deltaMs: number): PlayerState => {
  const moveLength = Math.hypot(input.moveX, input.moveY);
  const normalizedMoveX = moveLength > 0 ? input.moveX / moveLength : 0;
  const normalizedMoveY = moveLength > 0 ? input.moveY / moveLength : 0;
  const velocityX = normalizedMoveX * player.speedPerMs;
  const velocityY = normalizedMoveY * player.speedPerMs;

  return {
    ...player,
    x: clamp(player.x + velocityX * deltaMs, -WORLD_BOUNDS.x, WORLD_BOUNDS.x),
    y: clamp(player.y + velocityY * deltaMs, -WORLD_BOUNDS.y, WORLD_BOUNDS.y),
    velocityX,
    velocityY,
    cooldownMs: Math.max(0, player.cooldownMs - deltaMs),
  };
};

export const advanceGame = (state: GameState, input: InputState, deltaMs: number): GameState => {
  if (state.mode !== 'playing') {
    return state;
  }

  const bullets: BulletState[] = [];
  for (const bullet of state.bullets) {
    const movedBullet = {
      ...bullet,
      x: bullet.x + bullet.velocityX * deltaMs,
      y: bullet.y + bullet.velocityY * deltaMs,
      z: bullet.z + bullet.velocityZ * deltaMs,
      ttlMs: bullet.ttlMs - deltaMs,
    };
    if (
      movedBullet.ttlMs > 0 &&
      movedBullet.z < WORLD_BOUNDS.bulletCullZ &&
      Math.abs(movedBullet.x) < WORLD_BOUNDS.x * 1.4 &&
      Math.abs(movedBullet.y) < WORLD_BOUNDS.y * 1.4
    ) {
      bullets.push(movedBullet);
    }
  }

  const particles: ParticleState[] = [];
  for (const particle of state.particles) {
    const movedParticle = {
      ...particle,
      x: particle.x + particle.velocityX * deltaMs,
      y: particle.y + particle.velocityY * deltaMs,
      z: particle.z + particle.velocityZ * deltaMs,
      ageMs: particle.ageMs + deltaMs,
    };
    if (movedParticle.ageMs < movedParticle.lifeMs) {
      particles.push(movedParticle);
    }
  }

  let nextState: GameState = {
    ...state,
    player: updatePlayer(state.player, input, deltaMs),
    bullets,
    particles,
  };

  if (input.shootHeld && nextState.player.cooldownMs <= 0) {
    nextState = fireBullet(nextState, input);
  }

  let spawnCooldownMs = nextState.spawnCooldownMs - deltaMs;
  nextState = { ...nextState, spawnCooldownMs };
  while (nextState.waveRemainingToSpawn > 0 && spawnCooldownMs <= 0) {
    nextState = spawnEnemy(nextState);
    spawnCooldownMs += spawnIntervalForWave(nextState.wave);
    nextState = { ...nextState, spawnCooldownMs };
  }

  nextState = {
    ...nextState,
    enemies: nextState.enemies.map((enemy) => {
      const direction = normalize3({
        x: nextState.player.x - enemy.x,
        y: nextState.player.y - enemy.y,
        z: nextState.player.z - enemy.z,
      });

      return {
        ...enemy,
        x: enemy.x + direction.x * enemy.speedPerMs * deltaMs,
        y: enemy.y + direction.y * enemy.speedPerMs * deltaMs,
        z: enemy.z + direction.z * enemy.speedPerMs * deltaMs,
      };
    }),
  };

  const destroyedBulletIds = new Set<number>();
  const destroyedEnemyIds = new Set<number>();
  let particleSeed = nextState.seed;
  let particleNextId = nextState.nextId;
  const enemyBroadphase =
    nextState.bullets.length * nextState.enemies.length >= BROADPHASE_PAIR_THRESHOLD
      ? createEnemyBroadphase(nextState.enemies)
      : null;
  let scoreGain = 0;

  for (const bullet of nextState.bullets) {
    const candidateIndexes = enemyBroadphase ? queryEnemyCandidates(enemyBroadphase, bullet, nextState.enemies) : null;
    const candidateCount = candidateIndexes?.length ?? nextState.enemies.length;
    for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex += 1) {
      const enemyIndex = candidateIndexes?.[candidateIndex] ?? candidateIndex;
      const enemy = nextState.enemies[enemyIndex]!;
      if (destroyedEnemyIds.has(enemy.id)) {
        continue;
      }

      const hitDistance = bullet.radius + enemy.radius;
      if (distanceSquared(bullet, enemy) <= hitDistance * hitDistance) {
        destroyedBulletIds.add(bullet.id);
        destroyedEnemyIds.add(enemy.id);
        scoreGain += enemy.value;
        ({ seed: particleSeed, nextId: particleNextId } = appendParticleBurst(
          nextState.particles,
          enemy,
          particleSeed,
          particleNextId,
        ));
        break;
      }
    }
  }

  let playerHealth = nextState.player.health;
  const remainingEnemies: EnemyState[] = [];
  for (const enemy of nextState.enemies) {
    if (destroyedEnemyIds.has(enemy.id)) {
      continue;
    }

    const impactDistance = enemy.radius + nextState.player.radius + 0.12;
    const hasHitPlayer = distanceSquared(enemy, nextState.player) <= impactDistance * impactDistance;
    const hasPassedPlayer = enemy.z < nextState.player.z - 0.75;
    if (hasHitPlayer || hasPassedPlayer) {
      playerHealth = Math.max(0, playerHealth - ENEMY_COLLISION_DAMAGE);
      ({ seed: particleSeed, nextId: particleNextId } = appendParticleBurst(
        nextState.particles,
        enemy,
        particleSeed,
        particleNextId,
      ));
      continue;
    }

    remainingEnemies.push(enemy);
  }

  nextState = {
    ...nextState,
    score: nextState.score + scoreGain,
    player: {
      ...nextState.player,
      health: playerHealth,
    },
    bullets: nextState.bullets.filter((bullet) => !destroyedBulletIds.has(bullet.id)),
    enemies: remainingEnemies,
    seed: particleSeed,
    nextId: particleNextId,
  };

  if (nextState.player.health <= 0) {
    return {
      ...nextState,
      mode: 'game-over',
      bullets: [],
      spawnCooldownMs: 0,
    };
  }

  if (nextState.waveRemainingToSpawn === 0 && nextState.enemies.length === 0) {
    return prepareNextWave(nextState);
  }

  return nextState;
};

export const renderGameToText = (state: GameState) =>
  JSON.stringify({
    coordinateSystem: 'origin:center,+x:right,+y:up,+z:away-from-player',
    mode: state.mode,
    player: {
      x: round(state.player.x),
      y: round(state.player.y),
      z: round(state.player.z),
      vx: round(state.player.velocityX),
      vy: round(state.player.velocityY),
      health: state.player.health,
      cooldownMs: round(state.player.cooldownMs),
    },
    enemies: state.enemies.map((enemy) => ({
      id: enemy.id,
      x: round(enemy.x),
      y: round(enemy.y),
      z: round(enemy.z),
      r: round(enemy.radius),
    })),
    bullets: state.bullets.map((bullet) => ({
      id: bullet.id,
      x: round(bullet.x),
      y: round(bullet.y),
      z: round(bullet.z),
      r: round(bullet.radius),
    })),
    score: state.score,
    health: state.player.health,
    wave: state.wave,
    cooldownMs: round(state.player.cooldownMs),
  });
