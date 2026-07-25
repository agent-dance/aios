import type { AdaptiveQualityConfig, DprQualityProfile } from '../../game-platform/r3f';

export type RenderQuality = 'low' | 'balanced' | 'high';

export interface RenderQualityProfile extends DprQualityProfile {
  readonly starCount: number;
  readonly maxParticles: number;
}

export const RENDER_QUALITY_PROFILES: Readonly<Record<RenderQuality, RenderQualityProfile>> = {
  low: { dpr: 1, starCount: 900, maxParticles: 32 },
  balanced: { dpr: 1.35, starCount: 1600, maxParticles: 56 },
  high: { dpr: 2, starCount: 2400, maxParticles: 96 },
};

export const SPACE_GAME_QUALITY_CONFIG: AdaptiveQualityConfig<RenderQuality> = {
  tiers: ['low', 'balanced', 'high'],
  initialTier: 'high',
  downgradeThresholdMs: 22,
  upgradeThresholdMs: 17.2,
  downgradeWindowMs: 1_200,
  upgradeWindowMs: 5_000,
  cooldownMs: 3_000,
  emaWeight: 0.08,
  minSampleMs: 4,
  maxSampleMs: 100,
};
