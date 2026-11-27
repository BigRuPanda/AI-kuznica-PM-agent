import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { post } from './team-data';
import { PreviewCard, type TrackerPreview } from './tracking';
import './release-decision.css';

type Citation = { file: string; loc: string; version: string };
type Release = Citation & { id: string; date: string; description: string; metrics: string[] };
type Task = Citation & { id: string; title: string; status: string; description: string | null };
type Week = Citation & { date: string; value: number };
type Period = { start: string; end: string; mean: number; rows: Week[] };
type Trend =
  | { available: true; baseline: Period; current: Period; change: number | null }
  | { available: false; reason: string };
type Decision = {
  caseId: string | null;
  product: string;
  products: string[];
  asOf: string;
  historical: boolean;
  release: Release | null;
  releases: Release[];
  delivered: Task[];
  trend: Trend;
  competitor: Citation & {
    product: string; merchant: string; license: string | null; terms: string | null;
    competitorPrice: number; storePrice: number; checked: string; match?: string; sku: string | null;
  } | null;
  customer: Citation & { tags: string; excerpt: string | null } | null;
  backlog: Task | null;
  measurement: Citation & { title: string; metric: string; comment: string; formula: string } | null;
  recommendation: { title: string; reason: string | null; next: string; uncertainty: string };
  measurementIssue: boolean;
};
type TrackerSearch = {
  local: boolean;
  items: { key: string; title: string; url: string; status?: string; exact: boolean; canComment: boolean }[];
};
type Action = (fn: () => Promise<void>) => void;

const date = (s: string) => s.split('-').reverse().join('.');
const number = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' });

function Source({ source }: { source: Citation }) {
  return <a className="decision-source" href={'#knowledge-source/' + source.version + '/' + encodeURIComponent(source.loc)}>
    {source.file} · {source.loc}
  </a>;
}

function WeeklyIndex({ trend }: { trend: Trend }) {
  return <section className="paper decision-trend">
    <h2>Недельный индекс заказов</h2>
    {trend.available ? <>
      <div className="decision-values">
        <div><small>Предыдущие 12 недель</small><strong>{number(trend.baseline.mean)}</strong>
          <span>{date(trend.baseline.start)} — {date(trend.baseline.end)}</span></div>
        <Icon name="arrow" />
        <div><small>Последние 4 полные недели</small><strong>{number(trend.current.mean)}</strong>
          <span>{date(trend.current.start)} — {date(trend.current.end)}</span></div>
        {trend.change !== null && <span className="decision-change" data-negative={trend.change < 0}>
          {trend.change > 0 ? '+' : trend.change < 0 ? '−' : ''}{number(Math.abs(trend.change))}%
        </span>}
      </div>
      <p>Среднее по каждому периоду. Для оценки влияния релиза нужна отдельная проверка.</p>
      <details>
        <summary>16 недель и исходные строки</summary>
        <ul className="decision-weeks">
          {[...trend.baseline.rows, ...trend.current.rows].map(week => <li key={week.date}>
            <span>{date(week.date)} · <b>{number(week.value)}</b></span>
            <Source source={week} />
          </li>)}
        </ul>
      </details>
    </> : <p>{trend.reason}</p>}
  </section>;
}

function TrackerActions({ caseId, releaseId, action }: { caseId: string; releaseId: string; action: Action }) {
  const [search, setSearch] = useState<TrackerSearch>();
  const [draft, setDraft] = useState<TrackerPreview>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const payload = { caseId, releaseId };
  async function run(key?: string, prepare = false) {
    setPending(true);
    setError('');
    try {
      if (prepare) setDraft(await post<TrackerPreview>('release-tracker-draft', { ...payload, key }));
      else setSearch(await post<TrackerSearch>('release-tracker', payload));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }
  return <section className="paper">
    <h3>Задача по решению</h3>
    <button type="button" disabled={pending} onClick={() => void run()}>
      {pending && !search ? 'Ищем…' : search ? 'Повторить поиск' : 'Найти задачу и проверить дубли'}
    </button>
    {error && <p role="alert">{error}</p>}
    {search && <>
      <p role="status">{search.items.length ? 'Найдены задачи' : 'Совпадений по теме не найдено'} · {search.local ? 'Локальный бэклог' : 'Redmine'}</p>
      <ul className="decision-issues">
        {search.items.map(item => <li key={item.key}>
          <div>
            <a href={item.url}>{item.key} · {item.title}</a>
            <small>{[item.status, item.exact && 'Совпадает по названию',
              !item.canComment && 'Доступна для просмотра в Redmine'].filter(Boolean).join(' · ')}</small>
          </div>
          {item.canComment && (!search.items.some(hit => hit.exact) || item.exact) && <button
            type="button" disabled={pending} onClick={() => void run(item.key, true)}
          >Подготовить комментарий</button>}
        </li>)}
      </ul>
      {!search.items.some(item => item.exact) && <button
        type="button" disabled={pending} onClick={() => void run(undefined, true)}
      >Подготовить черновик задачи</button>}
    </>}
    {draft && <PreviewCard item={draft} action={action} reload={async () => {}} />}
  </section>;
}

export function ReleaseDecision({
  action, renderChat,
}: {
  action: Action;
  renderChat: (thread: string, caseId: string, releaseId: string) => React.ReactNode;
}) {
  const [criteria, setCriteria] = useState<{ product?: string; releaseId?: string; through?: string }>({});
  const [data, setData] = useState<Decision>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cut, setCut] = useState('');
  const [thread, setThread] = useState('');
  const [opening, setOpening] = useState(false);
  const chatAnchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    post<Decision>('release_decision', criteria).then(result => {
      if (active) setData(result);
    }).catch(err => {
      if (active) setError(err.message);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [criteria]);
  useEffect(() => {
    if (thread) chatAnchor.current?.scrollIntoView({ block: 'start' });
  }, [thread]);
  function select(next: typeof criteria) {
    setThread('');
    setError('');
    setLoading(true);
    setCriteria(next);
  }
  async function openChat(caseId: string) {
    if (thread) {
      chatAnchor.current?.scrollIntoView({ block: 'start' });
      return;
    }
    setOpening(true);
    try {
      setThread((await post<{ id: string }>('case-thread', { caseId })).id);
    } finally {
      setOpening(false);
    }
  }
  const release = data?.release;
  return <div className="release-decision">
    <a className="crumb" href="#overview">← Обзор</a>
    <div className="page-head"><h1>Решение по релизу</h1></div>
    {data && <form className="paper decision-filters" onSubmit={event => {
      event.preventDefault();
      if (cut) select({ product: data.product, through: cut });
    }}>
      <label>Семейство
        <select value={criteria.product || data.product} disabled={opening} onChange={event =>
          select({ product: event.target.value, through: criteria.through })}>
          {data.products.map(product => <option key={product}>{product}</option>)}
        </select>
      </label>
      <label>Релиз
        <select value={criteria.releaseId || release?.id || ''} disabled={opening || loading || !data.releases.length} onChange={event =>
          select({ product: data.product, through: criteria.through, releaseId: event.target.value })}>
          {!data.releases.length && <option value="">Нет выпущенных функций</option>}
          {data.releases.map(row => <option key={row.id} value={row.id}>{row.id} · {date(row.date)}</option>)}
        </select>
      </label>
      <label>Дата среза <input type="date" value={cut} onChange={event => setCut(event.target.value)} /></label>
      <button type="submit" disabled={!cut || opening}>Показать на дату</button>
      {criteria.through && <button type="button" disabled={opening} onClick={() => {
        setCut('');
        select({ product: data.product });
      }}>Вернуться к текущему срезу</button>}
    </form>}
    {error ? <p role="alert">{error}</p> : loading ? <p role="status">Читаем источники…</p> : data && <>
      <section className="signal-panel decision-hero" aria-labelledby="decision-subject">
        <div>
          <span className="state">{data.historical ? 'Исторический срез' : 'Срез загруженных данных'} · {date(data.asOf)}</span>
          <h2 id="decision-subject">{data.product}</h2>
          {release ? <>
            <p><b>{release.id} · {date(release.date)}</b></p>
            <p>{release.description}</p>
            <Source source={release} />
            {!!data.delivered.length && <p>Связанные задачи: {data.delivered.map(task => <span key={task.id}>
              {task.id} · {task.title} <Source source={task} />
            </span>)}</p>}
          </> : <p>К этой дате в календаре нет выпущенной функции семейства.</p>}
        </div>
        <div className="decision-next">
          <h3>{data.recommendation.title}</h3>
          <p>{data.recommendation.next}</p>
          {data.caseId && release && !data.historical && <>
            <button type="button" className="primary" disabled={opening} onClick={() => action(() => openChat(data.caseId!))}>
              {opening ? 'Открываем чат…' : 'Открыть чат разбора'}
            </button>
            <a href={'#case/' + data.caseId + '/effect'}>Настроить проверку эффекта <Icon name="arrow" /></a>
          </>}
        </div>
      </section>
      {data.historical && <p className="muted">Срез по датам событий в загруженной версии архива. Для части источников дата публикации неизвестна.</p>}
      <WeeklyIndex trend={data.trend} />
      <div className="decision-evidence">
        <section className="paper">
          <h2>Измерение и бэклог</h2>
          {data.backlog ? <>
            <p><b>{data.backlog.id} · {data.backlog.title}</b> · {data.backlog.status}</p>
            {data.backlog.description && <p>{data.backlog.description}</p>}
            <Source source={data.backlog} />
          </> : <p>В бэклоге на эту дату нет открытой задачи, прямо связанной с семейством.</p>}
          {data.measurement && <>
            <p><b>{data.measurement.title}</b></p>
            <p>{data.measurement.comment}</p>
            <details><summary>Как считается показатель</summary><p>{data.measurement.formula}</p></details>
            <Source source={data.measurement} />
          </>}
        </section>
        <section className="paper">
          <h2>Опыт покупателей</h2>
          {data.customer?.excerpt ? <>
            <blockquote>«{data.customer.excerpt}»</blockquote>
            <p>Фрагмент интервью без даты в источнике.</p>
          </> : <p>{data.historical ? 'В архиве нет датированного интервью для этого среза.'
            : data.customer ? 'В источнике доступны темы ответа; безопасная дословная цитата отсутствует.'
              : 'В загруженных интервью нет подтверждённой фразы для этого семейства.'}</p>}
          {data.customer && <Source source={data.customer} />}
          <p>{data.recommendation.uncertainty}</p>
        </section>
        <section className="paper">
          <h2>Проверка у конкурента</h2>
          {data.competitor ? <>
            <p><b>{data.competitor.product}</b></p>
            <p>{[data.competitor.sku && 'Артикул ' + data.competitor.sku,
              data.competitor.license?.replace(/^\//, ''), data.competitor.terms].filter(Boolean).join(' · ')}</p>
            <dl className="decision-prices">
              <div><dt>{data.competitor.merchant}</dt><dd>{money.format(data.competitor.competitorPrice)}</dd></div>
              <div><dt>store.softline.ru</dt><dd>{money.format(data.competitor.storePrice)}</dd></div>
            </dl>
            <p>Проверено {date(data.competitor.checked)}. {data.competitor.match === 'Частично'
              ? 'В источнике указана частичная сопоставимость. Для вывода о разнице цен нужно сверить лицензии.'
              : 'Источник отмечает предложения сопоставимыми. Цены относятся к этой позиции.'}</p>
            <Source source={data.competitor} />
          </> : <p>К этой дате нет проверенной строки с обеими ценами для семейства.</p>}
        </section>
      </div>
      {thread && data.caseId && release && <div className="decision-chat" ref={chatAnchor}>
        <h2>Чат разбора · {release.id}</h2>
        <div className="decision-chat-grid">
          <TrackerActions key={data.caseId + release.id} caseId={data.caseId} releaseId={release.id} action={action} />
          {renderChat(thread, data.caseId, release.id)}
        </div>
      </div>}
    </>}
  </div>;
}
