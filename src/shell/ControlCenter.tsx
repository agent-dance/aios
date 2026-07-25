import { Gauge, HardDrive, MoonStar, MonitorCog, SunMedium, Volume2, VolumeX, Wifi, Bluetooth } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { SystemPreferences } from '../system/types';
import type { ShellSurfaceProps, SystemStatusModel } from './shellTypes';

export interface ControlCenterProps extends ShellSurfaceProps {
  open: boolean;
  preferences: SystemPreferences;
  status: SystemStatusModel;
  onStatusChange: (patch: Partial<SystemStatusModel>) => void;
  onPreferencesChange: (patch: Partial<SystemPreferences>) => void;
}

export function ControlCenter({
  open,
  preferences,
  status,
  onStatusChange,
  onPreferencesChange,
  className,
  style,
}: ControlCenterProps) {
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      panelRef.current?.focus();
    }
  }, [open]);

  if (!open) {
    return null;
  }

  const storageUsage = Math.min(100, Math.round((status.storageUsedGb / status.storageTotalGb) * 100));

  return (
    <section
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-label="Control Center"
      tabIndex={-1}
      className={className}
      style={{
        width: 360,
        borderRadius: 28,
        padding: 18,
        color: '#f5fbff',
        background: 'rgba(7, 16, 28, 0.78)',
        border: '1px solid rgba(255,255,255,0.14)',
        boxShadow: '0 28px 60px rgba(4, 10, 20, 0.42)',
        backdropFilter: 'blur(28px)',
        ...style,
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
        <ToggleCard
          icon={<Wifi size={18} strokeWidth={2.1} />}
          title="Wi-Fi"
          subtitle={status.wifiLabel}
          active={status.wifiEnabled}
          onClick={() => onStatusChange({ wifiEnabled: !status.wifiEnabled })}
        />
        <ToggleCard
          icon={<Bluetooth size={18} strokeWidth={2.1} />}
          title="Bluetooth"
          subtitle={status.bluetoothLabel}
          active={status.bluetoothEnabled}
          onClick={() => onStatusChange({ bluetoothEnabled: !status.bluetoothEnabled })}
        />
      </div>

      <div style={{ display: 'grid', gap: 12, marginTop: 14 }}>
        <MetricCard
          icon={<Gauge size={18} strokeWidth={2.1} />}
          title="System Health"
          value={`${status.healthScore}%`}
          caption={status.healthScore >= 90 ? 'Nominal' : 'Check workload'}
        />
        <MetricCard
          icon={<HardDrive size={18} strokeWidth={2.1} />}
          title="Storage"
          value={`${status.storageUsedGb} GB / ${status.storageTotalGb} GB`}
          caption={`${storageUsage}% utilized`}
          progress={storageUsage}
        />
        <MetricCard
          icon={<MoonStar size={18} strokeWidth={2.1} />}
          title="Energy"
          value={status.energyMode}
          caption={status.energyMode === 'Performance' ? 'Peak throughput' : status.energyMode === 'Eco' ? 'Longest runtime' : 'Balanced draw'}
        />
      </div>

      <div style={{ display: 'grid', gap: 12, marginTop: 14 }}>
        <SliderCard
          icon={<SunMedium size={18} strokeWidth={2.1} />}
          title="Brightness"
          value={status.brightness}
          onChange={(value) => onStatusChange({ brightness: value })}
        />
        <SliderCard
          icon={status.volume > 0 ? <Volume2 size={18} strokeWidth={2.1} /> : <VolumeX size={18} strokeWidth={2.1} />}
          title="Volume"
          value={status.volume}
          onChange={(value) => onStatusChange({ volume: value })}
        />
      </div>

      <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
        <InlineToggle
          icon={<MonitorCog size={16} strokeWidth={2.1} />}
          label="Reduce motion"
          checked={preferences.reduceMotion}
          onChange={(checked) => onPreferencesChange({ reduceMotion: checked })}
        />
        <InlineToggle
          icon={<Volume2 size={16} strokeWidth={2.1} />}
          label="Sound effects"
          checked={preferences.soundEffects}
          onChange={(checked) => onPreferencesChange({ soundEffects: checked })}
        />
      </div>
    </section>
  );
}

interface ToggleCardProps {
  icon: ReactNode;
  title: string;
  subtitle: string;
  active: boolean;
  onClick: () => void;
}

function ToggleCard({ icon, title, subtitle, active, onClick }: ToggleCardProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      style={{
        minHeight: 100,
        borderRadius: 22,
        border: `1px solid ${active ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.08)'}`,
        background: active ? 'rgba(104, 220, 198, 0.22)' : 'rgba(255,255,255,0.06)',
        color: '#f5fbff',
        padding: 14,
        textAlign: 'left',
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span>{icon}</span>
        <span
          aria-hidden="true"
          style={{
            width: 34,
            height: 20,
            borderRadius: 999,
            background: active ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.2)',
            display: 'inline-flex',
            alignItems: 'center',
            padding: 2,
            justifyContent: active ? 'flex-end' : 'flex-start',
          }}
        >
          <span style={{ width: 16, height: 16, borderRadius: '50%', background: active ? '#0f1723' : '#ffffff' }} />
        </span>
      </div>
      <div style={{ marginTop: 12, fontSize: 15, fontWeight: 700 }}>{title}</div>
      <div style={{ marginTop: 4, fontSize: 12, opacity: 0.72 }}>{subtitle}</div>
    </button>
  );
}

interface MetricCardProps {
  icon: ReactNode;
  title: string;
  value: string;
  caption: string;
  progress?: number;
}

function MetricCard({ icon, title, value, caption, progress }: MetricCardProps) {
  return (
    <div
      style={{
        borderRadius: 22,
        padding: 14,
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span>{icon}</span>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
      </div>
      <div style={{ marginTop: 10, fontSize: 20, fontWeight: 700 }}>{value}</div>
      <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7 }}>{caption}</div>
      {typeof progress === 'number' ? (
        <div
          aria-hidden="true"
          style={{
            marginTop: 10,
            height: 8,
            borderRadius: 999,
            background: 'rgba(255,255,255,0.08)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${progress}%`,
              height: '100%',
              borderRadius: 999,
              background: 'linear-gradient(90deg, rgba(102,230,197,0.95), rgba(126,165,255,0.95))',
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

interface SliderCardProps {
  icon: ReactNode;
  title: string;
  value: number;
  onChange: (value: number) => void;
}

function SliderCard({ icon, title, value, onChange }: SliderCardProps) {
  return (
    <label
      style={{
        borderRadius: 22,
        padding: 14,
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.08)',
        display: 'grid',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>{icon}</span>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
        </div>
        <span style={{ fontSize: 12, opacity: 0.74 }}>{value}%</span>
      </div>
      <input
        aria-label={title}
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

interface InlineToggleProps {
  icon: ReactNode;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

function InlineToggle({ icon, label, checked, onChange }: InlineToggleProps) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 14,
        borderRadius: 18,
        padding: '12px 14px',
        background: 'rgba(255,255,255,0.05)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span>{icon}</span>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}
