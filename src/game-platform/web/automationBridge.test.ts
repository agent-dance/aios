import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ADVANCE_TIME_BUDGET_MS,
  hasVirtualTimeMarker,
  installGameAutomationBridge,
  normalizeAdvanceTime,
  normalizeAdvanceTimeBudget,
  resolveGameAutomationTarget,
  type GameAutomationTarget,
} from './automationBridge';

describe('game automation bridge', () => {
  it('exposes the exact automation globals and validates elapsed time', () => {
    const target: GameAutomationTarget = {};
    const advanceTime = vi.fn();
    const manual = vi.fn();
    const bridge = installGameAutomationBridge({ target, renderGameToText: () => '{"mode":"play"}', advanceTime, onManualClockRequested: manual });

    expect(Object.keys(target).sort()).toEqual(['advanceTime', 'render_game_to_text']);
    expect(target.render_game_to_text?.()).toBe('{"mode":"play"}');
    target.advanceTime?.(0);
    target.advanceTime?.(16.5);
    target.advanceTime?.(2_000);
    target.advanceTime?.(-1);
    target.advanceTime?.(Number.NaN);
    target.advanceTime?.(Number.POSITIVE_INFINITY);
    target.advanceTime?.(DEFAULT_ADVANCE_TIME_BUDGET_MS + 1);

    expect(advanceTime.mock.calls).toEqual([[0], [16.5], [2_000]]);
    expect(manual).toHaveBeenCalledTimes(3);
    bridge.dispose();
    expect(target).toEqual({});
  });

  it('detects the client marker by property presence and requests manual mode immediately', () => {
    const target: GameAutomationTarget = { __vt_pending: undefined };
    const manual = vi.fn();
    const bridge = installGameAutomationBridge({ target, renderGameToText: () => '{}', advanceTime: vi.fn(), onManualClockRequested: manual });

    expect(hasVirtualTimeMarker(target)).toBe(true);
    expect(bridge.manualClockRequestedAtInstall).toBe(true);
    expect(manual).toHaveBeenCalledOnce();
    bridge.dispose();
    expect(target).toEqual({ __vt_pending: undefined });
  });

  it('restores stacked owners and never deletes an unrelated replacement', () => {
    const originalRender = () => 'original';
    const originalAdvance = vi.fn();
    const target: GameAutomationTarget = { render_game_to_text: originalRender, advanceTime: originalAdvance };
    const first = installGameAutomationBridge({ target, renderGameToText: () => 'first', advanceTime: vi.fn() });
    const second = installGameAutomationBridge({ target, renderGameToText: () => 'second', advanceTime: vi.fn() });

    first.dispose();
    expect(target.render_game_to_text?.()).toBe('second');
    second.dispose();
    expect(target.render_game_to_text).toBe(originalRender);
    expect(target.advanceTime).toBe(originalAdvance);

    const third = installGameAutomationBridge({ target, renderGameToText: () => 'third', advanceTime: vi.fn() });
    const externalRender = () => 'external';
    target.render_game_to_text = externalRender;
    third.dispose();
    expect(target.render_game_to_text).toBe(externalRender);
    expect(target.advanceTime).toBe(originalAdvance);
  });

  it('normalizes only finite non-negative durations', () => {
    expect(normalizeAdvanceTime(1)).toBe(1);
    expect(normalizeAdvanceTime(0)).toBe(0);
    expect(normalizeAdvanceTime(-0)).toBe(-0);
    expect(normalizeAdvanceTime(-1)).toBeNull();
    expect(normalizeAdvanceTime(Number.NaN)).toBeNull();
    expect(normalizeAdvanceTime(DEFAULT_ADVANCE_TIME_BUDGET_MS)).toBe(DEFAULT_ADVANCE_TIME_BUDGET_MS);
    expect(normalizeAdvanceTime(DEFAULT_ADVANCE_TIME_BUDGET_MS + 1)).toBeNull();
    expect(normalizeAdvanceTime(2_000)).toBe(2_000);
    expect(normalizeAdvanceTime(1_500, 2_000)).toBe(1_500);
    expect(normalizeAdvanceTimeBudget(2_000)).toBe(2_000);
    expect(normalizeAdvanceTimeBudget(Number.POSITIVE_INFINITY)).toBe(DEFAULT_ADVANCE_TIME_BUDGET_MS);
    expect(normalizeAdvanceTimeBudget(-1)).toBe(DEFAULT_ADVANCE_TIME_BUDGET_MS);
  });

  it('enforces a configurable single-call budget before requesting manual mode', () => {
    const target: GameAutomationTarget = {};
    const advanceTime = vi.fn();
    const manual = vi.fn();
    installGameAutomationBridge({
      target,
      renderGameToText: () => '{}',
      advanceTime,
      onManualClockRequested: manual,
      maxAdvanceTimeMilliseconds: 50,
    });

    target.advanceTime?.(1000 / 60);
    target.advanceTime?.(50);
    target.advanceTime?.(50.01);
    expect(advanceTime.mock.calls).toEqual([[1000 / 60], [50]]);
    expect(manual).toHaveBeenCalledTimes(2);
  });

  it('preserves explicit null target injection instead of falling back to the ambient window', () => {
    const ambient: GameAutomationTarget = {};
    expect(resolveGameAutomationTarget(undefined, ambient)).toBe(ambient);
    expect(resolveGameAutomationTarget(null, ambient)).toBeNull();
  });
});
