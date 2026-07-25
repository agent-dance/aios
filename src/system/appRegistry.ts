import {
  Calculator,
  Folder,
  Gamepad2,
  Settings,
  ShoppingBag,
  SquareTerminal,
} from 'lucide-react';
import type { AppDefinition, AppId } from './types';

export const APP_REGISTRY: Record<AppId, AppDefinition> = {
  finder: {
    id: 'finder', name: 'Finder', eyebrow: 'Navigate', icon: Folder, accent: '#79d7ff',
    defaultSize: { width: 1000, height: 620 }, defaultPosition: { x: 70, y: 72 },
  },
  calculator: {
    id: 'calculator', name: 'Calculator', eyebrow: 'Utility', icon: Calculator, accent: '#ffb14d',
    defaultSize: { width: 650, height: 680 }, defaultPosition: { x: 220, y: 76 },
  },
  settings: {
    id: 'settings', name: 'Settings', eyebrow: 'System', icon: Settings, accent: '#aab3c0',
    defaultSize: { width: 860, height: 650 }, defaultPosition: { x: 240, y: 78 },
  },
  terminal: {
    id: 'terminal', name: 'Terminal', eyebrow: 'Command', icon: SquareTerminal, accent: '#c9ff57',
    defaultSize: { width: 760, height: 480 }, defaultPosition: { x: 320, y: 118 },
  },
  store: {
    id: 'store', name: 'App Store', eyebrow: 'Discover', icon: ShoppingBag, accent: '#9a8cff',
    defaultSize: { width: 980, height: 680 }, defaultPosition: { x: 170, y: 68 },
  },
  'space-game': {
    id: 'space-game', name: 'Cosmic Vanguard', eyebrow: 'Arcade', icon: Gamepad2, accent: '#62ffbf',
    defaultSize: { width: 1040, height: 670 }, defaultPosition: { x: 150, y: 62 },
  },
};

export const DOCK_APPS: AppId[] = ['finder', 'calculator', 'settings', 'terminal', 'store', 'space-game'];
