import { describe, expect, it, vi } from 'vitest';
import {
  createFullscreenController,
  isFullscreenCapable,
  resolveFullscreenDocumentTarget,
  type FullscreenDocumentTarget,
  type FullscreenElementTarget,
} from './fullscreenController';

class FakeFullscreenDocument implements FullscreenDocumentTarget {
  fullscreenElement: unknown | null = null;
  fullscreenEnabled = true;
  readonly listeners = new Map<string, Set<() => void>>();
  exitFullscreen = vi.fn(async () => {
    this.fullscreenElement = null;
    this.emit('fullscreenchange');
  });

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    this.listeners.get(type)?.forEach((listener) => listener());
  }
}

describe('fullscreen controller', () => {
  it('reports capability and follows fullscreenchange events', async () => {
    const documentTarget = new FakeFullscreenDocument();
    const element: FullscreenElementTarget = {
      requestFullscreen: vi.fn(async () => {
        documentTarget.fullscreenElement = element;
        documentTarget.emit('fullscreenchange');
      }),
    };
    const controller = createFullscreenController(documentTarget, () => element);

    expect(controller.getSnapshot()).toMatchObject({ supported: true, active: false, pending: false });
    expect(await controller.enter()).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ active: true, pending: false, error: null });
    expect(await controller.toggle()).toBe(true);
    expect(controller.getSnapshot().active).toBe(false);
    controller.dispose();
    expect(documentTarget.listeners.get('fullscreenchange')?.size).toBe(0);
    expect(documentTarget.listeners.get('fullscreenerror')?.size).toBe(0);
  });

  it('contains rejected promises and fullscreenerror events', async () => {
    const documentTarget = new FakeFullscreenDocument();
    const element: FullscreenElementTarget = {
      requestFullscreen: vi.fn(() => Promise.reject(new Error('Permission denied'))),
    };
    const controller = createFullscreenController(documentTarget, () => element);

    expect(await controller.enter()).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ pending: false, error: 'Permission denied' });
    controller.clearError();
    documentTarget.emit('fullscreenerror');
    expect(controller.getSnapshot().error).toBe('Fullscreen request failed');
  });

  it('reports unsupported documents without throwing', async () => {
    const documentTarget = new FakeFullscreenDocument();
    documentTarget.fullscreenEnabled = false;
    const element: FullscreenElementTarget = { requestFullscreen: vi.fn(async () => undefined) };
    const controller = createFullscreenController(documentTarget, () => element);

    expect(isFullscreenCapable(documentTarget, element)).toBe(false);
    expect(await controller.toggle()).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ supported: false, error: 'Fullscreen is not supported' });
  });

  it('deduplicates concurrent requests', async () => {
    const documentTarget = new FakeFullscreenDocument();
    let resolveRequest: (() => void) | undefined;
    const element: FullscreenElementTarget = {
      requestFullscreen: vi.fn(() => new Promise<void>((resolve) => { resolveRequest = resolve; })),
    };
    const controller = createFullscreenController(documentTarget, () => element);

    const first = controller.enter();
    const second = controller.enter();
    expect(element.requestFullscreen).toHaveBeenCalledOnce();
    resolveRequest?.();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
  });

  it('never treats or exits another component fullscreen element as its own', async () => {
    const documentTarget = new FakeFullscreenDocument();
    const otherElement = {};
    documentTarget.fullscreenElement = otherElement;
    const element: FullscreenElementTarget = { requestFullscreen: vi.fn(async () => undefined) };
    const controller = createFullscreenController(documentTarget, () => element);

    expect(controller.getSnapshot().active).toBe(false);
    expect(await controller.exit()).toBe(true);
    expect(documentTarget.exitFullscreen).not.toHaveBeenCalled();
    expect(await controller.toggle()).toBe(false);
    expect(documentTarget.exitFullscreen).not.toHaveBeenCalled();
    expect(element.requestFullscreen).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      active: false,
      pending: false,
      error: 'Another element is already fullscreen',
    });
  });

  it('contains synchronous throws and always clears pending state', async () => {
    const documentTarget = new FakeFullscreenDocument();
    const element: FullscreenElementTarget = {
      requestFullscreen: vi.fn(() => { throw new Error('Synchronous denial'); }),
    };
    const controller = createFullscreenController(documentTarget, () => element);

    expect(await controller.enter()).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ pending: false, error: 'Synchronous denial' });
    expect(await controller.enter()).toBe(false);
    expect(element.requestFullscreen).toHaveBeenCalledTimes(2);
  });

  it('refreshes against the current target and tolerates throwing resolvers', () => {
    const documentTarget = new FakeFullscreenDocument();
    const first: FullscreenElementTarget = { requestFullscreen: vi.fn(async () => undefined) };
    const second: FullscreenElementTarget = { requestFullscreen: vi.fn(async () => undefined) };
    let current: FullscreenElementTarget | null = first;
    const controller = createFullscreenController(documentTarget, () => current);
    documentTarget.fullscreenElement = first;
    controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ supported: true, active: true });

    current = second;
    controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ supported: true, active: false });

    const throwing = createFullscreenController(documentTarget, () => { throw new Error('detached'); });
    expect(throwing.getSnapshot()).toMatchObject({ supported: false, active: false });
    expect(() => throwing.refresh()).not.toThrow();
  });

  it('preserves explicit null document injection for hook target resolution', () => {
    const ambient = new FakeFullscreenDocument();
    expect(resolveFullscreenDocumentTarget(undefined, ambient)).toBe(ambient);
    expect(resolveFullscreenDocumentTarget(null, ambient)).toBeNull();
  });
});
