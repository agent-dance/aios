import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AppDefinition, WindowState } from '../system/types';
import { AppWindow } from './AppWindow';

const app: AppDefinition = {
  id: 'finder',
  name: 'Finder',
  eyebrow: 'Files',
  icon: () => null,
  accent: '#70d6ff',
  defaultSize: { width: 720, height: 520 },
  defaultPosition: { x: 80, y: 90 },
  version: '1.0.0',
  defaultInstallation: 'preinstalled',
  protectedSystemApp: true,
};

const baseWindow: WindowState = {
  appId: 'finder',
  isOpen: true,
  isMinimized: false,
  isMaximized: false,
  zIndex: 1,
  position: { x: 80, y: 90 },
  size: { width: 720, height: 520 },
};

function renderWindow(window: WindowState) {
  return renderToStaticMarkup(
    <AppWindow
      app={app}
      window={window}
      active
      viewport={{ width: 1280, height: 800, topInset: 68, bottomInset: 126 }}
      onFocus={vi.fn()}
      onClose={vi.fn()}
      onMinimize={vi.fn()}
      onToggleMaximize={vi.fn()}
      onMove={vi.fn()}
      onResize={vi.fn()}
    />,
  );
}

describe('AppWindow accessibility contract', () => {
  it('exposes pointer and keyboard resizing while restored', () => {
    const markup = renderWindow(baseWindow);

    expect(markup).toContain('aria-label="Resize Finder"');
    expect(markup).toContain('aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"');
    expect(markup).toContain('aria-label="Maximize Finder"');
    expect(markup).not.toContain('aria-pressed');
  });

  it('announces the restore action and removes the resize control while maximized', () => {
    const markup = renderWindow({ ...baseWindow, isMaximized: true });

    expect(markup).toContain('aria-label="Restore Finder"');
    expect(markup).not.toContain('aria-pressed');
    expect(markup).not.toContain('aria-label="Resize Finder"');
  });
});
