import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { useDiscussionDock } from './panel-size';
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
  decisionContext?: string;
  scope?: 'account';
  accountEvidence?: { lines: string[]; sources: Citation[] };
  caseId: string | null;
  product: string;
  products: string[];
  asOf: string;
  historical: boolean;
  release: Release | null;
  releases: Release[];
  delivered: Task[];
  trend?: Trend;
  competitor: Citation & {
    product: string; merchant: string; license: string | null; terms: string | null;
    competitorPrice: number; storePrice: number; checked: string; match?: string; sku: string | null; url?: string | null;
  } | null;
  customer: Citation & { tags: string; excerpt: string | null } | null;
  backlog: Task | null;
  measurement: Citation & { title: string; metric: string; comment: string; formula: string } | null;
  recommendation: { title: string; reason?: string | null; next: string; uncertainty?: string };
  measurementIssue: boolean;
};
type TrackerSearch = {
  local: boolean;
  caseId: string | null;
  items: { key: string; title: string; url: string; status?: string; exact: boolean; canComment: boolean; linkedToRelease: boolean }[];
};
type Action = (fn: () => Promise<void>) => void;
type Criteria = { product?: string; releaseId?: string; through?: string };

const date = (s: string) => s.split('-').reverse().join('.');
const number = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' });

function Source({ source }: { source: Citation }) {
  return <a className="decision-source" href={'#knowledge-source/' + source.version + '/' + encodeURIComponent(source.loc)}>
    {source.file} · {source.loc}
  </a>;
}

type OfferCheck = { text: string; url?: string; checkedAt: string; searchRequests: number; searchNote?: string };

function CurrentOffer({ offer }: { offer: NonNullable<Decision['competitor']> }) {
  const [check, setCheck] = useState<OfferCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { version, loc } = offer;
  const request = useRef(0);
  useEffect(() => {
    const id = ++request.current;
    post<OfferCheck | null>('competitor_check', { version, loc, savedOnly: true })
      .then(r => { if (request.current === id) setCheck(r); })
      .catch(e => { if (request.current === id) setError(e.message); });
    return () => { request.current++; };
  }, [version, loc]);
  async function refresh() {
    const id = ++request.current;
    setBusy(true);
    setError('');
    try {
      const result = await post<OfferCheck>('competitor_check', { version, loc });
      if (id === request.current) setCheck(result);
    } catch (e) {
      if (id === request.current) setError((e as Error).message);
    } finally { if (id === request.current) setBusy(false); }
  }
  return <div className="offer-check">
    {offer.url && <a href={offer.url} target="_blank" rel="noreferrer">Карточка из исследования ↗</a>}
    <button type="button" disabled={busy} onClick={() => void refresh()}>{busy ? 'Проверяем предложение…' : 'Проверить предложение сегодня'}</button>
    {error && <p role="alert">{error}</p>}
    {check && <div role="status">
      <strong>Веб-проверка · {new Date(check.checkedAt).toLocaleString('ru-RU')}</strong>
      <p>{check.text}</p>
      {check.url && <a href={check.url} target="_blank" rel="noreferrer">Страница проверки ↗</a>}
      <small>{check.searchNote} Запросов к Яндексу: {check.searchRequests}.</small>
    </div>}
  </div>;
}

function WeeklyIndex({ trend, caveat }: { trend: Trend; caveat?: string }) {
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
      {caveat && <p className="decision-caveat">{caveat}</p>}
      <details>
        <summary>16 недель и исходные строки</summary>
        <p>Изменение в процентах равно (среднее за 4 недели / среднее за 12 недель − 1) × 100.</p>
        <div className="table-scroll" role="region" aria-label="Недельные значения и источники" tabIndex={0}>
          <table className="numbers decision-table decision-weeks">
            <thead><tr><th scope="col">Неделя</th><th scope="col">Значение</th><th scope="col">Источник</th></tr></thead>
            <tbody>{[...trend.baseline.rows, ...trend.current.rows].map(week => <tr key={week.date}>
              <th scope="row"><time dateTime={week.date}>{date(week.date)}</time></th>
              <td>{number(week.value)}</td>
              <td><Source source={week} /></td>
            </tr>)}</tbody>
          </table>
        </div>
      </details>
    </> : <p>{trend.reason}</p>}
  </section>;
}

function CompetitorPrices({ offer, historical }: { offer: Decision['competitor']; historical: boolean }) {
  const terms = offer && [offer.sku && 'Артикул ' + offer.sku, offer.license?.replace(/^\//, ''), offer.terms].filter(Boolean).join(' · ');
  const partial = offer?.match === 'Частично';
  return <section className="paper decision-market">
    <h2>Проверка у конкурента</h2>
    {offer ? <>
      <p><strong>{offer.product}</strong> · Проверено <time dateTime={offer.checked}>{date(offer.checked)}</time></p>
      <div className="table-scroll" role="region" aria-label="Цены продавцов" tabIndex={0}>
        <table className="numbers decision-table">
          <thead><tr><th scope="col">Продавец</th><th scope="col">Цена</th></tr></thead>
          <tbody>
            <tr><th scope="row">{offer.merchant}</th><td>{money.format(offer.competitorPrice)}</td></tr>
            <tr><th scope="row">store.softline.ru</th><td>{money.format(offer.storePrice)}</td></tr>
          </tbody>
        </table>
      </div>
      {partial && <p className="decision-caveat">В источнике указана частичная сопоставимость. Для вывода о разнице цен нужно сверить лицензии.</p>}
      <Source source={offer} />
      <details>
        <summary>Условия сравнения</summary>
        {terms && <p>{terms}</p>}
        {partial && !terms && <p>Артикул, лицензия и условия в источнике отсутствуют.</p>}
        {!partial && <p>Источник отмечает предложения сопоставимыми. Цены относятся к этой позиции.</p>}
      </details>
      {!historical && <CurrentOffer key={offer.version + offer.loc} offer={offer} />}
    </> : <p>К этой дате нет проверенной строки с обеими ценами для семейства.</p>}
  </section>;
}

function TrackerActions({ product, releaseId, action }: { product: string; releaseId: string; action: Action }) {
  const [search, setSearch] = useState<TrackerSearch>();
  const [draft, setDraft] = useState<TrackerPreview>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const payload = { product, releaseId };
  const hasExact = search?.items.some(item => item.exact);
  const canDraft = !hasExact || search?.items.some(item => item.exact && item.canComment);
  async function run(op: 'search' | 'case' | 'draft', key?: string) {
    setPending(true);
    setError('');
    try {
      if (op === 'case' && search) {
        const { caseId } = await post<{ caseId: string }>('release-tracker-case', payload);
        setSearch({ ...search, caseId });
      } else if (op === 'draft' && search?.caseId) {
        setDraft(await post<TrackerPreview>('release-tracker-draft', { ...payload, caseId: search.caseId, key }));
      } else if (op === 'search') {
        setSearch(await post<TrackerSearch>('release-tracker', payload));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }
  return <section className="paper">
    <h3>Задача по решению</h3>
    <button type="button" disabled={pending} onClick={() => void run('search')}>
      {pending && !search ? 'Ищем…' : search ? 'Повторить поиск' : 'Найти задачу и проверить дубли'}
    </button>
    {error && <p role="alert">{error}</p>}
    {search && <>
      <p role="status">{search.items.length ? 'Найдены задачи' : 'Совпадений по теме не найдено'} · {search.local ? 'Локальный бэклог' : 'Redmine'}</p>
      <ul className="decision-issues">
        {search.items.map(item => <li key={item.key}>
          <div>
            <a href={item.url}>{item.key} · {item.title}</a>
            <small>{[item.status, item.linkedToRelease ? 'Связана с релизом в архиве' : item.exact && 'Совпадает по названию',
              !item.canComment && 'Доступна для просмотра в Redmine'].filter(Boolean).join(' · ')}</small>
          </div>
          {search.caseId && item.canComment && (!hasExact || item.exact) && <button
            type="button" disabled={pending} onClick={() => void run('draft', item.key)}
          >Подготовить комментарий</button>}
        </li>)}
      </ul>
      {!search.caseId && canDraft && <button
        type="button" disabled={pending} onClick={() => void run('case')}
      >Создать связанный разбор</button>}
      {search.caseId && !hasExact && <button
        type="button" disabled={pending} onClick={() => void run('draft')}
      >Подготовить черновик задачи</button>}
    </>}
    {draft && <PreviewCard item={draft} action={action} reload={async () => {}} />}
  </section>;
}

export function ReleaseDecision({
  action, renderChat, initialRelease,
}: {
  action: Action;
  initialRelease?: string;
  renderChat: (thread: string, caseId: string | undefined, releaseId: string, product: string,
    decisionContext: string | undefined) => React.ReactNode;
}) {
  const [criteria, setCriteria] = useState<Criteria>(() => history.state?.releaseDecision ?? { releaseId: initialRelease });
  const [data, setData] = useState<Decision>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cut, setCut] = useState(criteria.through || '');
  const [thread, setThread] = useState('');
  const [chatError, setChatError] = useState('');
  const chatDock = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  useDiscussionDock(chatDock, true);

  useEffect(() => {
    const current = ++request.current;
    async function load() {
      let decision: Decision;
      try {
        decision = await post<Decision>('release_decision', criteria);
      } catch (err) {
        if (request.current === current) {
          setError((err as Error).message);
          setLoading(false);
        }
        return;
      }
      if (request.current !== current) return;
      setData(decision);
      setLoading(false);
      if (!decision.release) return;

      try {
        const { id } = await post<{ id: string }>('release-thread', {
          product: decision.product, releaseId: decision.release.id, decisionContext: decision.decisionContext,
        });
        if (request.current === current) setThread(id);
      } catch (err) {
        if (request.current === current) setChatError((err as Error).message);
      }
    }
    void load();
    return () => { request.current++; };
  }, [criteria]);

  function select(next: typeof criteria) {
    request.current++;
    setThread('');
    setChatError('');
    setError('');
    setLoading(true);
    history.replaceState({ ...history.state, releaseDecision: next }, '');
    setCriteria(next);
  }

  const release = data?.release;
  const indexCaveat = data?.trend?.available && !data.measurementIssue ? data.recommendation.uncertainty : undefined;
  const selectedProduct = criteria.product ?? data?.product;
  const productReleases = data?.product === selectedProduct ? data?.releases : undefined;
  const selectedRelease = productReleases?.find(row => row.id === (criteria.releaseId ?? release?.id));
  const filters = data && <form className="paper decision-filters" onSubmit={event => {
    event.preventDefault();
    if (cut) select({ product: selectedProduct, through: cut,
      releaseId: selectedRelease && selectedRelease.date <= cut ? selectedRelease.id : undefined });
  }}>
    <label>Семейство или раздел
      <select value={selectedProduct} onChange={event =>
        select({ product: event.target.value, through: criteria.through })}>
        {data.products.map(product => <option key={product} value={product}>{product === 'ЛК' ? 'Личный кабинет' : product}</option>)}
      </select>
    </label>
    <label>Релиз
      <select value={criteria.releaseId || release?.id || ''} disabled={loading || !productReleases?.length} onChange={event =>
        select({ product: selectedProduct, through: criteria.through, releaseId: event.target.value })}>
        {!data.releases.length && <option value="">Нет выпущенных функций</option>}
        {data.releases.map(row => <option key={row.id} value={row.id}>{row.id} · {date(row.date)}</option>)}
      </select>
    </label>
    <label>Дата среза <input type="date" value={cut} onChange={event => setCut(event.target.value)} /></label>
    <button type="submit" disabled={!cut}>Показать на дату</button>
    {criteria.through && <button type="button" onClick={() => {
      setCut('');
      select({ product: selectedProduct, releaseId: selectedRelease?.id });
    }}>Вернуться к текущему срезу</button>}
  </form>;
  const details = <>
    {error ? <p role="alert">{error}</p> : loading ? <p role="status">Читаем источники…</p> : data && <>
      <section className="signal-panel decision-hero" aria-labelledby="decision-subject">
        <div className="decision-next">
          <span className="state">{data.historical ? 'Исторический срез' : 'Срез загруженных данных'} · {date(data.asOf)}</span>
          <h2 id="decision-subject">{data.recommendation.title}</h2>
          {data.recommendation.reason && <p>{data.recommendation.reason}</p>}
          <div>
            <strong>Следующий шаг</strong>
            <p>{data.recommendation.next}</p>
          </div>
        </div>
        <div className="decision-context">
          <h3>{data.scope === 'account' ? 'Личный кабинет' : data.product}</h3>
          {release ? <>
            <p><strong>{release.id} · {date(release.date)}</strong></p>
            <p>{release.description}</p>
            <Source source={release} />
            {!!data.delivered.length && <details>
              <summary>Связанные задачи</summary>
              <ul>{data.delivered.map(task => <li key={task.id}>{task.id} · {task.title} <Source source={task} /></li>)}</ul>
            </details>}
          </> : <p>К этой дате в календаре нет выпущенной функции семейства.</p>}
        </div>
      </section>
      {data.scope === 'account' && <section className="paper">
        <h2>Переходы из рекомендаций</h2>
        {data.accountEvidence ? <>
          {data.accountEvidence.lines.map(line => <p key={line}>{line}</p>)}
          {!!data.accountEvidence.sources.length && <details><summary>Источники расчёта</summary><ul>
            {data.accountEvidence.sources.map(s => <li key={s.version + s.loc}><Source source={s} /></li>)}
          </ul></details>}
        </> : <p>Для выбранной функции в календаре не указан показатель визитов с кликом по рекомендациям.</p>}
      </section>}
      {data.trend && <WeeklyIndex trend={data.trend} caveat={indexCaveat} />}
    </>}
    {!error && !loading && data?.historical && <p className="muted">Срез по датам событий в загруженной версии архива. Для части источников дата публикации неизвестна.</p>}
    {filters}
    {!error && !loading && data && <>
      {data.scope !== 'account' && <div className="decision-evidence">
        <CompetitorPrices offer={data.competitor} historical={data.historical} />
        <section className="paper"><details>
          <summary>Интервью покупателей</summary>
          {data.customer?.excerpt ? <>
            <blockquote>«{data.customer.excerpt}»</blockquote>
            <p>Фрагмент интервью без даты в источнике.</p>
          </> : <p>{data.historical ? 'В архиве нет датированного интервью для этого среза.'
            : data.customer ? 'В источнике доступны темы ответа; безопасная дословная цитата отсутствует.'
              : 'В загруженных интервью нет подтверждённой фразы для этого семейства.'}</p>}
          {data.customer && <Source source={data.customer} />}
          {!indexCaveat && data.recommendation.uncertainty && <p>{data.recommendation.uncertainty}</p>}
        </details></section>
        <section className="paper"><details>
          <summary>Бэклог и измерение</summary>
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
        </details></section>
      </div>}
      {release && !data.historical && <TrackerActions key={data.product + '/' + release.id}
        product={data.product} releaseId={release.id} action={action} />}
    </>}
  </>;
  const chatStatus = error ? 'Чат разбора недоступен.'
    : loading || release ? 'Загружаем чат разбора…' : 'На выбранную дату нет релиза для обсуждения.';

  return <div className="release-decision">
    <nav className="decision-breadcrumbs" aria-label="Путь к разбору релиза">
      <a className="crumb" href="#releases-list">← Журнал релизов</a>
    </nav>
    <div className="page-head"><h1>Разбор релиза</h1></div>
    <div className="decision-layout">
      <div className="case-discussion decision-chat" ref={chatDock} role="complementary" aria-label="Чат разбора">
        {thread && release && data ? renderChat(thread, data.caseId || undefined, release.id, data.product, data.decisionContext)
          : <p className="paper" role={chatError ? 'alert' : 'status'}>{chatError || chatStatus}</p>}
      </div>
      <div className="decision-main">{details}</div>
    </div>
  </div>;
}
