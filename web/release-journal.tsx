import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { DataForm } from './forms';
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
    <div className="page-head release-page-head">
      <h1 id="release-journal-title">Журнал релизов</h1>
      {journal && (canImport || canCreate) && <details className="release-management" ref={menu}>
        <summary>Управление</summary>
        <div className="release-management-actions">
          {canCreate && <button type="button" onClick={() => openForm('release')}>Добавить релиз</button>}
          {canImport && <button type="button" onClick={() => openForm('import')}>Импорт CSV</button>}
        </div>
      </details>}
    </div>
    <div className="release-filters" role="group" aria-label="Источник релизов">
      {filters.map(([key, label]) => <button key={key} type="button" aria-pressed={filter === key}
        onClick={() => setFilter(key)}>{label}</button>)}
    </div>
    {error && filter !== 'calendar' && <div className="actions release-list-status">
      <p role="alert" className="error">Не удалось загрузить релизы с метриками. {error}</p>
      <button type="button" onClick={() => refresh(n => n + 1)}>Повторить</button>
    </div>}
    {loading && <p role="status" className="muted">Загружаем релизы с метриками…</p>}
    {visible.length > 0 ? <div className="release-table-card">
      <table className="release-table release-journal-table" aria-labelledby="release-journal-title">
        <thead><tr><th scope="col">Релиз</th><th scope="col">Дата выпуска</th><th scope="col">Источник</th></tr></thead>
        <tbody>{visible.map(row => {
          const release = row.source === 'calendar' ? row.release : undefined;
          const href = release ? release.decisionAvailable && releaseAssessmentHref(row.id) : metricReleaseHref(row.id);
          const linkedTasks = release && releaseTasks(release);
          const linkedCases = release && renderCases(row.id);
          const hasTasks = Boolean(linkedTasks?.detailed.length || linkedTasks?.otherIds.length);
          const detailsLabel = hasTasks
            ? linkedCases ? 'Связанные задачи и разборы' : 'Связанные задачи'
            : linkedCases ? 'Связанные разборы' : '';
          const expanded = Boolean(detailsLabel && expandedRelease === row.id);
          const detailsId = 'release-links-' + encodeURIComponent(row.id);
          return <Fragment key={row.source + '/' + row.id}>
            <tr className="release-row">
              <th scope="row">
                {href ? <a href={href}>{row.title}</a> : <span>{row.title}</span>}
                {row.title !== row.id && <small>{row.id}</small>}
                {release && <div className="actions release-row-actions">
                  <button type="button" className="text-action" aria-label={'Запланировать разбор ' + row.id}
                    onClick={() => onPlan(row.id)}>Запланировать разбор</button>
                  {detailsLabel && <button type="button" className="text-action" aria-expanded={expanded}
                    aria-controls={expanded ? detailsId : undefined} aria-label={detailsLabel + ' ' + row.id}
                    onClick={() => setExpandedRelease(expanded ? null : row.id)}>{detailsLabel}</button>}
                </div>}
              </th>
              <td>{row.date ? <time dateTime={row.date}>{displayDate(row.date)}</time> : 'Не указана'}</td>
              <td>{sourceNames[row.source]}</td>
            </tr>
            {expanded && linkedTasks && <tr className="release-related-row">
              <td colSpan={3} id={detailsId}>
                {hasTasks && <RelatedTasks {...linkedTasks} />}
                {linkedCases && <section><h3>Связанные разборы</h3>{linkedCases}</section>}
              </td>
            </tr>}
          </Fragment>;
        })}</tbody>
      </table>
    </div> : !loading && !(error && filter === 'metrics') && <p className="paper muted">Релизов пока нет.</p>}
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
