import React, { useId, useState } from 'react';
import { post } from './team-data';

type Props = {
  caseId: string;
  runId: string;
  plan: string;
  outcomes: string[];
  issueQuery?: string;
  issueSourceKey?: string;
  measurement?: React.ReactNode;
  canDraft: boolean;
  onDraft: (id: string) => void;
};
type Hit = { key: string; url: string; title: string };
type Results = { items: Hit[]; local: boolean };

export function InvestigationPlan(props: Props) {
  return <PlanEditor key={props.caseId + '/' + props.runId} {...props} />;
}

function PlanEditor({ caseId, runId, plan, outcomes, issueQuery, issueSourceKey, measurement, canDraft, onDraft }: Props) {
  const formId = useId();
  const [steps, setSteps] = useState(plan);
  const [interpretations, setInterpretations] = useState(outcomes.join('\n'));
  const [existing, setExisting] = useState(Boolean(issueQuery || issueSourceKey));
  const [query, setQuery] = useState(issueQuery || issueSourceKey || '');
  const [results, setResults] = useState<Results>();
  const [selected, setSelected] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const hit = existing && results?.items.find(item => item.key === selected);
  const workbookKey = issueSourceKey || issueQuery?.match(/^T-\d+$/i)?.[0];

  async function request(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка запроса');
    } finally {
      setBusy(false);
    }
  }

  return <details className="investigation-plan">
    <summary className="primary">Посмотреть план проверки</summary>
    {measurement}
    {canDraft ? <>
      <form id={formId} aria-busy={busy} onSubmit={e => {
        e.preventDefault();
        if (busy || (existing && !hit)) return;
        void request(async () => {
          const preview = await post<{ id: string }>('investigation-draft', {
            caseId, runId, plan: steps,
            outcomes: interpretations.split(/\r?\n/).map(line => line.trim()).filter(Boolean),
            title: existing ? undefined : title.trim() || undefined,
            selection: hit ? { key: hit.key, url: hit.url, query: query.trim() } : undefined,
          });
          onDraft(preview.id);
        });
      }}>
        <label>План проверки
          <textarea required rows={4} maxLength={8000} disabled={busy} value={steps} onChange={e => setSteps(e.target.value)} />
        </label>
        <label>Как интерпретировать результат
          <textarea rows={4} maxLength={12000} disabled={busy} value={interpretations} onChange={e => setInterpretations(e.target.value)} />
        </label>
        <label>Куда записать план
          <select value={existing ? 'existing' : 'new'} disabled={busy}
            onChange={e => { setExisting(e.target.value === 'existing'); setError(''); }}>
            <option value="existing">Комментарий к существующей задаче</option>
            <option value="new">Новая задача</option>
          </select>
        </label>
        {!existing && <label>Название новой задачи
          <input value={title} maxLength={240} disabled={busy} placeholder="По заголовку разбора" onChange={e => setTitle(e.target.value)} />
        </label>}
      </form>
      {existing && <form onSubmit={e => {
        e.preventDefault();
        if (busy) return;
        void request(async () => {
          setSelected('');
          setResults(undefined);
          setResults(await post<Results>('issue_search', {query: query.trim()}));
        });
      }}>
        {workbookKey && <small>Ключ в конкурсной книге · {workbookKey}</small>}
        <label>Поиск задач по ключу или названию
          <input value={query} maxLength={400} disabled={busy} onChange={e => {
            setQuery(e.target.value); setSelected(''); setResults(undefined);
          }} />
        </label>
        <button disabled={busy}>Найти задачи</button>
        {results && (results.items.length ? <label>
          {results.local ? 'Задача локального демо' : 'Задача Redmine'}
          <select value={selected} disabled={busy} onChange={e => setSelected(e.target.value)}>
            <option value="">Выберите найденную задачу</option>
            {results.items.map(item => <option key={item.key} value={item.key}>{item.key} · {item.title}</option>)}
          </select>
        </label> : <p role="status">Совпадений нет. Попробуйте слова из названия задачи.</p>)}
        {hit && <a href={hit.url}>Открыть задачу · {hit.key}</a>}
      </form>}
      <p id={formId + '-visibility'}><small>После подтверждения этот текст увидят пользователи с доступом к задаче.</small></p>
      <button form={formId} aria-describedby={formId + '-visibility'} disabled={busy || !steps.trim() || (existing && !hit)}>
        Подготовить предпросмотр
      </button>
      {error && <p role="alert">{error}</p>}
    </> : <>
      <p className="tracker-text">{plan}</p>
      {outcomes.length > 0 && <><h4>Как интерпретировать результат</h4>
        <ul>{outcomes.map((outcome, i) => <li key={i}>{outcome}</li>)}</ul></>}
    </>}
  </details>;
}
