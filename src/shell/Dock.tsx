import { useState } from 'react';
import type { AppDefinition, AppId } from '../system/types';
import type { ShellSurfaceProps } from './shellTypes';

export interface DockProps extends ShellSurfaceProps {
  apps: AppDefinition[];
  activeAppId: AppId | null;
  openAppIds: AppId[];
  magnification: boolean;
  onOpenApp: (id: AppId) => void;
}

export function Dock({ apps, activeAppId, openAppIds, magnification, onOpenApp, className, style }: DockProps) {
  const [hoveredAppId, setHoveredAppId] = useState<AppId | null>(null);

  return (
    <nav
      aria-label="Dock"
      className={className}
      style={{
        position: 'absolute',
        left: '50%',
        bottom: 18,
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'flex-end',
        gap: 12,
        maxWidth: 'calc(100% - 24px)',
        overflowX: 'auto',
        overflowY: 'hidden',
        padding: '14px 16px 12px',
        borderRadius: 28,
        background: 'rgba(8, 15, 26, 0.56)',
        border: '1px solid rgba(255,255,255,0.12)',
        boxShadow: '0 20px 48px rgba(2, 8, 18, 0.34)',
        backdropFilter: 'blur(28px)',
        zIndex: 110,
        ...style,
      }}
    >
      {apps.map((app) => {
        const Icon = app.icon;
        const isOpen = openAppIds.includes(app.id);
        const isActive = app.id === activeAppId;
        const isHovered = app.id === hoveredAppId;
        const scale = magnification ? (isHovered ? 1.16 : isActive ? 1.08 : 1) : 1;

        return (
          <button
            key={app.id}
            type="button"
            aria-label={`Open ${app.name}`}
            onClick={() => onOpenApp(app.id)}
            onMouseEnter={() => setHoveredAppId(app.id)}
            onMouseLeave={() => setHoveredAppId(null)}
            style={{
              display: 'grid',
              flexShrink: 0,
              gap: 8,
              justifyItems: 'center',
              padding: 0,
              background: 'transparent',
              border: 'none',
              color: '#f8fbff',
              cursor: 'pointer',
              transform: `scale(${scale})`,
              transformOrigin: 'center bottom',
              transition: 'transform 160ms ease',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 58,
                height: 58,
                display: 'grid',
                placeItems: 'center',
                borderRadius: 20,
                background: `linear-gradient(180deg, ${app.accent}ee, ${app.accent}77)`,
                boxShadow: isActive ? `0 18px 36px ${app.accent}55` : `0 12px 26px ${app.accent}38`,
                border: isActive ? '1px solid rgba(255,255,255,0.22)' : '1px solid rgba(255,255,255,0.08)',
              }}
            >
              <Icon size={24} strokeWidth={2.1} />
            </span>
            <span
              aria-hidden="true"
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: isOpen ? '#f7fbff' : 'transparent',
                boxShadow: isOpen ? '0 0 14px rgba(247,251,255,0.85)' : 'none',
              }}
            />
          </button>
        );
      })}
    </nav>
  );
}
