import React, { useState } from 'react';
import { post, sourceText } from './team-data';
import type { Evidence } from './team-data';

export function InterviewSearch({ caseId, asOf }: { caseId: string; asOf?: string }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Evidence[]>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  return (
    <details className="paper interview-search">
      <summary data-ui-hint="Ищет обезличенные выдержки по теме или цитате.">Поиск по интервью</summary>
      <form onSubmit={async (event) => {
        event.preventDefault();
        if (!query.trim() || pending) return;
        setPending(true);
        setError('');
        setResults(undefined);
        try {
          setResults(await post<Evidence[]>('search', { caseId, query: query.trim(), kinds: ['interview'], asOf }));
        } catch (error) {
          setError(error instanceof Error ? error.message : 'Ошибка поиска');
        } finally {
          setPending(false);
        }
      }}>
        <label>
          Тема или цитата
          <input type="search" value={query} onChange={event => setQuery(event.target.value)} maxLength={400} required />
        </label>
        {asOf && <small>Интервью по <time dateTime={asOf}>{asOf}</time> включительно</small>}
        <button disabled={pending || !query.trim()}>Найти выдержки</button>
      </form>
      {pending && <p role="status">Ищем выдержки…</p>}
      {error && <p role="alert">{error}</p>}
      {results && (results.length === 0 ? <p role="status">Выдержки по запросу не найдены.</p> : (
        <div role="region" aria-label="Результаты поиска по интервью">
          {results.map(item => (
            <article className="excerpt" key={item.key}>
              <p>{sourceText(item)}</p>
              <small>{item.source}{item.metadata?.date && <> · <time dateTime={item.metadata.date}>{item.metadata.date}</time></>}</small>
              {item.metadata?.question && <small>{item.metadata.question}</small>}
              {item.metadata?.hypothesis && <small>Гипотеза «{item.metadata.hypothesis}» · {item.metadata.relation}</small>}
            </article>
          ))}
        </div>
      ))}
    </details>
  );
}
