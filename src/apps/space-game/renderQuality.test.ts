import { describe, expect, it } from 'vitest';
import { createAdaptiveQualityController } from '../../game-platform/r3f';
import { RENDER_QUALITY_PROFILES, SPACE_GAME_QUALITY_CONFIG } from './renderQuality';

describe('space-game render quality profiles', () => {
  it('keeps every quality budget monotonic', () => {
    const { low, balanced, high } = RENDER_QUALITY_PROFILES;
    expect(low.dpr).toBeLessThan(balanced.dpr);
    expect(balanced.dpr).toBeLessThan(high.dpr);
    expect(low.starCount).toBeLessThan(balanced.starCount);
    expect(balanced.starCount).toBeLessThan(high.starCount);
    expect(low.maxParticles).toBeLessThan(balanced.maxParticles);
    expect(balanced.maxParticles).toBeLessThan(high.maxParticles);
  });

  it('uses the shared adaptive controller with the game profile contract', () => {
    const controller = createAdaptiveQualityController(SPACE_GAME_QUALITY_CONFIG);
    expect(controller.tier).toBe('high');
    let transition = null;
    for (let index = 0; index < 100 && transition == null; index += 1) transition = controller.observeFrame(30);
    expect(transition).toBe('balanced');
  });
});
