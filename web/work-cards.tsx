import { RangeChart, WEEK } from './range-chart';
import type { Attachment } from './range-chart';
import React, { useState } from 'react';
import { num } from './team-data';
import type { View, Issue, MetricSeries } from './team-data';
import { analysisPeriods, changeLabel } from './case-periods';
import { SignalEvidence } from './signal-evidence';
import { metricName, WatchSummary } from './measurement';
import { Icon } from './icons';
import { Dialog } from './dialog';
export const labels: Record<string, string> = {
  summary: 'Сравнение периодов',
  trend: 'Индекс заказов',
  timeline: 'События и релизы',
  evidence: 'Источники',
  backlog: 'Приоритеты бэклога',
  ctr: 'Рекомендации в ЛК',
  reach: 'Выбор опций',
  gap: 'Качество измерения',
  watch: 'Проверка эффекта',
  signal: 'Расчёт сигнала',
};
export const initialCards = ['summary', 'trend', 'evidence', 'timeline', 'backlog'];

const sourceKinds = [
  { key: 'metrics', label: 'Метрики', icon: 'trend' },
  { key: 'competitor', label: 'Конкуренты', icon: 'overview' },
  { key: 'interview', label: 'Исследования', icon: 'people' },
  { key: 'backlog', label: 'Связанные задачи', icon: 'cases' },
] as const;

type MetricSourceRow = { label: string; date?: string; value?: string; source: string; partial?: boolean };

function metricSourceRows(view: View): MetricSourceRow[] {
  const orders = view.summary.flatMap(series => series.rows.map(row => ({
    label: 'Индекс заказов · ' + series.product,
    date: row.week, value: num(row.value) + ' п.', source: row.source, partial: row.partial,
  })));
  const signal = view.signal;
  const signalLabel = signal?.metric && metricName(signal.metric);
  const observed = signalLabel && signal.evidence
    ? [...signal.evidence.baseline, signal.evidence.latest].flatMap(week => week.rows.map(row => ({
      label: signalLabel + (row.segment && row.segment !== 'all' ? ' · ' + row.segment : ''),
      date: row.date,
      value: row.n != null && row.d != null && row.d > 0
        ? num(row.n / row.d * 100) + '% (' + num(row.n) + ' / ' + num(row.d) + ')' : undefined,
      source: row.source,
    })))
    : [];
  const observations = new Set(observed.map(row => row.source));
  const ratios = [
    { label: metricName('lk_reco_ctr'), sources: view.ctr?.sources },
    { label: metricName('cfg_reach_rate'), sources: view.reach?.sources },
  ].flatMap(({label, sources}) => [...new Set(sources)].filter(source => label !== signalLabel || !observations.has(source))
    .map(source => ({ label, source })));
  return [...orders, ...observed, ...ratios];
}

function Sources({ view }: { view: View }) {
  const [category, setCategory] = useState<typeof sourceKinds[number]>();
  const metrics = category?.key === 'metrics';
  const rows = metrics ? metricSourceRows(view) : [];
  const entries = category && !metrics ? view.evidence.filter(item => item.kind === category.key) : [];
  const hasMetrics = view.summary.some(series => series.rows.length) || view.signal?.evidence ||
    !!view.ctr?.sources?.length || !!view.reach?.sources?.length;
  return (
    <div className="sources-grid">
      {sourceKinds.map(kind => {
        const count = view.evidence.filter(item => item.kind === kind.key).length;
        if (kind.key === 'backlog' && !count) return null;
        return (
          <button type="button" key={kind.key} className="source-group" aria-haspopup="dialog"
            onClick={event => {
              event.currentTarget.focus({ preventScroll: true });
              setCategory(kind);
            }}>
            <span className="source-group-title"><Icon name={kind.icon} /> {kind.label} <Icon name="right" /></span>
            <small>{kind.key === 'metrics' && hasMetrics ? 'Данные расчёта' :
              count ? 'Материалов: ' + count : 'Нет материалов.'}</small>
          </button>
        );
      })}
      {category && (
        <Dialog title={category.label} close={() => setCategory(undefined)} wide>
          {(metrics ? rows.length : entries.length) > 0 ? (
            <div className="source-table-scroll" role="region" aria-label="Таблица источников" tabIndex={0}>
              <table className={'source-table' + (metrics ? ' metric-source-table' : '')}>
                <thead><tr>
                  {metrics ? <><th scope="col">Показатель</th><th scope="col">Дата</th><th scope="col">Значение</th></>
                    : <th scope="col">Материал</th>}
                  <th scope="col">Источник</th>
                </tr></thead>
                <tbody>
                  {metrics ? rows.map((row, index) => (
                    <tr key={row.source + '/' + index}>
                      <td>{row.label}</td>
                      <td>{row.date || '—'}{row.partial && <small>Неполная неделя</small>}</td>
                      <td>{row.value || '—'}</td>
                      <td>{row.source}</td>
                    </tr>
                  )) : entries.map(item => (
                    <tr key={item.key}>
                      <td>
                        {typeof item.data === 'string' ? <div>{item.data}</div> : <>
                          {item.data.title && <strong>{item.data.title}</strong>}
                          <div>{item.data.description || item.data.description_short}</div>
                        </>}
                        {item.metadata?.question && <small>Вопрос · {item.metadata.question}</small>}
                        {item.metadata?.date && <small>Дата · {item.metadata.date}</small>}
                        {item.metadata?.hypothesis && <small>Гипотеза · {item.metadata.hypothesis}</small>}
                        {item.metadata?.relation && <small>Связь с гипотезой · {item.metadata.relation}</small>}
                      </td>
                      <td>{item.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="muted">Нет материалов.</p>}
        </Dialog>
      )}
      {view.corrections.length > 0 && (
        <details className="source-corrections">
          <summary>Поправки к источникам</summary>
          {view.corrections.map((c, i) => (
            <p key={i}><b>{c.author}</b> · {c.comment}<small>{c.source}</small></p>
          ))}
        </details>
      )}
    </div>
  );
}

export function Cards({
  view,
  cards,
  backlog = [],
  onAsk,
  onPin,
  onAttach,
  onMetricSeries,
  pinned = [],
}: {
  view: View;
  cards: string[];
  backlog?: Issue[];
  onAsk?: (q: string) => void;
  onPin?: (k: string) => void;
  onAttach?: (a: Attachment) => void;
  onMetricSeries?: (card: 'ctr' | 'reach', series: MetricSeries | undefined) => void;
  pinned?: string[];
}) {
  const periods = analysisPeriods(view);
  const hasPartial = view.summary.some((s) => s.rows.some((r) => r.partial));
  return (
    <>
      {cards.map((k) => (
        <section className={'paper analysis-card card-' + k} key={k}>
          <div className="row-between">
            <h3>{labels[k] || k}</h3>
            {onPin && (
              <button className="text-action" onClick={() => onPin(k)}>
                {pinned.includes(k) ? 'Открепить' : 'Закрепить'}
              </button>
            )}
          </div>
          {(k === 'ctr' || k === 'reach') && !!view[k].choices?.length && onMetricSeries && (() => {
            const { choices = [], selection } = view[k];
            const selected = choices.findIndex(c => selection && c.sourceId === selection.sourceId &&
              c.definitionId === selection.definitionId && c.product === selection.product && c.segment === selection.segment);
            return <label>Ряд наблюдений
              <select value={selected < 0 ? '' : selected} onChange={e => {
                const index = e.target.value;
                onMetricSeries(k, index === '' ? undefined : choices[Number(index)]);
              }}>
                <option value="">Автовыбор</option>
                {choices.map((choice, index) => <option key={index} value={index}>
                  {choice.sourceId} · {choice.product} · {choice.segment} · {choice.stepDays === 7 ? 'неделя' : 'день'} · {choice.definitionId}
                </option>)}
              </select>
            </label>;
          })()}
          {k === 'summary' && (
            <>
              <div className="kpis">
                {view.summary.map((s) => (
                  <div key={s.product}>
                    <small>{s.product}{s.product !== view.product && ' · контроль'}</small>
                    <strong data-negative={s.product === view.product && (s.change ?? 0) < 0}>
                      {s.change == null ? 'Нет сравнения' : changeLabel(s.change)}
                    </strong>
                    <span>{num(s.before)} → {num(s.after)} п. · {s.baseWeeks} / {s.weeks} нед.</span>
                  </div>
                ))}
                {!view.summary.length && <p className="muted">Нет данных за этот период.</p>}
              </div>
              {view.summary.length > 0 && (
                <dl className="comparison-dates">
                  <div><dt>До</dt><dd>{periods.before}</dd></div>
                  <div><dt>После</dt><dd>{periods.after}</dd></div>
                </dl>
              )}
              {hasPartial && <small className="coverage-note">В периоде есть неполные недели.</small>}
            </>
          )}
          {k === 'trend' && (
            <RangeChart
              key={view.id}
              title="Индекс заказов"
              unit="п. индекса"
              step={WEEK}
              pivot={Date.parse(view.pivot + 'T00:00:00Z')}
              lines={view.summary.map((s, i) => ({
                key: s.product,
                name: s.product,
                color: i ? 'var(--series-control)' : 'var(--series-main)',
                dash: i ? '7 4' : undefined,
                points: s.rows.map((r) => ({
                  at: Date.parse(r.week + 'T00:00:00Z'),
                  value: r.value,
                  partial: r.partial,
                  rolling: i ? null : r.rolling,
                })),
              }))}
              pick={(series, ranges) => ({
                label: '',
                selection: {
                  source: 'weekly',
                  calcId: view.id,
                  version: view.id,
                  metric: 'orders_index',
                  series,
                  ranges,
                },
              })}
              attach={onAttach}
            />
          )}

          {k === 'timeline' &&
            (view.timeline.length ? (
              view.timeline.map((r) => (
                <div className="event-row" key={r.loc}>
                  <small>
                    {r.data.release_date} · {r.data.release_id}
                  </small>
                  <p>{r.data.description}</p>
                </div>
              ))
            ) : (
              <p>В окне сравнения нет событий.</p>
            ))}
          {k === 'evidence' && <Sources view={view} />}
          {k === 'backlog' &&
            (backlog.length ? (
              backlog.map((b) => (
                <div className="event-row" key={b.key}>
                  <small>
                    {b.category} · {b.key}
                  </small>
                  <b>{b.title}</b>
                  <p>{b.reason}</p>
                </div>
              ))
            ) : (
              <p>Открытых связанных задач в этом срезе нет.</p>
            ))}
          {k === 'ctr' && (
            <p className="big-number">
              {view.ctr.d && view.ctr.n != null ? num((view.ctr.n / view.ctr.d) * 100) + '%' : 'Нет данных для CTR'}{' '}
              <small>
                {view.ctr.n != null && view.ctr.d != null
                  ? view.ctr.n + ' клика / ' + view.ctr.d + ' визитов, где увидели блок'
                  : view.ctr.reason}
              </small>
            </p>
          )}
          {k === 'reach' && (
            <p>
              {view.reach.d && view.reach.n != null
                ? view.reach.n + ' визитов с выбором опции из ' + view.reach.d + ' визитов в строках с измеренным знаменателем.'
                : view.reach.reason || 'За период нет наблюдений с измеренным знаменателем.'}
            </p>
          )}
          {k === 'gap' && (
            <p>{view.gap || 'Для вывода о причине нужны подтверждённые данные следующего шага.'}</p>
          )}
          {k === 'watch' && (view.monitoring ? <WatchSummary {...view.monitoring} /> :
            <p>Период наблюдения и критерий успеха указаны в разделе «Проверка эффекта».</p>)}
          {k === 'signal' && view.signal?.metric && <SignalEvidence signal={view.signal} />}
          {k !== 'watch' && <div className="card-foot">
            <details className="proof">
              <summary>Источники и период</summary>
              {['summary', 'trend', 'ctr', 'reach', 'timeline'].includes(k) && (
                <p>
                  База с {view.base}, неделя релиза {view.pivot}, срез по {view.cut}.{' '}
                  {view.full ? 'Только полные недели.' : ''}
                </p>
              )}
              {k === 'ctr' ? (
                view.ctr.sources.map((s) => <small key={s}>{s}</small>)
              ) : k === 'reach' ? (
                (view.reach.sources || []).map((s) => <small key={s}>{s}</small>)
              ) : k === 'timeline' ? (
                view.timeline.map((s) => (
                  <small key={s.file + '/' + s.loc}>
                    {s.file} · {s.loc}
                  </small>
                ))
              ) : k === 'gap' ? (
                <small>{view.gap}</small>
              ) : k === 'backlog' ? (
                backlog.map((s) => (
                  <small key={s.key}>
                    {s.key} · {s.source}
                  </small>
                ))
              ) : k === 'evidence' ? (
                view.evidence.map((s) => <small key={s.kind + '/' + s.key}>{s.source}</small>)
              ) : (
                view.summary.map((s) => (
                  <details key={s.product}>
                    <summary>{s.product}</summary>
                    {s.rows.map((r) => (
                      <small key={r.week}>
                        {r.week} · {r.value} · {r.source}
                      </small>
                    ))}
                  </details>
                ))
              )}
              <a href={'#snapshot/' + view.id}>Открыть версию расчёта</a>
            </details>
            {onAsk && <button type="button" onClick={() => onAsk(labels[k])}>Спросить</button>}
          </div>}
        </section>
      ))}
    </>
  );
}
