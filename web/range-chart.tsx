import React, { useEffect, useId, useRef, useState } from 'react';
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
export type ChartLine = { key: string; name: string; color: string; points: Point[] };
export type Pick = (series: string[], ranges: WindowRange[]) => Promise<Attachment> | Attachment;
export const DAY = 86400000,
  WEEK = 7 * DAY;
export function inputDate(at: number) {
  return new Date(at + 3 * 3600000).toISOString().slice(0, 10);
}
const date = (at: number) =>
  new Date(at).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Europe/Moscow',
  });
export function rangeLabel(r: WindowRange, release = false) {
  if (release) {
    const f = new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Moscow',
    });
    return f.format(r.from) + ' — до ' + f.format(r.to) + ' МСК';
  }
  const f = new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return f.format(r.from) + ' – ' + f.format(r.to - 1);
}
export async function openRangeChat(a: Attachment) {
  const result = await post<{ thread: string; id: string }>(
    'range-chat',
    a.id ? { rangeId: a.id } : { selection: a.selection },
  );
  sessionStorage.setItem('pm-attachment/' + result.thread, JSON.stringify({ ...a, id: result.id }));
  const target = new URL(
    '/?openChat=' + encodeURIComponent(result.thread) + '#chats/' + result.thread,
    location.origin,
  );
  if (location.search === target.search) {
    location.hash = target.hash;
    location.reload();
  } else location.assign(target.toString());
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
  extras?: React.ReactNode;
  limits?: [number, number];
  markers?: { from: number; to: number; reason: string; href: string }[];
};
export function RangeChart({
  title,
  unit,
  lines,
  step,
  pivot,
  pick,
  attach,
  initial = [],
  extras,
  limits,
  markers = [],
  release = false,
}: Props) {
  const [hidden, hide] = useState<string[]>([]),
    [hover, point] = useState<number | null>(null),
    [ranges, choose] = useState<WindowRange[]>(initial),
    [slot, setSlot] = useState(0),
    [err, fail] = useState(''),
    [pending, wait] = useState(false);
  const tooltipId = useId();
  const svg = useRef<SVGSVGElement>(null),
    anchor = useRef<number | null>(null),
    touch = useRef<{ x: number; y: number; i: number; held: boolean; timer: number } | null>(null);
  const visible = lines.filter((l) => !hidden.includes(l.key)),
    dates = lines.flatMap((l) => l.points.map((p) => p.at)),
    min = limits?.[0] ?? Math.min(...dates),
    max = limits?.[1] ?? Math.max(...dates),
    len = Math.round((max - min) / step) + 1;
  const valid = Number.isFinite(len) && len > 0 && len <= 10000;
  const data = visible.map((l) => ({ ...l, by: new Map(l.points.map((p) => [p.at, p])) }));
  const W = 720,
    H = 216,
    left = 56,
    right = 704,
    top = 12,
    bottom = 174;
  const x = (i: number) => left + ((i + 0.5) * (right - left)) / len,
    edge = (i: number) => left + (i * (right - left)) / len;
  const values = data.flatMap((l) =>
    l.points.flatMap((p) =>
      [p.value, p.rolling].filter((v): v is number => typeof v === 'number' && Number.isFinite(v)),
    ),
  );
  const lo = Math.min(0, ...values),
    hi = Math.max(1, ...values) * 1.08,
    y = (n: number) => bottom - ((n - lo) / (hi - lo)) * (bottom - top);
  const at = (i: number) => min + i * step;
  function index(px: number) {
    const box = svg.current!.getBoundingClientRect();
    return Math.max(
      0,
      Math.min(len - 1, Math.floor(((((px - box.left) / box.width) * W - left) * len) / (right - left))),
    );
  }
  function select(i: number, j: number) {
    if (!pick) return;
    const r = { from: at(Math.min(i, j)), to: at(Math.max(i, j)) + step };
    choose((prev) => {
      const next = [...prev];
      next[Math.min(slot, next.length)] = r;
      return next;
    });
    fail('');
  }
  const events = useRef({ index, select });
  events.current = { index, select };
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const drag = (e: TouchEvent) => {
      const s = touch.current;
      if (!s?.held || e.touches.length !== 1) return;
      if (e.cancelable) e.preventDefault();
      const i = events.current.index(e.touches[0].clientX);
      point(i);
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
        i = events.current.index(t.clientX);
      point(i);
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
  if (!valid) return <p>Нет доступного временного ряда.</p>;
  function curve(l: (typeof data)[number], rolling = false) {
    let path = '',
      connected = false;
    for (let i = 0; i < len; i++) {
      const p = l.by.get(at(i)),
        v = rolling ? p?.rolling : p?.value;
      if (v == null) {
        connected = false;
        continue;
      }
      path += (connected ? 'L' : 'M') + x(i) + ' ' + y(v) + ' ';
      connected = true;
    }
    return path;
  }
  const picked = hover == null ? null : at(hover);
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
      <div className="range-legend">
        {lines.map((l) => (
          <button
            type="button"
            key={l.key}
            aria-pressed={!hidden.includes(l.key)}
            disabled={visible.length === 1 && visible[0].key === l.key}
            onClick={() =>
              hide(hidden.includes(l.key) ? hidden.filter((k) => k !== l.key) : [...hidden, l.key])
            }
          >
            <i style={{ background: l.color }} />
            {l.name}
          </button>
        ))}
        {extras}
      </div>
      <div className="range-plot">
        <svg
          ref={svg}
          viewBox={'0 0 ' + W + ' ' + H}
          preserveAspectRatio="none"
          tabIndex={0}
          role="group"
          aria-describedby={hover != null ? tooltipId : undefined}
          aria-label={
            title + ' — выбор периода. Стрелки — дата, пробел — выбрать, Shift и стрелки — расширить.'
          }
          onContextMenu={(e) => e.preventDefault()}
          onPointerDown={(e) => {
            if (e.pointerType === 'touch' || e.button !== 0 || (e.target as Element).closest('a')) return;
            const i = index(e.clientX);
            anchor.current = i;
            point(i);
            select(i, i);
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (e.pointerType === 'touch') return;
            const i = index(e.clientX);
            point(i);
            if (anchor.current !== null) select(anchor.current, i);
          }}
          onPointerUp={(e) => {
            if (e.pointerType === 'touch') return;
            if (anchor.current !== null) select(anchor.current, index(e.clientX));
            anchor.current = null;
          }}
          onPointerCancel={() => {
            anchor.current = null;
          }}
          onPointerLeave={() => {
            if (anchor.current === null) point(null);
          }}
          onFocus={() => point((p) => p ?? 0)}
          onBlur={() => point(null)}
          onKeyDown={(e) => {
            const current = hover ?? 0;
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
              point(next);
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
          {[0, 1, 2, 3].map((i) => (
            <g key={i}>
              <line
                x1={left}
                x2={right}
                y1={y(lo + (i * (hi - lo)) / 3)}
                y2={y(lo + (i * (hi - lo)) / 3)}
                stroke="#e0e5df"
              />
              <text x="1" y={y(lo + (i * (hi - lo)) / 3) + 4}>
                {Intl.NumberFormat('ru', { notation: 'compact', maximumFractionDigits: 1 }).format(
                  lo + (i * (hi - lo)) / 3,
                )}
              </text>
            </g>
          ))}
          {markers.map((m) => (
            <a href={m.href} key={m.href} aria-label={m.reason}>
              <rect
                x={edge((m.from - min) / step)}
                width={edge((m.to - min) / step) - edge((m.from - min) / step)}
                y={top}
                height={bottom - top}
                fill="#efe7e5"
                opacity=".5"
              />
            </a>
          ))}
          {ranges.map((r, i) => (
            <g key={i} pointerEvents="none">
              <rect
                x={edge((r.from - min) / step)}
                y={top}
                width={(((r.to - r.from) / step) * (right - left)) / len}
                height={bottom - top}
                fill={i ? '#6e9eac' : '#cb815d'}
                opacity=".20"
              />
              <text x={edge((r.from - min) / step) + 3} y={top + 13}>
                {i ? 'B' : 'A'}
              </text>
            </g>
          ))}
          {pivot != null && pivot >= min && pivot <= max && (
            <line
              x1={edge((pivot - min) / step)}
              x2={edge((pivot - min) / step)}
              y1={top}
              y2={bottom}
              stroke="#87948b"
              strokeDasharray="4 4"
            />
          )}
          {data.map((l) => (
            <g key={l.key}>
              <path d={curve(l)} fill="none" stroke={l.color} strokeWidth="2.5" />
              {l.points
                .filter((p) => p.value != null)
                .map((p) => (
                  <circle
                    key={p.at}
                    cx={x((p.at - min) / step)}
                    cy={y(p.value!)}
                    r="2.5"
                    fill={p.partial ? 'white' : l.color}
                    stroke={l.color}
                  />
                ))}
              <path d={curve(l, true)} fill="none" stroke={l.color} strokeDasharray="4 4" />
            </g>
          ))}
          {hover != null && <line x1={x(hover)} x2={x(hover)} y1={top} y2={bottom} stroke="#31443d" />}
          <text x={left} y={204}>
            {date(min)}
          </text>
          <text x={right} y={204} textAnchor="end">
            {date(max)}
          </text>
        </svg>
        {picked !== null && (
          <div role="tooltip" id={tooltipId} className={'range-tip ' + (hover! > len / 2 ? 'start' : 'end')}>
            <b>{rangeLabel({ from: picked, to: picked + step }, release)}</b>
            {data.map((l) => {
              const p = l.by.get(picked),
                prev = l.by.get(picked - step),
                delta = p?.value != null && prev?.value != null ? p.value - prev.value : null;
              return (
                <div key={l.key}>
                  <i style={{ background: l.color }} />
                  {l.name} · {p?.value == null ? 'нет наблюдения' : num(p.value) + ' ' + unit}
                  {delta != null &&
                    ' · Δ ' + (delta > 0 ? '+' : '') + num(delta) + (unit === '%' ? ' п.п.' : ' ' + unit)}
                  {p?.n != null && p.d != null && unit === '%' && ' · ' + p.n + '/' + p.d}
                  {p?.n != null && p.d == null && ' · наблюдений: ' + p.n}
                  {p?.partial && ' · неполные данные'}
                  {p?.rolling != null && ' · среднее 4 нед. ' + num(p.rolling)}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {pick && (
        <div className="range-controls">
          {!ranges.length && (
            <small>Выберите точку или протяните период. На телефоне удерживайте график.</small>
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
              />{' '}
              —{' '}
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
              <small>{visible.map((l) => l.name).join(' · ')}</small>
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
                        visible.map((l) => l.key),
                        ranges,
                      );
                      a.label = title + ' · ' + visible.map((l) => l.name).join(', ') + ' · ' + selectedText;
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
