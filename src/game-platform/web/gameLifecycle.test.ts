import { describe, expect, it, vi } from 'vitest';
import {
  createGameLifecycleController,
  deriveGameLifecycleSnapshot,
  readLifecycleDocumentState,
  resolveLifecycleTarget,
  type LifecycleDocumentTarget,
} from './gameLifecycle';

describe('game lifecycle controller', () => {
  it('derives stable, ordered suspension reasons', () => {
    expect(deriveGameLifecycleSnapshot({ active: false, focused: false, visible: false })).toEqual({
      active: false,
      focused: false,
      visible: false,
      suspended: true,
      reasons: ['inactive', 'blurred', 'hidden'],
    });
    expect(deriveGameLifecycleSnapshot(
      { active: true, focused: false, visible: true },
      { suspendOnBlur: false },
    ).suspended).toBe(false);
    expect(deriveGameLifecycleSnapshot(
      { active: false, focused: true, visible: true },
      { suspendOnInactive: undefined },
    ).reasons).toEqual(['inactive']);
  });

  it('resets input and clock once per suspension boundary', () => {
    const onResetInput = vi.fn();
    const onResetClock = vi.fn();
    const onSuspend = vi.fn();
    const onResume = vi.fn();
    const controller = createGameLifecycleController(
      { active: true, focused: true, visible: true },
      { resetInputOnResume: true },
      { onResetInput, onResetClock, onSuspend, onResume },
    );

    controller.setFocused(false);
    controller.setVisible(false);
    controller.setFocused(true);
    expect(onSuspend).toHaveBeenCalledOnce();
    expect(onResume).not.toHaveBeenCalled();
    controller.setVisible(true);

    expect(onResume).toHaveBeenCalledOnce();
    expect(onResetInput).toHaveBeenCalledTimes(2);
    expect(onResetClock).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().suspended).toBe(false);
  });

  it('supports shell inactivity and configurable suspension sources', () => {
    const onSuspend = vi.fn();
    const onResume = vi.fn();
    const controller = createGameLifecycleController(
      { active: true, focused: true, visible: true },
      { suspendOnBlur: false },
      { onSuspend, onResume },
    );
    const snapshots: boolean[] = [];
    controller.subscribe((snapshot) => snapshots.push(snapshot.suspended));

    controller.setFocused(false);
    expect(controller.getSnapshot().suspended).toBe(false);
    controller.setActive(false);
    controller.setFocused(true);
    controller.setActive(true);

    expect(onSuspend).toHaveBeenCalledOnce();
    expect(onResume).toHaveBeenCalledOnce();
    expect(snapshots).toEqual([false, true, true, false]);
  });

  it('immediately suspends an initially hidden game', () => {
    const onSuspend = vi.fn();
    const onResetClock = vi.fn();
    const controller = createGameLifecycleController(
      { active: true, focused: true, visible: false },
      {},
      { onSuspend, onResetClock },
    );

    expect(controller.getSnapshot().reasons).toEqual(['hidden']);
    expect(onSuspend).toHaveBeenCalledOnce();
    expect(onResetClock).toHaveBeenCalledOnce();
  });

  it('defers render-phase callbacks and initializes exactly once for StrictMode effect replay', () => {
    const onResetInput = vi.fn();
    const onResetClock = vi.fn();
    const onSuspend = vi.fn();
    const controller = createGameLifecycleController(
      { active: true, focused: true, visible: true },
      {},
      { onResetInput, onResetClock, onSuspend },
      { deferInitialCallbacks: true },
    );

    controller.setVisible(false);
    expect(onSuspend).not.toHaveBeenCalled();
    controller.initialize();
    controller.initialize();

    expect(onSuspend).toHaveBeenCalledOnce();
    expect(onResetInput).toHaveBeenCalledOnce();
    expect(onResetClock).toHaveBeenCalledOnce();
    expect(onSuspend).toHaveBeenCalledWith(expect.objectContaining({ reasons: ['hidden'] }));
  });

  it('derives the initial browser focus and visibility state safely', () => {
    const hiddenDocument = {
      visibilityState: 'hidden',
      hasFocus: () => false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } satisfies LifecycleDocumentTarget;
    expect(readLifecycleDocumentState(hiddenDocument)).toEqual({ focused: false, visible: false });

    const throwingDocument = {
      visibilityState: 'visible',
      hasFocus: () => { throw new Error('unavailable'); },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } satisfies LifecycleDocumentTarget;
    expect(readLifecycleDocumentState(throwingDocument)).toEqual({ focused: true, visible: true });
  });

  it('preserves explicit null lifecycle targets instead of using ambient targets', () => {
    const ambient = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    expect(resolveLifecycleTarget(undefined, ambient)).toBe(ambient);
    expect(resolveLifecycleTarget(null, ambient)).toBeNull();
  });
});
