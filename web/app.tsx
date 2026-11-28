import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, contextQuery, date, dayDate, fmt, metricNames, segmentNames } from './types';
import type { Release, Report, Journal, Segment, Message, Board, Card, Context } from './types';
import { MetricCard, MetricChart, MetricEvidence } from './charts';
import { CalculationPage, CalculationPreview, SavedChart } from './calculations';
import { Dialog } from './dialog';
import { metricSample } from './metric-values';
import { Answer } from './answer';
import { Icon } from './icons';
import { useDiscussionDock } from './panel-size';
import { ProfileAvatar } from './profile';
import { ReleaseHelp, releaseCutHelp } from './release-help';
import type { User } from './team-data';
import './style.css';
import './releases.css';

function stored(key: string) {
  try { return localStorage.getItem('release-v1/' + key) || ''; } catch { return ''; }
}
function remember(key: string, value: string) {
  try { localStorage.setItem('release-v1/' + key, value); } catch { /* Storage is optional. */ }
}
const clock = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
type ReleaseResult =
  | { kind: 'chart'; card: Card; report: Report }
  | { kind: 'comparison'; card: Card; report: Report; context: Context }
  | { kind: 'saved'; id: string; title?: string };

export function ReleaseAnalytics({ route, requestedId, user }: {
  route: string; requestedId?: string; user: User;
}) {
  return <section className="release-workspace">
    {route === 'calc' ? <CalculationPage id={requestedId || ''}/> :
      <ReleaseReport id={requestedId || ''} user={user}/>}
  </section>;
}

function ReleaseReport({ id, user }: { id: string; user: User }) {
  const [journal, setJournal] = useState<Journal | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<Journal>('journal').then(data => { if (active) setJournal(data); })
      .catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, []);
  const release = journal?.releases.find(release => release.id === id);
  return <>
    <a className="crumb" href="#releases-list">← Журнал релизов</a>
    {error ? <p role="alert">{error}</p> : !journal ? <p role="status">Загрузка релиза…</p> : release ?
      <ReleasePanels release={release} mode={journal.mode} user={user}/> :
      <p role="alert">Релиз не найден.</p>}
  </>;
}

function ReleaseResultDialog({ result, close }: { result: ReleaseResult; close: () => void }) {
  const [related, setRelated] = useState<string | null>(null);
  const opener = useRef<HTMLElement | SVGElement | null>(null);
  function showRelated(id: string) {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement || active instanceof SVGElement ? active : null;
    setRelated(id);
  }
  function goBack() {
    setRelated(null);
    requestAnimationFrame(() => opener.current?.focus({ preventScroll: true }));
  }
  const title = related ? 'Расчёт' : result.kind === 'chart' ? 'График: ' + result.card.title :
    result.kind === 'comparison' ? 'Расчёт: ' + result.card.title : result.title ? 'Расчёт: ' + result.title : 'Расчёт';
  return <Dialog title={title} wide close={close}>
    <div hidden={related !== null}>
      {result.kind === 'chart' ? <div className="release-chart release-metric-dialog">
        <MetricChart card={result.card} report={result.report} openCalculation={showRelated}/>
      </div> : result.kind === 'comparison' ? <CalculationPreview source={result.context}>
        <MetricEvidence card={result.card} report={result.report} openCalculation={showRelated}/>
      </CalculationPreview> : <CalculationPreview source={result.id} showTitle={!result.title}/>}
    </div>
    {related && <>
      <button type="button" className="text-action" autoFocus onClick={goBack}>
        {result.kind === 'chart' ? '← К графику' : '← К расчёту'}
      </button>
      <CalculationPreview source={related} showTitle/>
    </>}
  </Dialog>;
}

function ReleasePanels({ release, mode, user }: { release: Release; mode: string; user: User }) {
  const { id } = release;
  const [day, setDay] = useState<number | undefined>(() => stored(id + '/day') ? Number(stored(id + '/day')) : undefined);
  const [segment, setSegment] = useState<Segment>(() => (stored(id + '/seg') || 'all') as Segment);
  const [report, setReport] = useState<Report | null>(null);
  const [reportError, setReportError] = useState('');
  const [refresh, rerun] = useState(0);
  const [metric, setMetric] = useState<number | null>(null);
  const [dialog, setDialog] = useState<ReleaseResult | null>(null);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [boards, setBoards] = useState<Board[]>([]);
  const [board, setBoard] = useState('');
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [chatError, setChatError] = useState('');
  const [activityError, setActivityError] = useState('');
  const [history, setHistory] = useState<{ day: number; start: number } | null>(null);
  const discussion = useRef<HTMLElement>(null);
  const chatLog = useRef<HTMLDivElement>(null);
  const chatFlow = useRef<HTMLDivElement>(null);
  const chatBox = useRef<HTMLTextAreaElement>(null);
  const followChat = useRef(true);
  const lastActivity = useRef('');
  const initial = useRef(new Set<string>());
  const activitySeq = useRef(0);
  const alive = useRef(true);
  const requestId = useRef('');
  useDiscussionDock(discussion, true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    const log = chatLog.current;
    const flow = chatFlow.current;
    if (!log || !flow) return;
    const observer = new ResizeObserver(() => {
      if (followChat.current && !document.querySelector('dialog[open]')) log.scrollTop = log.scrollHeight;
    });
    observer.observe(flow);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let active = true;
    setReportError('');
    setReport(current => current && current.context.segment === segment &&
      (day === undefined || current.context.day === day) ? current : null);
    api<Report>('report?' + contextQuery({ releaseId: id, segment, day }))
      .then(data => { if (active) setReport(data); })
      .catch(error => { if (active) setReportError(error.message); });
    return () => { active = false; };
  }, [id, day, segment, refresh]);

  async function activity() {
    const seq = ++activitySeq.current;
    try {
      const next = await api<{ messages: Message[]; boards: Board[] }>('activity?' + contextQuery({ releaseId: id }));
      if (!alive.current || seq !== activitySeq.current) return;
      setActivityError('');
      const snapshot = JSON.stringify(next);
      if (lastActivity.current === snapshot) return;
      lastActivity.current = snapshot;
      setMessages(next.messages);
      setBoards(next.boards);
    } catch (error) {
      if (alive.current && seq === activitySeq.current) setActivityError((error as Error).message);
    }
  }
  useEffect(() => {
    const check = () => { if (!document.hidden) void activity(); };
    void activity();
    const timer = window.setInterval(check, 2500);
    document.addEventListener('visibilitychange', check);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', check); };
  }, [id]);
  useEffect(() => {
    if (!report || report.report || ['offline', 'local'].includes(mode) ||
        report.cards[report.release.target].status !== 'ready') return;
    const key = report.context.version + '/' + report.context.day;
    if (initial.current.has(key)) return;
    initial.current.add(key);
    api('initial', { ...report.context, segment: 'all' })
      .then(() => { if (alive.current) rerun(n => n + 1); })
      .catch(error => { if (alive.current) setReportError(error.message); });
  }, [report, mode]);

  const cutoff = report?.context.day ?? day;
  const eligible = messages?.filter(message => cutoff !== undefined && message.context.day <= cutoff) ?? [];
  const latestQuestion = Math.max(0, eligible.map(message => message.role).lastIndexOf('user'));
  const historyStart = history && history.day === cutoff ? history.start : latestQuestion;
  useEffect(() => {
    if (cutoff !== undefined && eligible.length && history?.day !== cutoff) {
      setHistory({ day: cutoff, start: latestQuestion });
    }
  }, [cutoff, eligible.length, history?.day, latestQuestion]);

  async function ask(event: FormEvent) {
    event.preventDefault();
    if (!report || busy || !question.trim()) return;
    setBusy(true);
    setChatError('');
    if (!requestId.current) requestId.current = crypto.randomUUID();
    try {
      await api('chat', { ...report.context, metric: metric ?? release.target,
        author: user.name, question, requestId: requestId.current });
      if (!alive.current) return;
      setQuestion('');
      requestId.current = '';
      followChat.current = true;
      await activity();
      if (alive.current) rerun(n => n + 1);
    } catch (error) {
      if (alive.current) setChatError((error as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function showHistory() {
    if (cutoff === undefined) return;
    followChat.current = false;
    setHistory({ day: cutoff, start: 0 });
    requestAnimationFrame(() => chatLog.current?.scrollTo(0, 0));
  }
  function openMetric(kind: 'chart' | 'comparison', card: Card) {
    if (!report) return;
    setMetric(card.metric);
    setDialog(kind === 'chart' ? { kind, card, report } :
      { kind, card, report, context: { ...report.context, metric: card.metric } });
  }
  function openCalculation(id: string, title?: string) {
    setDialog({ kind: 'saved', id, title });
  }

  const names = [...new Set(boards.map(item => item.name))];
  const target = report?.cards.find(item => item.metric === release.target);
  const insight = target && report?.overview.startsWith(target.caption) ?
    report.overview.slice(target.caption.length).trim() : report?.overview;
  const selectedBoard = names.includes(board) ? board : names[0];
  const firstAnalysis = report?.report;
  const viewMetric = metric ?? release.target;

  return <>
    <header className="report-head">
      <small className="eyebrow">{id} · {date(release.launch)}</small>
      <h1>{release.title}</h1>
    </header>
    <div className="release-columns">
      <section className="release-metrics" aria-label="Метрики релиза">
        {reportError && <p role="alert">{reportError}</p>}
        {report && target ? <>
          <div className="filters release-report-filters">
            <div className="release-help-label">
              <label>Дата среза<select value={report.context.day} onChange={event => {
                setDay(Number(event.target.value));
                remember(id + '/day', event.target.value);
              }}>
                {Array.from({ length: report.last + 1 }, (_, offset) =>
                  <option key={offset} value={offset}>{dayDate(release.launch, offset)}</option>)}
              </select></label>
              <ReleaseHelp text={releaseCutHelp} />
            </div>
            <label>Сегмент<select value={segment} onChange={event => {
              setSegment(event.target.value as Segment);
              remember(id + '/seg', event.target.value);
            }}>
              {Object.entries(segmentNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>
          </div>
          <MetricCard key={report.context.version + '/' + segment + '/' + report.context.day}
            card={target} report={report} openComparison={() => openMetric('comparison', target)}
            openCalculation={openCalculation} insight={insight}/>
          {report.cards.length > 1 && <details className="paper release-other">
            <summary>Другие метрики</summary>
            <table className="release-table" aria-label="Другие метрики">
              <thead><tr><th scope="col">Показатель</th><th scope="col">До</th><th scope="col">После</th></tr></thead>
              <tbody>{report.cards.filter(card => card.metric !== release.target).map(card => {
                const { before, after } = card.series.all;
                return <tr key={card.metric}>
                  <th scope="row">{card.title}
                    <div className="actions metric-row-actions">
                      <button type="button" aria-haspopup="dialog" aria-label={'График: ' + card.title}
                        title={'Показать динамику метрики «' + card.title + '» по дням.'}
                        onClick={() => openMetric('chart', card)}>График</button>
                      <button type="button" aria-haspopup="dialog" aria-label={'Расчёт: ' + card.title}
                        title={'Сравнить значения метрики «' + card.title + '» до и после выпуска.'}
                        onClick={() => openMetric('comparison', card)}>Расчёт</button>
                    </div>
                  </th>
                  {[before, after].map((value, index) => <td key={index}>{fmt(value.value, card.unit)}
                    <small className="table-basis">{metricSample(value, card.metric) ||
                      (card.status === 'missing' ? 'Нет данных' : '')}</small>
                    {index === 1 && card.status === 'preliminary' && <small className="table-basis">Предварительно</small>}
                  </td>)}
                </tr>;
              })}</tbody>
            </table>
          </details>}
          <details className="paper release-about">
            <summary>О релизе</summary>
            <p>{release.description}</p>
            <p>Аудитория · {release.audience}</p>
            <p>Главный вопрос · {release.question}</p>
            {firstAnalysis && firstAnalysis.summaryMetric === release.target && firstAnalysis.version === report.context.version &&
              <details><summary>Первый разбор · {dayDate(release.launch, firstAnalysis.day)}</summary>
                <Answer text={firstAnalysis.answer}/>
                <button type="button" className="text-action" aria-haspopup="dialog"
                  onClick={() => openCalculation(firstAnalysis.calc)}>Открыть расчёт</button>
              </details>}
          </details>
        </> : !reportError && <p role="status">Загружаем расчёты…</p>}
        {names.length > 0 && <details className="paper release-saved">
          <summary>Сохранённые графики</summary>
          <label>Дашборд<select value={selectedBoard} onChange={event => setBoard(event.target.value)}>
            {names.map(name => <option key={name}>{name}</option>)}</select></label>
          {boards.filter(item => item.name === selectedBoard).map(item => <SavedChart key={item.calc} id={item.calc}/>)}
        </details>}
      </section>
      <aside ref={discussion} className="thread release-discussion" aria-label="Обсуждение релиза">
        <header className="conversation-heading">
          <span className="chat-avatar" aria-hidden="true"><Icon name="people"/></span>
          <div className="conversation-title"><h2>Обсуждение релиза</h2><small>Командный чат</small></div>
        </header>
        <div className="conversation-body">
          <div className="chat-history" ref={chatLog} onScroll={event => {
            const log = event.currentTarget;
            followChat.current = log.scrollHeight - log.scrollTop - log.clientHeight < 28;
          }}>
            <div className="chat-flow" ref={chatFlow}>
              {messages === null && !activityError && <p className="chat-loading muted" role="status">Загрузка переписки…</p>}
              {messages && report && !eligible.length && !activityError && !busy && <div className="chat-empty"><h4>Что проверить?</h4></div>}
              {historyStart > 0 && <button type="button" className="earlier" onClick={showHistory}>Предыдущие сообщения <span>{historyStart}</span></button>}
              {eligible.slice(historyStart).map((message, index) => <article key={index + historyStart} className={'bubble ' + message.role}>
                <header className="message-author">
                  {message.role === 'assistant' ? <span className="chat-avatar" aria-hidden="true"><Icon name="agent"/></span> :
                    <ProfileAvatar className="chat-avatar" name={message.author} avatar={message.own ? user.avatar : null}/>}
                  <strong>{message.author}</strong>
                  <time dateTime={new Date(message.created).toISOString()}
                    title={new Date(message.created).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) + ' МСК'}>{clock.format(message.created)}</time>
                </header>
                <Answer text={message.text} compact={message.role === 'assistant' && message.refs?.some(ref => ref.op === 'build_chart')}/>
                {message.refs?.filter(ref => ref.op === 'build_chart').map(ref =>
                  <SavedChart key={ref.id} id={ref.id} author={user.name} suggested={names} onSave={() => void activity()}/>)}
                {message.refs?.filter(ref => ref.op !== 'build_chart').map(ref =>
                  <button key={ref.id} type="button" className="text-action" aria-haspopup="dialog"
                    onClick={() => openCalculation(ref.id, ref.title)}>{ref.title}</button>)}
                <small className="message-context">{segmentNames[message.context.segment]} · срез на {dayDate(release.launch, message.context.day)}</small>
              </article>)}
              {activityError && <p role="alert">{activityError}</p>}
            </div>
          </div>
        </div>
        <form className="chat-composer" onSubmit={ask}>
          {mode === 'offline' && <p className="hint">Модель не подключена.</p>}
          {mode === 'local' && <p className="hint">Доступны расчёт метрики и его источник.</p>}
          <button type="button" className="text-action suggest" onClick={() => {
            setQuestion('Сколько дней обычно проходит от выставления счёта до оплаты? Построй график медианы.');
            requestId.current = '';
            chatBox.current?.focus();
          }}>Исследовать скорость оплаты</button>
          <small className="chat-typing" role="status">
            {busy ? <><span aria-hidden="true"><i/><i/><i/></span> Агент проверяет данные…</> :
              metricNames[viewMetric] + ' · ' + segmentNames[segment]}
          </small>
          {chatError && <p role="alert">{chatError}</p>}
          <div className="composer-row">
            <textarea ref={chatBox} aria-label="Спросить агента" required maxLength={1500} rows={1} value={question}
              placeholder="Спросить агента…" onChange={event => { setQuestion(event.target.value); requestId.current = ''; }}
              onKeyDown={event => {
                if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.nativeEvent.isComposing) return;
                event.preventDefault();
                if (report && !busy && question.trim()) event.currentTarget.form?.requestSubmit();
              }}/>
            <button type="submit" className="primary chat-send" aria-label="Отправить вопрос" title="Отправить вопрос (Enter)"
              disabled={!report || busy || !question.trim()}><Icon name="arrowUp"/></button>
          </div>
        </form>
      </aside>
    </div>
    {dialog && <ReleaseResultDialog result={dialog} close={() => setDialog(null)}/>}
  </>;
}
