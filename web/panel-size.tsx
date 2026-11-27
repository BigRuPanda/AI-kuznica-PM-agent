import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';

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

export function useDiscussionDock(ref: RefObject<HTMLDivElement | null>, mounted: boolean) {
  useLayoutEffect(() => {
    const dock = ref.current;
    const layout = dock?.parentElement;
    if (!mounted || !dock || !layout) return;
    const topMenu = dock.closest('.team-app[data-menu="top"]')?.querySelector('.side');
    const wide = matchMedia('(min-width: 821px)');
    let frame = 0;
    function measure() {
      if (!dock || !layout || !wide.matches) return;
      const inset = 16;
      const stickyTop = (topMenu?.getBoundingClientRect().height ?? 0) + inset;
      const top = Math.max(stickyTop, layout.getBoundingClientRect().top);
      dock.style.setProperty('--discussion-top', stickyTop + 'px');
      dock.style.setProperty('--discussion-height', Math.max(0, window.innerHeight - top - inset) + 'px');
    }
    function schedule() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    }
    const observer = new ResizeObserver(schedule);
    observer.observe(layout);
    if (layout.previousElementSibling) observer.observe(layout.previousElementSibling);
    if (topMenu) observer.observe(topMenu);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, { passive: true });
    measure();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule);
    };
  }, [ref, mounted]);
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

export function PanelResizeHandle({ panel, className, label, controls, direction = 1 }: {
  panel: ReturnType<typeof usePanelSize>;
  className: string;
  label: string;
  controls: string;
  direction?: 1 | -1;
}) {
  const drag = useRef<{ id: number; point: number; size: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  function stop(id: number) {
    if (drag.current?.id !== id) return;
    drag.current = null;
    panel.setPreview(null);
    setResizing(false);
  }

  return <div className={'panel-resizer ' + className}
    role="separator" tabIndex={0} aria-label={label} aria-controls={controls}
    aria-orientation="vertical"
    aria-valuemin={panel.min} aria-valuemax={panel.max} aria-valuenow={panel.size}
    data-resizing={resizing}
    onPointerDown={event => {
      if (!event.isPrimary || event.button !== 0 || drag.current) return;
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, point: event.clientX, size: panel.size };
      setResizing(true);
    }}
    onPointerMove={event => {
      const start = drag.current;
      if (start?.id === event.pointerId) panel.setPreview(start.size + (event.clientX - start.point) * direction);
    }}
    onPointerUp={event => {
      const start = drag.current;
      if (start?.id !== event.pointerId) return;
      const next = panel.constrain(start.size + (event.clientX - start.point) * direction);
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
      const sizes: Record<string, number> = { ArrowLeft: panel.size - 8 * direction, ArrowRight: panel.size + 8 * direction,
        Home: panel.min, End: panel.max };
      if (!Object.hasOwn(sizes, event.key)) return;
      event.preventDefault();
      panel.commit(sizes[event.key]);
    }}
  />;
}
