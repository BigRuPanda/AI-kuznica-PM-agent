import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DataForm } from './forms';
import { Icon } from './icons';
import { ReleaseCaseLink } from './release-case-link';
import { ReleaseHelp } from './release-help';
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
type Entry = { id: string; title: string; date: string } & (
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
  const entries: Entry[] = [
    ...calendar.map((item): Entry => ({ id: item.release_id, title: item.description || item.release_id,
      date: calendarDate(item.release_date), source: 'calendar', release: item })),
    ...(journal?.releases ?? []).map((item): Entry => ({ id: item.id, title: item.title,
      date: isoDate.format(item.launch), source: 'metrics' })),
  ];
  const visible = entries.filter(entry => filter === 'all' || entry.source === filter)
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
    <header className="page-head release-journal-head">
      <h1>Релизы</h1>
      <div className="toolbar release-journal-toolbar">
        <div className="release-help-label">
          <label>
            Источник
            <select value={filter} onChange={event => setFilter(event.target.value as Filter)}>
              {filters.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
          <ReleaseHelp text="«Из календаря» показывает записи из документов, а «С метриками» — релизы с дневными данными CSV." />
        </div>
        {journal && (canImport || canCreate) && <details className="release-management" ref={menu}>
          <summary title="Открыть действия с релизами и наборами событий.">Управление</summary>
          <div className="release-management-actions">
            {canCreate && <button type="button" title="Создать релиз по загруженному набору событий."
              onClick={() => openForm('release')}>Добавить релиз</button>}
            {canImport && <button type="button" title="Загрузить события для расчёта метрик релиза."
              onClick={() => openForm('import')}>Импорт CSV</button>}
          </div>
        </details>}
      </div>
    </header>
    {error && filter !== 'calendar' && <div className="paper release-list-status">
      <p role="alert" className="error">Не удалось загрузить релизы с метриками. {error}</p>
      <button type="button" onClick={() => refresh(n => n + 1)}>Повторить</button>
    </div>}
    {loading && <p role="status" className="paper release-list-note">Загружаем релизы с метриками…</p>}
    {visible.length > 0 ? <ol role="list" className="release-journal-list" aria-label="Журнал релизов">
      {visible.map(entry => {
        const release = entry.source === 'calendar' ? entry.release : undefined;
        const href = release ? release.decisionAvailable && releaseAssessmentHref(entry.id) : metricReleaseHref(entry.id);
        const linkedTasks = release && releaseTasks(release);
        const linkedCases = release && renderCases(entry.id);
        const hasTasks = Boolean(linkedTasks?.detailed.length || linkedTasks?.otherIds.length);
        const detailsLabel = hasTasks
          ? linkedCases ? 'Задачи и разборы' : 'Задачи'
          : linkedCases ? 'Разборы' : '';
        const expanded = Boolean(detailsLabel && expandedRelease === entry.id);
        const detailsId = 'release-links-' + encodeURIComponent(entry.id);
        return <li key={entry.source + '/' + entry.id} className="release-journal-card" data-source={entry.source}>
          <div className="release-card-meta">
            {entry.date
              ? <time className="release-date" dateTime={entry.date}>{displayDate(entry.date)}</time>
              : <span>Дата не указана</span>}
            <span className="release-source">{sourceNames[entry.source]}</span>
            {entry.title !== entry.id && <small className="release-id">{entry.id}</small>}
          </div>
          <h2 className="release-card-title">
            {href ? <a className="release-entry-link" href={href}
              title={release ? 'Открыть данные этого релиза.' : 'Открыть отчёт с метриками релиза.'}>
              <span>{entry.title}</span><span className="release-open-icon"><Icon name="arrow" /></span>
            </a> : entry.title}
          </h2>
          {release && <div className="release-card-actions">
            {detailsLabel && <button type="button" aria-expanded={expanded}
              aria-controls={expanded ? detailsId : undefined}
              aria-label={'Связанные ' + detailsLabel.toLowerCase() + ' ' + entry.id}
              title={(expanded ? 'Свернуть' : 'Показать') + ' связанные ' + detailsLabel.toLowerCase()}
              onClick={() => setExpandedRelease(expanded ? null : entry.id)}>{detailsLabel}<Icon name="down" /></button>}
            {release.decisionAvailable || release.releaseCaseId
              ? <ReleaseCaseLink releaseId={entry.id} caseId={release.releaseCaseId} className="release-plan" />
              : <button type="button" className="release-plan" aria-label={'Запланировать разбор ' + entry.id}
                 title="Открыть форму разбора с выбранным релизом."
                onClick={() => onPlan(entry.id)}>Запланировать разбор</button>}
          </div>}
          {expanded && linkedTasks && <div className="release-card-related" id={detailsId}>
            {hasTasks && <RelatedTasks {...linkedTasks} />}
            {linkedCases && <section><h3>Связанные разборы</h3>{linkedCases}</section>}
          </div>}
        </li>;
      })}
    </ol> : !loading && (!error || filter === 'calendar') && <p role="status" className="paper release-list-note">
      {filter === 'metrics' ? 'Релизов с метриками пока нет.' : 'Релизов пока нет.'}
    </p>}
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
