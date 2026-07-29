import { useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { AppDefinition } from '../system/types';
import type { DesktopIconDefinition, ShellSurfaceProps } from './shellTypes';

export interface DesktopIconProps extends ShellSurfaceProps {
  app: AppDefinition;
  icon?: DesktopIconDefinition;
  selected?: boolean;
  onSelect?: () => void;
  onOpen: () => void;
}

export function DesktopIcon({ app, icon, selected = false, onSelect, onOpen, className, style }: DesktopIconProps) {
  const Icon = app.icon;
  const [focused, setFocused] = useState(false);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen();
    }
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType !== 'mouse') {
      onOpen();
    }
  };

  return (
    <button
      type="button"
      aria-label={`Open ${app.name}`}
      data-app-id={app.id}
      data-desktop-icon="true"
      className={className}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onFocus={() => {
        setFocused(true);
        onSelect?.();
      }}
      onBlur={() => setFocused(false)}
      onKeyDown={handleKeyDown}
      onPointerUp={handlePointerUp}
      style={{
        width: 88,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        padding: '10px 8px',
        borderRadius: 20,
        border: selected ? '1px solid rgba(255,255,255,0.24)' : '1px solid transparent',
        background: selected ? 'rgba(255,255,255,0.14)' : 'transparent',
        color: '#f8fbff',
        cursor: 'pointer',
        outline: focused ? '2px solid rgba(255,255,255,0.66)' : 'none',
        outlineOffset: 2,
        backdropFilter: 'blur(12px)',
        boxShadow: selected ? '0 12px 30px rgba(3, 12, 24, 0.18)' : 'none',
        ...style,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 64,
          height: 64,
          display: 'grid',
          placeItems: 'center',
          borderRadius: 20,
          background: `linear-gradient(180deg, ${app.accent}ee, ${app.accent}77)`,
          boxShadow: `0 18px 34px ${app.accent}40`,
        }}
      >
        <Icon size={28} strokeWidth={2.1} />
      </span>
      <span style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>{icon?.label ?? app.name}</span>
      {icon?.description ? (
        <span style={{ fontSize: 11, opacity: 0.7, lineHeight: 1.3 }}>{icon.description}</span>
      ) : null}
    </button>
  );
}
