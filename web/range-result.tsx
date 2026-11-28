import { useEffect, useState } from 'react';
import { post, num } from './team-data';
import { RangeChart, rangeLabel } from './range-chart';
import { HelpMarker } from './ui-hints';
import type { Point, WindowRange, GraphSelection } from './range-chart';
type Value = {
  key: string;
  value: number | null;
  commonValue?: number | null;
  n?: number;
  d?: number;
  pending?: number;
  available: number;
  partial?: number;
  incomplete?: boolean;
  reason?: string;
  sources?: { location: string; date: string; version: string }[];
};
type Result = GraphSelection & {
  id: string;
  step: number;
  title: string;
  unit: string;
  asOf: string;
  product: string;
  filters: { segment?: string; full?: boolean };
  points: Record<string, Point[]>;
  periods: (WindowRange & { expected: number; commonDates?: string[]; series: Value[] })[];
  differences?: {
    key: string;
    absolute: number | null;
    relative: number | null;
    commonAbsolute?: number | null;
  }[];
};
export function RangeResult({ id }: { id: string }) {
  const [r, set] = useState<Result | null>(null),
    [error, fail] = useState('');
  useEffect(() => {
    let active = true;
    set(null);
    post<Result>('range_read', { id })
      .then((v) => {
        if (active) set(v);
      })
      .catch((e) => {
        if (active) fail(e.message);
      });
    return () => {
      active = false;
    };
  }, [id]);
  if (!r) return <p>{error || 'Открываем сохранённый участок…'}</p>;
  const min = Math.min(...r.ranges.map((x) => x.from)),
    max = Math.max(...r.ranges.map((x) => x.to)) - r.step;
  return (
    <section className="paper range-result">
      <a href="#cases">← Разборы</a>
      <div className="ui-hint-heading">
        <h1>{r.title}</h1>
        <HelpMarker label="О расчёте по выделению" hint="Показывает расчёт и покрытие по выбранным периодам." />
      </div>
      <p>
        {r.product} · срез {r.asOf} · версия {r.version?.slice(0, 10)}
      </p>
      <RangeChart
        release={r.source === 'release'}
        title={r.title}
        lines={r.series.map((key, i) => ({
          key,
          name: key,
          color: i ? 'var(--series-control)' : 'var(--series-main)',
          dash: i ? '7 4' : undefined,
          points: r.points[key],
        }))}
        unit={r.unit}
        step={r.step}
        limits={[min, max]}
        initial={r.ranges}
        pick={(series, ranges) => ({
          label: r.title,
          id:
            JSON.stringify(ranges) === JSON.stringify(r.ranges) &&
            JSON.stringify(series) === JSON.stringify(r.series)
              ? r.id
              : undefined,
          selection: {
            source: r.source,
            calcId: r.calcId,
            version: r.version,
            metric: r.metric,
            series,
            ranges,
          },
        })}
      />
      {r.periods.map((p, i) => (
        <section key={i}>
          <h2>
            {i ? 'B' : 'A'} · {rangeLabel(p, r.source === 'release')}
          </h2>
          <table>
            <thead>
              <tr>
                <th>Ряд</th>
                <th>{r.unit}</th>
                <th>Покрытие</th>
                {p.commonDates && <th>На общих неделях</th>}
              </tr>
            </thead>
            <tbody>
              {p.series.map((s) => (
                <tr key={s.key}>
                  <th>{s.key}</th>
                  <td>
                    {num(s.value)}
                    {s.reason && <small>{s.reason}</small>}
                    {s.n != null && s.d != null && r.unit === '%' && (
                      <small>
                        {' '}
                        · {s.n}/{s.d}
                      </small>
                    )}
                  </td>
                  <td>
                    {s.available}/{p.expected}
                    {s.partial ? ' · неполных: ' + s.partial : ''}
                    {s.incomplete ? ' · предварительно' : ''}
                    {s.pending ? ' · ожидают: ' + s.pending : ''}
                  </td>
                  {p.commonDates && (
                    <td>
                      {num(s.commonValue)} · {p.commonDates.length} нед.
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {p.series.some((s) => s.sources?.length) && (
            <details>
              <summary>Строки источника</summary>
              {p.series.map((s) =>
                s.sources?.map((row) => (
                  <p key={s.key + row.date}>
                    {s.key} · {row.date} · {row.location}
                  </p>
                )),
              )}
            </details>
          )}
        </section>
      ))}
      {r.differences && (
        <section>
          <h2>Изменение от A к B</h2>
          {r.differences.map((d) => (
            <p key={d.key}>
              {d.key} · {num(d.absolute)} {r.unit === '%' ? 'п.п.' : r.unit} ·{' '}
              {d.relative == null ? 'нет относительного сравнения' : num(d.relative) + '%'}
              {d.commonAbsolute != null && ' · на общих неделях ' + num(d.commonAbsolute)}
            </p>
          ))}
        </section>
      )}
    </section>
  );
}
