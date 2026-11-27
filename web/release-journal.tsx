import { useEffect, useRef, useState, type ReactNode } from 'react';
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
type Row = { id: string; title: string; date: string; source: Source };
const sourceNames: Record<Source, string> = { calendar: 'Календарь', metrics: 'CSV' };
const isoDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow',
  year: 'numeric', month: '2-digit', day: '2-digit' });
const displayDate = (date: string) => date.split('-').reverse().join('.');
const calendarDate = (value: Release['release_date']) =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : '';
const hrefFor = (source: Source, id: string) =>
  '#' + (source === 'calendar' ? 'release-detail' : 'release') + '/' + encodeURIComponent(id);

export function ReleaseJournal({ calendar, initialFilter, admin, archiveOnly }: {
  calendar: Release[]; initialFilter: Filter; admin: boolean; archiveOnly: boolean;
}) {
  const [filter, setFilter] = useState(initialFilter);
  const [journal, setJournal] = useState<Journal | null>(null);
  const [error, setError] = useState('');
  const [generation, refresh] = useState(0);
  const [form, setForm] = useState<Form | null>(null);
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
      date: calendarDate(item.release_date), source: 'calendar' })),
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
        <tbody>{visible.map(row => <tr key={row.source + '/' + row.id} className="release-row">
          <th scope="row"><a href={hrefFor(row.source, row.id)}>{row.title}</a>
            {row.title !== row.id && <small>{row.id}</small>}</th>
          <td>{row.date ? <time dateTime={row.date}>{displayDate(row.date)}</time> : 'Не указана'}</td>
          <td>{sourceNames[row.source]}</td>
        </tr>)}</tbody>
      </table>
    </div> : !loading && !(error && filter === 'metrics') && <p className="paper muted">Релизов пока нет.</p>}
    {journal && form && <DataForm kind={form} journal={journal} close={() => setForm(null)}
      onDone={id => {
        setForm(null);
        if (id) location.hash = hrefFor('metrics', id);
        else refresh(n => n + 1);
      }} />}
  </section>;
}

export function CalendarRelease({ release, onPlan, renderCases }: {
  release: Release | undefined; onPlan: () => void; renderCases: () => ReactNode;
}) {
  const canDecide = Boolean(release?.decisionAvailable);
  const date = calendarDate(release?.release_date ?? null);
  const tasks = release?.relatedTasks ?? [];
  const taskIds = String(release?.related_task_ids ?? '').split(/[,;]/u).map(key => key.trim())
    .filter(key => key && !/^[-—–]$|^(?:нет|не указан|отсутств)/iu.test(key));
  const detailed = tasks.filter(task => task.title || task.status);
  const otherIds = [...new Set([...taskIds, ...tasks.map(task => task.id)])]
    .filter(key => !detailed.some(task => task.id === key));
  return <section className="calendar-release">
    <a className="crumb" href="#releases-list">← Журнал релизов</a>
    {release ? <>
      <header className="page-head">
        <small>{release.release_id} · {date ? <time dateTime={date}>{displayDate(date)}</time> : 'Дата не указана'}</small>
        <h1>{release.description || release.release_id}</h1>
        <div className="actions">
          {canDecide && <a className="primary" href={'#release-decision/' + encodeURIComponent(release.release_id)}>Разбор релиза</a>}
          <button type="button" className={canDecide ? 'text-action' : 'primary'}
            aria-label={'Запланировать разбор ' + release.release_id} onClick={onPlan}>
            Запланировать разбор
          </button>
        </div>
      </header>
      <section className="paper">
        <h2>Связанные задачи</h2>
        {detailed.length > 0 && <table className="release-table" aria-label="Связанные задачи">
          <thead><tr><th scope="col">Номер</th><th scope="col">Задача</th><th scope="col">Статус</th></tr></thead>
          <tbody>{detailed.map(task => <tr key={task.id}><th scope="row">{task.id}</th>
            <td>{task.title || '—'}</td><td>{task.status || '—'}</td></tr>)}</tbody>
        </table>}
        {otherIds.length > 0 && <ul className="release-task-ids">{otherIds.map(key => <li key={key}>{key}</li>)}</ul>}
        {!detailed.length && !otherIds.length && <p className="muted">Связанных задач пока нет.</p>}
      </section>
      <section className="paper"><h2>Разборы релиза</h2>{renderCases()}</section>
    </> : <p role="alert">Запись календаря не найдена.</p>}
  </section>;
}
