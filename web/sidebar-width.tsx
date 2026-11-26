import { useEffect, useRef, useState } from 'react';
import { menuLayoutKey } from './menu-layout';

const widthKey = 'pm-sidebar-width';
export const minSidebarWidth = 56;
const maxSidebarWidth = 232;

function constrainWidth(width: number) {
  return Math.max(minSidebarWidth, Math.min(maxSidebarWidth, Math.round(width)));
}

function readSidebarWidth(): number | null {
  try {
    if (localStorage.getItem(menuLayoutKey) === 'compact') return minSidebarWidth;
    const stored = localStorage.getItem(widthKey);
    if (stored === 'full') return maxSidebarWidth;
    if (stored !== null && /^\d+$/.test(stored) && Number.isSafeInteger(Number(stored))) {
      return constrainWidth(Number(stored));
    }
  } catch {}
  return null;
}

export function useSidebarWidth() {
  const [saved, setSaved] = useState(readSidebarWidth);
  const [preview, setPreview] = useState<number | null>(null);
  const [narrowWindow, setNarrowWindow] = useState(() => matchMedia('(max-width: 930px)').matches);

  useEffect(() => {
    const media = matchMedia('(max-width: 930px)');
    const update = () => setNarrowWindow(media.matches);
    media.addEventListener('change', update);
    try {
      if (localStorage.getItem(menuLayoutKey) === 'compact') {
        localStorage.setItem(widthKey, String(minSidebarWidth));
        localStorage.setItem(menuLayoutKey, 'left');
      }
    } catch {}
    return () => media.removeEventListener('change', update);
  }, []);

  const width = constrainWidth(preview ?? saved ?? (narrowWindow ? 156 : 218));

  function commit(next: number) {
    const value = constrainWidth(next);
    setSaved(value);
    try { localStorage.setItem(widthKey, String(value)); } catch {}
  }

  return { width, setPreview, commit };
}

export function SidebarResizeHandle({ width, setPreview, commit }: ReturnType<typeof useSidebarWidth>) {
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  const [resizing, setResizing] = useState(false);

  function stop(id: number) {
    if (drag.current?.id !== id) return;
    drag.current = null;
    setPreview(null);
    setResizing(false);
  }

  return (
    <div
      className="sidebar-resizer"
      role="separator"
      tabIndex={0}
      aria-label="Ширина меню"
      aria-orientation="vertical"
      aria-controls="workspace-sidebar"
      aria-valuemin={minSidebarWidth}
      aria-valuemax={maxSidebarWidth}
      aria-valuenow={width}
      title="Потяните, чтобы изменить ширину меню"
      data-resizing={resizing}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, x: event.clientX, width };
        setResizing(true);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start?.id === event.pointerId) setPreview(start.width + event.clientX - start.x);
      }}
      onPointerUp={(event) => {
        const start = drag.current;
        if (start?.id !== event.pointerId) return;
        const value = constrainWidth(start.width + event.clientX - start.x);
        if (value !== start.width) commit(value);
        stop(event.pointerId);
      }}
      onPointerCancel={(event) => stop(event.pointerId)}
      onLostPointerCapture={(event) => stop(event.pointerId)}
      onKeyDown={(event) => {
        const start = drag.current;
        if (start) {
          if (event.key === 'Escape') {
            event.preventDefault();
            stop(start.id);
            event.currentTarget.releasePointerCapture(start.id);
          }
          return;
        }

        const next = {
          ArrowLeft: width - 8,
          ArrowRight: width + 8,
          Home: minSidebarWidth,
          End: maxSidebarWidth,
        };
        if (!Object.hasOwn(next, event.key) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        event.preventDefault();
        commit(next[event.key as keyof typeof next]);
      }}
    />
  );
}
