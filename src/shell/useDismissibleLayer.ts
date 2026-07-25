import type { RefObject } from 'react';
import { useEffect, useEffectEvent } from 'react';

interface UseDismissibleLayerOptions {
  open: boolean;
  onDismiss: () => void;
  refs: Array<RefObject<HTMLElement | null>>;
  restoreFocusRef?: RefObject<HTMLElement | null>;
}

export function useDismissibleLayer({ open, onDismiss, refs, restoreFocusRef }: UseDismissibleLayerOptions) {
  const onDismissEvent = useEffectEvent(onDismiss);
  const restoreFocusEvent = useEffectEvent(() => {
    window.requestAnimationFrame(() => {
      restoreFocusRef?.current?.focus();
    });
  });

  useEffect(() => {
    if (!open) {
      return;
    }

    const isInsideAnyRef = (target: EventTarget | null) =>
      refs.some((ref) => {
        const node = ref.current;
        return node instanceof HTMLElement && target instanceof Node && node.contains(target);
      });

    const handlePointerDown = (event: PointerEvent) => {
      if (!isInsideAnyRef(event.target)) {
        onDismissEvent();
        restoreFocusEvent();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onDismissEvent();
        restoreFocusEvent();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, refs, onDismissEvent, restoreFocusEvent]);
}
