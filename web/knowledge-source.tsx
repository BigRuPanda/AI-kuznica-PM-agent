import React, { useEffect, useState } from 'react';
import { post, type SourceReference } from './team-data';
import { useTrackingVisibility } from './tracking-visibility';

export function SourceLink({ source, file, loc, version }: SourceReference) {
  return file && /\.(xlsx|pptx)$/i.test(file) && loc && version
    ? <a href={'#knowledge-source/' + version + '/' + encodeURIComponent(loc)}>{source}</a>
    : <>{source}</>;
}

export type Workbook = { file: string; version: string; created: number; total: number };
type Extract = Workbook & {
  offset: number;
  rows: { loc: string; offer:boolean; links: {url:string;loc:string}[]; value: string | Record<string, unknown> }[];
};

type OfferResult = { checkedAt:string; text:string; url?:string };
function OfferCheck({version,loc}:{version:string;loc:string}) {
  const [result,set]=useState<OfferResult|null>(null);
  const [busy,wait]=useState(false), [error,fail]=useState('');
  useEffect(()=>{let live=true;post<OfferResult|null>('competitor_check',{version,loc,savedOnly:true}).then(r=>{if(live)set(r);},()=>{});return ()=>{live=false;};},[version,loc]);
  return <div><button type="button" disabled={busy} onClick={async()=>{
    wait(true);fail('');
    try {set(await post<OfferResult>('competitor_check',{version,loc}));}
    catch(e){fail((e as Error).message);} finally {wait(false);}
  }}>Проверить цену продавца</button>
  {result && <p>{result.text} · {new Date(result.checkedAt).toLocaleString('ru-RU')} {result.url && <a href={result.url} rel="noreferrer" target="_blank">Карточка продавца</a>}</p>}
  {error && <p role="alert">{error}</p>}</div>;
}
export function SourceExtract({ version, loc }: { version: string; loc?: string }) {
  const { showConfluence } = useTrackingVisibility();
  const [offset, setOffset] = useState<number | undefined>(),
    [data, set] = useState<Extract>(),
    [error, fail] = useState('');
  const [selection,select]=useState(''), [question,ask]=useState(''), [busy,setBusy]=useState(false);
  const pending=React.useRef<{key:string;thread?:string;request:string}|null>(null);
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
      <a href={showConfluence ? '#knowledge' : '#sources'}>{showConfluence ? 'База знаний' : 'Источники'}</a>
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
              {r.offer && <OfferCheck version={version} loc={r.loc}/>}
              {r.links.map(link=><button type="button" key={link.loc} onClick={()=>select(link.loc)}>Проверить ссылку из {link.loc}</button>)}
            </div>
          ))}
          {selection && <form onSubmit={async e=>{
            e.preventDefault(); if(busy || !question.trim()) return;
            setBusy(true); fail('');
            try {
              const key=JSON.stringify([version,selection,question.trim()]);
              if(pending.current?.key!==key) pending.current={key,request:crypto.randomUUID()};
              const draft=pending.current;
              draft.thread??=(await post<{id:string}>('thread',{title:'Проверка '+selection})).id;
              await post('ask',{thread:draft.thread,requestId:draft.request,question:question.trim(),sourceCell:{version,loc:selection}});
              location.hash='chats/'+draft.thread;
            } catch(err) {fail((err as Error).message);} finally {setBusy(false);}
          }}>
            <label>Что проверить по ссылке из {selection}?<input required maxLength={2400} value={question} onChange={e=>ask(e.target.value)} /></label>
            <button type="submit" disabled={busy}>Проверить в чате</button>
          </form>}
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
