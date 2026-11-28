import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { DataForm } from './forms';
import { Icon } from './icons';
import type { Release } from './team-data';
import { api, type Journal } from './types';
import './releases.css';

const filters = [
  ['all', 'Все'],
  ['calendar', 'Из календаря'],
  ['metrics', 'С метриками'],
] as const;
type Filter = typeof filters[number][0];
type Source = Exclude<Filter, 'all'>;
type Form = 'release' | 'import';
type Row = { id: string; title: string; date: string } & (
  { source: 'calendar'; release: Release } | { source: 'metrics' }
);
const sourceNames: Record<Source, string> = { calendar: 'Календарь', metrics: 'CSV' };
const isoDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow',
  year: 'numeric', month: '2-digit', day: '2-digit' });
const displayDate = (date: string) => date.split('-').reverse().join('.');
const calendarDate = (value: Release['release_date']) =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : '';
const metricReleaseHref = (id: string) => '#release/' + encodeURIComponent(id);
export const releaseAssessmentHref = (id: string) => '#release-decision/' + encodeURIComponent(id);

export function ReleaseJournal({ calendar, initialFilter, admin, archiveOnly, onPlan, renderCases }: {
  calendar: Release[]; initialFilter: Filter; admin: boolean; archiveOnly: boolean;
  onPlan: (id: string) => void; renderCases: (id: string) => ReactNode;
}) {
  const [filter, setFilter] = useState(initialFilter);
  const [journal, setJournal] = useState<Journal | null>(null);
  const [error, setError] = useState('');
  const [generation, refresh] = useState(0);
  const [form, setForm] = useState<Form | null>(null);
  const [expandedRelease, setExpandedRelease] = useState<string | null>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    let current = true;
    setError('');
    api<Journal>('journal').then(journal => { if (current) setJournal(journal); })
      .catch(error => { if (current) setError(error.message); });
    return () => { current = false; };
  }, [generation]);
  const rows: Row[] = [
    ...calendar.map((item): Row => ({ id: item.release_id, title: item.description || item.release_id,
      date: calendarDate(item.release_date), source: 'calendar', release: item })),
    ...(journal?.releases ?? []).map((item): Row => ({ id: item.id, title: item.title,
      date: isoDate.format(item.launch), source: 'metrics' })),
  ];
  const visible = rows.filter(row => filter === 'all' || row.source === filter)
    .sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title, 'ru') || a.id.localeCompare(b.id));
  const showActions = visible.some(row => row.source === 'calendar');
  const loading = !journal && !error && filter !== 'calendar';
  const canImport = admin && !archiveOnly;
  const canCreate = admin && Boolean(journal?.datasets.length);
  function openForm(kind: Form) {
    if (menu.current) {
      menu.current.open = false;
      menu.current.querySelector('summary')?.focus();
    }
    setForm(kind);
  }
  return <section className="release-journal">
    <header className="page-head">
      <h1>Релизы</h1>
    </header>
    <div className="paper release-table-card">
      <div className="toolbar release-journal-toolbar">
        <label>
          Источник
          <select value={filter} onChange={event => setFilter(event.target.value as Filter)}>
            {filters.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        {journal && (canImport || canCreate) && <details className="release-management" ref={menu}>
          <summary>Управление</summary>
          <div className="release-management-actions">
            {canCreate && <button type="button" onClick={() => openForm('release')}>Добавить релиз</button>}
            {canImport && <button type="button" onClick={() => openForm('import')}>Импорт CSV</button>}
          </div>
        </details>}
      </div>
      {error && filter !== 'calendar' && <div className="release-list-status">
        <p role="alert" className="error">Не удалось загрузить релизы с метриками. {error}</p>
        <button type="button" onClick={() => refresh(n => n + 1)}>Повторить</button>
      </div>}
      {loading && <p role="status" className="release-list-note">Загружаем релизы с метриками…</p>}
      {visible.length > 0 ? <table role="table" className="release-table release-journal-table" aria-label="Журнал релизов">
        <colgroup>
          <col /><col className="release-date-col" /><col className="release-source-col" />
          {showActions && <col className="release-actions-col" />}
        </colgroup>
        <thead role="rowgroup"><tr role="row">
          <th role="columnheader" scope="col">Релиз</th>
          <th role="columnheader" scope="col">Дата выпуска</th>
          <th role="columnheader" scope="col">Источник</th>
          {showActions && <th role="columnheader" scope="col">Действия</th>}
        </tr></thead>
        <tbody role="rowgroup">{visible.map(row => {
          const release = row.source === 'calendar' ? row.release : undefined;
          const href = release ? release.decisionAvailable && releaseAssessmentHref(row.id) : metricReleaseHref(row.id);
          const linkedTasks = release && releaseTasks(release);
          const linkedCases = release && renderCases(row.id);
          const hasTasks = Boolean(linkedTasks?.detailed.length || linkedTasks?.otherIds.length);
          const detailsLabel = hasTasks
            ? linkedCases ? 'Задачи и разборы' : 'Задачи'
            : linkedCases ? 'Разборы' : '';
          const expanded = Boolean(detailsLabel && expandedRelease === row.id);
          const detailsId = 'release-links-' + encodeURIComponent(row.id);
          return <Fragment key={row.source + '/' + row.id}>
            <tr role="row" className="release-row">
              <th role="rowheader" scope="row" className="release-name">
                {row.title !== row.id && <small className="release-id">{row.id}</small>}
                {href ? <a className="release-entry-link" href={href}>
                  <span>{row.title}</span><span className="release-open-icon"><Icon name="arrow" /></span>
                </a> : <span>{row.title}</span>}
              </th>
              <td role="cell" className="release-date">{row.date ? <time dateTime={row.date}>{displayDate(row.date)}</time> : 'Не указана'}</td>
              <td role="cell" className="release-source">{sourceNames[row.source]}</td>
              {showActions && <td role="cell" className="release-actions">
                {release && <div className="release-row-actions">
                  <button type="button" className="text-action" aria-label={'Запланировать разбор ' + row.id}
                    onClick={() => onPlan(row.id)}>Запланировать разбор</button>
                  {detailsLabel && <button type="button" className="text-action" aria-expanded={expanded}
                    aria-controls={expanded ? detailsId : undefined}
                    aria-label={'Связанные ' + detailsLabel.toLowerCase() + ' ' + row.id}
                    onClick={() => setExpandedRelease(expanded ? null : row.id)}>{detailsLabel}<Icon name="down" /></button>}
                </div>}
              </td>}
            </tr>
            {expanded && linkedTasks && <tr role="row" className="release-related-row">
              <td role="cell" colSpan={showActions ? 4 : 3} id={detailsId}>
                {hasTasks && <RelatedTasks {...linkedTasks} />}
                {linkedCases && <section><h3>Связанные разборы</h3>{linkedCases}</section>}
              </td>
            </tr>}
          </Fragment>;
        })}</tbody>
      </table> : !loading && (!error || filter === 'calendar') && <p role="status" className="release-list-note">
        {filter === 'metrics' ? 'Релизов с метриками пока нет.' : 'Релизов пока нет.'}
      </p>}
    </div>
    {journal && form && <DataForm kind={form} journal={journal} close={() => setForm(null)}
      onDone={id => {
        setForm(null);
        if (id) location.hash = metricReleaseHref(id);
        else refresh(n => n + 1);
      }} />}
  </section>;
}

function releaseTasks(release: Release) {
  const tasks = release.relatedTasks ?? [];
  const taskIds = String(release.related_task_ids ?? '').split(/[,;]/u).map(key => key.trim())
    .filter(key => key && !/^[-—–]$|^(?:нет|не указан|отсутств)/iu.test(key));
  const detailed = tasks.filter(task => task.title || task.status);
  const otherIds = [...new Set([...taskIds, ...tasks.map(task => task.id)])]
    .filter(key => !detailed.some(task => task.id === key));
  return { detailed, otherIds };
}

function RelatedTasks({ detailed, otherIds }: ReturnType<typeof releaseTasks>) {
  return <section>
    <h3>Связанные задачи</h3>
    {detailed.length > 0 && <table className="release-table" aria-label="Связанные задачи">
      <thead><tr><th scope="col">Номер</th><th scope="col">Задача</th><th scope="col">Статус</th></tr></thead>
      <tbody>{detailed.map(task => <tr key={task.id}><th scope="row">{task.id}</th>
        <td>{task.title || '—'}</td><td>{task.status || '—'}</td></tr>)}</tbody>
    </table>}
    {otherIds.length > 0 && <ul className="release-task-ids">{otherIds.map(key => <li key={key}>{key}</li>)}</ul>}
  </section>;
}
