import type { ComponentType } from 'react';

export type AppId = 'finder' | 'calculator' | 'settings' | 'terminal' | 'store' | 'space-game' | 'doudizhu';
export type Theme = 'aurora' | 'midnight';

export interface AppDefinition {
  id: AppId;
  name: string;
  eyebrow: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  accent: string;
  defaultSize: { width: number; height: number };
  defaultPosition: { x: number; y: number };
}
export interface WindowState {
  appId: AppId;
  isOpen: boolean;
  isMinimized: boolean;
  isMaximized: boolean;
  zIndex: number;
  position: { x: number; y: number };
  size: { width: number; height: number };
  restore?: {
    position: { x: number; y: number };
    size: { width: number; height: number };
  };
}

export interface SystemPreferences {
  theme: Theme;
  reduceMotion: boolean;
  soundEffects: boolean;
  dockMagnification: boolean;
  accent: 'lime' | 'cyan' | 'amber';
}
