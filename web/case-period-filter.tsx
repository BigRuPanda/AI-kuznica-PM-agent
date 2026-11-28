import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { Icon } from './icons';
import { positionPopover } from './popover-position';

type Period = { from?: string; through?: string };

export function CasePeriodFilter({ period, onApply, boundaryRef, triggerTitle }: {
  period: Period;
  onApply: (period: Period) => void;
  boundaryRef: RefObject<HTMLElement | null>;
  triggerTitle?: string;
}) {
  const id = useId();
  const title = id + '-title';
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const firstDate = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const active = Boolean(period.from || period.through);

  useEffect(() => {
    const panel = popup.current, anchor = trigger.current, boundary = boundaryRef.current;
    if (!open || !panel || !anchor) return;
    const reposition = () => {
      if (panel.matches(':popover-open')) positionPopover(panel, anchor, boundary);
    };
    const observer = new ResizeObserver(reposition);
    observer.observe(panel);
    observer.observe(anchor);
    if (boundary) observer.observe(boundary);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, boundaryRef]);

  function close() {
    if (popup.current?.matches(':popover-open')) popup.current.hidePopover();
    trigger.current?.focus({ preventScroll: true });
  }

  return <>
    <button ref={trigger} type="button" className="case-period-trigger" data-active={active} title={triggerTitle}
      data-ui-hint="Меняет даты, которые попадают в расчёт."
      popoverTarget={id} aria-controls={id} aria-expanded={open} aria-haspopup="dialog"
      onClick={event => {
        event.preventDefault();
        const panel = popup.current, anchor = trigger.current;
        if (!panel || !anchor) return;
        if (panel.matches(':popover-open')) {
          close();
          return;
        }
        form.current?.reset();
        setError('');
        panel.showPopover();
        positionPopover(panel, anchor, boundaryRef.current);
        firstDate.current?.focus({ preventScroll: true });
      }}>
      <Icon name="calendar" /> Период расчёта <Icon name="down" />
    </button>
    <div ref={popup} id={id} popover="auto" role="dialog" aria-labelledby={title} className="case-period-popover"
      onToggle={event => setOpen(event.newState === 'open')}>
      <form ref={form} className="case-period-filter" aria-labelledby={title}
        onChange={() => { if (error) setError(''); }}
        onSubmit={event => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          const from = String(fields.get('from') || '') || undefined;
          const through = String(fields.get('through') || '') || undefined;
          if (from && through && from > through) {
            setError('Начало периода должно быть не позже конца.');
            return;
          }
          close();
          onApply({ from, through });
        }}>
        <h2 id={title}>Период расчёта</h2>
        <div className="case-period-fields">
          <label>Начало периода<input ref={firstDate} type="date" name="from" defaultValue={period.from ?? ''} /></label>
          <label>Срез по дату включительно<input type="date" name="through" defaultValue={period.through ?? ''} /></label>
        </div>
        {error && <p role="alert">{error}</p>}
        <button type="submit" className="primary">Применить период</button>
      </form>
    </div>
  </>;
}
