import { beforeEach, describe, expect, it } from 'vitest';
import { APP_REGISTRY } from './appRegistry';
import { useSystemStore } from './useSystemStore';

describe('system window manager', () => {
  beforeEach(() => {
    useSystemStore.setState({ windows: {}, activeAppId: null, topZ: 0 });
  });

  it('opens, focuses, minimizes and restores an app through one lifecycle', () => {
    const store = useSystemStore.getState();
    store.openApp('terminal');
    expect(useSystemStore.getState().windows.terminal).toMatchObject({
      isOpen: true,
      isMinimized: false,
    });

    useSystemStore.getState().minimizeApp('terminal');
    expect(useSystemStore.getState().windows.terminal?.isMinimized).toBe(true);

    useSystemStore.getState().openApp('terminal');
    expect(useSystemStore.getState().windows.terminal?.isMinimized).toBe(false);
    expect(useSystemStore.getState().activeAppId).toBe('terminal');
  });

  it('restores exact bounds after maximizing a window', () => {
    useSystemStore.getState().openApp('finder');
    useSystemStore.getState().moveWindow('finder', 123, 87);
    useSystemStore.getState().resizeWindow('finder', 720, 510);
    useSystemStore.getState().toggleMaximize('finder');
    expect(useSystemStore.getState().windows.finder?.isMaximized).toBe(true);

    useSystemStore.getState().toggleMaximize('finder');
    expect(useSystemStore.getState().windows.finder).toMatchObject({
      isMaximized: false,
      position: { x: 123, y: 87 },
      size: { width: 720, height: 510 },
    });
  });

  it('uses registry bounds for a newly launched app', () => {
    useSystemStore.getState().openApp('calculator');
    expect(useSystemStore.getState().windows.calculator?.size).toEqual(
      APP_REGISTRY.calculator.defaultSize,
    );
  });
});
