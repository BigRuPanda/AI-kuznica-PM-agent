import React, { useEffect, useState } from 'react';
import { post } from './team-data';

export type Workbook = { file: string; version: string; created: number; total: number };
type Extract = Workbook & {
  offset: number;
  rows: { loc: string; value: string | Record<string, unknown> }[];
};

export function SourceExtract({ version, loc }: { version: string; loc?: string }) {
  const [offset, setOffset] = useState<number | undefined>(),
    [data, set] = useState<Extract>(),
    [error, fail] = useState('');
  useEffect(() => {
    let live = true;
    set(undefined);
    fail('');
    post<Extract>('knowledge-source', { version, offset, loc: offset === undefined ? loc : undefined })
      .then((d) => {
        if (live) set(d);
      })
      .catch((e) => {
        if (live) fail(e.message);
      });
    return () => {
      live = false;
    };
  }, [version, offset, loc]);
  return (
    <section className="paper">
      <a href="#knowledge">База знаний</a>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <h1>{data.file}</h1>
          <p>
            Версия {data.version.slice(0, 12)} · {new Date(data.created).toLocaleString('ru-RU')}
          </p>
          <p>
            {data.total
              ? `Записи ${data.offset + 1}–${data.offset + data.rows.length} из ${data.total}`
              : 'Импорт завершён. Распознанных записей в этой книге нет.'}
          </p>
          {data.rows.map((r, i) => (
            <div className="excerpt" key={i}>
              <b>{r.loc}</b>
              <p>
                {typeof r.value === 'string'
                  ? r.value
                  : Object.entries(r.value)
                      .filter(([, v]) => v != null && v !== '')
                      .map(([k, v]) => k + ' = ' + String(v))
                      .join(' · ')}
              </p>
            </div>
          ))}
          <div className="actions">
            {data.offset > 0 && <button onClick={() => setOffset(Math.max(0, data.offset - 40))}>Предыдущие 40</button>}
            {data.offset + data.rows.length < data.total && (
              <button onClick={() => setOffset(data.offset + 40)}>Следующие 40</button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
