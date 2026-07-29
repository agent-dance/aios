import {
  Calculator,
  Folder,
  Gamepad2,
  MessageCircle,
  Spade,
  Settings,
  ShoppingBag,
  SquareTerminal,
} from 'lucide-react';
import type { AppDefinition, AppId } from './types';

const SYSTEM_VERSION = '1.0.0';

export const APP_REGISTRY: Record<AppId, AppDefinition> = {
  finder: {
    id: 'finder', name: 'Finder', eyebrow: 'Navigate', icon: Folder, accent: '#79d7ff',
    defaultSize: { width: 1000, height: 620 }, defaultPosition: { x: 70, y: 72 }, version: SYSTEM_VERSION,
    defaultInstallation: 'preinstalled', protectedSystemApp: true,
  },
  calculator: {
    id: 'calculator', name: 'Calculator', eyebrow: 'Utility', icon: Calculator, accent: '#ffb14d',
    defaultSize: { width: 650, height: 680 }, defaultPosition: { x: 220, y: 76 }, version: SYSTEM_VERSION,
    defaultInstallation: 'preinstalled', protectedSystemApp: false,
  },
  settings: {
    id: 'settings', name: 'Settings', eyebrow: 'System', icon: Settings, accent: '#aab3c0',
    defaultSize: { width: 860, height: 650 }, defaultPosition: { x: 240, y: 78 }, version: SYSTEM_VERSION,
    defaultInstallation: 'preinstalled', protectedSystemApp: true,
  },
  terminal: {
    id: 'terminal', name: 'Terminal', eyebrow: 'Command', icon: SquareTerminal, accent: '#c9ff57',
    defaultSize: { width: 760, height: 480 }, defaultPosition: { x: 320, y: 118 }, version: SYSTEM_VERSION,
    defaultInstallation: 'preinstalled', protectedSystemApp: false,
  },
  store: {
    id: 'store', name: 'App Store', eyebrow: 'Discover', icon: ShoppingBag, accent: '#9a8cff',
    defaultSize: { width: 980, height: 680 }, defaultPosition: { x: 170, y: 68 }, version: SYSTEM_VERSION,
    defaultInstallation: 'preinstalled', protectedSystemApp: true,
  },
  'space-game': {
    id: 'space-game', name: 'Cosmic Vanguard', eyebrow: 'Arcade', icon: Gamepad2, accent: '#62ffbf',
    defaultSize: { width: 1040, height: 670 }, defaultPosition: { x: 150, y: 62 }, version: SYSTEM_VERSION,
    defaultInstallation: 'preinstalled', protectedSystemApp: false,
  },
  doudizhu: {
    id: 'doudizhu', name: '斗地主', eyebrow: 'AI Table', icon: Spade, accent: '#f2c66d',
    defaultSize: { width: 1120, height: 720 }, defaultPosition: { x: 130, y: 56 }, version: SYSTEM_VERSION,
    defaultInstallation: 'preinstalled', protectedSystemApp: false,
  },
  wechat: {
    id: 'wechat', name: '微信', eyebrow: 'Communication', icon: MessageCircle, accent: '#07c160',
    defaultSize: { width: 1080, height: 720 }, defaultPosition: { x: 140, y: 60 }, version: SYSTEM_VERSION,
    defaultInstallation: 'on-demand', protectedSystemApp: false,
  },
};

export const DOCK_APPS: AppId[] = ['finder', 'calculator', 'settings', 'terminal', 'store', 'space-game', 'wechat'];

export const APP_IDS = Object.freeze(Object.keys(APP_REGISTRY) as AppId[]);
export const PROTECTED_SYSTEM_APP_IDS = Object.freeze(
  APP_IDS.filter((appId) => APP_REGISTRY[appId].protectedSystemApp),
);
export const PREINSTALLED_APP_IDS = Object.freeze(
  APP_IDS.filter((appId) => APP_REGISTRY[appId].defaultInstallation === 'preinstalled'),
);

export function isAppId(value: unknown): value is AppId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(APP_REGISTRY, value);
}

export function isProtectedSystemApp(appId: AppId): boolean {
  return APP_REGISTRY[appId].protectedSystemApp;
}
