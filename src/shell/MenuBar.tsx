import { Activity, Bluetooth, Clock3, Sparkles, Wifi } from 'lucide-react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import type { AppId } from '../system/types';
import type { ShellSurfaceProps, SystemStatusModel } from './shellTypes';

export interface MenuBarProps extends ShellSurfaceProps {
  brand?: ReactNode;
  activeAppId: AppId | null;
  activeAppName?: string;
  now: Date;
  status: SystemStatusModel;
  controlCenterOpen: boolean;
  clockOpen: boolean;
  onToggleControlCenter: () => void;
  onToggleClock: () => void;
  controlCenterButtonRef: RefObject<HTMLButtonElement | null>;
  clockButtonRef: RefObject<HTMLButtonElement | null>;
}

export function MenuBar({
  brand = 'AlSniper OS',
  activeAppId,
  activeAppName,
  now,
  status,
  controlCenterOpen,
  clockOpen,
  onToggleControlCenter,
  onToggleClock,
  controlCenterButtonRef,
  clockButtonRef,
  className,
  style,
}: MenuBarProps) {
  const dateLabel = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(now);

  return (
    <header
      className={className}
      style={{
        position: 'absolute',
        inset: '12px 12px auto',
        height: 44,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '0 16px',
        borderRadius: 18,
        background: 'rgba(5, 13, 24, 0.48)',
        border: '1px solid rgba(255,255,255,0.12)',
        color: '#f7fbff',
        backdropFilter: 'blur(24px)',
        boxShadow: '0 20px 50px rgba(2, 8, 18, 0.28)',
        zIndex: 120,
        ...style,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontWeight: 700 }}>
          <Sparkles size={15} strokeWidth={2.2} />
          <span>{brand}</span>
        </div>
        <span
          aria-hidden="true"
          style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.18)', flexShrink: 0 }}
        />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {activeAppName ?? 'Desktop'}
          </div>
          <div style={{ fontSize: 11, opacity: 0.72 }}>{activeAppId ? `Active: ${activeAppId}` : 'Ready'}</div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div aria-label={`Wi-Fi ${status.wifiEnabled ? 'connected' : 'disabled'}`} style={{ display: 'flex', alignItems: 'center' }}>
          <Wifi size={16} strokeWidth={2.2} opacity={status.wifiEnabled ? 1 : 0.45} />
        </div>
        <div
          aria-label={`Bluetooth ${status.bluetoothEnabled ? 'enabled' : 'disabled'}`}
          style={{ display: 'flex', alignItems: 'center' }}
        >
          <Bluetooth size={16} strokeWidth={2.2} opacity={status.bluetoothEnabled ? 1 : 0.45} />
        </div>
        <button
          ref={controlCenterButtonRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={controlCenterOpen}
          aria-label="Toggle Control Center"
          onClick={onToggleControlCenter}
          style={menuButtonStyle(controlCenterOpen)}
        >
          <Activity size={16} strokeWidth={2.2} />
        </button>
        <button
          ref={clockButtonRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={clockOpen}
          aria-label="Toggle clock panel"
          onClick={onToggleClock}
          style={menuButtonStyle(clockOpen)}
        >
          <Clock3 size={16} strokeWidth={2.2} />
          <span className="menu-clock-label" style={{ fontSize: 13, fontWeight: 600 }}>{dateLabel}</span>
        </button>
      </div>
    </header>
  );
}

const menuButtonStyle = (active: boolean) =>
  ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    height: 32,
    borderRadius: 14,
    border: active ? '1px solid rgba(255,255,255,0.22)' : '1px solid transparent',
    background: active ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.06)',
    color: '#f7fbff',
    cursor: 'pointer',
    padding: '0 10px',
  }) satisfies CSSProperties;
