import React, { useState } from 'react';
import { num, sourceText } from './team-data';
import type { View, Issue, Comparison } from './team-data';
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
};
export const initialCards = ['summary', 'trend', 'timeline', 'evidence', 'backlog'];
function Plot({ series, pivot }: { series: Comparison[]; pivot: string }) {
  const dates = [
    ...new Set(series.flatMap((s) => s.rows.map((x) => x.week)).concat(pivot ? [pivot] : [])),
  ].sort();
  const max = Math.max(1, ...series.flatMap((s) => s.rows.map((r) => r.value))) * 1.12;
  if (!dates.length) return <p>В выбранном периоде нет данных.</p>;
  const x = (d: string) => 48 + (dates.indexOf(d) * 640) / Math.max(1, dates.length - 1),
    y = (v: number) => 182 - (v / max) * 156;
  return (
    <>
      <div className="keys">
        {series.map((s, i) => (
          <span key={s.product}>
            <i style={{ background: i ? '#568683' : '#cb362f' }} />
            {s.product}
          </span>
        ))}
        <span>┄ Среднее за 4 недели · {series[0]?.product}</span>
      </div>
      <svg
        viewBox="0 0 722 216"
        className="team-plot"
        aria-label="Недельный индекс самостоятельных заказов"
        role="img"
      >
        {[0, 1, 2, 3].map((t) => (
          <g key={t}>
            <line x1="48" x2="690" y1={y((t * max) / 3)} y2={y((t * max) / 3)} stroke="#e6e5e1" />
            <text x="5" y={y((t * max) / 3) + 4}>
              {Math.round((t * max) / 3)}
            </text>
          </g>
        ))}
        {pivot && (
          <line x1={x(pivot)} x2={x(pivot)} y1="15" y2="184" stroke="#868782" strokeDasharray="4 5" />
        )}
        {series.map((s, i) => (
          <g key={s.product}>
            <polyline
              points={s.rows.map((r) => x(r.week) + ',' + y(r.value)).join(' ')}
              fill="none"
              stroke={i ? '#568683' : '#cb362f'}
              strokeWidth="3"
            />
            {s.rows.map((r) => (
              <circle
                key={r.week}
                cx={x(r.week)}
                cy={y(r.value)}
                r="3"
                fill={r.partial ? 'white' : i ? '#568683' : '#cb362f'}
                stroke={i ? '#568683' : '#cb362f'}
              >
                <title>
                  {r.week} · {num(r.value)}
                  {r.partial ? ' · неполная неделя' : ''}
                </title>
              </circle>
            ))}
          </g>
        ))}
        <polyline
          points={series[0]?.rows
            .filter((r) => r.rolling != null)
            .map((r) => x(r.week) + ',' + y(r.rolling!))
            .join(' ')}
          fill="none"
          stroke="#672c29"
          strokeWidth="2"
          strokeDasharray="5 4"
        />
        <text x="48" y="207">
          {dates[0]}
        </text>
        <text x="690" textAnchor="end" y="207">
          {dates.at(-1)}
        </text>
      </svg>
    </>
  );
}
export function Cards({
  view,
  cards,
  backlog = [],
  onAsk,
  onPin,
  pinned = [],
}: {
  view: View;
  cards: string[];
  backlog?: Issue[];
  onAsk?: (q: string) => void;
  onPin?: (k: string) => void;
  pinned?: string[];
}) {
  const [proof, setProof] = useState('');
  return (
    <>
      {cards.map((k) => (
        <section className="paper" key={k}>
          <div className="row-between">
            <h3>{labels[k] || k}</h3>
            {onPin && (
              <button className="text-action" onClick={() => onPin(k)}>
                {pinned.includes(k) ? 'Открепить' : 'Закрепить'}
              </button>
            )}
          </div>
          {k === 'summary' && (
            <div className="kpis">
              {view.summary.map((s) => (
                <div key={s.product}>
                  <small>{s.product}</small>
                  <strong>
                    {s.change == null ? 'Нет сравнения' : (s.change > 0 ? '+' : '') + num(s.change) + '%'}
                  </strong>
                  <span>
                    {num(s.before)} → {num(s.after)} · {s.baseWeeks} / {s.weeks} нед.
                  </span>
                </div>
              ))}
            </div>
          )}
          {k === 'trend' && <Plot series={view.summary} pivot={view.pivot} />}
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
          {k === 'evidence' && (
            <>
              {view.evidence.map((e) => (
                <div className="excerpt" key={e.kind + e.key}>
                  <small>{e.source}</small>
                  <p>{sourceText(e)}</p>
                </div>
              ))}
              {!view.evidence.length && <p>Совпадений в источниках нет.</p>}
              {view.corrections.map((c, i) => (
                <p key={i}>
                  <b>{c.author}</b> · {c.comment}
                  <small>{c.source}</small>
                </p>
              ))}
            </>
          )}
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
              {view.ctr.d ? num((view.ctr.n / view.ctr.d) * 100) + '%' : 'Нет данных для CTR'}{' '}
              <small>
                {view.ctr.n} клика / {view.ctr.d} визитов, где увидели блок
              </small>
            </p>
          )}
          {k === 'reach' && (
            <p>
              {view.reach.n} визитов с выбором опции из {view.reach.d} визитов в строках с измеренным
              знаменателем.
            </p>
          )}
          {k === 'gap' && (
            <p>{view.gap || 'Для вывода о причине нужны подтверждённые данные следующего шага.'}</p>
          )}
          {k === 'watch' && <p>Период наблюдения и критерий успеха указаны в разделе «Проверка эффекта».</p>}
          <div className="card-foot">
            <button onClick={() => setProof(proof === k ? '' : k)}>Показать расчёт</button>
            {onAsk && <button onClick={() => onAsk(labels[k])}>Спросить об этом</button>}
          </div>
          {proof === k && (
            <details open className="proof">
              <summary>Источники и период</summary>
              {['summary', 'trend'].includes(k) && (
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
