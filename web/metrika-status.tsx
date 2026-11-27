type Attempt = {
  from: string; to: string; started: number; finished: number | null;
  state: 'running' | 'ready' | 'empty' | 'error'; rows: number | null;
  observed: string | null; lag: number | null; sampleShare: number | null; pages: number | null; reason: string | null;
};
export type MetrikaStatus = {
  configurationError?: string;
  reports: {
    counter: string; report: string; replay: boolean; stale: boolean; expectedThrough: string | null; waitingForPeriod: boolean;
    coveredFrom: string | null; coveredThrough: string | null; lastObservation: string | null;
    lastAttempt: number | null; lastSuccess: number | null; attempts: Attempt[];
  }[];
};
const labels = {ready:'Загрузка завершена',empty:'Успешно, строк нет',error:'Ошибка загрузки',running:'Загрузка идёт'};
const stamp = (time: number) => new Date(time).toLocaleString('ru-RU');

export function MetrikaJournal({ status }: { status?: MetrikaStatus }) {
  if (!status) return null;
  return <section className="paper" aria-label="Свежесть данных Метрики">
    <h3>Свежесть данных Метрики</h3>
    {status.configurationError && <p role="alert">{status.configurationError}</p>}
    {!status.configurationError && !status.reports.length && <p>Синхронизация Метрики не настроена.</p>}
    {status.reports.map((r,i) => <article key={r.counter + '/' + r.report + '/' + i}>
      <h4>{r.report} · счётчик {r.counter}</h4>
      {r.replay && <p>Тестовый счётчик, воспроизведение</p>}
      <p>{r.waitingForPeriod ? 'В выбранном периоде нет полной недели' : r.attempts.length ? labels[r.attempts[0].state] : 'Загрузка ожидается'}
        {r.stale && !r.waitingForPeriod && ' · требуется обновление'}</p>
      {r.attempts[0]?.reason && <p>{r.attempts[0].reason}</p>}
      <dl>
        <div><dt>Проверенный период</dt><dd>{r.coveredFrom && r.coveredThrough ? r.coveredFrom+' — '+r.coveredThrough : 'Нет подтверждённой загрузки'}</dd></div>
        {r.expectedThrough && <div><dt>Ожидаются данные по</dt><dd>{r.expectedThrough}</dd></div>}
        <div><dt>Последнее наблюдение</dt><dd>{r.lastObservation || 'Нет наблюдений'}</dd></div>
        <div><dt>Последняя попытка</dt><dd>{r.lastAttempt == null ? 'Пока не выполнялась' : stamp(r.lastAttempt)}</dd></div>
        <div><dt>Последняя успешная загрузка</dt><dd>{r.lastSuccess == null ? 'Пока не выполнялась' : stamp(r.lastSuccess)}</dd></div>
      </dl>
      {!!r.attempts.length && <details><summary>Последние загрузки</summary>
        {r.attempts.map((a,j) => <p key={j}>
          {stamp(a.started)} · {a.from} — {a.to} · {labels[a.state]}
          {a.finished != null && ' · '+Math.max(0,(a.finished-a.started)/1000).toLocaleString('ru-RU')+' с'}
          {a.rows != null && ' · строк '+a.rows}
          {a.pages != null && ' · страниц '+a.pages}
          {a.lag != null && ' · задержка источника '+a.lag+' с'}
          {a.sampleShare != null && ' · выборка '+(100*a.sampleShare).toLocaleString('ru-RU')+'%'}
          {a.reason && ' · '+a.reason}
        </p>)}
      </details>}
    </article>)}
  </section>;
}
