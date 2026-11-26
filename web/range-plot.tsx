import { useId, useMemo } from 'react';
import type { ChartLine, Point, WindowRange } from './range-chart';

export type PlotSeries = ChartLine & { by: Map<number, Point> };
export type PlotMarker = WindowRange & { reason: string; href: string };

const tickNumber = new Intl.NumberFormat('ru-RU', {
  notation: 'compact',
  maximumSignificantDigits: 3,
});
const tickDate = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  timeZone: 'Europe/Moscow',
});

export function plotScale(width: number, height: number, length: number, values: number[]) {
  const left = Math.min(55, Math.round(width * 0.22));
  const right = Math.max(left + 1, width - 8);
  const top = 12;
  const bottom = height - 31;
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(0, ...values);
  const padding = (maximum - minimum) * 0.06;
  const low = minimum < 0 ? minimum - padding : 0;
  const high = maximum > 0 ? maximum + padding : minimum < 0 ? 0 : 1;
  const idealInterval = (high - low) / 5;
  const magnitude = 10 ** Math.floor(Math.log10(idealInterval));
  const interval = ([1, 2, 2.5, 5, 10].find((factor) => factor * magnitude >= idealInterval) ?? 10) * magnitude;
  const firstTick = Math.floor(low / interval);
  const lastTick = Math.ceil(high / interval);
  const ticks = Array.from({ length: lastTick - firstTick + 1 }, (_, i) => (firstTick + i) * interval);
  const count = Math.min(length, 6, Math.max(2, Math.floor((right - left) / 86) + 1));
  const dates = Array.from({ length: count }, (_, i) => count === 1 ? 0 : Math.round(i * (length - 1) / (count - 1)));
  const edge = (i: number) => left + (i * (right - left)) / length;

  return {
    left, right, top, bottom, ticks, dates, edge,
    x: (i: number) => edge(i + 0.5),
    y: (value: number) => bottom - ((value / interval - firstTick) / (lastTick - firstTick)) * (bottom - top),
  };
}

type Scale = ReturnType<typeof plotScale>;
type Vertex = { x: number; y: number; point: Point };

function trace(points: (Point | undefined)[], field: 'value' | 'rolling', scale: Scale) {
  const sections: Vertex[][] = [];
  let current: Vertex[] | undefined;
  points.forEach((point, index) => {
    const value = point?.[field];
    if (!point || value == null || !Number.isFinite(value)) {
      current = undefined;
      return;
    }
    if (!current) {
      current = [];
      sections.push(current);
    }
    current.push({ x: scale.x(index), y: scale.y(value), point });
  });
  return sections;
}

function path(sections: Vertex[][]) {
  return sections
    .map((section) => section.map(({ x, y }, i) => (i ? 'L' : 'M') + x.toFixed(2) + ' ' + y.toFixed(2)).join(' '))
    .join(' ');
}

export function RangePlot({
  scale, series, min, length, step, pivot, ranges, markers, hover,
}: {
  scale: Scale;
  series: PlotSeries[];
  min: number;
  length: number;
  step: number;
  pivot?: number;
  ranges: WindowRange[];
  markers: PlotMarker[];
  hover: { index: number; x: number } | null;
}) {
  const id = useId();
  const clip = id + '-plot';
  const { left, right, top, bottom, ticks, dates, edge, x, y } = scale;
  const boundary = (time: number) => edge((time - min) / step);
  const graphics = useMemo(() => series.map((line) => {
    const points = Array.from({ length }, (_, i) => line.by.get(min + i * step));
    const sections = trace(points, 'value', scale);
    const last = sections.at(-1)?.at(-1);
    return {
      line,
      stroke: path(sections),
      average: path(trace(points, 'rolling', scale)),
      dots: sections.flatMap((section) => section.filter(({ point }, index) =>
        point.partial || length <= 8 || section.length === 1 || section[index] === last,
      )),
    };
  }), [series, min, length, step, scale]);
  const pivotX = pivot == null ? null : boundary(pivot);

  return (
    <>
      <defs>
        <clipPath id={clip}>
          <rect x={left} y={top} width={right - left} height={bottom - top} rx="9" />
        </clipPath>
      </defs>

      <rect className="range-canvas" x={left} y={top} width={right - left} height={bottom - top} rx="9" />
      <g clipPath={'url(#' + clip + ')'}>
        {markers.map((marker, index) => (
          <a href={marker.href} key={marker.href + index} aria-label={marker.reason}>
            <rect
              className="range-saved-band"
              x={boundary(marker.from)}
              width={boundary(marker.to) - boundary(marker.from)}
              y={top}
              height={bottom - top}
            />
          </a>
        ))}
        <g className="range-ink" aria-hidden="true">
          {ticks.map((tick) => (
            <line className="range-grid-line" key={tick} x1={left} x2={right} y1={y(tick)} y2={y(tick)} />
          ))}
          {dates.map((index) => (
            <line className="range-grid-line range-grid-date" key={index} x1={x(index)} x2={x(index)} y1={top} y2={bottom} />
          ))}
          {ranges.map((range, index) => (
            <rect
              className="range-selection"
              key={index}
              x={boundary(range.from)}
              y={top}
              width={boundary(range.to) - boundary(range.from)}
              height={bottom - top}
              fill={index ? 'var(--chart-b)' : 'var(--chart-a)'}
            />
          ))}
          {pivotX !== null && <line className="range-pivot" x1={pivotX} x2={pivotX} y1={top} y2={bottom} />}
          {graphics.map(({ line, stroke, average, dots }) => (
            <g key={line.key}>
              {average && <path className="range-average" d={average} stroke={line.color} />}
              <path className="range-line" d={stroke} stroke={line.color} strokeDasharray={line.dash} />
              {dots.map(({ x, y, point }) => (
                <circle
                  key={point.at}
                  cx={x}
                  cy={y}
                  r={point.partial ? 4 : 3}
                  className="range-dot"
                  fill={point.partial ? 'var(--surface)' : line.color}
                  stroke={point.partial ? line.color : 'var(--surface)'}
                />
              ))}
            </g>
          ))}
          {hover !== null && (
            <>
              <line className="range-crosshair" x1={hover.x} x2={hover.x} y1={top} y2={bottom} />
              {series.map((line) => {
                const value = line.by.get(min + hover.index * step)?.value;
                return value == null || !Number.isFinite(value) ? null : (
                  <circle className="range-focus-point" key={line.key} cx={x(hover.index)} cy={y(value)} r="5" stroke={line.color} />
                );
              })}
            </>
          )}
          {ranges.map((range, index) => {
            const from = boundary(range.from);
            const to = boundary(range.to);
            if (to - from < 18) return null;
            const color = index ? 'var(--chart-b)' : 'var(--chart-a)';
            return (
              <g key={index}>
                <rect className="range-selection-tag" x={(from + to) / 2 - 8} y={top + 6} width="16" height="16" rx="4" />
                <text className="range-selection-letter" x={(from + to) / 2} y={top + 17} textAnchor="middle" fill={color}>
                  {index ? 'B' : 'A'}
                </text>
              </g>
            );
          })}
        </g>
      </g>
      <g className="range-axis-labels" aria-hidden="true">
        {ticks.map((tick) => (
          <text key={tick} x={left - 8} y={y(tick) + 4} textAnchor="end">{tickNumber.format(tick)}</text>
        ))}
        {dates.map((index) => (
          <text
            key={index}
            x={dates.length === 1 ? x(index) : index === 0 ? left : index === length - 1 ? right : x(index)}
            y={bottom + 21}
            textAnchor={dates.length === 1 ? 'middle' : index === 0 ? 'start' : index === length - 1 ? 'end' : 'middle'}
          >
            {tickDate.format(min + index * step)}
          </text>
        ))}
      </g>
    </>
  );
}
