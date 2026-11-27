import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './icons';
import { plotScale, RangePlot } from './range-plot';
import type { PlotMarker } from './range-plot';
import { post, num } from './team-data';
import './range-chart.css';
export type WindowRange = { from: number; to: number };
export type GraphSelection = {
  source: 'weekly' | 'release' | 'metric';
  calcId: string;
  version?: string;
  metric: string;
  series: string[];
  ranges: WindowRange[];
};
export type Attachment = { selection: GraphSelection; label: string; id?: string };
export type Point = {
  at: number;
  value: number | null;
  partial?: boolean;
  n?: number;
  d?: number;
  rolling?: number | null;
};
export type ChartLine = { key: string; name: string; color: string; dash?: string; points: Point[] };
export type Pick = (series: string[], ranges: WindowRange[]) => Promise<Attachment> | Attachment;
export const DAY = 86400000,
  WEEK = 7 * DAY;
export function inputDate(at: number) {
  return new Date(at + 3 * 3600000).toISOString().slice(0, 10);
}
const chartDate = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Moscow',
});
const releaseDate = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric', month: 'short', timeZone: 'Europe/Moscow',
});
const releaseRangeDate = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow',
});
const rangeDate = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
});
export function rangeLabel(r: WindowRange, release = false) {
  if (release) {
    return releaseRangeDate.format(r.from) + ' — до ' + releaseRangeDate.format(r.to) + ' МСК';
  }
  return rangeDate.format(r.from) + ' – ' + rangeDate.format(r.to - 1);
}
export async function openRangeChat(a: Attachment) {
  const result = await post<{ thread: string; id: string }>(
    'range-chat',
    a.id ? { rangeId: a.id } : { selection: a.selection },
  );
  sessionStorage.setItem('pm-attachment/' + result.thread, JSON.stringify({ ...a, id: result.id }));
  const target = '#chats/' + result.thread;
  if (location.hash === target) location.reload();
  else location.hash = target;
}
type Props = {
  release?: boolean;
  title: string;
  unit: string;
  lines: ChartLine[];
  step: number;
  pivot?: number;
  pick?: Pick;
  attach?: (a: Attachment) => void;
  initial?: WindowRange[];
  limits?: [number, number];
  markers?: PlotMarker[];
};
type Coordinates = { x: number; y: number };
type HoverPoint = { index: number; pointer?: Coordinates };

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function placeTooltip(tip: HTMLDivElement, plot: DOMRect, position: Coordinates) {
  const gap = 12;
  const inset = 6;
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  const viewport = document.documentElement;
  const left = Math.max(inset, inset - plot.left);
  const right = Math.min(plot.width - inset, viewport.clientWidth - inset - plot.left);
  const viewTop = inset - plot.top;
  const viewBottom = viewport.clientHeight - inset - plot.top;
  const plotTop = Math.max(inset, viewTop);
  const plotBottom = Math.min(plot.height - inset, viewBottom);
  const x = clamp(position.x, 0, plot.width);
  const y = clamp(position.y, 0, plot.height);
  const after = x + gap;
  const before = x - width - gap;
  const below = y + gap;
  const above = y - height - gap;

  let tipX: number;
  let tipY: number;
  if (after + width <= right || before >= left) {
    tipX = after + width <= right ? after : before;
    tipY = plotBottom - plotTop >= height
      ? clamp(below, plotTop, plotBottom - height)
      : clamp(below, viewTop, viewBottom - height);
  } else {
    tipX = clamp(x - width / 2, left, right - width);
    tipY = [below, above].find((candidate) => candidate >= plotTop && candidate + height <= plotBottom)
      ?? clamp(below + height <= viewBottom ? below : above, viewTop, viewBottom - height);
  }
  tip.style.transform = 'translate3d(' + tipX + 'px, ' + tipY + 'px, 0)';
}

export function RangeChart({
  title,
  unit,
  lines,
  step,
  pivot,
  pick,
  attach,
  initial = [],
  limits,
  markers = [],
  release = false,
}: Props) {
  const [hidden, hide] = useState<string[]>([]),
    [hover, point] = useState<HoverPoint | null>(null),
    [ranges, choose] = useState<WindowRange[]>(initial),
    [slot, setSlot] = useState(0),
    [err, fail] = useState(''),
    [pending, wait] = useState(false);
  const tooltipId = useId();
  const [size, setSize] = useState({ width: 640, height: 240 });
  const svg = useRef<SVGSVGElement>(null),
    tooltip = useRef<HTMLDivElement>(null),
    anchor = useRef<number | null>(null),
    touch = useRef<{ x: number; y: number; i: number; held: boolean; timer: number } | null>(null);
  const dates = useMemo(() => lines.flatMap((l) => l.points.map((p) => p.at)), [lines]),
    min = limits?.[0] ?? Math.min(...dates),
    max = limits?.[1] ?? Math.max(...dates),
    len = Math.round((max - min) / step) + 1;
  const valid = Number.isFinite(len) && len > 0 && len <= 10000;
  const data = useMemo(() => lines.filter((l) => !hidden.includes(l.key))
    .map((l) => ({ ...l, by: new Map(l.points.map((p) => [p.at, p])) })), [hidden, lines]);
  const { values, hasObservations, hasRolling, hasPartial } = useMemo(() => {
    const points = data.flatMap((line) => line.points.filter((p) => p.at >= min && p.at <= max));
    return {
      values: points.flatMap((p) => [p.value, p.rolling].filter((v): v is number => v != null && Number.isFinite(v))),
      hasObservations: points.some((p) => p.value != null && Number.isFinite(p.value)),
      hasRolling: points.some((p) => p.rolling != null && Number.isFinite(p.rolling)),
      hasPartial: points.some((p) => p.partial),
    };
  }, [data, min, max]);
  const scale = useMemo(() => plotScale(size.width, size.height, valid ? len : 1, values), [len, size, valid, values]);
  const releaseAt = pivot != null && pivot >= min && pivot <= max ? pivot : undefined;
  const at = (i: number) => min + i * step;
  const cursor = hover !== null && hover.index < len ? hover : null;
  const picked = cursor === null ? null : at(cursor.index);
  const cursorX = cursor === null ? null : clamp(cursor.pointer?.x ?? scale.x(cursor.index), scale.left, scale.right);

  useLayoutEffect(() => {
    const plot = svg.current?.parentElement;
    if (!plot) return;
    const sync = (w: number, h: number) => {
      if (w <= 0 || h <= 0) return;
      const width = Math.round(w), height = Math.round(h);
      setSize((previous) => previous.width === width && previous.height === height ? previous : { width, height });
    };
    sync(plot.clientWidth, plot.clientHeight);
    const observer = new ResizeObserver(([entry]) => sync(entry.contentRect.width, entry.contentRect.height));
    observer.observe(plot);
    return () => observer.disconnect();
  }, [valid]);

  useLayoutEffect(() => {
    const tip = tooltip.current;
    if (!tip || cursor === null || picked === null || cursorX === null) return;
    const plot = svg.current?.getBoundingClientRect();
    if (!plot) return;
    const value = data[0]?.by.get(picked)?.value;
    const x = cursor.pointer?.x ?? cursorX;
    const y = cursor.pointer?.y ?? (value == null ? scale.top : scale.y(value));
    placeTooltip(tip, plot, { x: x * plot.width / size.width, y: y * plot.height / size.height });
  });

  function pointAt(clientX: number, clientY: number) {
    const box = svg.current!.getBoundingClientRect();
    const { left, right } = scale;
    const x = (clientX - box.left) * size.width / box.width;
    const y = (clientY - box.top) * size.height / box.height;
    const index = clamp(Math.floor(((x - left) * len) / (right - left)), 0, len - 1);
    point({ index, pointer: { x, y } });
    return index;
  }
  function select(i: number, j: number) {
    if (!pick) return;
    const r = { from: at(Math.min(i, j)), to: at(Math.max(i, j)) + step };
    choose((prev) => {
      const position = Math.min(slot, prev.length);
      if (prev[position]?.from === r.from && prev[position].to === r.to) return prev;
      const next = [...prev];
      next[position] = r;
      return next;
    });
    fail('');
  }
  const events = useRef({ pointAt, select });
  events.current = { pointAt, select };
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const drag = (e: TouchEvent) => {
      const s = touch.current;
      if (!s?.held || e.touches.length !== 1) return;
      if (e.cancelable) e.preventDefault();
      const { clientX, clientY } = e.touches[0];
      const i = events.current.pointAt(clientX, clientY);
      events.current.select(s.i, i);
    };
    const reset = () => {
      if (touch.current) clearTimeout(touch.current.timer);
      el.removeEventListener('touchmove', drag);
      touch.current = null;
    };
    const start = (e: TouchEvent) => {
      reset();
      if (e.touches.length !== 1) return;
      const t = e.touches[0],
        i = events.current.pointAt(t.clientX, t.clientY);
      const state = { x: t.clientX, y: t.clientY, i, held: false, timer: 0 };
      touch.current = state;
      if (pick)
        state.timer = window.setTimeout(() => {
          state.held = true;
          el.addEventListener('touchmove', drag, { passive: false });
          events.current.select(i, i);
        }, 420);
    };
    const move = (e: TouchEvent) => {
      const s = touch.current;
      if (!s || e.touches.length !== 1) {
        reset();
        return;
      }
      const t = e.touches[0];
      if (!s.held && Math.hypot(t.clientX - s.x, t.clientY - s.y) > 8) {
        reset();
        point(null);
      }
    };
    const end = (e: TouchEvent) => {
      if (touch.current?.held && e.cancelable) e.preventDefault();
      reset();
    };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: true });
    el.addEventListener('touchend', end, { passive: false });
    el.addEventListener('touchcancel', reset);
    return () => {
      reset();
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', reset);
    };
  }, [!!pick, valid]);
  if (!valid) return <p className="muted">Нет доступного временного ряда.</p>;
  const selectedText = ranges.map((r, i) => (i ? 'B' : 'A') + ' · ' + rangeLabel(r, release)).join(' / ');
  function changeDate(n: number, end: boolean, value: string) {
    const i = Math.round(
      (Date.parse(value + 'T00:00:00Z') - Date.parse(inputDate(min) + 'T00:00:00Z')) / DAY,
    );
    const tick = min + i * DAY,
      r = ranges[n];
    if (!Number.isFinite(tick) || tick < min || tick > max || (tick - min) % step) {
      fail(step === WEEK ? 'Выберите понедельник в пределах графика.' : 'Выберите дату на графике.');
      return;
    }
    const next = end ? { from: r.from, to: tick + step } : { from: tick, to: r.to };
    if (next.to <= next.from) {
      fail('Конец периода раньше начала.');
      return;
    }
    choose(ranges.map((x, j) => (j === n ? next : x)));
    fail('');
  }
  return (
    <div className="range-widget">
      <div className="range-header">
        <div className="range-legend" role="group" aria-label="Ряды графика">
          {lines.map((l) => (
            <button
              type="button"
              key={l.key}
              aria-pressed={!hidden.includes(l.key)}
              disabled={data.length === 1 && data[0].key === l.key}
              onClick={() =>
                hide((previous) => previous.includes(l.key) ? previous.filter((k) => k !== l.key) : [...previous, l.key])
              }
            >
              <i className={l.dash ? 'dashed' : undefined} style={{ color: l.color }} aria-hidden="true" />
              <span>{l.name}</span>
            </button>
          ))}
        </div>
        <small className="range-period"><Icon name="calendar" />{chartDate.formatRange(min, max)}</small>
      </div>
      <div className="range-frame">
        <div className="range-axis-heading">
          <small>{unit}</small>
          {releaseAt !== undefined && (
            <small className="range-release"><i className="dashed" aria-hidden="true" />Релиз · {releaseDate.format(releaseAt)}</small>
          )}
        </div>
        <div className="range-plot">
          <svg
            ref={svg}
            viewBox={'0 0 ' + size.width + ' ' + size.height}
            preserveAspectRatio="none"
            tabIndex={0}
            role="group"
            aria-describedby={cursor != null ? tooltipId : undefined}
            aria-label={title + (pick
              ? ' — выбор периода. Стрелки — дата, пробел — выбрать, Shift и стрелки — расширить.'
              : ' — просмотр данных. Стрелки — дата.')}
            onContextMenu={(e) => e.preventDefault()}
            onPointerDown={(e) => {
              if (e.pointerType === 'touch' || e.button !== 0 || (e.target as Element).closest('a')) return;
              const i = pointAt(e.clientX, e.clientY);
              if (!pick) return;
              anchor.current = i;
              select(i, i);
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (e.pointerType === 'touch') return;
              const i = pointAt(e.clientX, e.clientY);
              if (anchor.current !== null) select(anchor.current, i);
            }}
            onPointerUp={(e) => {
              if (e.pointerType === 'touch') return;
              if (anchor.current !== null) select(anchor.current, pointAt(e.clientX, e.clientY));
              anchor.current = null;
            }}
            onPointerCancel={() => {
              anchor.current = null;
              point(null);
            }}
            onPointerLeave={() => {
              if (anchor.current === null) point(null);
            }}
            onFocus={() => point((p) => p ?? { index: 0 })}
            onBlur={() => point(null)}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              const current = cursor?.index ?? 0;
              if (e.key === 'Escape') {
                point(null);
                anchor.current = null;
                return;
              }
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
                e.preventDefault();
                const next =
                  e.key === 'Home'
                    ? 0
                    : e.key === 'End'
                      ? len - 1
                      : Math.min(len - 1, Math.max(0, current + (e.key === 'ArrowRight' ? 1 : -1)));
                point({ index: next });
                if (e.shiftKey) {
                  anchor.current ??= current;
                  select(anchor.current, next);
                } else anchor.current = null;
              }
              if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                select(current, current);
              }
            }}
          >
            <RangePlot
              scale={scale}
              series={data}
              min={min}
              length={len}
              step={step}
              pivot={releaseAt}
              ranges={ranges}
              markers={markers}
              hover={cursor !== null && cursorX !== null ? { index: cursor.index, x: cursorX } : null}
            />
          </svg>
          {!hasObservations && <p className="range-empty">Нет наблюдений за период.</p>}
          {cursor !== null && picked !== null && (
            <div ref={tooltip} role="tooltip" id={tooltipId} className="range-tip">
              <b>{release || step > DAY ? rangeLabel({ from: picked, to: picked + step }, release) : chartDate.format(picked)}</b>
              {data.map((l) => {
                const p = l.by.get(picked),
                  prev = l.by.get(picked - step),
                  delta = p?.value != null && prev?.value != null ? p.value - prev.value : null;
                const notes = [
                  delta != null && 'Δ ' + (delta > 0 ? '+' : '') + num(delta) + (unit === '%' ? ' п.п.' : ' ' + unit),
                  p?.n != null && p.d != null && unit === '%' && p.n + '/' + p.d,
                  p?.n != null && p.d == null && 'Наблюдений: ' + p.n,
                  p?.partial && 'Неполные данные',
                  p?.rolling != null && 'Среднее за 4 нед. · ' + num(p.rolling),
                ].filter(Boolean);
                return (
                  <div className="range-tip-row" key={l.key}>
                    <div className="range-tip-value">
                      <span><i className={l.dash ? 'dashed' : undefined} style={{ color: l.color }} aria-hidden="true" />{l.name}</span>
                      <strong>{p?.value == null ? 'Нет данных' : num(p.value) + ' ' + unit}</strong>
                    </div>
                    {notes.length > 0 && <small>{notes.join(' · ')}</small>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {(hasRolling || hasPartial) && (
        <div className="range-keys">
          {hasRolling && <small><i className="dashed" aria-hidden="true" />Среднее за 4 недели</small>}
          {hasPartial && <small><i className="hollow" aria-hidden="true" />{step === WEEK ? 'Неполная неделя' : 'Неполные данные'}</small>}
        </div>
      )}
      {pick && (
        <div className="range-controls">
          {!ranges.length && (
            <small>Нажмите точку или выделите период. На телефоне удерживайте график.</small>
          )}
          {ranges.map((r, i) => (
            <div className="range-dates" key={i}>
              <button type="button" aria-pressed={slot === i} onClick={() => setSlot(i)}>
                {i ? 'B' : 'A'}
              </button>
              <input
                type="date"
                aria-label={'Начало ' + (i ? 'B' : 'A')}
                min={inputDate(min)}
                max={inputDate(max)}
                value={inputDate(r.from)}
                onChange={(e) => changeDate(i, false, e.target.value)}
              />
              <input
                type="date"
                aria-label={'Конец ' + (i ? 'B' : 'A')}
                min={inputDate(min)}
                max={inputDate(max)}
                value={inputDate(r.to - step)}
                onChange={(e) => changeDate(i, true, e.target.value)}
              />
              <button
                type="button"
                aria-label={'Удалить ' + (i ? 'B' : 'A')}
                onClick={() => {
                  choose(ranges.filter((_, j) => i !== j));
                  setSlot(0);
                }}
              >
                ×
              </button>
            </div>
          ))}
          {ranges.length > 0 && (
            <>
              <small>{data.map((l) => l.name).join(' · ')}</small>
              <div className="range-buttons">
                {ranges.length === 1 && (
                  <button type="button" onClick={() => setSlot(1)}>
                    {slot === 1 ? 'Выберите границы B' : 'Добавить период для сравнения'}
                  </button>
                )}
                <button
                  type="button"
                  className="primary"
                  disabled={pending}
                  aria-label="Спросить о выделении"
                  onClick={async () => {
                    wait(true);
                    try {
                      const a = await pick(
                        data.map((l) => l.key),
                        ranges,
                      );
                      a.label = title + ' · ' + data.map((l) => l.name).join(', ') + ' · ' + selectedText;
                      if (attach) attach(a);
                      else await openRangeChat(a);
                    } catch (e) {
                      fail((e as Error).message);
                    } finally {
                      wait(false);
                    }
                  }}
                >
                  Спросить
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {err && <p role="alert">{err}</p>}
    </div>
  );
}
