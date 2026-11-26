import { RangeChart, WEEK } from './range-chart';
import type { Attachment } from './range-chart';
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
export function Cards({
  view,
  cards,
  backlog = [],
  onAsk,
  onPin,
  onAttach,
  pinned = [],
}: {
  view: View;
  cards: string[];
  backlog?: Issue[];
  onAsk?: (q: string) => void;
  onPin?: (k: string) => void;
  onAttach?: (a: Attachment) => void;
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
          {k === 'trend' && (
            <RangeChart
              key={view.id}
              title="Индекс заказов"
              unit="п. индекса"
              step={WEEK}
              pivot={Date.parse(view.pivot + 'T00:00:00Z')}
              extras={<small>┄ Среднее за 4 недели</small>}
              lines={view.summary.map((s, i) => ({
                key: s.product,
                name: s.product,
                color: i ? '#568683' : '#cb362f',
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
