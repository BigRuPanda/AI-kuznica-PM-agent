import { useCallback, useEffect, useRef, useState } from 'react';

export function usePanelSpace() {
  const [available, setAvailable] = useState(0);
  const observe = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { available, observe };
}

export function useViewportHeight() {
  const [height, setHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    const measure = () => setHeight(window.innerHeight);
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  return height;
}

export function usePanelSize(key: string, initial: number, minimum: number, maximum: number) {
  const [saved, setSaved] = useState(() => {
    try {
      const value = Number(localStorage.getItem(key));
      if (Number.isFinite(value) && value > 0) return value;
    } catch {}
    return null;
  });
  const [preview, setPreview] = useState<number | null>(null);
  const min = Math.min(minimum, maximum);
  const constrain = (value: number) => Math.max(min, Math.min(maximum, Math.round(value)));
  function commit(value: number) {
    const next = constrain(value);
    setSaved(next);
    try { localStorage.setItem(key, String(next)); } catch {}
  }
  return { size: constrain(preview ?? saved ?? initial), min, max: maximum, constrain, setPreview, commit };
}

export function PanelResizeHandle({ panel, className, label, controls, axis = 'x', direction = 1 }: {
  panel: ReturnType<typeof usePanelSize>;
  className: string;
  label: string;
  controls: string;
  axis?: 'x' | 'y';
  direction?: 1 | -1;
}) {
  const drag = useRef<{ id: number; point: number; size: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  const point = (event: { clientX: number; clientY: number }) => axis === 'x' ? event.clientX : event.clientY;
  function stop(id: number) {
    if (drag.current?.id !== id) return;
    drag.current = null;
    panel.setPreview(null);
    setResizing(false);
  }

  return <div className={'panel-resizer ' + className}
    role="separator" tabIndex={0} aria-label={label} aria-controls={controls}
    aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
    aria-valuemin={panel.min} aria-valuemax={panel.max} aria-valuenow={panel.size}
    data-axis={axis} data-resizing={resizing}
    onPointerDown={event => {
      if (!event.isPrimary || event.button !== 0 || drag.current) return;
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, point: point(event), size: panel.size };
      setResizing(true);
    }}
    onPointerMove={event => {
      const start = drag.current;
      if (start?.id === event.pointerId) panel.setPreview(start.size + (point(event) - start.point) * direction);
    }}
    onPointerUp={event => {
      const start = drag.current;
      if (start?.id !== event.pointerId) return;
      const next = panel.constrain(start.size + (point(event) - start.point) * direction);
      if (next !== start.size) panel.commit(next);
      stop(event.pointerId);
    }}
    onPointerCancel={event => stop(event.pointerId)}
    onLostPointerCapture={event => stop(event.pointerId)}
    onKeyDown={event => {
      const start = drag.current;
      if (start) {
        if (event.key === 'Escape') {
          event.preventDefault();
          stop(start.id);
          event.currentTarget.releasePointerCapture(start.id);
        }
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const previous = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
      const next = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
      const sizes = { [previous]: panel.size - 8 * direction, [next]: panel.size + 8 * direction,
        Home: panel.min, End: panel.max };
      if (!Object.hasOwn(sizes, event.key)) return;
      event.preventDefault();
      panel.commit(sizes[event.key]);
    }}
  />;
}
