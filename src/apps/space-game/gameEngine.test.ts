import { describe, expect, it } from 'vitest';
import {
  advanceGame,
  createInputState,
  createInitialGameState,
  renderGameToText,
  restartGame,
  startGame,
  togglePause,
  type BulletState,
  type EnemyState,
} from './gameEngine';

describe('space-game engine', () => {
  it('starts and restarts in playing mode with reset score', () => {
    const started = startGame();
    expect(started.mode).toBe('playing');
    expect(started.score).toBe(0);
    expect(started.wave).toBe(1);

    const restarted = restartGame();
    expect(restarted).toEqual(started);
  });

  it('moves and fires deterministically', () => {
    const input = createInputState();
    input.moveX = 1;
    input.moveY = 1;
    input.shootHeld = true;
    input.aimX = 2;
    input.aimY = 1;

    const next = advanceGame(startGame(), input, 250);
    expect(next.player.x).toBeGreaterThan(0);
    expect(next.player.y).toBeGreaterThan(-0.35);
    expect(next.bullets).toHaveLength(1);
    expect(next.player.cooldownMs).toBeGreaterThan(0);
  });

  it('destroys enemies and awards score', () => {
    const state = startGame();
    state.bullets = [
      {
        id: 1,
        x: 0,
        y: 0,
        z: 3,
        radius: 0.3,
        velocityX: 0,
        velocityY: 0,
        velocityZ: 0,
        ttlMs: 1000,
      },
    ];
    state.enemies = [
      {
        id: 2,
        x: 0,
        y: 0,
        z: 3,
        radius: 0.7,
        speedPerMs: 0,
        value: 140,
      },
    ];
    state.waveRemainingToSpawn = 1;

    const next = advanceGame(state, createInputState(), 16);
    expect(next.enemies).toHaveLength(0);
    expect(next.bullets).toHaveLength(0);
    expect(next.score).toBe(140);
    expect(next.particles.length).toBeGreaterThan(0);
  });

  it('damages the player and ends the game on lethal contact', () => {
    const state = startGame();
    state.player.health = 18;
    state.enemies = [
      {
        id: 9,
        x: 0,
        y: -0.35,
        z: 0.2,
        radius: 0.8,
        speedPerMs: 0,
        value: 0,
      },
    ];

    const next = advanceGame(state, createInputState(), 16);
    expect(next.player.health).toBe(0);
    expect(next.mode).toBe('game-over');
  });

  it('toggles pause without mutating unrelated modes', () => {
    const started = startGame();
    const paused = togglePause(started);
    expect(paused.mode).toBe('paused');
    expect(advanceGame(paused, { ...createInputState(), shootHeld: true }, 10_000)).toBe(paused);
    expect(togglePause(paused).mode).toBe('playing');
    expect(togglePause(createInitialGameState()).mode).toBe('start');
  });

  it('preserves deterministic entity ordering in dense collision states', () => {
    const state = startGame();
    state.waveRemainingToSpawn = 1;
    state.bullets = Array.from({ length: 48 }, (_, index): BulletState => ({
      id: 1_000 + index,
      x: index < 8 ? index : -12,
      y: 0,
      z: 8,
      radius: 0.3,
      velocityX: 0,
      velocityY: 0,
      velocityZ: 0,
      ttlMs: 1_000,
    }));
    state.enemies = Array.from({ length: 48 }, (_, index): EnemyState => ({
      id: 2_000 + index,
      x: index < 8 ? index : 30,
      y: 0,
      z: 8,
      radius: 0.7,
      speedPerMs: 0,
      value: 100 + index,
    }));

    const next = advanceGame(state, createInputState(), 16);
    expect(next.score).toBe(828);
    expect(next.enemies.map((enemy) => enemy.id)).toEqual(
      Array.from({ length: 40 }, (_, index) => 2_008 + index),
    );
    expect(next.bullets.map((bullet) => bullet.id)).toEqual(
      Array.from({ length: 40 }, (_, index) => 1_008 + index),
    );
    expect(next.particles).toHaveLength(64);
  });

  it('keeps the text-rendering contract concise and stable', () => {
    const payload = JSON.parse(renderGameToText(createInitialGameState()));
    expect(payload).toMatchObject({
      coordinateSystem: 'origin:center,+x:right,+y:up,+z:away-from-player',
      mode: 'start',
      score: 0,
      health: 100,
      wave: 1,
      player: { x: 0, y: -0.35, z: 0, vx: 0, vy: 0, health: 100, cooldownMs: 0 },
      enemies: [],
      bullets: [],
    });
  });
});
