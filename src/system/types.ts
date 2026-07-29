import type { ComponentType } from 'react';

export type AppId = 'finder' | 'calculator' | 'settings' | 'terminal' | 'store' | 'space-game' | 'doudizhu' | 'wechat';
export type Theme = 'aurora' | 'midnight';
export type EnergyMode = 'Eco' | 'Balanced' | 'Performance';
export type DefaultAppInstallation = 'preinstalled' | 'on-demand';

export interface AppDefinition {
  id: AppId;
  name: string;
  eyebrow: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  accent: string;
  defaultSize: { width: number; height: number };
  defaultPosition: { x: number; y: number };
  version: string;
  defaultInstallation: DefaultAppInstallation;
  protectedSystemApp: boolean;
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

export interface AppInstallation {
  appId: AppId;
  version: string;
  enabled: boolean;
}

export type AppInstallationOperation = 'install' | 'enable' | 'disable' | 'uninstall';
export type AppInstallationResultCode =
  | 'installed'
  | 'already-installed'
  | 'enabled'
  | 'already-enabled'
  | 'disabled'
  | 'already-disabled'
  | 'uninstalled'
  | 'not-installed'
  | 'protected-system-app'
  | 'unknown-app';

export interface AppInstallationResult {
  operation: AppInstallationOperation;
  appId: string;
  ok: boolean;
  changed: boolean;
  code: AppInstallationResultCode;
  revision: number;
  installation: AppInstallation | null;
}

export interface SystemStatusModel {
  wifiEnabled: boolean;
  wifiLabel: string;
  bluetoothEnabled: boolean;
  bluetoothLabel: string;
  healthScore: number;
  storageUsedGb: number;
  storageTotalGb: number;
  energyMode: EnergyMode;
  brightness: number;
  volume: number;
}

export interface SystemStatusUpdateResult {
  ok: boolean;
  changed: boolean;
  code: 'updated' | 'unchanged' | 'invalid-patch';
  revision: number;
  status: SystemStatusModel;
}
