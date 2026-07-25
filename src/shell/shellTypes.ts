import type { CSSProperties, ReactNode, RefObject } from 'react';
import type { AppDefinition, AppId, WindowState } from '../system/types';

export interface ShellViewport {
  width: number;
  height: number;
  topInset: number;
  bottomInset: number;
}

export interface FocusSession {
  active: boolean;
  label: string;
  durationMinutes: number;
  startedAt: number | null;
}

export interface SystemStatusModel {
  wifiEnabled: boolean;
  wifiLabel: string;
  bluetoothEnabled: boolean;
  bluetoothLabel: string;
  healthScore: number;
  storageUsedGb: number;
  storageTotalGb: number;
  energyMode: 'Eco' | 'Balanced' | 'Performance';
  brightness: number;
  volume: number;
}

export interface AppContentRenderContext {
  appId: AppId;
  app: AppDefinition;
  window: WindowState;
  isActive: boolean;
  close: () => void;
  minimize: () => void;
  maximize: () => void;
  focus: () => void;
}

export type AppContentEntry = ReactNode | ((context: AppContentRenderContext) => ReactNode);
export type AppContentMap = Partial<Record<AppId, AppContentEntry>>;

export interface DesktopIconDefinition {
  appId: AppId;
  label?: string;
  description?: string;
  position?: { x: number; y: number };
}

export interface PopoverAnchorRefs {
  panelRef: RefObject<HTMLElement | null>;
  triggerRef: RefObject<HTMLElement | null>;
}

export interface ShellSurfaceProps {
  className?: string;
  style?: CSSProperties;
}
