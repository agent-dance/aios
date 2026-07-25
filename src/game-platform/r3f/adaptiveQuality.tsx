import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { assertAutomaticRenderPriority } from './fixedStepDriver';

export interface DprQualityProfile {
  readonly dpr: number;
}

export interface AdaptiveQualityConfig<Tier extends string> {
  /** Ordered from least expensive to most expensive. */
  readonly tiers: readonly Tier[];
  readonly initialTier: Tier;
  readonly downgradeThresholdMs?: number;
  readonly upgradeThresholdMs?: number;
  readonly downgradeWindowMs?: number;
  readonly upgradeWindowMs?: number;
  readonly cooldownMs?: number;
  readonly emaWeight?: number;
  readonly initialAverageFrameMs?: number;
  readonly minSampleMs?: number;
  /**
   * Samples above this limit are initially treated as possible wake-up
   * outliers. A sustained sequence is accepted at this capped value.
   */
  readonly maxSampleMs?: number;
  /** Samples at or above this absolute limit are always rejected as clock/background outliers. */
  readonly maxOutlierMs?: number;
  /** Consecutive slow samples required before maxSampleMs-capped observations are accepted. */
  readonly slowFrameConfirmationSamples?: number;
  /** Optional platform filter in addition to finite/range checks. */
  readonly sampleFilter?: (frameMs: number) => boolean;
}

export type AdaptiveQualityListener<Tier extends string> = (tier: Tier, previousTier: Tier) => void;

export interface AdaptiveQualityController<Tier extends string> {
  readonly tier: Tier;
  readonly averageFrameMs: number;
  observeFrame(frameMs: number): Tier | null;
  reset(tier?: Tier): void;
  /** Receives actual tier transitions, including transitions caused by reset(). */
  subscribe(listener: AdaptiveQualityListener<Tier>): () => void;
}

interface ResolvedAdaptiveQualityPolicy {
  readonly downgradeThresholdMs: number;
  readonly upgradeThresholdMs: number;
  readonly downgradeWindowMs: number;
  readonly upgradeWindowMs: number;
  readonly cooldownMs: number;
  readonly emaWeight: number;
  readonly initialAverageFrameMs: number;
  readonly minSampleMs: number;
  readonly maxSampleMs: number;
  readonly maxOutlierMs: number;
  readonly slowFrameConfirmationSamples: number;
}

const DEFAULT_POLICY: ResolvedAdaptiveQualityPolicy = {
  downgradeThresholdMs: 22,
  upgradeThresholdMs: 17.2,
  downgradeWindowMs: 1_200,
  upgradeWindowMs: 5_000,
  cooldownMs: 3_000,
  emaWeight: 0.08,
  initialAverageFrameMs: 1_000 / 60,
  minSampleMs: 4,
  maxSampleMs: 100,
  maxOutlierMs: 1_000,
  slowFrameConfirmationSamples: 3,
};

function resolveFiniteOption(name: string, value: number | undefined, fallback: number, minimum: number): number {
  if (value == null) return fallback;
  if (!Number.isFinite(value) || value < minimum) {
    throw new RangeError(`${name} must be a finite number greater than or equal to ${minimum}.`);
  }
  return value;
}

function resolvePositiveIntegerOption(name: string, value: number | undefined, fallback: number): number {
  if (value == null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function resolvePolicy<Tier extends string>(config: AdaptiveQualityConfig<Tier>): ResolvedAdaptiveQualityPolicy {
  const policy = {
    downgradeThresholdMs: resolveFiniteOption(
      'downgradeThresholdMs',
      config.downgradeThresholdMs,
      DEFAULT_POLICY.downgradeThresholdMs,
      0,
    ),
    upgradeThresholdMs: resolveFiniteOption(
      'upgradeThresholdMs',
      config.upgradeThresholdMs,
      DEFAULT_POLICY.upgradeThresholdMs,
      0,
    ),
    downgradeWindowMs: resolveFiniteOption(
      'downgradeWindowMs',
      config.downgradeWindowMs,
      DEFAULT_POLICY.downgradeWindowMs,
      0,
    ),
    upgradeWindowMs: resolveFiniteOption(
      'upgradeWindowMs',
      config.upgradeWindowMs,
      DEFAULT_POLICY.upgradeWindowMs,
      0,
    ),
    cooldownMs: resolveFiniteOption('cooldownMs', config.cooldownMs, DEFAULT_POLICY.cooldownMs, 0),
    emaWeight: resolveFiniteOption('emaWeight', config.emaWeight, DEFAULT_POLICY.emaWeight, Number.EPSILON),
    initialAverageFrameMs: resolveFiniteOption(
      'initialAverageFrameMs',
      config.initialAverageFrameMs,
      DEFAULT_POLICY.initialAverageFrameMs,
      Number.EPSILON,
    ),
    minSampleMs: resolveFiniteOption('minSampleMs', config.minSampleMs, DEFAULT_POLICY.minSampleMs, 0),
    maxSampleMs: resolveFiniteOption('maxSampleMs', config.maxSampleMs, DEFAULT_POLICY.maxSampleMs, Number.EPSILON),
    maxOutlierMs: resolveFiniteOption(
      'maxOutlierMs',
      config.maxOutlierMs,
      DEFAULT_POLICY.maxOutlierMs,
      Number.EPSILON,
    ),
    slowFrameConfirmationSamples: resolvePositiveIntegerOption(
      'slowFrameConfirmationSamples',
      config.slowFrameConfirmationSamples,
      DEFAULT_POLICY.slowFrameConfirmationSamples,
    ),
  };

  if (policy.emaWeight > 1) throw new RangeError('emaWeight must be in the range (0, 1].');
  if (policy.upgradeThresholdMs >= policy.downgradeThresholdMs) {
    throw new RangeError('upgradeThresholdMs must be lower than downgradeThresholdMs to provide hysteresis.');
  }
  if (policy.minSampleMs >= policy.maxSampleMs) {
    throw new RangeError('minSampleMs must be lower than maxSampleMs.');
  }
  if (policy.maxSampleMs >= policy.maxOutlierMs) {
    throw new RangeError('maxSampleMs must be lower than maxOutlierMs.');
  }
  return policy;
}

/** Pure adaptive-quality state machine. Browser visibility filtering belongs to its adapter. */
export function createAdaptiveQualityController<Tier extends string>(
  config: AdaptiveQualityConfig<Tier>,
): AdaptiveQualityController<Tier> {
  const tiers = [...config.tiers];
  if (tiers.length === 0) throw new RangeError('At least one quality tier is required.');
  if (tiers.some((tier) => typeof tier !== 'string' || tier.trim().length === 0)) {
    throw new RangeError('Quality tiers must be non-empty strings.');
  }
  if (new Set(tiers).size !== tiers.length) throw new RangeError('Quality tiers must be unique.');

  const policy = resolvePolicy(config);
  const initialTier = config.initialTier;
  const sampleFilter = config.sampleFilter;
  if (sampleFilter != null && typeof sampleFilter !== 'function') {
    throw new TypeError('sampleFilter must be a function.');
  }
  const tierIndex = new Map(tiers.map((tier, index) => [tier, index] as const));
  if (!tierIndex.has(initialTier)) throw new RangeError('initialTier must be present in tiers.');

  let tier = initialTier;
  let averageFrameMs = policy.initialAverageFrameMs;
  let overBudgetMs = 0;
  let underBudgetMs = 0;
  let cooldownRemainingMs = 0;
  let consecutiveSlowFrames = 0;
  const listeners = new Set<AdaptiveQualityListener<Tier>>();

  const resetWindows = () => {
    overBudgetMs = 0;
    underBudgetMs = 0;
  };

  const publishTier = (nextTier: Tier) => {
    const previousTier = tier;
    if (nextTier === previousTier) return;
    tier = nextTier;
    for (const listener of [...listeners]) listener(nextTier, previousTier);
  };

  return {
    get tier() {
      return tier;
    },
    get averageFrameMs() {
      return averageFrameMs;
    },
    observeFrame(frameMs: number) {
      if (
        !Number.isFinite(frameMs) ||
        frameMs < policy.minSampleMs ||
        frameMs >= policy.maxOutlierMs ||
        (sampleFilter && !sampleFilter(frameMs))
      ) {
        consecutiveSlowFrames = 0;
        return null;
      }

      let acceptedFrameMs = frameMs;
      if (frameMs > policy.maxSampleMs) {
        consecutiveSlowFrames += 1;
        if (consecutiveSlowFrames < policy.slowFrameConfirmationSamples) return null;
        acceptedFrameMs = policy.maxSampleMs;
      } else {
        consecutiveSlowFrames = 0;
      }

      averageFrameMs += (acceptedFrameMs - averageFrameMs) * policy.emaWeight;
      cooldownRemainingMs = Math.max(0, cooldownRemainingMs - acceptedFrameMs);
      if (cooldownRemainingMs > 0) {
        resetWindows();
        return null;
      }

      if (averageFrameMs > policy.downgradeThresholdMs) {
        overBudgetMs += acceptedFrameMs;
        underBudgetMs = 0;
      } else if (averageFrameMs < policy.upgradeThresholdMs) {
        underBudgetMs += acceptedFrameMs;
        overBudgetMs = 0;
      } else {
        resetWindows();
      }

      const currentIndex = tierIndex.get(tier)!;
      let nextTier: Tier | undefined;
      if (overBudgetMs >= policy.downgradeWindowMs && currentIndex > 0) {
        nextTier = tiers[currentIndex - 1];
      } else if (underBudgetMs >= policy.upgradeWindowMs && currentIndex < tiers.length - 1) {
        nextTier = tiers[currentIndex + 1];
      }
      if (nextTier == null) return null;

      publishTier(nextTier);
      cooldownRemainingMs = policy.cooldownMs;
      resetWindows();
      return tier;
    },
    reset(nextTier = initialTier) {
      if (!tierIndex.has(nextTier)) throw new RangeError('reset tier must be present in tiers.');
      averageFrameMs = policy.initialAverageFrameMs;
      cooldownRemainingMs = 0;
      consecutiveSlowFrames = 0;
      resetWindows();
      publishTier(nextTier);
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Adaptive quality listener must be a function.');
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function resolveProfileDpr(profileDpr: number, deviceDpr: number, maxDpr = Number.POSITIVE_INFINITY): number {
  const safeProfileDpr = Number.isFinite(profileDpr) && profileDpr > 0 ? profileDpr : 1;
  const safeDeviceDpr = Number.isFinite(deviceDpr) && deviceDpr > 0 ? deviceDpr : 1;
  const safeMaxDpr = Number.isFinite(maxDpr) && maxDpr > 0 ? maxDpr : Number.POSITIVE_INFINITY;
  return Math.min(safeProfileDpr, safeDeviceDpr, safeMaxDpr);
}

export interface AdaptiveDprProps<Tier extends string> {
  readonly controller: AdaptiveQualityController<Tier>;
  readonly profiles: Readonly<Record<Tier, DprQualityProfile>>;
  readonly enabled?: boolean;
  readonly maxDpr?: number;
  readonly priority?: number;
  readonly onTierChange?: (tier: Tier) => void;
}

export interface AdaptiveDprBindingOptions<Tier extends string> {
  readonly controller: AdaptiveQualityController<Tier>;
  readonly profiles: Readonly<Record<Tier, DprQualityProfile>>;
  readonly setDpr: (dpr: number) => void;
  readonly getDeviceDpr: () => number;
  readonly maxDpr?: number;
  readonly onTierChange?: (tier: Tier) => void;
}

/** Keeps renderer DPR synchronized with both frame-driven and external controller transitions. */
export function bindAdaptiveDprController<Tier extends string>({
  controller,
  profiles,
  setDpr,
  getDeviceDpr,
  maxDpr,
  onTierChange,
}: AdaptiveDprBindingOptions<Tier>): () => void {
  const applyTier = (tier: Tier) => {
    if (!Object.prototype.hasOwnProperty.call(profiles, tier)) {
      throw new RangeError(`Missing DPR profile for quality tier "${tier}".`);
    }
    const profile = profiles[tier];
    if (profile == null) throw new RangeError(`Missing DPR profile for quality tier "${tier}".`);
    setDpr(resolveProfileDpr(profile.dpr, getDeviceDpr(), maxDpr));
  };

  applyTier(controller.tier);
  const unsubscribe = controller.subscribe((tier) => {
    applyTier(tier);
    onTierChange?.(tier);
  });
  return unsubscribe;
}

/** Thin R3F adapter around the pure controller; it never changes simulation semantics. */
export function AdaptiveDpr<Tier extends string>({
  controller,
  profiles,
  enabled = true,
  maxDpr,
  priority = 0,
  onTierChange,
}: AdaptiveDprProps<Tier>) {
  const automaticRenderPriority = assertAutomaticRenderPriority(priority);
  const setDpr = useThree((state) => state.setDpr);
  const onTierChangeRef = useRef(onTierChange);
  onTierChangeRef.current = onTierChange;

  useEffect(() => {
    return bindAdaptiveDprController({
      controller,
      profiles,
      setDpr,
      getDeviceDpr: () => (typeof window === 'undefined' ? 1 : window.devicePixelRatio),
      maxDpr,
      onTierChange: (tier) => onTierChangeRef.current?.(tier),
    });
  }, [controller, maxDpr, profiles, setDpr]);

  useFrame((_, deltaSeconds) => {
    if (!enabled || (typeof document !== 'undefined' && document.hidden)) return;
    controller.observeFrame(deltaSeconds * 1_000);
  }, automaticRenderPriority);

  return null;
}
