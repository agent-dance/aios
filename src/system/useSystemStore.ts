import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { APP_REGISTRY } from './appRegistry';
import type { AppId, SystemPreferences, WindowState } from './types';

interface SystemStore {
  windows: Partial<Record<AppId, WindowState>>;
  activeAppId: AppId | null;
  topZ: number;
  controlCenterOpen: boolean;
  clockOpen: boolean;
  preferences: SystemPreferences;
  openApp: (id: AppId) => void;
  closeApp: (id: AppId) => void;
  minimizeApp: (id: AppId) => void;
  focusApp: (id: AppId) => void;
  toggleMaximize: (id: AppId) => void;
  moveWindow: (id: AppId, x: number, y: number) => void;
  resizeWindow: (id: AppId, width: number, height: number) => void;
  setControlCenterOpen: (open: boolean) => void;
  setClockOpen: (open: boolean) => void;
  updatePreferences: (patch: Partial<SystemPreferences>) => void;
}

const initialWindow = (id: AppId, zIndex: number): WindowState => {
  const app = APP_REGISTRY[id];
  return {
    appId: id,
    isOpen: true,
    isMinimized: false,
    isMaximized: false,
    zIndex,
    position: { ...app.defaultPosition },
    size: { ...app.defaultSize },
  };
};

export const useSystemStore = create<SystemStore>()(
  persist(
    (set, get) => ({
      windows: { finder: initialWindow('finder', 1) },
      activeAppId: 'finder',
      topZ: 1,
      controlCenterOpen: false,
      clockOpen: false,
      preferences: {
        theme: 'aurora',
        reduceMotion: false,
        soundEffects: true,
        dockMagnification: true,
        accent: 'lime',
      },
      openApp: (id) => {
        const state = get();
        const zIndex = state.topZ + 1;
        const existing = state.windows[id];
        set({
          topZ: zIndex,
          activeAppId: id,
          controlCenterOpen: false,
          clockOpen: false,
          windows: {
            ...state.windows,
            [id]: existing
              ? { ...existing, isOpen: true, isMinimized: false, zIndex }
              : initialWindow(id, zIndex),
          },
        });
      },
      closeApp: (id) => {
        const state = get();
        const win = state.windows[id];
        if (!win) return;
        set({ windows: { ...state.windows, [id]: { ...win, isOpen: false } }, activeAppId: null });
      },
      minimizeApp: (id) => {
        const state = get();
        const win = state.windows[id];
        if (!win) return;
        set({ windows: { ...state.windows, [id]: { ...win, isMinimized: true } }, activeAppId: null });
      },
      focusApp: (id) => {
        const state = get();
        const win = state.windows[id];
        if (!win) return;
        const zIndex = state.topZ + 1;
        set({
          topZ: zIndex,
          activeAppId: id,
          windows: { ...state.windows, [id]: { ...win, zIndex, isMinimized: false } },
        });
      },
      toggleMaximize: (id) => {
        const state = get();
        const win = state.windows[id];
        if (!win) return;
        const maximized = !win.isMaximized;
        set({
          windows: {
            ...state.windows,
            [id]: maximized
              ? { ...win, isMaximized: true, restore: { position: win.position, size: win.size } }
              : {
                  ...win,
                  isMaximized: false,
                  position: win.restore?.position ?? win.position,
                  size: win.restore?.size ?? win.size,
                  restore: undefined,
                },
          },
        });
      },
      moveWindow: (id, x, y) => {
        const state = get();
        const win = state.windows[id];
        if (!win || win.isMaximized) return;
        set({ windows: { ...state.windows, [id]: { ...win, position: { x, y } } } });
      },
      resizeWindow: (id, width, height) => {
        const state = get();
        const win = state.windows[id];
        if (!win || win.isMaximized) return;
        set({ windows: { ...state.windows, [id]: { ...win, size: { width, height } } } });
      },
      setControlCenterOpen: (open) => set({ controlCenterOpen: open, clockOpen: false }),
      setClockOpen: (open) => set({ clockOpen: open, controlCenterOpen: false }),
      updatePreferences: (patch) => set((state) => ({ preferences: { ...state.preferences, ...patch } })),
    }),
    {
      name: 'alsniper-os-preferences',
      partialize: (state) => ({ preferences: state.preferences }),
    },
  ),
);
