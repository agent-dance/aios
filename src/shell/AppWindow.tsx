import { Minus, Square, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { AppDefinition, WindowState } from '../system/types';
import type { ShellSurfaceProps, ShellViewport } from './shellTypes';

export interface AppWindowProps extends ShellSurfaceProps {
  app: AppDefinition;
  window: WindowState;
  active: boolean;
  viewport: ShellViewport;
  onFocus: () => void;
  onClose: () => void;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onMove: (x: number, y: number) => void;
  onResize: (width: number, height: number) => void;
  children?: ReactNode;
}

type InteractionSession =
  | {
      mode: 'drag';
      pointerId: number;
      originX: number;
      originY: number;
      startX: number;
      startY: number;
      lastClientX: number;
      lastClientY: number;
      originalTransform: string;
      originalWillChange: string;
      previewTransform: string;
    }
  | {
      mode: 'resize';
      pointerId: number;
      originX: number;
      originY: number;
      startWidth: number;
      startHeight: number;
      lastClientX: number;
      lastClientY: number;
      originalTransform: string;
      originalWillChange: string;
      previewTransform: string;
    };

type InteractionMode = 'idle' | InteractionSession['mode'];

interface WindowRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

type PendingUpdate =
  | { mode: 'drag'; rect: WindowRect; baseRect: WindowRect; x: number; y: number }
  | { mode: 'resize'; rect: WindowRect; width: number; height: number };

const MIN_WIDTH = 320;
const MIN_HEIGHT = 240;
const WINDOW_GAP = 8;

export function AppWindow({
  app,
  window,
  active,
  viewport,
  onFocus,
  onClose,
  onMinimize,
  onToggleMaximize,
  onMove,
  onResize,
  children,
  className,
  style,
}: AppWindowProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const interactionRef = useRef<InteractionSession | null>(null);
  const latestUpdateRef = useRef<PendingUpdate | null>(null);
  const previewFrameRef = useRef<number | null>(null);
  const finishedInteractionRef = useRef<InteractionSession | null>(null);
  const [interactionMode, setInteractionMode] = useState<InteractionMode>('idle');

  const maximizedRect = useMemo(
    () => ({
      left: WINDOW_GAP,
      top: viewport.topInset,
      width: Math.max(MIN_WIDTH, viewport.width - WINDOW_GAP * 2),
      height: Math.max(MIN_HEIGHT, viewport.height - viewport.topInset - viewport.bottomInset - WINDOW_GAP),
    }),
    [viewport],
  );

  const frameRect = window.isMaximized
    ? maximizedRect
    : getWindowRect(window.position.x, window.position.y, window.size.width, window.size.height, viewport);

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const session = interactionRef.current;
    if (!session || event.pointerId !== session.pointerId) {
      return;
    }

    session.lastClientX = event.clientX;
    session.lastClientY = event.clientY;
    latestUpdateRef.current = calculateInteractionUpdate(session, event.clientX, event.clientY, window, viewport);
    if (previewFrameRef.current === null) {
      previewFrameRef.current = requestAnimationFrame(() => {
        previewFrameRef.current = null;
        const activeSession = interactionRef.current;
        const update = latestUpdateRef.current;
        const frame = frameRef.current;
        if (frame && activeSession && update) {
          applyPreviewToFrame(frame, activeSession, update);
        }
      });
    }
  };

  const finishInteraction = (event: ReactPointerEvent<HTMLElement>) => {
    const session = interactionRef.current;
    if (!session || event.pointerId !== session.pointerId) {
      return;
    }

    if (event.clientX === session.originX && event.clientY === session.originY) {
      cancelInteraction(event.pointerId);
      return;
    }

    const update = calculateInteractionUpdate(session, event.clientX, event.clientY, window, viewport);
    latestUpdateRef.current = update;

    if (previewFrameRef.current !== null) {
      cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }

    const frame = frameRef.current;
    if (frame) {
      applyPreviewToFrame(frame, session, update);
    }

    interactionRef.current = null;
    latestUpdateRef.current = null;
    finishedInteractionRef.current = session;

    if (update?.mode === 'drag' && (update.x !== window.position.x || update.y !== window.position.y)) {
      onMove(update.x, update.y);
    } else if (
      update?.mode === 'resize' &&
      (update.width !== window.size.width || update.height !== window.size.height)
    ) {
      onResize(update.width, update.height);
    }

    setInteractionMode('idle');
  };

  const cancelInteraction = (pointerId?: number) => {
    const session = interactionRef.current;
    if (!session || (pointerId !== undefined && pointerId !== session.pointerId)) {
      return;
    }

    if (previewFrameRef.current !== null) {
      cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }

    interactionRef.current = null;
    latestUpdateRef.current = null;
    finishedInteractionRef.current = session;
    const frame = frameRef.current;
    if (frame?.hasPointerCapture(session.pointerId)) {
      frame.releasePointerCapture(session.pointerId);
    }
    setInteractionMode('idle');
  };

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) {
      return;
    }

    const session = interactionRef.current;
    if (session && window.isMaximized) {
      if (previewFrameRef.current !== null) {
        cancelAnimationFrame(previewFrameRef.current);
        previewFrameRef.current = null;
      }
      interactionRef.current = null;
      latestUpdateRef.current = null;
      applyFinalStyleValue(frame, 'transform', style, session.originalTransform);
      applyFinalStyleValue(frame, 'willChange', style, session.originalWillChange);
      if (session.mode === 'resize') {
        applyFinalLength(frame, 'left', style, frameRect.left);
        applyFinalLength(frame, 'top', style, frameRect.top);
        applyFinalLength(frame, 'width', style, frameRect.width);
        applyFinalLength(frame, 'height', style, frameRect.height);
      }
      if (frame.hasPointerCapture(session.pointerId)) {
        frame.releasePointerCapture(session.pointerId);
      }
      setInteractionMode('idle');
      return;
    }

    if (session) {
      session.previewTransform = resolveStyleValue(style, 'transform', session.previewTransform);
      const update = calculateInteractionUpdate(
        session,
        session.lastClientX,
        session.lastClientY,
        window,
        viewport,
      );
      latestUpdateRef.current = update;
      applyPreviewToFrame(frame, session, update);
      return;
    }

    const finishedSession = finishedInteractionRef.current;
    if (!finishedSession) {
      return;
    }

    applyFinalStyleValue(frame, 'transform', style, finishedSession.originalTransform);
    applyFinalStyleValue(frame, 'willChange', style, finishedSession.originalWillChange);
    if (finishedSession.mode === 'resize') {
      applyFinalLength(frame, 'left', style, frameRect.left);
      applyFinalLength(frame, 'top', style, frameRect.top);
      applyFinalLength(frame, 'width', style, frameRect.width);
      applyFinalLength(frame, 'height', style, frameRect.height);
    }
    finishedInteractionRef.current = null;
  });

  useEffect(
    () => () => {
      if (previewFrameRef.current !== null) {
        cancelAnimationFrame(previewFrameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (active) {
      frameRef.current?.focus();
    }
  }, [active]);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (window.isMaximized || interactionRef.current || !event.isPrimary || event.button !== 0) {
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest('button')) {
      return;
    }

    event.preventDefault();
    const frame = frameRef.current;
    const session: InteractionSession = {
      mode: 'drag',
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      startX: frameRect.left,
      startY: frameRect.top,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      originalTransform: frame?.style.transform ?? '',
      originalWillChange: frame?.style.willChange ?? '',
      previewTransform: frame ? getPreviewTransform(frame, style, frame.style.transform) : '',
    };
    if (!frame) {
      return;
    }
    try {
      frame.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
    interactionRef.current = session;
    latestUpdateRef.current = null;
    setInteractionMode('drag');
  };

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (interactionRef.current || !event.isPrimary || event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (window.isMaximized) {
      return;
    }
    onFocus();
    const frame = frameRef.current;
    const session: InteractionSession = {
      mode: 'resize',
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      startWidth: frameRect.width,
      startHeight: frameRect.height,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      originalTransform: frame?.style.transform ?? '',
      originalWillChange: frame?.style.willChange ?? '',
      previewTransform: frame ? getPreviewTransform(frame, style, frame.style.transform) : '',
    };
    if (!frame) {
      return;
    }
    try {
      frame.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
    interactionRef.current = session;
    latestUpdateRef.current = null;
    setInteractionMode('resize');
  };

  return (
    <section
      ref={frameRef}
      role="dialog"
      aria-label={app.name}
      aria-modal="false"
      tabIndex={-1}
      className={className}
      onPointerDown={onFocus}
      onPointerMove={handlePointerMove}
      onPointerUp={finishInteraction}
      onPointerCancel={(event) => cancelInteraction(event.pointerId)}
      onLostPointerCapture={(event) => cancelInteraction(event.pointerId)}
      style={{
        position: 'absolute',
        left: frameRect.left,
        top: frameRect.top,
        width: frameRect.width,
        height: frameRect.height,
        display: 'grid',
        gridTemplateRows: '56px minmax(0, 1fr)',
        borderRadius: window.isMaximized ? 24 : 28,
        overflow: 'hidden',
        background: 'rgba(8, 14, 24, 0.74)',
        border: active ? '1px solid rgba(255,255,255,0.16)' : '1px solid rgba(255,255,255,0.08)',
        boxShadow: active ? '0 34px 76px rgba(0,0,0,0.34)' : '0 22px 48px rgba(0,0,0,0.22)',
        // The game canvas is opaque, so blurring everything behind it only
        // adds an off-screen compositing pass. Interactive windows also drop
        // blur temporarily to keep drag/resize inside the frame budget.
        backdropFilter: app.id === 'space-game' || interactionMode !== 'idle' ? 'none' : 'blur(22px)',
        zIndex: window.zIndex,
        pointerEvents: 'auto',
        ...style,
      }}
    >
      <div
        onPointerDown={startDrag}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          padding: '0 18px',
          background: 'linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02))',
          cursor: window.isMaximized ? 'default' : interactionMode === 'drag' ? 'grabbing' : 'grab',
          userSelect: 'none',
          touchAction: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <WindowChromeButton tone="#ff5f57" label={`Close ${app.name}`} onClick={onClose}>
            <X size={11} strokeWidth={2.5} />
          </WindowChromeButton>
          <WindowChromeButton tone="#febc2e" label={`Minimize ${app.name}`} onClick={onMinimize}>
            <Minus size={11} strokeWidth={2.5} />
          </WindowChromeButton>
          <WindowChromeButton tone="#28c840" label={`Maximize ${app.name}`} onClick={onToggleMaximize}>
            <Square size={10} strokeWidth={2.4} />
          </WindowChromeButton>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <div
            aria-hidden="true"
            style={{
              width: 32,
              height: 32,
              display: 'grid',
              placeItems: 'center',
              borderRadius: 12,
              background: `linear-gradient(180deg, ${app.accent}ee, ${app.accent}77)`,
            }}
          >
            <app.icon size={16} strokeWidth={2.1} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: '#f8fbff', fontSize: 14, fontWeight: 700 }}>{app.name}</div>
            <div style={{ color: 'rgba(248,251,255,0.66)', fontSize: 11 }}>{app.eyebrow}</div>
          </div>
        </div>

        <div style={{ width: 72 }} />
      </div>

      <div
        className="app-window-content"
        style={{ position: 'relative', minHeight: 0, containerType: 'inline-size', background: 'rgba(4, 10, 18, 0.32)' }}
      >
        {children}
      </div>

      {!window.isMaximized ? (
        <button
          type="button"
          aria-label={`Resize ${app.name}`}
          onPointerDown={startResize}
          style={{
            position: 'absolute',
            right: 10,
            bottom: 10,
            width: 20,
            height: 20,
            cursor: 'nwse-resize',
            border: 'none',
            background: 'transparent',
            touchAction: 'none',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              right: 0,
              bottom: 0,
              width: 14,
              height: 14,
              borderRight: '2px solid rgba(255,255,255,0.36)',
              borderBottom: '2px solid rgba(255,255,255,0.36)',
              borderRadius: 2,
            }}
          />
        </button>
      ) : null}
    </section>
  );
}

interface WindowChromeButtonProps {
  tone: string;
  label: string;
  onClick: () => void;
  children: ReactNode;
}

function WindowChromeButton({ tone, label, onClick, children }: WindowChromeButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      style={{
        width: 14,
        height: 14,
        display: 'grid',
        placeItems: 'center',
        padding: 0,
        borderRadius: '50%',
        border: 'none',
        background: tone,
        color: 'rgba(0,0,0,0.72)',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getWindowRect(
  x: number,
  y: number,
  width: number,
  height: number,
  viewport: ShellViewport,
): WindowRect {
  const availableWidth = Math.max(MIN_WIDTH, viewport.width - WINDOW_GAP * 2);
  const availableHeight = Math.max(
    MIN_HEIGHT,
    viewport.height - viewport.topInset - viewport.bottomInset - WINDOW_GAP,
  );
  const responsiveWidth = Math.min(width, availableWidth);
  const responsiveHeight = Math.min(height, availableHeight);

  return {
    left: clamp(x, WINDOW_GAP, Math.max(WINDOW_GAP, viewport.width - responsiveWidth - WINDOW_GAP)),
    top: clamp(
      y,
      viewport.topInset,
      Math.max(viewport.topInset, viewport.height - viewport.bottomInset - responsiveHeight - WINDOW_GAP),
    ),
    width: responsiveWidth,
    height: responsiveHeight,
  };
}

function calculateInteractionUpdate(
  session: InteractionSession,
  clientX: number,
  clientY: number,
  windowState: WindowState,
  viewport: ShellViewport,
): PendingUpdate {
  if (session.mode === 'drag') {
    const nextX = clamp(
      session.startX + clientX - session.originX,
      WINDOW_GAP,
      Math.max(WINDOW_GAP, viewport.width - windowState.size.width - WINDOW_GAP),
    );
    const nextY = clamp(
      session.startY + clientY - session.originY,
      viewport.topInset,
      Math.max(viewport.topInset, viewport.height - viewport.bottomInset - 72),
    );
    const baseRect = getWindowRect(
      windowState.position.x,
      windowState.position.y,
      windowState.size.width,
      windowState.size.height,
      viewport,
    );
    const rect = getWindowRect(nextX, nextY, windowState.size.width, windowState.size.height, viewport);
    return {
      mode: 'drag',
      baseRect,
      rect,
      x: rect.left,
      y: rect.top,
    };
  }

  const baseRect = getWindowRect(
    windowState.position.x,
    windowState.position.y,
    windowState.size.width,
    windowState.size.height,
    viewport,
  );
  const maxWidth = Math.max(MIN_WIDTH, viewport.width - baseRect.left - WINDOW_GAP);
  const maxHeight = Math.max(
    MIN_HEIGHT,
    viewport.height - viewport.bottomInset - baseRect.top - WINDOW_GAP,
  );
  const nextWidth = clamp(session.startWidth + clientX - session.originX, MIN_WIDTH, maxWidth);
  const nextHeight = clamp(session.startHeight + clientY - session.originY, MIN_HEIGHT, maxHeight);
  return {
    mode: 'resize',
    rect: getWindowRect(baseRect.left, baseRect.top, nextWidth, nextHeight, viewport),
    width: nextWidth,
    height: nextHeight,
  };
}

function applyPreviewToFrame(
  frame: HTMLDivElement,
  session: InteractionSession,
  update: PendingUpdate,
) {
  if (session.mode !== update.mode) {
    return;
  }

  frame.style.willChange = session.mode === 'drag' ? 'transform' : 'left, top, width, height';
  if (session.mode === 'drag' && update.mode === 'drag') {
    const deltaX = update.rect.left - update.baseRect.left;
    const deltaY = update.rect.top - update.baseRect.top;
    const translation = `translate3d(${deltaX}px, ${deltaY}px, 0)`;
    frame.style.transform = session.previewTransform
      ? `${translation} ${session.previewTransform}`
      : translation;
    return;
  }

  frame.style.left = `${update.rect.left}px`;
  frame.style.top = `${update.rect.top}px`;
  frame.style.width = `${update.rect.width}px`;
  frame.style.height = `${update.rect.height}px`;
}

type BoundsProperty = 'left' | 'top' | 'width' | 'height';
type TransientStyleProperty = 'transform' | 'willChange';

function getPreviewTransform(
  frame: HTMLDivElement,
  style: ShellSurfaceProps['style'],
  fallback: string,
) {
  if (hasOwnStyleValue(style, 'transform')) {
    return resolveStyleValue(style, 'transform', fallback);
  }
  const computedTransform = getComputedStyle(frame).transform;
  return computedTransform === 'none' ? fallback : computedTransform;
}

function applyFinalStyleValue(
  frame: HTMLDivElement,
  property: TransientStyleProperty,
  style: ShellSurfaceProps['style'],
  fallback: string,
) {
  frame.style[property] = resolveStyleValue(style, property, fallback);
}

function resolveStyleValue(
  style: ShellSurfaceProps['style'],
  property: TransientStyleProperty,
  fallback: string,
) {
  if (!hasOwnStyleValue(style, property)) {
    return fallback;
  }
  const value = style?.[property];
  return value === null || value === undefined || typeof value === 'boolean' ? '' : String(value);
}

function hasOwnStyleValue(style: ShellSurfaceProps['style'], property: string): boolean {
  return Boolean(style && Object.prototype.hasOwnProperty.call(style, property));
}

function applyFinalLength(
  frame: HTMLDivElement,
  property: BoundsProperty,
  style: ShellSurfaceProps['style'],
  fallback: number,
) {
  const hasOverride = hasOwnStyleValue(style, property);
  const value = hasOverride ? style?.[property] : fallback;
  if (value === null || value === undefined || typeof value === 'boolean') {
    frame.style.removeProperty(property);
  } else {
    frame.style.setProperty(property, typeof value === 'number' ? `${value}px` : String(value));
  }
}
