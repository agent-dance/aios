import { describe, expect, it } from 'vitest';
import {
  bindAdaptiveDprController,
  createAdaptiveQualityController,
  resolveProfileDpr,
  type AdaptiveQualityConfig,
} from './adaptiveQuality';

const createController = (initialTier: 'low' | 'balanced' | 'high' = 'high') =>
  createAdaptiveQualityController({
    tiers: ['low', 'balanced', 'high'] as const,
    initialTier,
    downgradeThresholdMs: 20,
    upgradeThresholdMs: 17,
    downgradeWindowMs: 100,
    upgradeWindowMs: 200,
    cooldownMs: 100,
    emaWeight: 1,
  });

describe('createAdaptiveQualityController', () => {
  it('moves one tier after a sustained over-budget window', () => {
    const controller = createController();
    expect(controller.observeFrame(25)).toBeNull();
    expect(controller.observeFrame(25)).toBeNull();
    expect(controller.observeFrame(25)).toBeNull();
    expect(controller.observeFrame(25)).toBe('balanced');
    expect(controller.tier).toBe('balanced');
  });

  it('requires cooldown and the longer recovery window before upgrading', () => {
    const controller = createController();
    for (let index = 0; index < 4; index += 1) controller.observeFrame(25);
    expect(controller.tier).toBe('balanced');

    for (let index = 0; index < 28; index += 1) expect(controller.observeFrame(10)).toBeNull();
    expect(controller.observeFrame(10)).toBe('high');
  });

  it('ignores invalid, outlying, and caller-filtered samples', () => {
    const controller = createAdaptiveQualityController({
      tiers: ['low', 'high'] as const,
      initialTier: 'high',
      emaWeight: 1,
      downgradeWindowMs: 20,
      sampleFilter: (frameMs) => frameMs !== 30,
    });

    for (const frameMs of [Number.NaN, Number.POSITIVE_INFINITY, 1, 1_000, 30]) {
      expect(controller.observeFrame(frameMs)).toBeNull();
    }
    expect(controller.averageFrameMs).toBeCloseTo(1_000 / 60);
    expect(controller.observeFrame(25)).toBe('low');
  });

  it('accepts sustained very slow foreground frames while rejecting isolated and extreme outliers', () => {
    const controller = createAdaptiveQualityController({
      tiers: ['low', 'high'] as const,
      initialTier: 'high',
      emaWeight: 1,
      downgradeWindowMs: 100,
      maxSampleMs: 100,
      maxOutlierMs: 1_000,
      slowFrameConfirmationSamples: 3,
    });

    expect(controller.observeFrame(160)).toBeNull();
    expect(controller.averageFrameMs).toBeCloseTo(1_000 / 60);
    expect(controller.observeFrame(16)).toBeNull();

    expect(controller.observeFrame(160)).toBeNull();
    expect(controller.observeFrame(160)).toBeNull();
    expect(controller.observeFrame(160)).toBe('low');
    expect(controller.averageFrameMs).toBe(100);

    controller.reset('high');
    for (let index = 0; index < 5; index += 1) expect(controller.observeFrame(1_000)).toBeNull();
    expect(controller.tier).toBe('high');
  });

  it('resets all observations and validates its tier', () => {
    const controller = createController('balanced');
    controller.observeFrame(25);
    controller.reset('low');
    expect(controller.tier).toBe('low');
    expect(controller.averageFrameMs).toBeCloseTo(1_000 / 60);
    expect(() => controller.reset('unknown' as 'low')).toThrow(RangeError);
  });

  it('publishes external observeFrame and reset transitions and supports idempotent unsubscribe', () => {
    const controller = createController();
    const transitions: string[] = [];
    const unsubscribe = controller.subscribe((tier, previousTier) => {
      transitions.push(`${previousTier}->${tier}`);
    });

    for (let index = 0; index < 4; index += 1) controller.observeFrame(25);
    controller.reset('low');
    controller.reset('low');
    expect(transitions).toEqual(['high->balanced', 'balanced->low']);

    unsubscribe();
    unsubscribe();
    controller.reset('high');
    expect(transitions).toEqual(['high->balanced', 'balanced->low']);
  });

  it('snapshots tier order, initial tier, and the sample filter at construction', () => {
    type Tier = 'low' | 'high';
    const tiers: Tier[] = ['low', 'high'];
    const config: AdaptiveQualityConfig<Tier> = {
      tiers,
      initialTier: 'high',
      emaWeight: 1,
      downgradeWindowMs: 20,
      sampleFilter: () => true,
    };
    const controller = createAdaptiveQualityController(config);

    tiers.reverse();
    (config as { initialTier: Tier }).initialTier = 'low';
    (config as { sampleFilter: (frameMs: number) => boolean }).sampleFilter = () => false;

    expect(controller.observeFrame(25)).toBe('low');
    controller.reset();
    expect(controller.tier).toBe('high');
  });

  it('rejects policies without ordered hysteresis', () => {
    expect(() =>
      createAdaptiveQualityController({
        tiers: ['low', 'high'] as const,
        initialTier: 'high',
        upgradeThresholdMs: 22,
        downgradeThresholdMs: 20,
      }),
    ).toThrow(RangeError);
  });

  it.each([
    { emaWeight: Number.NaN },
    { emaWeight: 0 },
    { emaWeight: 1.01 },
    { downgradeWindowMs: -1 },
    { maxSampleMs: 100, maxOutlierMs: 100 },
    { slowFrameConfirmationSamples: 0 },
    { slowFrameConfirmationSamples: 1.5 },
  ])('rejects invalid explicit policy boundaries: %o', (invalidPolicy) => {
    expect(() =>
      createAdaptiveQualityController({
        tiers: ['low', 'high'] as const,
        initialTier: 'high',
        ...invalidPolicy,
      }),
    ).toThrow(RangeError);
  });

  it('rejects invalid runtime tier and callback configuration', () => {
    expect(() =>
      createAdaptiveQualityController({
        tiers: ['low', ''] as const,
        initialTier: 'low',
      }),
    ).toThrow(RangeError);
    expect(() =>
      createAdaptiveQualityController({
        tiers: ['low', 'high'] as const,
        initialTier: 'high',
        sampleFilter: 42 as unknown as (frameMs: number) => boolean,
      }),
    ).toThrow(TypeError);
  });
});

describe('bindAdaptiveDprController', () => {
  it('synchronizes initial, externally observed, and reset tiers until disposed', () => {
    const controller = createController();
    const appliedDpr: number[] = [];
    const changedTiers: string[] = [];
    const dispose = bindAdaptiveDprController({
      controller,
      profiles: {
        low: { dpr: 1 },
        balanced: { dpr: 1.5 },
        high: { dpr: 2 },
      },
      setDpr: (dpr) => appliedDpr.push(dpr),
      getDeviceDpr: () => 1.75,
      onTierChange: (tier) => changedTiers.push(tier),
    });

    expect(appliedDpr).toEqual([1.75]);
    for (let index = 0; index < 4; index += 1) controller.observeFrame(25);
    controller.reset('low');
    expect(appliedDpr).toEqual([1.75, 1.5, 1]);
    expect(changedTiers).toEqual(['balanced', 'low']);

    dispose();
    controller.reset('high');
    expect(appliedDpr).toEqual([1.75, 1.5, 1]);
  });

  it('fails fast when a controller tier has no renderer profile', () => {
    const controller = createController();
    expect(() =>
      bindAdaptiveDprController({
        controller,
        profiles: Object.create(null) as Record<'low' | 'balanced' | 'high', { dpr: number }>,
        setDpr: () => undefined,
        getDeviceDpr: () => 1,
      }),
    ).toThrow(RangeError);
  });
});

describe('resolveProfileDpr', () => {
  it('caps a profile by the device and optional platform limit', () => {
    expect(resolveProfileDpr(2, 1.5)).toBe(1.5);
    expect(resolveProfileDpr(2, 3, 1.25)).toBe(1.25);
    expect(resolveProfileDpr(Number.NaN, 2)).toBe(1);
  });
});
