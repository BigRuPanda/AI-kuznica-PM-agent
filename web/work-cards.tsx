import { RangeChart, WEEK } from './range-chart';
import type { Attachment } from './range-chart';
import React, { useState } from 'react';
import { num, sourceText } from './team-data';
import type { View, Issue, MetricSeries } from './team-data';
import { analysisPeriods, changeLabel } from './case-periods';
import { SignalEvidence } from './signal-evidence';
import { WatchSummary } from './measurement';
import { Icon } from './icons';
import { moveView } from './motion';
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

function Sources({ view }: { view: View }) {
  const metric = view.summary.find((row) => row.product === view.product);
  const files = [...new Set(metric?.rows.map((row) => row.source) || [])];
  const kinds = [
    { key: 'competitor', label: 'Конкуренты', icon: 'overview' },
    { key: 'interview', label: 'Исследования', icon: 'people' },
    { key: 'backlog', label: 'Связанные задачи', icon: 'cases' },
  ];
  return (
    <div className="sources-grid">
      <section className="source-group">
        <h4><Icon name="trend" /> Метрики</h4>
        <p>{metric?.baseWeeks && metric.weeks ? 'Индекс заказов · ' + view.product : 'Нет сравнения по индексу.'}</p>
        {files.length > 0 && (
          <details>
            <summary>Источники расчёта</summary>
            {files.map((file) => <small key={file}>{file}</small>)}
          </details>
        )}
      </section>
      {kinds.map(({ key, label, icon }) => {
        const entries = view.evidence.filter((item) => item.kind === key);
        if (key === 'backlog' && !entries.length) return null;
        return (
          <section className="source-group" key={key}>
            <h4><Icon name={icon} /> {label}</h4>
            {entries.length ? (
              <>
                <p className="source-preview">{sourceText(entries[0])}</p>
                <details>
                  <summary>Выдержки ({entries.length})</summary>
                  {entries.map((item) => (
                    <div className="excerpt" key={item.key}>
                      <small>{item.source}</small>
                      {item.metadata?.question && <small>Вопрос исследования · {item.metadata.question}</small>}
                      {item.metadata?.hypothesis && <small>Гипотеза «{item.metadata.hypothesis}» · {item.metadata.relation}</small>}
                      <p>{sourceText(item)}</p>
                    </div>
                  ))}
                </details>
              </>
            ) : <p className="muted">Нет материалов.</p>}
          </section>
        );
      })}
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
  const [proof, setProof] = useState('');
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
            <button aria-expanded={proof === k} onClick={() => moveView(() => setProof(proof === k ? '' : k))}>Расчёт</button>
            {onAsk && <button onClick={() => onAsk(labels[k])}>Спросить</button>}
          </div>}
          {proof === k && (
            <details open className="proof">
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
                  <small key={s.loc}>
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
                view.evidence.map((s) => <small key={s.source}>{s.source}</small>)
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
          )}
        </section>
      ))}
    </>
  );
}
