import React, { useEffect, useState } from 'react';
import { post } from './team-data';
import type { Workbook } from './knowledge-source';

type Result = {
  reference: string;
  episode: number;
  caseId: string;
  issue: number | string;
  pageKey: string | null;
  title: string;
  status: string;
  description: string;
  url: string;
  observed: string;
  closed_on: string | null;
  closing_note?: { text: string; author: string } | null;
  report: { start: string; end: string; periods: number[][]; web: string; status: string } | null;
};
type Publication = { id: string; caseId: string; title: string; conclusion: string; created: number };
type WikiPage = { key: string; title: string; version: number; caseId: string };
export function Knowledge({ admin }: { admin: boolean }) {
  const [data, set] = useState<{
      results: Result[];
      publications: Publication[];
      sources: Workbook[];
      pages: WikiPage[];
    } | null>(null),
    [query, search] = useState(''),
    [error, fail] = useState('');
  useEffect(() => {
    let live = true;
    post<NonNullable<typeof data>>('knowledge')
      .then(r => { if (live) set(r); })
      .catch(e => { if (live) fail(e.message); });
    return () => { live = false; };
  }, []);
  const match = (s: string) => s.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const seenPages = new Set<string>();
  const results = (data?.results || []).filter((r) => {
    if (
      (r.pageKey && seenPages.has(r.pageKey)) ||
      !match([r.issue, r.title, r.description, r.status, r.closing_note?.text].join(' '))
    )
      return false;
    if (r.pageKey) seenPages.add(r.pageKey);
    return true;
  });
  const pubs = data?.publications.filter((p) => match(p.title + ' ' + p.conclusion)) || [];
  const sources = data?.sources.filter((s) => match(s.file + ' ' + s.version)) || [];
  const shown = new Set(results.map((r) => r.pageKey));
  const pages = data?.pages.filter((p) => !shown.has(p.key) && match(p.title)) || [];
  return (
    <>
      <div className="page-head">
        <h1>База знаний</h1>
        {admin && <a href="#sources">Загрузить Excel</a>}
      </div>
      <section className="paper">
        <label>
          Поиск по задачам, страницам и источникам
          <input type="search" value={query} onChange={(e) => search(e.target.value)} />
        </label>
      </section>
      {error && <p role="alert">{error}</p>}
      {data && !results.length && !pubs.length && !sources.length && !pages.length && (
        <p>
          {query
            ? 'Совпадений нет.'
            : 'Здесь появятся источники Excel, страницы и результаты закрытых задач Redmine.'}
        </p>
      )}
      {results.map((r) => (
        <article className="paper" key={r.reference + r.episode}>
          <small>
            Redmine #{r.issue} · {r.status} ·{' '}
            {new Date(r.closed_on || r.observed).toLocaleDateString('ru-RU')}
          </small>
          <h3>{r.title}</h3>
          <p>{r.description}</p>
          {r.closing_note && <p>Комментарий при закрытии · {r.closing_note.text}</p>}
          {r.report && (
            <>
              <p>
                Отчёт при создании задачи · {r.report.start} — {r.report.end}. {r.report.status}.
              </p>
              <p>
                Визиты с корзиной / все визиты по неделям:{' '}
                {r.report.periods.map((p) => p[p.length - 1] + '/' + p[0]).join(' → ')}.
              </p>
            </>
          )}
          <div className="actions">
            <a href={r.url} target="_blank" rel="noreferrer">
              Задача Redmine
            </a>
            {r.report && (
              <a href={r.report.web} target="_blank" rel="noreferrer">
                Отчёт Метрики
              </a>
            )}
            {r.pageKey && <a href={'#demo-page/' + encodeURIComponent(r.pageKey)}>Страница по задаче</a>}
            <a
              href={
                '#case/' +
                r.caseId +
                '/documentation?' +
                new URLSearchParams({ issue: String(r.issue), ...(r.pageKey && { page: r.pageKey }) })
              }
            >
              Оформить документацию
            </a>
          </div>
        </article>
      ))}
      {pages.map((p) => (
        <article className="paper" key={p.key}>
          <small>Страница · версия {p.version}</small>
          <h3>
            <a href={'#demo-page/' + encodeURIComponent(p.key)}>{p.title}</a>
          </h3>
          <a href={'#case/' + p.caseId}>Разбор</a>
        </article>
      ))}
      {sources.length > 0 && (
        <section className="paper">
          <h3>Источники Excel</h3>
          {sources.map((s) => (
            <div key={s.version} className="event-row">
              <a href={'#knowledge-source/' + s.version}>{s.file}</a>
              <small>
                Версия {s.version.slice(0, 12)} · {s.total} записей
              </small>
            </div>
          ))}
        </section>
      )}
      {pubs.map((p) => (
        <article className="paper" key={p.id}>
          <small>Опубликованный разбор · {new Date(p.created).toLocaleDateString('ru-RU')}</small>
          <h3>{p.title}</h3>
          {p.conclusion && <p>{p.conclusion}</p>}
          <a href={'#case/' + p.caseId}>Открыть разбор</a>
        </article>
      ))}
    </>
  );
}
