import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog } from './dialog';
import { Icon } from './icons';
import { InvestigationPlan } from './investigation-plan';
import { researchModes } from './investigation-settings';
import { RangeChart, WEEK } from './range-chart';
import { num, post } from './team-data';
import { calendarPeriod, signalEvidenceWeek } from './case-periods';
import type { InvestigationBundle, InvestigationCheck, InvestigationStage, InvestigationHypothesis, InvestigationRun, InvestigationSource } from './team-data';
import './case-investigation.css';

const runStatus = {
  queued: 'В очереди', running: 'Идут проверки', waiting: 'Исследование приостановлено',
  retry: 'Ожидается повтор проверки', ready: 'Исследование готово', superseded: 'Архивная версия',
};
const roles: Record<string, string> = {
  calculation: 'Серверный расчёт', analyst: 'Аналитик', researcher: 'Исследователь',
  lead: 'Ведущий', reviewer: 'Рецензент',
};
const checkStatus: Record<string, string> = {
  done: 'Проверено', unavailable: 'Данные недоступны', waiting: 'Ожидаем данные',
  running: 'В работе', queued: 'В очереди', retry: 'Ожидает повтора',
};

function snapshotLink(calcId: string, findingId?: string) {
  return '#snapshot/' + encodeURIComponent(calcId) + (findingId ? '/' + encodeURIComponent(findingId) : '');
}

export function useCaseInvestigation(caseId: string, initial?: InvestigationBundle) {
  const [live, setLive] = useState<InvestigationBundle>();
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const investigation = live || initial;
  useEffect(() => { setLive(undefined); }, [initial]);
  const refresh = useCallback(async () => {
    const version = ++sequence.current;
    try {
      const next = await post<InvestigationBundle>('investigation-status', { caseId });
      if (sequence.current === version) {
        setLive(next);
        setError('');
      }
    } catch {
      if (sequence.current === version) setError('Не удалось обновить статус исследования. Повторим запрос.');
    }
  }, [caseId]);
  const statuses = [investigation?.current, ...(investigation?.alternatives || [])].map(run => run?.status);
  const interval = statuses.includes('running') || statuses.includes('queued') ? 1200
    : statuses.includes('waiting') || statuses.includes('retry') || !investigation?.current ? 3000 : 8000;
  const loaded = !!initial;
  useEffect(() => {
    if (!loaded) return;
    let active = true;
    let timer: number;
    async function tick() {
      if (!document.hidden) await refresh();
      if (active) timer = window.setTimeout(tick, interval);
    }
    timer = window.setTimeout(tick, interval);
    return () => {
      active = false;
      sequence.current++;
      window.clearTimeout(timer);
    };
  }, [loaded, refresh, interval]);
  return { investigation, refresh, error };
}

function RunMeta({ run }: { run: InvestigationRun }) {
  if (!run.period && !run.unit && !run.calcId) return null;
  return <div className="investigation-meta">
    {[run.period, run.unit].filter(Boolean).join(' · ')}
    {run.calcId && <a href={snapshotLink(run.calcId)}>Открыть расчёт</a>}
  </div>;
}

function SourceLink({ source }: { source: InvestigationSource }) {
  const url = source.calcId ? snapshotLink(source.calcId, source.findingId)
    : /^https?:\/\//i.test(source.url || '') ? source.url : undefined;
  return url ? <a href={url}>{source.label}</a> : <span>{source.label}</span>;
}

function Check({ check }: { check: InvestigationCheck }) {
  return <details className="investigation-check">
    <summary>
      <span className="investigation-detail-title">
        <small>{roles[check.role] || check.role} · {checkStatus[check.status] || check.status}</small>
        <strong>{check.question}</strong>
      </span>
      {check.result && <span className="investigation-check-result">{check.result}</span>}
    </summary>
    <div className="investigation-check-body">
      {check.period && <p className="muted">{check.period}</p>}
      {check.impact && <><strong>Влияние на вывод</strong><p>{check.impact}</p></>}
      {check.sources.length > 0 && <ul className="investigation-sources">{check.sources.map((source, index) =>
        <li key={source.label + '/' + index}><SourceLink source={source} /></li>)}</ul>}
    </div>
  </details>;
}

function Hypothesis({ hypothesis }: { hypothesis: InvestigationHypothesis }) {
  return <details className="investigation-check">
    <summary>{hypothesis.title}</summary>
    <dl className="investigation-hypothesis">
      {(['for', 'against'] as const).map(side => <div key={side}>
        <dt>{side === 'for' ? 'За' : 'Против'}</dt>
        <dd>{hypothesis[side].length ? <ul>{hypothesis[side].map((item, index) => {
          const source = hypothesis.sourceRefs?.[side]?.[index];
          return <li key={index}>{item}{source && <small><SourceLink source={source} /></small>}</li>;
        })}</ul> : 'Свидетельств не найдено.'}</dd>
      </div>)}
      <div><dt>Как различить версии</dt><dd>{hypothesis.test}</dd></div>
    </dl>
  </details>;
}

function Checks({ run }: { run: InvestigationRun }) {
  const hypotheses = run.result?.hypotheses || [];
  const mode = researchModes[run.mode as keyof typeof researchModes];
  const pending = run.status === 'superseded' ? [] : (run.stages || []).filter(s => s.status !== 'done');
  if (!run.checks.length && !hypotheses.length && !pending.length) return null;
  return <details className="investigation-checks">
    <summary>Как проверяли</summary>
    {mode && <p className="muted">Режим · {mode}</p>}
    {pending.map(s => <p key={s.role}><strong>{roles[s.role]}</strong> · {s.reason || (s.status === 'waiting' ? 'Ожидает запуска' : checkStatus[s.status])}</p>)}
    {run.checks.map((check, index) => <Check key={check.role + '/' + index} check={check} />)}
    {hypotheses.length > 0 && <>
      <h4>Гипотезы</h4>
      {hypotheses.map((hypothesis, index) => <Hypothesis key={index} hypothesis={hypothesis} />)}
    </>}
  </details>;
}

function StageRetry({run,stage,refresh}: {run: InvestigationRun; stage: InvestigationStage; refresh: () => Promise<void>}) {
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  return <div className="investigation-stage-retry">
    <strong>{roles[stage.role]} · попытка {stage.attempt}</strong>
    <p>{stage.reason}</p>
    <button type="button" disabled={busy} onClick={async () => {
      if (busy) return;
      setBusy(true); setError('');
      try {
        await post('investigation-retry-stage',{caseId:run.caseId,runId:run.id,role:stage.role,attempt:stage.attempt});
        await refresh();
      } catch (e) { setError((e as Error).message); }
      finally { setBusy(false); }
    }}>Повторить ИИ-проверку</button>
    {error && <p role="alert">{error}</p>}
  </div>;
}

function ThresholdObservation({ observation, calcId }: { observation: NonNullable<InvestigationRun['thresholdObservation']>; calcId: string }) {
  const {product,threshold,baseline,weeks:[first,second],findingId} = observation;
  const change = second.value - first.value;
  return <div className="threshold-observation">
    <h2>Две недели ниже порога</h2>
    <p>Индекс {product} составил <strong>{num(first.value)}</strong> за {signalEvidenceWeek(first.week)} и{' '}
      <strong>{num(second.value)}</strong> за {signalEvidenceWeek(second.week).replace(/\.$/u, '')}. Порог — <strong>{num(threshold)}</strong>.{' '}
      {change === 0 ? 'За вторую неделю показатель остался на том же уровне.'
        : `За вторую неделю индекс ${change > 0 ? 'вырос' : 'снизился'} на ${num(Math.abs(change))} п.`}</p>
    <p><strong>Для сравнения с прошлым периодом нужна история.</strong>{' '}
      За {calendarPeriod(baseline.from,baseline.through)} в базе нет полных недель. Когда появятся данные за этот период, сравнение пересчитается автоматически.</p>
    <a href={snapshotLink(calcId,findingId)}>Посмотреть обе недели и источники</a>
  </div>;
}

function RunSummary({ run, refresh, active = false }: { run: InvestigationRun; refresh?: () => Promise<void>; active?: boolean }) {
  if (run.status === 'waiting' && run.thresholdObservation && run.calcId)
    return <ThresholdObservation observation={run.thresholdObservation} calcId={run.calcId} />;
  const failures = refresh ? (run.stages || []).filter(stage => stage.canRetry) : [];
  return <>
    {run.status !== 'ready' && <p className="investigation-status" role={run.status === 'superseded' ? undefined : 'status'}>
      <strong>{active && run.status === 'queued' ? 'Очередь' : runStatus[run.status]}</strong>
      {run.reason && !failures.some(stage => stage.reason === run.reason) && ' · ' + run.reason}
    </p>}
    {refresh && failures.map(stage => <StageRetry key={run.id + stage.role + stage.attempt} run={run} stage={stage} refresh={refresh} />)}
    {(run.result?.summary || run.summary) && <p className="investigation-text">{run.result?.summary || run.summary}</p>}
  </>;
}

function ArchiveItem({ run }: { run: InvestigationRun }) {
  const [expanded, expand] = useState(false);
  return <details className="investigation-version" onToggle={event => expand(event.currentTarget.open)}>
    <summary>{run.question || 'Версия ' + run.revision}{run.created ? ' · ' + new Date(run.created).toLocaleDateString('ru-RU') : ''}</summary>
    {expanded && <div className="investigation-version-body">
      <RunMeta run={run} />
      <RunSummary run={run} />
      {run.result?.action && <p><strong>Рекомендация на момент исследования</strong> {run.result.action}</p>}
      <Checks run={run} />
    </div>}
  </details>;
}

function AlternativeQuestion({ run, close, created }: {
  run: InvestigationRun; close: () => void; created: (id: string) => void;
}) {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<{ id: string; question: string }>(undefined);
  const hypotheses = run.result?.hypotheses || [];
  return <Dialog title="Проверить другую версию" close={close}>
    <form aria-busy={busy} onSubmit={async event => {
      event.preventDefault();
      const text = question.trim();
      if (busy || !text) return;
      if (request.current?.question !== text) request.current = { id: crypto.randomUUID(), question: text };
      setBusy(true);
      setError('');
      try {
        const alternative = await post<{ id: string }>('investigation-alternative', {
          caseId: run.caseId, parentId: run.id, question: text, requestId: request.current.id,
        });
        created(alternative.id);
      } catch (e) {
        setError((e as Error).message);
        setBusy(false);
      }
    }}>
      {hypotheses.length > 0 && <label>Гипотеза из разбора
        <select defaultValue="" disabled={busy} onChange={event => {
          const hypothesis = hypotheses[Number(event.target.value)];
          if (event.target.value && hypothesis) setQuestion('Проверить гипотезу «' + hypothesis.title + '».');
        }}>
          <option value="">Выберите гипотезу или напишите свой вопрос</option>
          {hypotheses.map((hypothesis, index) => <option key={index} value={index}>{hypothesis.title}</option>)}
        </select>
      </label>}
      <label>Вопрос для проверки
        <textarea required rows={3} maxLength={2400} value={question} disabled={busy} onChange={event => setQuestion(event.target.value)} />
      </label>
      <p className="muted">До публикации исследование доступно вам.</p>
      {error && <p role="alert">{error}</p>}
      <button className="primary" disabled={busy || !question.trim()}>Начать проверку</button>
    </form>
  </Dialog>;
}

function PublishVersion({ run, refresh }: { run: InvestigationRun; refresh: () => Promise<void> }) {
  const [publishing, publish] = useState(false);
  const [error, setError] = useState('');
  return <>
    <button disabled={publishing} aria-busy={publishing} onClick={async () => {
      publish(true);
      setError('');
      try {
        await post('investigation-publish', { caseId: run.caseId, id: run.id });
        await refresh();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        publish(false);
      }
    }}>Опубликовать для команды</button>
    {error && <p role="alert">{error}</p>}
  </>;
}

type CurrentStep = { label: string; title?: string; open: () => void };

export function CaseInvestigation({ investigation, error, refresh, userId, canExplore, canPublish, canDraft, onDraft, next, measurement }: {
  investigation: InvestigationBundle; error: string; refresh: () => Promise<void>; userId: string;
  canExplore: boolean; canPublish: boolean; canDraft: boolean; onDraft: (id: string) => void; next?: CurrentStep;
  measurement?: (run: InvestigationRun) => React.ReactNode;
}) {
  const { current, alternatives, history } = investigation;
  const [prompt, setPrompt] = useState<InvestigationRun>();
  const [selected, select] = useState('');
  const ready = current?.status === 'ready' ? current.result : undefined;
  const compactQueue = current?.status === 'queued' && !current.summary && !current.reason &&
    !current.period && !current.unit && !current.calcId && !current.checks.length && !error;
  const currentMeasurement = ready && current ? measurement?.(current) : undefined;
  const publishable = (run: InvestigationRun) => canPublish && run.owner === userId
    && !run.published && run.status === 'ready' && !!run.result;
  return <div className="case-investigation">
    {(current || canExplore || next || error) && <section className="paper investigation-decision" aria-label="Исследование"
      data-compact-queue={compactQueue}>
      {current ? <>
        {current.owner && <p className="investigation-visibility muted">
          <span>{current.published ? 'Опубликовано для команды' : 'Личное исследование'}</span>
          {current.publishedBy && ' · ' + current.publishedBy}
        </p>}
        {!current.thresholdObservation && <RunMeta run={current} />}
        <div aria-live="polite">
          {ready && <h2>Вывод</h2>}
          <RunSummary run={current} refresh={refresh} active />
        </div>
        {ready && canExplore && ((!next && ready.action) || currentMeasurement) && <div className="investigation-recommendation">
          {!next && <><h3>Что делать ПМу</h3>
            <p className="investigation-text">{ready.action}</p>
          </>}
          {ready.plan && <InvestigationPlan caseId={current.caseId} runId={current.id}
            plan={ready.plan} outcomes={ready.outcomes} issueQuery={ready.issueQuery}
            issueSourceKey={ready.issueSourceKey}
            canDraft={canDraft && !next} onDraft={onDraft} measurement={currentMeasurement} />}
        </div>}
      </> : canExplore && <p role="status">Исследование ещё не началось.</p>}
      {(next || (current && canExplore)) && <div className="investigation-actions">
        {next && <button className="primary arrow-action" title={next.title} onClick={next.open}>{next.label}<Icon name="arrow" /></button>}
        {current && canExplore && <button className="text-action" onClick={() => setPrompt(current)}>Проверить другую версию</button>}
        {current && publishable(current) && <PublishVersion key={current.id} run={current} refresh={refresh} />}
      </div>}
      {current && <Checks run={current} />}
      {error && <p className="muted" role="status">{error}</p>}
      {prompt && canExplore && <AlternativeQuestion run={prompt} close={() => setPrompt(undefined)} created={id => {
        select(id);
        setPrompt(undefined);
        void refresh();
      }} />}
    </section>}
    {alternatives.length > 0 && <section className="paper investigation-versions">
      <h3>Альтернативные исследования</h3>
      {alternatives.map(run => {
        const runMeasurement = run.status === 'ready' ? measurement?.(run) : undefined;
        return <details className="investigation-version" key={run.id} open={selected === run.id || undefined}>
        <summary>
          <span className="investigation-detail-title">
            <small><span>{run.published ? 'Опубликовано для команды' : 'Личное исследование'}</span>
              {run.publishedBy && ' · ' + run.publishedBy}</small>
            <strong>{run.question || 'Альтернативная версия'}</strong>
          </span>
          {run.status !== 'ready' && <small>{runStatus[run.status]}</small>}
        </summary>
        <div className="investigation-version-body">
          <RunMeta run={run} />
          <RunSummary run={run} refresh={refresh} />
          {run.result?.action && <>
            <strong>Рекомендация</strong>
            <p className="investigation-text">{run.result.action}</p>
            {run.parentId === current?.id && ready?.action && ready.action !== run.result.action && <details>
              <summary>Сопоставить с исходной рекомендацией</summary>
              <p className="investigation-text">{ready.action}</p>
            </details>}
          </>}
          {run.status === 'ready' && run.result?.plan && canExplore && (!next || runMeasurement) && <InvestigationPlan caseId={run.caseId}
            runId={run.id} plan={run.result.plan} outcomes={run.result.outcomes} issueQuery={run.result.issueQuery}
            issueSourceKey={run.result.issueSourceKey}
            canDraft={canDraft && !next} onDraft={onDraft} measurement={runMeasurement} />}
          {publishable(run) && <PublishVersion run={run} refresh={refresh} />}
          <Checks run={run} />
        </div>
      </details>})}
    </section>}
    {history.length > 0 && <details className="paper investigation-versions">
      <summary>История исследований</summary>
      {history.map(run => <ArchiveItem key={run.id} run={run} />)}
    </details>}
  </div>;
}

type CalculationRow = {
  date?: string; week?: string; value?: number | null; n?: number | null; d?: number | null;
  source?: string; version?: string; segment?: string; unit?: string;
};
type Finding = {
  id: string; kind: string; label: string; title?: string; text: string;
  source?: string; sources?: string[]; version?: string; relation?: string; rows?: CalculationRow[];
};
export type InvestigationCalculation = {
  kind: 'investigation-calculation'; title: string; caseId?: string; period?: string; unit?: string;
  summary?: string; findings: Finding[];
};

function CalculationFinding({ finding, unit, selected }: { finding: Finding; unit?: string; selected: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { if (selected) ref.current?.focus(); }, [selected]);
  const title = finding.title || finding.label;
  const points = (finding.rows || []).filter(row => row.value != null && (row.date || row.week))
    .map(row => ({ at: Date.parse((row.date || row.week) + 'T00:00:00Z'), value: row.value! }))
    .filter(point => Number.isFinite(point.at)).sort((a, b) => a.at - b.at);
  const showChart = unit === 'п. индекса' && ['calculation', 'control'].includes(finding.kind)
    && points.length > 1 && new Set(points.map(point => point.at)).size === points.length;
  const hasCounts = finding.rows?.some(row => row.n != null || row.d != null);
  const hasSegments = finding.rows?.some(row => row.segment);
  return <section className="paper investigation-finding" ref={ref} tabIndex={selected ? -1 : undefined}>
    <h2>{title}</h2>
    <p className="investigation-text">{finding.text}</p>
    {finding.relation && <p className="muted">{finding.relation}</p>}
    {[...new Set([finding.source, ...(finding.sources || [])].filter(Boolean))].map(source => <p key={source}>{source}</p>)}
    {finding.version && <small>{finding.version}</small>}
    {showChart && <RangeChart title={title} unit={unit} step={WEEK}
      lines={[{ key: finding.id, name: title, color: 'var(--series-main)', points }]} />}
    {!!finding.rows?.length && <div className="investigation-table" role="region" aria-label={'Исходные значения · ' + title} tabIndex={0}>
      <table>
        <thead><tr><th scope="col">Дата</th>{hasSegments && <th scope="col">Сегмент</th>}
          <th scope="col">Значение{unit && ', ' + unit}</th>
          {hasCounts && <><th scope="col">Числитель</th><th scope="col">Знаменатель</th></>}
          <th scope="col">Источник</th><th scope="col">Версия</th></tr></thead>
        <tbody>{finding.rows.map((row, index) => <tr key={index}>
          <td>{row.date || row.week || '—'}</td>{hasSegments && <td>{row.segment || '—'}</td>}
          <td>{num(row.unit === 'ratio' && unit === '%' && row.value != null ? row.value * 100 : row.value)}</td>
          {hasCounts && <><td>{num(row.n)}</td><td>{num(row.d)}</td></>}
          <td>{row.source || '—'}</td><td>{row.version || '—'}</td>
        </tr>)}</tbody>
      </table>
    </div>}
  </section>;
}

export function InvestigationSnapshot({ calculation, selected, embedded }: {
  calculation: InvestigationCalculation; selected?: string; embedded?: boolean;
}) {
  return <div className="investigation-snapshot">
    {!embedded && <a className="crumb" href={calculation.caseId ? '#case/' + encodeURIComponent(calculation.caseId) : '#cases'}>
      {calculation.caseId ? '← К разбору' : '← Разборы'}
    </a>}
    {embedded ? <h2>{calculation.title}</h2> : <h1>{calculation.title}</h1>}
    <p className="muted">{[calculation.period, calculation.unit].filter(Boolean).join(' · ')}</p>
    {calculation.summary && <p className="investigation-text">{calculation.summary}</p>}
    {calculation.findings.map(finding => <CalculationFinding key={finding.id} finding={finding} unit={calculation.unit}
      selected={encodeURIComponent(finding.id) === selected} />)}
  </div>;
}
