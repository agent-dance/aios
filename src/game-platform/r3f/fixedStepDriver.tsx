import { useFrame } from '@react-three/fiber';
import { memo, useRef } from 'react';

export const DEFAULT_MAX_FRAME_MS = 50;
export const DEFAULT_DRIVER_PRIORITY = -100;

/**
 * R3F treats every positive useFrame priority as a request to take over
 * rendering. Platform adapters only observe the automatic render loop, so a
 * positive (or non-finite) priority would silently freeze the canvas.
 */
export function assertAutomaticRenderPriority(priority: number): number {
  if (!Number.isFinite(priority) || priority > 0) {
    throw new RangeError('Frame priority must be a finite, non-positive number to preserve R3F automatic rendering.');
  }
  return priority;
}

export function assertPositiveFrameLimit(maxFrameMs: number): number {
  if (!Number.isFinite(maxFrameMs) || maxFrameMs <= 0) {
    throw new RangeError('maxFrameMs must be a finite number greater than zero.');
  }
  return maxFrameMs;
}

export interface FixedStepDriverProps {
  /** Receives the clamped real-time delta. Fixed-step accumulation stays in the game runtime. */
  readonly onFrame: (elapsedMs: number, nowMs: number) => void;
  readonly enabled?: boolean;
  /** Suppresses real-time ticks while an external deterministic clock owns simulation time. */
  readonly manual?: boolean;
  /** Caps long foreground frames to prevent a simulation spiral of death. */
  readonly maxFrameMs?: number;
  /** R3F frame callback order. Keep non-positive unless this driver also owns rendering. */
  readonly priority?: number;
}

export function normalizeFrameElapsedMs(deltaSeconds: number, maxFrameMs = DEFAULT_MAX_FRAME_MS): number {
  if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return 0;
  if (!Number.isFinite(maxFrameMs) || maxFrameMs <= 0) return 0;
  return Math.min(deltaSeconds * 1_000, maxFrameMs);
}

/**
 * The only R3F clock bridge a game simulation should mount. It deliberately
 * does not own a second requestAnimationFrame loop or fixed-step accumulator.
 */
export const FixedStepDriver = memo(function FixedStepDriver({
  onFrame,
  enabled = true,
  manual = false,
  maxFrameMs = DEFAULT_MAX_FRAME_MS,
  priority = DEFAULT_DRIVER_PRIORITY,
}: FixedStepDriverProps) {
  const automaticRenderPriority = assertAutomaticRenderPriority(priority);
  const frameLimitMs = assertPositiveFrameLimit(maxFrameMs);
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  useFrame((_, deltaSeconds) => {
    if (!enabled || manual) return;
    const elapsedMs = normalizeFrameElapsedMs(deltaSeconds, frameLimitMs);
    if (elapsedMs === 0) return;
    onFrameRef.current(elapsedMs, performance.now());
  }, automaticRenderPriority);

  return null;
});
