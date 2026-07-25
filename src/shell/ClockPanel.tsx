import { Focus, TimerReset } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ShellSurfaceProps, FocusSession } from './shellTypes';

export interface ClockPanelProps extends ShellSurfaceProps {
  open: boolean;
  now: Date;
  focus: FocusSession;
  onToggleFocus: () => void;
  onResetFocus: () => void;
}

export function ClockPanel({ open, now, focus, onToggleFocus, onResetFocus, className, style }: ClockPanelProps) {
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      panelRef.current?.focus();
    }
  }, [open]);

  if (!open) {
    return null;
  }

  const monthLabel = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(now);
  const timeLabel = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(now);
  const dayLabel = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(now);

  const elapsedMinutes = focus.startedAt ? Math.max(0, Math.floor((now.getTime() - focus.startedAt) / 60000)) : 0;
  const remaining = Math.max(0, focus.durationMinutes - elapsedMinutes);
  const focusProgress = focus.durationMinutes > 0 ? Math.min(100, Math.round((elapsedMinutes / focus.durationMinutes) * 100)) : 0;

  return (
    <section
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-label="Clock panel"
      tabIndex={-1}
      className={className}
      style={{
        width: 360,
        borderRadius: 28,
        padding: 18,
        color: '#f5fbff',
        background: 'rgba(7, 16, 28, 0.8)',
        border: '1px solid rgba(255,255,255,0.14)',
        boxShadow: '0 28px 60px rgba(4, 10, 20, 0.42)',
        backdropFilter: 'blur(28px)',
        ...style,
      }}
    >
      <div style={{ fontSize: 14, opacity: 0.72 }}>{dayLabel}</div>
      <div style={{ marginTop: 4, fontSize: 44, lineHeight: 1, fontWeight: 800 }}>{timeLabel}</div>

      <div
        style={{
          marginTop: 18,
          borderRadius: 22,
          padding: 16,
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700 }}>{monthLabel}</div>
        <CalendarGrid now={now} />
      </div>

      <div
        style={{
          marginTop: 14,
          borderRadius: 22,
          padding: 16,
          background: focus.active ? 'rgba(100, 220, 195, 0.18)' : 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Focus size={18} strokeWidth={2.1} />
            <div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{focus.label}</div>
              <div style={{ fontSize: 12, opacity: 0.72 }}>
                {focus.active ? `${remaining} min remaining` : `${focus.durationMinutes} minute session`}
              </div>
            </div>
          </div>
          <button
            type="button"
            aria-label="Reset focus session"
            onClick={onResetFocus}
            style={{
              width: 34,
              height: 34,
              display: 'grid',
              placeItems: 'center',
              borderRadius: 12,
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(255,255,255,0.06)',
              color: '#f5fbff',
              cursor: 'pointer',
            }}
          >
            <TimerReset size={16} strokeWidth={2.1} />
          </button>
        </div>

        <div
          aria-hidden="true"
          style={{
            marginTop: 12,
            height: 8,
            borderRadius: 999,
            background: 'rgba(255,255,255,0.1)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${focusProgress}%`,
              height: '100%',
              borderRadius: 999,
              background: 'linear-gradient(90deg, rgba(102,230,197,0.95), rgba(126,165,255,0.95))',
            }}
          />
        </div>

        <button
          type="button"
          onClick={onToggleFocus}
          style={{
            marginTop: 14,
            width: '100%',
            height: 44,
            borderRadius: 16,
            border: '1px solid rgba(255,255,255,0.14)',
            background: focus.active ? 'rgba(11, 18, 29, 0.44)' : 'rgba(104, 220, 198, 0.18)',
            color: '#f5fbff',
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          {focus.active ? 'Pause Focus' : 'Start Focus'}
        </button>
      </div>
    </section>
  );
}

function CalendarGrid({ now }: { now: Date }) {
  const year = now.getFullYear();
  const month = now.getMonth();
  const firstDay = new Date(year, month, 1);
  const startWeekDay = firstDay.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = Array.from({ length: 42 }, (_, index) => {
    const day = index - startWeekDay + 1;
    return day > 0 && day <= daysInMonth ? day : null;
  });

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6, fontSize: 11, opacity: 0.6 }}>
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => (
          <div key={`${day}-${index}`} style={{ textAlign: 'center' }}>
            {day}
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6, marginTop: 8 }}>
        {cells.map((day, index) => {
          const isToday = day === now.getDate();
          return (
            <div
              key={`${day ?? 'empty'}-${index}`}
              style={{
                height: 34,
                display: 'grid',
                placeItems: 'center',
                borderRadius: 12,
                fontSize: 12,
                background: isToday ? 'rgba(104, 220, 198, 0.22)' : 'rgba(255,255,255,0.03)',
                border: isToday ? '1px solid rgba(255,255,255,0.18)' : '1px solid transparent',
                opacity: day ? 1 : 0.24,
              }}
            >
              {day ?? ''}
            </div>
          );
        })}
      </div>
    </div>
  );
}
