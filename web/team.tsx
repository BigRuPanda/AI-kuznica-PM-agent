import { SourceExtract } from './knowledge-source';
import { Knowledge } from './knowledge';
import { ReleaseDecision } from './release-decision';
import { ReleaseAnalytics } from './app';
import { MetrikaJournal } from './metrika-status';
import { ChatTrackerPreview, Connections, DemoObject, Tracking } from './tracking';
import type { TrackerPreview } from './tracking';
import { BridgePages, useTrackingVisibility } from './tracking-visibility';
import { RangeResult } from './range-result';
import { rangeLabel, RangeChart, DAY } from './range-chart';
import type { Attachment } from './range-chart';
import { SavedChart } from './calculations';
import {
  MaterialCard,
  MaterialDetail,
  MiniPlot,
  MaterialsProvider,
  PinnedMaterials,
  pastedMaterial,
  useMaterials,
  type ChatAttachment,
  type MaterialRef,
} from './materials';
import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, type RefObject } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ChatScenarioMenu } from './chat-scenario-menu';
import { loadScenarioDraft, selectScenario, serializeScenarioDraft } from './chat-scenarios';
import { post, jump, num } from './team-data';
import type { Home, User, Case, Detail, View, Msg, Thread, InvestigationRun } from './team-data';
import { describeMeasurement, MeasurementFields, measurementPayload, metricName, WatchSummary } from './measurement';
import { AgreedMeasurement, InvestigationMeasurement } from './investigation-measurement';
import { EffectPlan } from './effect-plan';
import { Cards, initialCards, labels } from './work-cards';
import { patchCaseView, readCasePeriod, readCaseRatioSelections, readCaseView } from './case-view-preferences';
import type { CaseViewPreferences } from './case-view-preferences';
import { InterviewSearch } from './interview-search';
import { Icon } from './icons';
import { Dialog } from './dialog';
import { ChatThreadRow } from './chat-thread-row';
import { ChatMenu, type ChatAction } from './chat-menu';
import { ThemeProvider, ThemeSwitch } from './theme-switch';
import { MetricRules } from './metric-rules';
import { InvestigationSettings } from './investigation-settings';
import { CaseInvestigation, InvestigationSnapshot, useCaseInvestigation } from './case-investigation';
import type { InvestigationCalculation } from './case-investigation';
import { caseHeading, changeLabel, signalBaseline, signalPeriod } from './case-periods';
import { CasePeriodFilter } from './case-period-filter';
import { SignalEvidence } from './signal-evidence';
import { Answer } from './answer';
import { moveMenu, moveView } from './motion';
import { styleFormValidation } from './form-validation';
import { menuLayoutKey, readMenuLayout } from './menu-layout';
import type { MenuLayout } from './menu-layout';
import { minSidebarWidth, SidebarResizeHandle, useSidebarWidth } from './sidebar-width';
import { PanelResizeHandle, useDiscussionDock, usePanelSize, usePanelSpace } from './panel-size';
import { BrandLogo } from './brand-logo';
import { ProfileEntry, ProfilePage } from './profile';
import { NotificationSettings } from './notifications';
import { ChatPresentation, PresentationMaterials } from './presentations';
import './team.css';
import './tracking.css';
import './chat.css';

type Action = (fn: () => Promise<void>) => void;
type ThreadTitle = Pick<Thread, 'id' | 'title'>;
const releaseAssessmentHref = (releaseId: string) => '#release-decision/' + encodeURIComponent(releaseId);

function currentRoute() {
  if (location.hash.length > 1) return location.hash.slice(1);
  const params = new URLSearchParams(location.search);
  if (params.get('openChat')) return 'chats/' + params.get('openChat');
  return params.get('legacy') === '1' ? 'releases' : 'overview';
}
function useRoute() {
  const [route, set] = useState(currentRoute());
  useEffect(() => {
    const change = () => set(currentRoute());
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  const [page, ...segments] = route.split('/');
  if (segments.length && (page === 'release-detail' || page === 'release-decision')) {
    const releaseId = segments.join('/');
    try { return [page, decodeURIComponent(releaseId)]; }
    catch { return [page, releaseId]; }
  }
  return [page, ...segments];
}
function Login({ onLogin, joinCode }: { onLogin: (user: User) => void; joinCode?: string }) {
  const [register, mode] = useState(joinCode !== undefined),
    [error, fail] = useState(''),
    [pending, wait] = useState(false);
  return (
    <main className="login-wrap">
      <div className="login-box">
        <div className="login-top">
          <div className="brand" role="img" aria-label="Софтлайн Решения">
            <BrandLogo />
          </div>
          <ThemeSwitch />
        </div>
        <h1>{register ? 'Создать аккаунт' : 'Вход'}</h1>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            wait(true);
            fail('');
            const data = Object.fromEntries(new FormData(e.currentTarget));
            try {
              onLogin(await post<User>(register ? 'register' : 'login', data));
              if (joinCode !== undefined) jump('overview');
            } catch (err) {
              fail(String((err as Error).message));
            } finally {
              wait(false);
            }
          }}
        >
          {register && (
            <label>
              Имя
              <input name="name" autoComplete="name" required />
            </label>
          )}
          <label>
            Логин
            <input name="login" autoComplete="username" required />
          </label>
          <label>
            Пароль
            <input
              name="password"
              type="password"
              minLength={register ? 8 : 1}
              autoComplete={register ? 'new-password' : 'current-password'}
              required
            />
          </label>
          {register && (
            <label>
              Код приглашения
              <input name="code" defaultValue={joinCode ?? ''} required />
            </label>
          )}
          {error && <p role="alert">{error}</p>}
          <button className="primary" disabled={pending}>
            {pending ? 'Подождите…' : register ? 'Создать аккаунт' : 'Войти'}
          </button>
        </form>
        <button className="text-action" onClick={() => mode(!register)}>
          {register ? 'Уже есть аккаунт' : 'У меня есть приглашение'}
        </button>
      </div>
    </main>
  );
}
const caseTypeLabels = {
  all: 'Все',
  signal: 'Сигналы',
  release: 'Релизы',
  standalone: 'Самостоятельные',
} as const;
type CaseType = keyof typeof caseTypeLabels;

function caseReleaseId(item: Case) {
  return item.body.release || item.body.signal?.releaseId;
}

function matchesCaseType(item: Case, type: CaseType) {
  switch (type) {
    case 'signal': return Boolean(item.body.signal);
    case 'release': return Boolean(caseReleaseId(item));
    case 'standalone': return !item.body.signal && !caseReleaseId(item);
    case 'all': return true;
  }
}

function CaseList({
  items, showTypes = false, emptyMessage = 'Разборы появятся после загрузки данных или нового поручения.',
}: { items: Case[]; showTypes?: boolean; emptyMessage?: string }) {
  return (
    <div className="case-list">
      {items.length ? (
        items.map((c) => {
          const releaseId = showTypes ? caseReleaseId(c) : undefined;
          return (
            <a key={c.id} href={'#case/' + c.id}>
              <div>
                <div className="case-badges">
                  <span className="state">{c.state}</span>
                  {showTypes && c.body.signal && <span className="state">сигнал</span>}
                  {releaseId && <span className="state">релиз</span>}
                  {c.body.signal?.status === 'withdrawn' && <span className="state">Сигнал отозван</span>}
                </div>
                <h3>{c.title}</h3>
                <small>
                  {c.body.signal?.week || c.product}
                  {releaseId && ' · ' + releaseId}
                </small>
              </div>
              <div className="case-value" data-negative={(c.body.signal?.change ?? 0) < 0}>
                {c.body.signal?.status === 'withdrawn' ? '—' : c.body.signal?.rule === 'relative'
                  ? changeLabel(c.body.signal.change)
                  : c.body.signal
                    ? num(c.body.signal.value) + (c.body.signal.metric ? '%' : ' п.')
                    : <Icon name="arrow" />}
              </div>
            </a>
          );
        })
      ) : (
        <p className="empty">{emptyMessage}</p>
      )}
    </div>
  );
}
const stepNames: Record<string, string> = {
  overview: 'Открыт обзор',
  release_decision: 'Проверены данные по релизу',
  web_search:'Поиск в Яндексе', read_public_page:'Прочитана публичная страница', competitor_check:'Проверено предложение продавца',
  'knowledge-source':'Прочитаны строки книги', 'knowledge-sources':'Найдены книги', source_value:'Проверена ячейка',
  metrics: 'Проверен каталог метрик',
  selection_context: 'Проверен соседний период и источники',
  search: 'Найдены свидетельства',
  view: 'Сопоставлены продукт и контроль',
  calc: 'Открыт сохранённый расчёт',
  chart: 'Построен график',
  funnel: 'Рассчитаны этапы воронки',
  range_read: 'Проверены выбранные даты',
  range_compare: 'Сопоставлены периоды',
  draft: 'Сохранён черновик',
  issue_search: 'Проверены похожие задачи',
  issue_read: 'Прочитана задача',
  page_search: 'Найдены страницы',
  page_read: 'Прочитана страница',
  page_draft: 'Подготовлена публикация в Confluence',
  'create-case': 'Создан личный разбор',
  set_view: 'Обновлён личный экран',
  prepare_publish: 'Подготовлена публикация',
  append_case: 'Сохранён вывод',
  feedback: 'Сохранена поправка',
  watch: 'Назначена проверка',
  decide: 'Изменён статус',
};
const stepLabel = (name: string) => stepNames[name] || name;
function CompletedChecks({ body }: { body: Msg['body'] }) {
  const { visibleTrackerStep } = useTrackingVisibility();
  const checks = [...new Set([...(body.checks || []), ...(body.steps || [])]
    .filter(visibleTrackerStep).map(stepLabel))];
  if (!checks.length) return null;
  return <details>
    <summary>Выполненные проверки</summary>
    <ul>{checks.map(check => <li key={check}>{check}</li>)}</ul>
  </details>;
}
function Overview({ home, onAsk }: { home: Home; onAsk: () => void }) {
  const watching = home.cases.filter((c) => c.state === 'Наблюдаем эффект');
  const attention = home.cases
    .filter((c) => (c.state === 'Исследуем' && c.body.signal && c.body.signal.status !== 'withdrawn') || c.state === 'Нужно решение')
    .sort((a, b) => (b.body.signal?.week || '').localeCompare(a.body.signal?.week || ''));
  const featured = attention.find((c) => c.body.signal && c.body.signal.status !== 'withdrawn');
  const signal = featured?.body.signal;
  const relative = signal?.rule === 'relative';

  return (
    <>
      <div className="page-head overview-head">
        <div>
          <h1>Обзор</h1>
          {home.user.role === 'judge' && <span className="state">Демо</span>}
        </div>
        <div className="overview-actions">
          <button onClick={onAsk}>Спросить помощника</button>
        </div>
      </div>
      <section aria-labelledby="attention-title">
        <h2 id="attention-title">Требует внимания</h2>
        {featured && signal && (
          <article className="signal-panel">
            <div className="signal-main">
              <span className="state">{featured.state}</span>
              {signal.metric && signal.status === 'provisional' && <span className="state">Предварительный сигнал</span>}
              <h3>{caseHeading(featured)}</h3>
              <p className="signal-product">{featured.product}</p>
              <strong className="signal-metric">
                {relative || signal.metric ? changeLabel(signal.change, signal.changeUnit) : num(signal.value) + ' п.'}
              </strong>
            </div>
            <div className="signal-comparison">
              <dl className="signal-periods">
                <div>
                  <dt>{relative ? '4 полные недели' : 'Неделя сигнала'}</dt>
                  <dd>{signalPeriod(signal)}</dd>
                </div>
                {(relative || signal.metric) && (
                  <div>
                    <dt>{signal.metric ? 'База до релиза' : 'Предыдущие 12 недель'}</dt>
                    <dd>{signalBaseline(signal)}</dd>
                  </div>
                )}
              </dl>
              {relative && (
                <div className="signal-window-strip" aria-hidden="true">
                  <span /><span />
                </div>
              )}
              <a className="primary arrow-action" href={'#case/' + featured.id}>
                Открыть разбор <Icon name="arrow" />
              </a>
            </div>
          </article>
        )}
        {(!featured || attention.length > 1) && <CaseList items={attention.filter((c) => c !== featured)} />}
      </section>
      <section aria-labelledby="watch-title">
        <h2 id="watch-title">Проверка эффекта</h2>
        {watching.length ? <CaseList items={watching} /> : <p className="empty">Пока нет назначенных проверок.</p>}
      </section>
    </>
  );
}
function Chat({
  id,
  userId,
  avatar,
  caseId,
  threads,
  onThreadAction,
  threadMenuTrigger,
  decisionReleaseId,
  decisionContext,
  product,
  action,
  onResult,
  context,
  clearContext,
  attachment,
  screen,
  onAttachFocus,
}: {
  id: string;
  userId: string;
  avatar: User['avatar'];
  caseId?: string;
  threads: Thread[];
  onThreadAction?: (thread: Thread, action: ChatAction) => void;
  threadMenuTrigger?: RefObject<HTMLButtonElement | null>;
  decisionReleaseId?: string;
  decisionContext?: string;
  product?: string;
  action: Action;
  onResult?: (b: Msg['body']) => void;
  context?: string;
  clearContext?: () => void;
  attachment?: Attachment;
  screen?: { calc: string; full: boolean; control?: string | false; cards: string[] };
  onAttachFocus?: () => void;
}) {
  const { open: openMaterial, load: loadMaterial, listen } = useMaterials();
  const { hiddenDemoPage, visibleTrackerStep } = useTrackingVisibility();
  const [progress, setProgress] = useState<string[]>([]);
  const [jobIssue, setJobIssue] = useState('');
  const [material, setMaterial] = useState<MaterialRef | null>(null);
  const [sharing, setSharing] = useState(false);
  const [webSearch,setWebSearch]=useState(false);
  useEffect(()=>setWebSearch(false),[id]);
  const focusHandler = useRef(onAttachFocus);
  focusHandler.current = onAttachFocus;
  const pendingKey = 'pm-pending/' + userId + '/' + id;
  const draftKey = 'pm-chat-draft/' + userId + '/' + id;
  const readPending = () => {
    try {
      return JSON.parse(sessionStorage.getItem(pendingKey) || 'null') as {
        id: string;
        body: string;
        text: string;
      } | null;
    } catch {
      return null;
    }
  };
  const [items, setItems] = useState<Msg[]>([]),
    [running, work] = useState(false),
    [draft, setDraft] = useState(() => {
      try { return loadScenarioDraft(sessionStorage.getItem(draftKey), readPending()?.text || ''); }
      catch { return {text: '', scenarioId: null}; }
    }),
    [err, setErr] = useState(''),
    [loaded, setLoaded] = useState(false),
    [away, setAway] = useState(false),
    [copied, setCopied] = useState<number>();
  const activeThread = threads.find((t) => t.id === id);
  const q = draft.text;
  function editText(text: string) {
    setDraft(previous => ({text, scenarioId: text ? previous.scenarioId : null}));
  }
  const isGroup = activeThread?.scope === 'group';
  // Private thread IDs are unique to the account; group IDs are shared, including "group".
  const storageId = isGroup ? userId + '/' + id : id;
  const [attached, setAttached] = useState<Attachment | undefined>(() => {
    try {
      return JSON.parse(sessionStorage.getItem('pm-attachment/' + storageId) || 'null') || undefined;
    } catch {
      return undefined;
    }
  });
  const [sending, setSending] = useState(false),
    [receipts, showReceipt] = useState<Record<string, string>>({});
  const box = useRef<HTMLTextAreaElement>(null),
    history = useRef<HTMLDivElement>(null),
    send = useRef<HTMLButtonElement>(null),
    follow = useRef(true),
    request = useRef<{ id: string; body: string; text: string } | null>(readPending());
  const replacementRequests = useRef(new Map<number, string>());
  useEffect(() => {
    function accept(a: ChatAttachment) {
      setMaterial(a.material);
      sessionStorage.setItem('pm-material-draft/' + storageId, JSON.stringify(a));
      if (a.range) {
        setAttached(a.range);
        sessionStorage.setItem('pm-attachment/' + storageId, JSON.stringify(a.range));
      } else {
        setAttached(undefined);
        sessionStorage.removeItem('pm-attachment/' + storageId);
      }
      setSharing(false);
      focusHandler.current?.();
      requestAnimationFrame(() => box.current?.focus());
    }
    const saved = sessionStorage.getItem('pm-material-draft/' + storageId);
    if (saved) {
      try {
        accept(JSON.parse(saved));
      } catch {
        sessionStorage.removeItem('pm-material-draft/' + storageId);
      }
    }
    return listen(accept);
  }, [storageId, listen]);
  const pasted = pastedMaterial(q);
  const [linkMaterial, setLinkMaterial] = useState<MaterialRef | null>(null);
  const needsShare =
    threads.find((t) => t.id === id)?.scope === 'group' &&
    [material, linkMaterial].some((m) => m && !m.shared);
  useEffect(() => {
    let valid = true;
    setLinkMaterial(null);
    setSharing(false);
    if (pasted)
      loadMaterial(pasted)
        .then((m) => {
          if (valid) setLinkMaterial(m);
        })
        .catch((e) => {
          if (valid) setErr(e.message);
        });
    return () => {
      valid = false;
    };
  }, [pasted, loadMaterial]);
  useEffect(() => {
    if (attachment) {
      setAttached(attachment);
      sessionStorage.setItem('pm-attachment/' + storageId, JSON.stringify(attachment));
      box.current?.focus();
    }
  }, [attachment, storageId]);
  useEffect(() => {
    if (sessionStorage.getItem('pm-attachment/' + storageId)) box.current?.focus();
  }, [storageId]);
  function clearAttachment() {
    setAttached(undefined);
    sessionStorage.removeItem('pm-attachment/' + storageId);
  }
  const resultHandler = useRef(onResult);
  resultHandler.current = onResult;
  const refresh = useCallback(async () => {
    return await post<{ items: Msg[]; jobs: { steps: string[]; issue?: string }[] }>('messages', {
      thread: id,
    });
  }, [id]);
  useEffect(() => {
    let valid = true,
      fetching = false,
      initial = true;
    const seen = new Map<number, string | undefined>();
    follow.current = true;
    setItems([]);
    setLoaded(false);
    setErr('');
    const read = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const data = await refresh();
        if (!valid) return;
        setItems(data.items);
        work(!!data.jobs.length);
        setLoaded(true);
        setErr('');
        setProgress(data.jobs.flatMap((j) => j.steps || []).filter(visibleTrackerStep));
        setJobIssue(data.jobs.find((j) => j.issue)?.issue || '');
        for (const m of data.items)
          if (m.role === 'assistant') {
            if (!initial && (!seen.has(m.seq) || seen.get(m.seq) !== m.body.outcome))
              resultHandler.current?.(m.body);
            seen.set(m.seq, m.body.outcome);
          }
        initial = false;
      } catch (e) {
        if (valid) { setErr((e as Error).message); setLoaded(true); }
      } finally {
        fetching = false;
      }
    };
    void read();
    const t = setInterval(read, 1400);
    return () => {
      valid = false;
      clearInterval(t);
    };
  }, [id, refresh]);
  useLayoutEffect(() => {
    if (box.current) {
      box.current.style.height = 'auto';
      box.current.style.height = Math.min(144, box.current.scrollHeight) + 'px';
    }
  }, [q]);
  useEffect(() => {
    try {
      if (draft.text) sessionStorage.setItem(draftKey, serializeScenarioDraft(draft));
      else sessionStorage.removeItem(draftKey);
    } catch {}
  }, [draft, draftKey]);
  useLayoutEffect(() => {
    if (follow.current && history.current && !document.querySelector('dialog[open]')) history.current.scrollTop = history.current.scrollHeight;
  }, [items.length, loaded, running]);
  function jumpToLatest() {
    follow.current = true;
    setAway(false);
    history.current?.scrollTo({
      top: history.current.scrollHeight,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }
  function suggest(question: string) {
    setDraft({text: question, scenarioId: null});
    box.current?.focus();
  }
  function chooseScenario(scenarioId: string) {
    flushSync(() => setDraft(previous => selectScenario(previous, scenarioId)));
    const input = box.current;
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
  return (
    <section className={!caseId ? 'chat-box standalone-chat' : 'chat-box'} aria-label="Переписка">
      <header className="conversation-heading">
        <span className="chat-avatar" aria-hidden="true"><Icon name={isGroup ? 'people' : 'agent'} /></span>
        <div className="conversation-title">
          <h3>{caseId ? 'Обсудить разбор' : activeThread?.title || 'Чат'}</h3>
          <small>{isGroup ? 'Командный чат' : 'Личный чат'}</small>
        </div>
        {activeThread && onThreadAction && (
          <ChatMenu thread={activeThread} onAction={onThreadAction} triggerRef={threadMenuTrigger} />
        )}
      </header>
      <div className="conversation-body">
        <div
          className="chat-history"
          ref={history}
          onScroll={(event) => {
            const list = event.currentTarget;
            const nearEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 72;
            follow.current = nearEnd;
            setAway(!nearEnd);
          }}
        >
        {!loaded && <p className="chat-loading muted" role="status">Загрузка переписки…</p>}
        {loaded && !items.length && !err && !running && (
          <div className="chat-empty">
            {!caseId && <span className="chat-illustration" aria-hidden="true" />}
            <h4>{caseId ? 'Что проверить?' : 'С чего начнём?'}</h4>
            {caseId ? (
              <button type="button" onClick={() => suggest('Что стоит проверить в этом разборе?')}>
                <Icon name="cases" /> Что стоит проверить
              </button>
            ) : (
              <div className="chat-prompts">
                <button type="button" onClick={() => suggest('Какие изменения метрик требуют внимания?')}>
                  <Icon name="trend" /> Найти отклонения
                </button>
                <button type="button" onClick={() => suggest('Какие задачи стоит проверить в первую очередь?')}>
                  <Icon name="cases" /> Проверить бэклог
                </button>
              </div>
            )}
          </div>
        )}
        {items.map((m) => (
          <article className={'bubble ' + m.role} key={m.seq}>
            <div className="message-author">
              <span className="chat-avatar" aria-hidden="true">
                {m.role === 'assistant' ? <Icon name="agent" /> : m.own && avatar
                  ? <img src={avatar} alt="" />
                  : m.author.trim().slice(0, 1).toUpperCase()}
              </span>
              <b>{m.author}</b>
            </div>
            {m.role === 'assistant' ? (
              <Answer text={m.body.text} openMaterial={openMaterial} />
            ) : (
              <p>{m.body.text}</p>
            )}
            {m.body.readSources?.filter(source => !hiddenDemoPage(source.url)).map(source => <div key={source.url}>
              <a href={source.url} {...(/^https?:\/\//i.test(source.url) && {target:'_blank',rel:'noreferrer'})}>{source.label}</a>
              {source.detail && <small> · {source.detail}</small>}
            </div>)}
            {m.body.closingQuotes?.map(quote => <div key={quote.key}>
              <small>Комментарий при закрытии{quote.author ? ' · ' + quote.author : ''}</small>
              <blockquote className="tracker-text">{quote.text}</blockquote>
            </div>)}
            {m.body.checkedAt && <small>Проверено {new Date(m.body.checkedAt).toLocaleString('ru-RU')}</small>}
            {m.body.materials?.map((item) => (
              <MaterialCard key={item.id} item={item} />
            ))}
            {!m.body.materials?.length &&
              m.body.suggestions?.map((s) =>
                s.source === 'metric' ? (
                  <Snapshot key={s.calc} id={s.calc} previewTitle={s.title} />
                ) : s.source === 'release' ? (
                  <SavedChart key={s.calc} id={s.calc} preview />
                ) : (
                  <a
                    key={s.calc}
                    href={
                      s.source === 'range'
                        ? '#range/' + s.calc
                        : '#snapshot/' + s.calc + '/' + s.cards.join(',')
                    }
                  >
                    {s.title}
                  </a>
                ),
              )}
            {m.body.rangeId && !m.body.materials?.length && (
              <a href={'#range/' + m.body.rangeId}>
                Выделенный участок
                {m.body.selection
                  ? ' · ' +
                    m.body.selection.ranges
                      .map(
                        (r, i) => (i ? 'B: ' : 'A: ') + rangeLabel(r, m.body.selection?.source === 'release'),
                      )
                      .join(' / ')
                  : ''}
              </a>
            )}
            {m.body.actions?.filter(a => visibleTrackerStep(a.op)).map((a, i) => (
              <div className="tool-receipt" key={a.id || i}>
                <b>
                  {a.title ||
                    (
                      {
                        prepare_publish: 'Публикация в команду',
                        watch: 'Проверка назначена',
                        feedback: 'Поправка сохранена',
                        append_case: 'Вывод сохранён',
                        set_view: 'Личный вид обновлён',
                        decide: 'Состояние изменено',
                      } as Record<string, string>
                    )[a.op]}
                </b>
                {a.description && <p>{a.description}</p>}
                {a.conclusion && <p>{a.conclusion}</p>}
                {!!a.similar?.length && (
                  <details>
                    <summary>Похожие задачи · {a.similar.length}</summary>
                    {a.similar.map((task) => (
                      <p key={task.key}>
                        {task.key} · {task.title}
                      </p>
                    ))}
                  </details>
                )}
                {a.id && a.canConfirm !== false && ['draft', 'page_draft'].includes(a.op) && (
                  <ChatTrackerPreview id={a.id} action={action} />
                )}
                {a.recipient && <small>Получатели: {a.recipient}</small>}
                {a.rangeId && <a href={'#range/' + a.rangeId}>Проверить выделенные периоды</a>}
                {a.cards?.length ? (
                  <small>Материалы: {a.cards.map((k) => labels[k] || k).join(', ')}</small>
                ) : null}
                {a.id &&
                  a.canConfirm !== false &&
                  a.op === 'prepare_publish' &&
                  (a.state === 'done' || receipts[a.id] ? (
                    <small>{receipts[a.id] || a.external || 'Подтверждено'}</small>
                  ) : (
                    <button
                      onClick={() =>
                        action(async () => {
                          const r = await post<{ key?: string; id?: string }>('approve_preview', {
                            id: a.id,
                          });
                          showReceipt((prev) => ({ ...prev, [a.id!]: r.key || 'Опубликовано' }));
                        })
                      }
                    >
                      Подтвердить публикацию
                    </button>
                  ))}
              </div>
            ))}
            <CompletedChecks body={m.body} />
            {m.body.presentationId && m.body.presentationStatus === 'ready' &&
              <ChatPresentation id={m.body.presentationId} />}
            {m.body.mode === 'presentation' && m.body.outcome === 'clarification' &&
              <a href="#cases">Открыть разборы</a>}
            {m.body.replacePresentation && (
              <button disabled={running || sending} onClick={() => action(async () => {
                const requestId = replacementRequests.current.get(m.seq) || crypto.randomUUID();
                replacementRequests.current.set(m.seq, requestId);
                work(true);
                try {
                  await post('ask', { thread:id, caseId:m.body.caseId, question:'Сделай презентацию', requestId });
                  replacementRequests.current.delete(m.seq);
                } catch (error) {
                  work(false);
                  throw error;
                }
              })}>
                Собрать новую версию
              </button>
            )}
            {m.body.warning && !m.body.text.includes(m.body.warning) && <small>{m.body.warning}</small>}
            {m.body.canResume && (
              <button
                disabled={running}
                onClick={() =>
                  action(async () => {
                    await post('resume-job', { id: m.body.jobId });
                    work(true);
                  })
                }
              >
                {m.body.missingPresentation ? 'Собрать презентацию' : 'Продолжить с сохранённого шага'}
              </button>
            )}
            {m.body.calc && !m.body.materials?.length && (
              <a href={'#snapshot/' + m.body.calc + '/' + (m.body.cards || initialCards).join(',')}>
                Открыть расчёт
              </a>
            )}{' '}
            {m.body.caseId && <a href={'#case/' + m.body.caseId}>К разбору</a>}
            {!caseId && m.role === 'assistant' && m.body.calc && m.body.product && !m.body.caseId && (
              <button
                onClick={() =>
                  action(async () => {
                    const c = await post<{ id: string }>('create-case', {
                      title:
                        items.filter((x) => x.seq < m.seq && x.role === 'user').at(-1)?.body.text ||
                        m.body.product,
                      product: m.body.product,
                      message: m.seq,
                    });
                    jump('case/' + c.id);
                  })
                }
              >
                Открыть разбор
              </button>
            )}
            {m.role === 'assistant' && m.body.text && (
              <button
                type="button"
                className="copy-message"
                aria-label={copied === m.seq ? 'Ответ скопирован' : 'Скопировать ответ'}
                title={copied === m.seq ? 'Скопировано' : 'Скопировать ответ'}
                onClick={() => action(async () => {
                  await navigator.clipboard.writeText(m.body.text);
                  setCopied(m.seq);
                })}
              >
                <Icon name={copied === m.seq ? 'check' : 'copy'} />
              </button>
            )}
          </article>
        ))}
        {err && <p role="alert">{err}</p>}
        {running && (
          <p className="chat-typing" role="status">
            <span aria-hidden="true"><i /><i /><i /></span> {jobIssue || (progress.length ? 'Выполнено · ' + [...new Set(progress.map(stepLabel))].join(' · ') : 'Помощник отвечает')}
          </p>
        )}
        </div>
        {away && (
          <button type="button" className="chat-latest" onClick={jumpToLatest} title="К последнему сообщению" aria-label="К последнему сообщению">
            <Icon name="down" />
          </button>
        )}
      </div>
      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (!q.trim() || sending) return;
          const groupMessage = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'message';
          action(async () => {
            setSending(true);
            const body = {
              thread: id,
              typedQuestion:q.trim(), webSearch:!groupMessage && webSearch,
              question: (context && !webSearch ? 'О графике «' + context + '». ' : '') + q,
              caseId,
              decisionReleaseId,
              decisionContext,
              product,
              screen,
              materialIds: [...new Set([material?.id, pasted].filter(Boolean))],
              shareMaterials: !!needsShare && sharing,
              ...(attached?.id
                ? { rangeId: attached.id }
                : attached
                  ? { selection: attached.selection }
                  : {}),
            };
            const key = JSON.stringify(body);
            if (request.current?.body !== key)
              request.current = { id: crypto.randomUUID(), body: key, text: q };
            sessionStorage.setItem(pendingKey, JSON.stringify(request.current));
            try {
              await post(groupMessage ? 'say' : 'ask', { ...body, requestId: request.current.id });
            } finally {
              setSending(false);
            }
            request.current = null;
            sessionStorage.removeItem(pendingKey);
            setWebSearch(false);
            follow.current = true;
            setAway(false);
            clearAttachment();
            setMaterial(null);
            sessionStorage.removeItem('pm-material-draft/' + storageId);
            setDraft(current => current === draft ? {text: '', scenarioId: null} : current);
            work(!groupMessage);
            clearContext?.();
          });
        }}
      >
        {(material || linkMaterial) && (
          <div className="range-attachment">
            <span>{(material || linkMaterial)?.title}</span>
            <button
              type="button"
              aria-label="Убрать материал"
              onClick={() => {
                setMaterial(null);
                sessionStorage.removeItem('pm-material-draft/' + storageId);
                if (pasted)
                  editText(
                    q
                      .split(/\s+/)
                      .filter((w) => pastedMaterial(w) !== pasted)
                      .join(' '),
                  );
              }}
            >
              ×
            </button>
          </div>
        )}
        {needsShare && (
          <label>
            <input
              type="checkbox"
              checked={sharing}
              required
              onChange={(e) => setSharing(e.target.checked)}
            />{' '}
            Открыть участникам команды доступ к приложенным материалам
          </label>
        )}
        {attached && (
          <div className="range-attachment">
            <span>{attached.label}</span>
            <button type="button" aria-label="Убрать выделение" onClick={clearAttachment}>
              ×
            </button>
            <button
              type="button"
              onClick={() => {
                suggest('Почему здесь изменилось значение?');
              }}
            >
              Почему здесь изменение?
            </button>
          </div>
        )}
        {context && (
          <button type="button" onClick={clearContext}>
            {context} ×
          </button>
        )}
        <label className="sr" htmlFor={'q' + id}>
          Вопрос агенту
        </label>
        <div className="composer-row">
          {!caseId && <ChatScenarioMenu onSelect={chooseScenario} />}
          <textarea
            ref={box}
            id={'q' + id}
            placeholder="Ваш вопрос…"
            value={q}
            rows={1}
            onChange={(e) => editText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.nativeEvent.isComposing) return;
              e.preventDefault();
              if (q.trim() && !sending) e.currentTarget.form?.requestSubmit(send.current ?? undefined);
            }}
            required
          />
          <button type="button" role="switch" aria-checked={webSearch} className="chat-web-search"
            disabled={sending} onClick={() => setWebSearch(value => !value)}>
            <span className="search-switch-track" aria-hidden="true" />
            Поиск в интернете
          </button>
          <button ref={send} type="submit" className="primary chat-send" aria-label={isGroup ? 'Спросить помощника' : 'Отправить'} title="Отправить (Enter)" disabled={sending || !q.trim()}>
            <Icon name="arrowUp" />
          </button>
        </div>
        {isGroup && !attached && (
          <button type="submit" className="text-action team-send" value="message" disabled={sending || !q.trim()}>
            <Icon name="people" /> Написать команде
          </button>
        )}
      </form>
    </section>
  );
}
function RenameChatDialog({ thread, close, onRename }: {
  thread: Thread;
  close: (renamed: boolean) => void;
  onRename: (renamed: ThreadTitle) => void;
}) {
  const [saving, save] = useState(false);
  const [error, fail] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const renamed = useRef(false);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  return (
    <Dialog title="Переименовать чат" close={() => close(renamed.current)}>
      {(dismiss) => (
        <form onSubmit={async (event) => {
          event.preventDefault();
          if (saving) return;
          const title = String(new FormData(event.currentTarget).get('title') || '').trim();
          if (!title) {
            fail('Введите название чата.');
            field.current?.focus();
            return;
          }
          if (title === thread.title) {
            dismiss();
            return;
          }
          save(true);
          fail('');
          try {
            onRename(await post<ThreadTitle>('rename-thread', { thread: thread.id, title }));
            renamed.current = true;
            dismiss();
          } catch (e) {
            fail((e as Error).message);
          } finally {
            save(false);
          }
        }}>
          <label>
            Название
            <input
              ref={field}
              name="title"
              defaultValue={thread.title}
              maxLength={120}
              required
              readOnly={saving}
              onChange={() => fail('')}
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <footer className="actions chat-dialog-actions">
            <button type="button" disabled={saving} onClick={() => dismiss()}>Отмена</button>
            <button type="submit" className="primary" disabled={saving}>{saving ? 'Сохраняем…' : 'Сохранить'}</button>
          </footer>
        </form>
      )}
    </Dialog>
  );
}

function DeleteChatDialog({ thread, close, onDelete }: {
  thread: Thread;
  close: () => void;
  onDelete: (id: string) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, fail] = useState('');
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);

  return (
    <Dialog title="Удалить чат?" close={close}>
      {(dismiss) => (
        <div className="confirm-action">
          <p>Чат <strong>«{thread.title}»</strong> будет удалён вместе с перепиской. Восстановить её нельзя.</p>
          {thread.scope === 'group' && <p>Чат исчезнет у всех участников.</p>}
          {error && <p role="alert">{error}</p>}
          <footer className="actions chat-dialog-actions">
            <button ref={cancel} type="button" disabled={deleting} onClick={() => dismiss()}>Отмена</button>
            <button type="button" className="primary" disabled={deleting} onClick={async () => {
              if (deleting) return;
              setDeleting(true);
              fail('');
              try {
                const result = await post<{ id: string }>('delete-thread', { thread: thread.id });
                onDelete(result.id);
                dismiss();
              } catch (e) {
                fail((e as Error).message);
              } finally {
                setDeleting(false);
              }
            }}>{deleting ? 'Удаляем…' : 'Удалить чат'}</button>
          </footer>
        </div>
      )}
    </Dialog>
  );
}

function ChatWorkspace({ home, id, avatar, action, refresh, onRename, onDelete }: {
  home: Home;
  id: string;
  avatar: User['avatar'];
  action: Action;
  refresh: () => Promise<void>;
  onRename: (renamed: ThreadTitle) => void;
  onDelete: (id: string) => void;
}) {
  const [query, search] = useState('');
  const [listOpen, toggleList] = useState(false);
  const [listCollapsed, collapseList] = useState(false);
  const [wide, setWide] = useState(() => matchMedia('(min-width: 821px)').matches);
  useEffect(() => {
    const media = matchMedia('(min-width: 821px)');
    const update = () => setWide(media.matches);
    media.addEventListener('change', update);
    update();
    return () => media.removeEventListener('change', update);
  }, []);
  const [creating, create] = useState(false);
  const [saving, save] = useState(false);
  const [editing, edit] = useState<{ thread: Thread; action: ChatAction } | null>(null);
  const activeMenuTrigger = useRef<HTMLButtonElement>(null);
  const renamedThread = useRef<string>(null);
  const { available, observe } = usePanelSpace();
  const listWidth = usePanelSize('pm-chat-list-width', 280, 164,
    available ? Math.max(164, Math.min(368, Math.floor(available - 314))) : 368);
  const activeId = id || 'group';
  const term = query.trim().toLocaleLowerCase('ru');
  const threads = home.threads.filter((thread) => thread.title.toLocaleLowerCase('ru').includes(term));
  const groups = [
    { id: 'personal', title: 'Личные', threads: threads.filter(thread => !thread.caseId) },
    { id: 'cases', title: 'Разборы', threads: threads.filter(thread => thread.caseId) },
  ];
  const listHidden = wide ? listCollapsed : !listOpen;
  const activeRowAvailable = !listHidden && groups.some(group => group.threads.some(thread => thread.id === activeId));
  const openAction = (thread: Thread, action: ChatAction) => edit({ thread, action });

  // The active menu can move between the row and the heading while the rename dialog is open.
  useLayoutEffect(() => {
    if (editing || !renamedThread.current) return;
    const trigger = activeMenuTrigger.current;
    if (renamedThread.current === activeId && trigger !== document.activeElement) trigger?.focus();
    renamedThread.current = null;
  }, [editing, activeId]);

  function removeChat(deleted: string) {
    try {
      const thread = home.threads.find(t => t.id === deleted);
      const storageId = thread?.scope === 'group' ? home.user.id + '/' + deleted : deleted;
      sessionStorage.removeItem('pm-material-draft/' + storageId);
      sessionStorage.removeItem('pm-chat-draft/' + home.user.id + '/' + deleted);
      sessionStorage.removeItem('pm-pending/' + home.user.id + '/' + deleted);
      sessionStorage.removeItem('pm-attachment/' + storageId);
    } catch {}
    onDelete(deleted);
    if (location.hash === '#chats/' + deleted) location.replace('#chats');
  }

  return (
    <>
      <div className="page-head chats-head">
        <h1>Чаты</h1>
        <button type="button" className="primary new-chat" onClick={() => create(true)}>
          <Icon name="plus" /> Новый чат
        </button>
      </div>
      <div className="chat-layout" ref={observe} data-list-collapsed={listCollapsed}
        style={{ '--thread-width': listWidth.size + 'px' } as React.CSSProperties}>
        <aside className="threads-panel" aria-label="Чаты" data-open={listOpen}>
          <div className="threads-heading">
            {!listCollapsed && <h2>Список чатов</h2>}
            <button type="button" className="threads-collapse"
              aria-label={listCollapsed ? 'Развернуть список чатов' : 'Свернуть список чатов'}
              title={listCollapsed ? 'Развернуть список чатов' : 'Свернуть список чатов'}
              aria-expanded={!listCollapsed} aria-controls="thread-panel-content"
              onClick={() => collapseList(value => !value)}>
              <Icon name={listCollapsed ? 'right' : 'left'} />
            </button>
          </div>
          <button
            type="button"
            className="threads-toggle"
            aria-label={listOpen ? 'Свернуть список чатов' : 'Развернуть список чатов'}
            aria-expanded={listOpen}
            aria-controls="thread-panel-content"
            onClick={() => toggleList(!listOpen)}
          >
            <Icon name="chat" /> Список чатов <Icon name="down" />
          </button>
          <div id="thread-panel-content" className="thread-panel-content" inert={listHidden}>
            <label className="thread-search">
              <Icon name="search" />
              <span className="sr">Поиск чатов</span>
              <input type="search" placeholder="Найти чат" value={query} onChange={(e) => search(e.target.value)} />
            </label>
            <nav className="thread-list" aria-label="Переписки">
              {groups.filter(group => group.threads.length > 0).map(group => (
                <section className="thread-group" key={group.id} aria-labelledby={'thread-group-' + group.id}>
                  <h2 id={'thread-group-' + group.id}>{group.title}</h2>
                  {group.threads.map(t => (
                    <ChatThreadRow key={t.id} thread={t} current={activeId === t.id}
                      menuTrigger={activeRowAvailable && activeId === t.id ? activeMenuTrigger : undefined}
                      onSelect={() => toggleList(false)} onAction={openAction} />
                  ))}
                </section>
              ))}
              {!threads.length && <p className="muted">{query ? 'Чаты не найдены' : 'Пока нет чатов'}</p>}
            </nav>
          </div>
          {!listCollapsed && <PanelResizeHandle panel={listWidth} className="threads-resizer"
            label="Ширина списка чатов" controls="thread-panel-content" />}
        </aside>
        <Chat
          key={activeId}
          userId={home.user.id}
          avatar={avatar}
          id={activeId}
          threads={home.threads}
          onThreadAction={activeRowAvailable ? undefined : openAction}
          action={action}
          threadMenuTrigger={activeMenuTrigger}
        />
      </div>
      {creating && (
        <Dialog title="Новый чат" close={() => create(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (saving) return;
              const fields = new FormData(e.currentTarget);
              const title = String(fields.get('title') || '').trim();
              if (!title) return;
              action(async () => {
                save(true);
                try {
                  const thread = await post<{ id: string }>('thread', { title, group: fields.get('scope') === 'group' });
                  create(false);
                  search('');
                  toggleList(false);
                  await refresh();
                  jump('chats/' + thread.id);
                } finally {
                  save(false);
                }
              });
            }}
          >
            <label>Название<input name="title" required /></label>
            <label>
              Участники
              <select name="scope"><option value="private">Только я</option><option value="group">Вся команда</option></select>
            </label>
            <button className="primary" disabled={saving}>Создать</button>
          </form>
        </Dialog>
      )}
      {editing?.action === 'rename' && (
        <RenameChatDialog thread={editing.thread} close={(renamed) => {
          renamedThread.current = renamed ? editing.thread.id : null;
          edit(null);
        }} onRename={(renamed) => {
          if (!renamed.title.toLocaleLowerCase('ru').includes(term)) search('');
          onRename(renamed);
        }} />
      )}
      {editing?.action === 'delete' && (
        <DeleteChatDialog thread={editing.thread} close={() => edit(null)} onDelete={removeChat} />
      )}
    </>
  );
}

function Investigation({
  id,
  selected,
  documentation,
  home,
  avatar,
  action,
  refresh,
}: {
  id: string;
  selected?: string;
  documentation?: string;
  home: Home;
  avatar: User['avatar'];
  action: Action;
  refresh: () => Promise<void>;
}) {
  const prefix = 'pm-view/' + home.user.id + '/' + id;
  const [viewState, setViewState] = useState(() => ({
    preferences: readCaseView(prefix),
    period: readCasePeriod(prefix + '/period'),
    ratioSelections: readCaseRatioSelections(prefix + '/metric-series'),
    inputsVersion: 0,
  }));
  const currentView = useRef(viewState);
  const requestVersion = useRef(0);
  const active = useRef(false);
  const { period, preferences, inputsVersion } = viewState;
  const { cards = initialCards, pinned = [], full = false, control: peer = '' } = preferences || {};
  const [d, set] = useState<Detail | null>(null),
    [ctx, ask] = useState(''),
    [attachment, attach] = useState<Attachment>(),
    [tid, thread] = useState(''),
    [preview, show] = useState(false),
    [conclusion, writeConclusion] = useState(''),
    [selection, select] = useState<string[]>([]),
    [err, fail] = useState(''),
    [confirmation, confirm] = useState<'reset' | 'finish'>(),
    [updating, setUpdating] = useState(false),
    [preparingSignalIssue, setPreparingSignalIssue] = useState(false),
    [draftToFocus, setDraftToFocus] = useState('');
  const [presentationAction, setPresentationAction] = useState<HTMLSpanElement | null>(null);
  const [versionFromChat, setVersionFromChat] = useState<string>();
  const updateViewState = useCallback((next: typeof viewState) => {
    const previous = currentView.current;
    const before = previous.preferences || {}, after = next.preferences || {};
    if (previous.period !== next.period || previous.ratioSelections !== next.ratioSelections ||
      (before.full ?? false) !== (after.full ?? false) || (before.control ?? '') !== (after.control ?? '') ||
      (before.sourceQuery || '') !== (after.sourceQuery || '')) {
      // Ignore earlier results as soon as the inputs change, before the next effect runs.
      requestVersion.current++;
      next = { ...next, inputsVersion: previous.inputsVersion + 1 };
    }
    currentView.current = next;
    setViewState(next);
  }, []);
  const updatePreferences = useCallback((patch: Partial<CaseViewPreferences>) => {
    const previous = currentView.current;
    patchCaseView(prefix, patch);
    updateViewState({ ...previous, preferences: { ...previous.preferences, ...patch } });
  }, [prefix, updateViewState]);
  function applyPeriod(next: typeof period) {
    localStorage.setItem(prefix + '/period', JSON.stringify(next));
    updateViewState({ ...currentView.current, period: next });
  }
  const load = useCallback(async () => {
    if (!active.current) return;
    const version = ++requestVersion.current;
    const { preferences, period, ratioSelections } = currentView.current;
    setUpdating(true);
    fail('');
    try {
      const v = await post<Detail>('view', {
        caseId: id, full: preferences?.full ?? false,
        control: preferences?.control === '' ? undefined : preferences?.control,
        sourceQuery: preferences?.sourceQuery || '', ratioSelections, from: period.from, through: period.through,
      });
      if (version !== requestVersion.current) return;
      set(v);
      const personal = v.personal;
      if (personal?.revision && localStorage.getItem(prefix + '/revision') !== personal.revision) {
        const pinned = currentView.current.preferences?.pinned || [];
        const nextPinned = personal.pin === true ? [...new Set([...pinned, ...personal.cards])]
          : personal.pin === false ? [] : pinned;
        updatePreferences({
          cards: [...new Set([...nextPinned, ...personal.cards])], pinned: nextPinned,
          ...(personal.full !== undefined ? { full: personal.full } : {}),
          ...(personal.control !== undefined ? { control: personal.control } : {}),
        });
        localStorage.setItem(prefix + '/revision', personal.revision);
      } else if (v.case.body.origin && !currentView.current.preferences) {
        const snapshot = v.case.body.origin;
        updatePreferences({ cards: snapshot.cards || initialCards, full: !!snapshot.full });
      }
    } catch (e) {
      if (version !== requestVersion.current) return;
      fail((e as Error).message);
      throw e;
    } finally {
      if (version === requestVersion.current) setUpdating(false);
    }
  }, [id, prefix, updatePreferences]);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      requestVersion.current++;
    };
  }, []);
  useEffect(() => {
    void load().catch(() => {});
  }, [load, inputsVersion]);
  useEffect(() => {
    let valid = true;
    post<{ id: string }>('case-thread', { caseId: id })
      .then((r) => { if (valid) thread(r.id); })
      .catch((e) => { if (valid) fail(e.message); });
    return () => { valid = false; };
  }, [id]);
  const result = useCallback(
    (m: Msg['body']) => {
      if (m.presentationId) setVersionFromChat(m.presentationId);
      if (m.mode !== 'analysis' && m.cards && !m.rangeId) {
        const pinned = currentView.current.preferences?.pinned || [];
        updatePreferences({
          cards: [...new Set([...pinned, ...m.cards])],
          ...(m.fullWeeksFilter !== undefined ? { full: m.fullWeeksFilter } : {}),
          ...(m.sourceQuery !== undefined ? { sourceQuery: m.sourceQuery } : {}),
        });
      }
      if (m.personal?.caseId === id) void load().catch(() => {});
    },
    [id, load, updatePreferences],
  );
  const [mobileChat, chatMode] = useState(false);
  const [focusDiscussion, requestDiscussionFocus] = useState(false);
  const caseControls = useRef<HTMLDivElement>(null);
  const discussion = useRef<HTMLDivElement>(null);
  const { available, observe } = usePanelSpace();
  const discussionWidth = usePanelSize('pm-case-chat-width', (available || 940) * .34, 232,
    available ? Math.max(232, Math.min(540, Math.floor(available - 300))) : 540);
  useDiscussionDock(discussion, !!d && !!tid);
  const [editingMeasurement, editMeasurement] = useState(false);
  const [advancedEffectOpen, setAdvancedEffectOpen] = useState(false);
  const taskPanel = useRef<HTMLDetailsElement>(null);
  const effectSection = useRef<HTMLDetailsElement>(null);
  const detailLoaded = !!d;
  const hasWatch = !!d?.case.body.watch;
  useEffect(() => {
    if (documentation === undefined || !detailLoaded) return;
    chatMode(false);
    const frame = requestAnimationFrame(() => {
      if (!taskPanel.current) return;
      taskPanel.current.open = true;
      taskPanel.current.querySelector('summary')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [documentation, detailLoaded]);
  useEffect(() => {
    if (selected !== 'effect' || !detailLoaded) return;
    chatMode(false);
    if (!hasWatch) setAdvancedEffectOpen(true);
    const frame = requestAnimationFrame(() => {
      if (!effectSection.current) return;
      effectSection.current.open = true;
      effectSection.current.querySelector('summary')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [selected, detailLoaded, hasWatch]);
  const research = useCaseInvestigation(id, d?.investigation);
  const viewRunId = d?.investigation?.current?.id;
  const liveRunId = research.investigation?.current?.id;
  useEffect(() => {
    if (liveRunId !== viewRunId) void load().catch(() => {});
  }, [viewRunId, liveRunId, load]);
  useLayoutEffect(() => {
    if (!draftToFocus) return;
    const panel = taskPanel.current;
    const preview = document.getElementById('case-draft-' + draftToFocus);
    if (panel && preview) {
      // The disclosure animation hides the preview during programmatic focus.
      panel.dataset.revealDraft = '';
      panel.open = true;
      preview.focus();
      delete panel.dataset.revealDraft;
    }
    setDraftToFocus('');
  }, [draftToFocus]);
  useLayoutEffect(() => {
    if (!focusDiscussion || !tid) return;
    discussion.current?.querySelector<HTMLTextAreaElement>('.chat-composer textarea')?.focus();
    requestDiscussionFocus(false);
  }, [focusDiscussion, tid]);
  if (!d) return <p className={err ? 'error' : 'empty'} role={err ? 'alert' : 'status'}>{err || 'Загружаем разбор…'}</p>;
  const v = d.view,
    c = d.case;
  const signal = c.body.signal;
  const redmine = home.integrations.redmine;
  const watchNext = c.state === 'Наблюдаем эффект';
  const specified = c.body.plan?.measurement;
  const agreement = c.body.plan?.measurementAgreement;
  const agreed = specified && agreement ? { measurement: specified, agreement } : undefined;
  const monitoring = v.monitoring;
  const archiveMonitoring = monitoring?.kind === 'archive-observation' ? monitoring : undefined;
  const localMonitoring = monitoring?.kind !== 'archive-observation' ? monitoring : undefined;
  const activeMeasurement = localMonitoring?.plan.measurement;
  const signalMetric = signal?.metric;
  const productSignal = !!signalMetric && ['lk_reco_ctr','cfg_completion_rate','cfg_reach_rate'].includes(signalMetric);
  const agreementMetric = productSignal ? signalMetric : ['','orders_index','family_orders_idx','индекс заказов']
    .includes(signalMetric?.trim().toLowerCase() || '') ? 'orders_index' : undefined;
  const targetMetric = archiveMonitoring?.plan.metric || activeMeasurement?.metric || specified?.metric || signalMetric;
  const needsSalesContext = !targetMetric || targetMetric === 'orders_index' || !!v.summary[0]?.rows.length;
  const comparison = peer === false ? false : peer || v.summary[1]?.product;
  const caseCards = cards.filter(key => key !== 'watch' && (needsSalesContext || !['summary', 'trend'].includes(key)));
  const shareCards = v.monitoring ? [...caseCards, 'watch'] : caseCards;
  const oldMetric = c.body.plan?.metric?.trim().toLowerCase();
  const clarifyMetric = !!oldMetric && !['orders_index','family_orders_idx','индекс заказов'].includes(oldMetric);
  const completed = c.state === 'Завершено';
  const withdrawn = signal?.status === 'withdrawn';
  const needsReconfirmation = !!agreement && !c.body.watch &&
    (withdrawn || agreement.signalRevision !== (signal?.revision ?? 0));
  const canPlanArchive = !completed && !specified && !productSignal && !activeMeasurement;
  const useArchiveForm = Boolean(archiveMonitoring || (home.archiveOnly && !monitoring && canPlanArchive));
  const showEffect = watchNext || (completed && !!v.monitoring);
  const researchAvailable = !!research.investigation;
  const readyRuns = [research.investigation?.current, ...(research.investigation?.alternatives || [])];
  const planAccepted = d.drafts.some(draft => draft.state === 'done' &&
    readyRuns.some(run => run?.status === 'ready' && run.id === draft.investigationId));
  const scheduleEffect = !completed && !needsReconfirmation && planAccepted;
  const measurementEditor = (run: InvestigationRun) => {
    if (!signal || !agreementMetric || withdrawn || completed || c.body.watch || watchNext ||
      run.revision !== (signal.revision ?? 0) || (specified && !agreement)) return undefined;
    if (run.owner && !run.published && !(c.body.owner === home.user.id && run.owner === home.user.id && !run.parentId))
      return undefined;
    return <InvestigationMeasurement key={run.id} run={run} signal={signal} metric={agreementMetric} product={c.product}
      recovery={home.rules.recovery} previous={agreed} reload={load} />;
  };
  const onDraft = async (draftId: string) => {
    await load();
    chatMode(false);
    setDraftToFocus(draftId);
  };
  const openShare = () => {
    select(shareCards);
    writeConclusion(v.monitoring?.result.state ||
      v.summary.filter((s) => s.change != null).map((s) => s.product + ' ' + changeLabel(s.change)).join(' · '));
    show(true);
  };
  const openNext = () => {
    chatMode(false);
    requestAnimationFrame(() => {
      const panel = showEffect || scheduleEffect ? effectSection.current : taskPanel.current;
      if (!panel) return;
      panel.open = true;
      panel.querySelector('summary')?.focus();
    });
  };
  const shareAsPrimary = !researchAvailable && completed;
  const issueUnavailable = withdrawn ? 'Сигнал отозван'
    : !redmine.local && !redmine.connected ? 'Подключите личный доступ к Redmine' : undefined;
  const caseActions = <div className="actions case-actions" role="group" aria-label="Действия разбора">
    <span ref={setPresentationAction} />
    {signal && (
      <button type="button" disabled={!!issueUnavailable || updating || preparingSignalIssue}
        title={issueUnavailable} data-unavailable={issueUnavailable ? '' : undefined}
        aria-busy={preparingSignalIssue} onClick={() =>
        action(async () => {
          setPreparingSignalIssue(true);
          try {
            const draft = await post<TrackerPreview>('signal-issue-draft', { caseId: id, revision: signal.revision });
            await onDraft(draft.id);
          } finally {
            setPreparingSignalIssue(false);
          }
        })
      }>Подготовить задачу по сигналу</button>
    )}
    <div className="case-share-actions">
      <button className={shareAsPrimary ? 'primary arrow-action' : undefined} onClick={openShare} disabled={updating}>
        Поделиться {shareAsPrimary && <Icon name="arrow" />}
      </button>
      <CasePeriodFilter period={period} onApply={applyPeriod} boundaryRef={caseControls} />
    </div>
    {!researchAvailable && !completed && <button className="primary arrow-action" onClick={openNext}>
      {watchNext ? 'Проверить эффект' : 'К задаче'}
      <Icon name="arrow" />
    </button>}
  </div>;
  const signalDetails = signal?.metric && <details>
    <summary>Данные и источники сигнала</summary>
    <SignalEvidence signal={signal} />
    {v.signal?.metric && <a href={'#snapshot/' + v.id + '/signal'}>Открыть сохранённый расчёт сигнала</a>}
  </details>;
  return (
    <>
      <a className="crumb" href="#cases">← Разборы</a>
      <header className="page-head investigation-head">
        <small>{!c.title.toLocaleLowerCase('ru').includes(c.product.toLocaleLowerCase('ru')) && c.product + ' · '}
          {c.body.owner ? 'Личный разбор' : 'Команда'}</small>
        <h1>{c.title}</h1>
        {signal && !withdrawn && !research.investigation?.current?.period && <p>
          {[signal.releaseId, signalPeriod(signal), changeLabel(signal.change, signal.changeUnit)].filter(Boolean).join(' · ')}
        </p>}
        <span className="state">{c.state}</span>
        {signal?.metric && signal.status === 'provisional' && <span className="state">Предварительный сигнал</span>}
        {withdrawn && <p role="status">Сигнал отозван после пересчёта данных. Разбор и сохранённые выводы доступны для проверки.</p>}
        {!researchAvailable && signalDetails}
      </header>
      <div className={'case-layout ' + (mobileChat && tid ? 'show-chat' : '')} ref={observe} data-discussion={!!tid} style={{
        '--discussion-width': discussionWidth.size + 'px',
      } as React.CSSProperties}>
        <div className="case-main" aria-busy={updating}>
          <div className="case-controls" ref={caseControls}>
            {caseActions}
            <section className="paper case-view-settings" aria-labelledby="case-view-settings-heading">
              <h2 id="case-view-settings-heading">Вид разбора</h2>
              <div className="case-view-controls">
                <label className="case-view-switch">
                  <span>Только полные недели</span>
                  <input type="checkbox" role="switch" className="search-switch-track" checked={full}
                    onChange={(e) => updatePreferences({ full: e.target.checked })} />
                </label>
                {needsSalesContext && <label className="case-comparison">
                  <span>Сравнить с</span>
                  <select value={comparison || ''}
                    onChange={(e) => updatePreferences({ control: e.target.value || false })}>
                    <option value="">Без сравнения</option>
                    {home.products.filter((p) => p !== c.product).map((p) => <option key={p}>{p}</option>)}
                  </select>
                </label>}
                <button type="button" className="text-action" onClick={() => confirm('reset')}>Сбросить вид</button>
              </div>
            </section>
          </div>
          {research.investigation && <CaseInvestigation investigation={research.investigation} error={research.error}
            refresh={research.refresh} userId={home.user.id} canExplore={!withdrawn && !completed}
            canPublish={!withdrawn && !completed && !c.body.owner}
            canDraft={!!(redmine.local || redmine.connected)} onDraft={draftId => action(() => onDraft(draftId))}
            measurement={measurementEditor}
            next={!withdrawn && (showEffect || scheduleEffect) ? {
              label: showEffect ? 'Посмотреть результат проверки эффекта' : 'Назначить проверку эффекта', open: openNext,
            } : undefined} />}
          {tid && (
            <button className="mobile-toggle" aria-expanded={mobileChat} onClick={() => moveView(() => chatMode(!mobileChat))}>
              <Icon name="down" /> {mobileChat ? 'К разбору' : 'Обсудить'}
            </button>
          )}
          {err && <p role="alert">{err}</p>}
          {c.body.origin && <p>
            <a href={'#snapshot/' + c.body.origin.calc + '/' + (c.body.origin.cards || initialCards).join(',')}>
              Исходный ответ и расчёт
            </a>
          </p>}
          {researchAvailable && signalDetails && <div className="paper">
            {signalDetails}
          </div>}
          <Cards
            view={v}
            cards={caseCards}
            backlog={d.backlog}
            pinned={pinned}
            onMetricSeries={(card, series) => {
              const next = { ...currentView.current.ratioSelections, [card]: series };
              localStorage.setItem(prefix + '/metric-series', JSON.stringify(next));
              updateViewState({ ...currentView.current, ratioSelections: next });
            }}
            onAttach={(a) => {
              attach(a);
              chatMode(true);
            }}
            onAsk={(x) => {
              ask(x);
              chatMode(true);
              requestDiscussionFocus(true);
            }}
            onPin={(k) => {
              const current = currentView.current.preferences?.pinned || [];
              updatePreferences({ pinned: current.includes(k) ? current.filter(p => p !== k) : [...current, k] });
            }}
          />
          {c.body.plan && (c.body.plan.hypothesis || (specified && !agreement)) && (
            <section className="paper">
              <h3>План до разработки</h3>
              <p>{c.body.plan.hypothesis}</p>
              {specified && <p>{describeMeasurement(specified)}</p>}
              <small>
                {[c.body.plan.metric, c.body.plan.baseline, c.body.plan.control, c.body.plan.success]
                  .filter(Boolean)
                  .join(' · ')}
              </small>
            </section>
          )}
          {!!c.body.notes?.length && (
            <section className="paper"><h3>Сохранённые выводы</h3>
              {c.body.notes.map((note, i) => <article className="excerpt" key={note.created + '/' + i}>
                <small>{note.author} · {new Date(note.created).toLocaleDateString('ru-RU')}</small>
                <p>{note.text}</p>
                {note.rangeId && <a href={'#range/' + note.rangeId}>Открыть период</a>}
              </article>)}
            </section>
          )}
          <PinnedMaterials caseId={id} />
          <PresentationMaterials key={id} caseId={id} actionSlot={presentationAction} versionFromChat={versionFromChat} />
          <Tracking panelRef={taskPanel}
            documentation={documentation}
            caseId={id}
            product={c.product}
            title={c.title}
            conclusion={conclusion || d.published.find((p) => p.body.conclusion)?.body.conclusion || ''}
            home={home}
            drafts={d.drafts}
            action={action}
            reload={load}
          />
          <details className="paper effect-panel" ref={effectSection}>
            <summary>Проверка эффекта</summary>
            {useArchiveForm ? <EffectPlan key={id + '/' + (archiveMonitoring?.plan.revision || 0)}
              caseId={id} saved={archiveMonitoring?.result ?? null} archiveOnly={home.archiveOnly}
              readOnly={completed} reload={async () => { await load(); await refresh(); }} /> : <>
            {localMonitoring ? <WatchSummary {...localMonitoring} /> : needsReconfirmation
              ? <p role="status">Согласуйте критерий в актуальном исследовании перед назначением проверки.</p>
              : <p>{agreed ? 'Укажите дату выкладки.' : 'Укажите дату выкладки и цель.'}</p>}
            {!needsReconfirmation && <form
              key={id + '/' + (c.body.watch?.revision || 0)}
              onSubmit={(e) => {
                e.preventDefault();
                const b = measurementPayload(e.currentTarget);
                action(async () => {
                  await post('watch', { ...b, caseId: id, agreementId: agreement?.id,
                    control: !productSignal && !b.measurement && !specified && !activeMeasurement ? v.summary[1]?.product : undefined });
                  editMeasurement(false);
                  await load();
                  await refresh();
                });
              }}
            >
              <label>
                Дата выкладки
                <input type="date" name="deployed" defaultValue={localMonitoring?.plan.deployed} required />
              </label>
              {productSignal && !agreed && <p>{[metricName(signalMetric!), c.product, signal?.segment, signal?.sourceId].filter(Boolean).join(' · ')}</p>}
              {agreed ? !v.monitoring && <AgreedMeasurement {...agreed} /> : specified || (activeMeasurement && !editingMeasurement) ? (
                <p>{describeMeasurement(specified || activeMeasurement!)}</p>
              ) : <MeasurementFields required={clarifyMetric || productSignal || editingMeasurement} initialMetric={oldMetric}
                product={c.product} signal={productSignal ? signal : undefined} initial={activeMeasurement} legacyWatch={!productSignal} />}
              <div className="actions">
                <button>Назначить проверку</button>
                {activeMeasurement && !specified && <button type="button" onClick={() => editMeasurement(value => !value)}>
                  {editingMeasurement ? 'Отменить изменение' : 'Изменить критерий'}
                </button>}
              </div>
            </form>}
            {canPlanArchive && <details open={advancedEffectOpen} onToggle={e => setAdvancedEffectOpen(e.currentTarget.open)}>
              <summary>Наблюдение по архивным источникам</summary>
              {advancedEffectOpen && <EffectPlan key={id} caseId={id} saved={null} archiveOnly={home.archiveOnly}
                reload={async () => { await load(); await refresh(); }} />}
            </details>}
            </>}
            {!!c.body.watchHistory?.length && <details>
              <summary>Прошлые проверки</summary>
              <ul>{c.body.watchHistory.map(item => <li key={item.revision}>
                <a href={'#snapshot/' + item.calc + '/watch'}>Версия {item.revision}{item.deployed && ' · ' + item.deployed}</a>
              </li>)}</ul>
            </details>}
            <button
              onClick={() => confirm('finish')}
              disabled={completed}
            >
              Завершить разбор
            </button>
          </details>
          <details className="paper">
            <summary>Поправка к источнику</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const b = Object.fromEntries(new FormData(e.currentTarget));
                action(async () => {
                  await post('feedback', {
                    caseId: id,
                    ...b,
                    comment: (b.disposition === 'exclude' ? '[Исключить связь] ' : '') + b.comment,
                  });
                  await load();
                });
              }}
            >
              <label>
                Источник
                <select name="source" required>
                  {v.evidence.map((e) => (
                    <option key={e.source}>{e.source}</option>
                  ))}
                </select>
              </label>
              <label>
                Применение к продукту
                <select name="disposition">
                  <option value="note">Уточнить вывод</option>
                  <option value="exclude">Исключить ошибочную связь</option>
                </select>
              </label>
              <label>
                Что учесть в следующих расследованиях
                <textarea name="comment" required />
              </label>
              <button>Сохранить замечание</button>
            </form>
          </details>
          {!!d.published.length && (
            <section className="paper">
              <h3>Опубликованные версии</h3>
              {d.published.map((p) => (
                <p key={p.id}>
                  <a
                    href={
                      p.body.rangeId
                        ? '#range/' + p.body.rangeId
                        : '#snapshot/' + p.body.calc + '/' + p.body.cards.join(',')
                    }
                  >
                    {p.user} · {p.body.cards.map((k) => labels[k]).join(', ')}
                  </a>
                </p>
              ))}
            </section>
          )}
          <InterviewSearch caseId={id} asOf={v.requested?.through} key={id + '/' + (v.requested?.through || '')} />
          {!!d.signalHistory?.length && <details className="paper signal-history">
            <summary>История сигнала</summary>
            <ol>{d.signalHistory.map((r, index, history) => <li key={r.revision}>
              <strong>{r.event === 'withdrawn' || r.status === 'withdrawn' ? 'Отозван'
                : r.event === 'corrected' ? 'Уточнён'
                : r.status === 'provisional' ? 'Предварительный'
                : !r.event && history[index + 1]?.status === 'confirmed' ? 'Данные обновлены' : 'Подтверждён'}</strong>
              {' · '}{r.created ? new Date(r.created).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : 'До введения журнала'}
              {' · неделя с '}{new Date(r.week + 'T00:00:00Z').toLocaleDateString('ru-RU', { timeZone: 'UTC' })}
              {r.status !== 'withdrawn' && ' · ' + num(r.value) + (r.metric ? '%' : ' п. индекса')}
              {r.imported.map(doc => <small key={doc.version} title={doc.version}>{doc.file} · {doc.version.slice(0,10)}</small>)}
            </li>)}</ol>
          </details>}
        </div>
        {tid && (
          <div id="case-discussion" className="case-discussion" ref={discussion}>
            <PanelResizeHandle panel={discussionWidth} className="discussion-width"
              label="Ширина обсуждения" controls="case-discussion" direction={-1} />
            <Chat
              id={tid}
              userId={home.user.id}
              avatar={avatar}
              caseId={id}
              threads={home.threads}
              action={action}
              context={ctx}
              attachment={attachment}
              screen={{ calc: v.id, full, control: comparison, cards: caseCards }}
              clearContext={() => {
                ask('');
                attach(undefined);
              }}
              onResult={result}
              onAttachFocus={() => chatMode(true)}
            />
          </div>
        )}
      </div>
      {confirmation && (
        <Dialog title={confirmation === 'reset' ? 'Сбросить вид?' : 'Завершить разбор?'} close={() => confirm(undefined)}>
          {(dismiss) => (
            <div className="confirm-action">
              <p>{confirmation === 'reset'
                ? 'Вернутся начальные фильтры и карточки. Закрепления будут сняты.'
                : 'Разбор получит статус «Завершено» и уйдёт из активных проверок.'}</p>
              <footer className="actions">
                <button type="button" onClick={() => dismiss()}>Отмена</button>
                <button type="button" className="primary" onClick={() => dismiss(() => {
                  if (confirmation === 'reset') {
                    localStorage.removeItem(prefix + '/period');
                    localStorage.removeItem(prefix + '/metric-series');
                    updateViewState({ ...currentView.current, period: {}, ratioSelections: {} });
                    updatePreferences({ cards: initialCards, pinned: [], full: false, control: '', sourceQuery: '' });
                    return;
                  }
                  action(async () => {
                    await post('decide', { caseId: id, state: 'Завершено' });
                    await load();
                    await refresh();
                  });
                })}>{confirmation === 'reset' ? 'Сбросить' : 'Завершить'}</button>
              </footer>
            </div>
          )}
        </Dialog>
      )}
      {preview && (
        <Dialog title="Поделиться с командой" close={() => show(false)}>
          {(dismiss) => <div className="share-form">
            <p className="muted">Получатель — «{home.threads.find((t) => t.id === 'group')?.title || 'Команда Store'}».</p>
            <label>
              Вывод для команды
              <textarea
                value={conclusion}
                onChange={(e) => writeConclusion(e.target.value)}
                maxLength={1400}
              />
            </label>
            {shareCards.map((k) => (
              <label key={k}>
                <input
                  type="checkbox"
                  checked={selection.includes(k)}
                  onChange={() =>
                    select(selection.includes(k) ? selection.filter((x) => x !== k) : [...selection, k])
                  }
                />
                {labels[k]}
              </label>
            ))}
            <footer>
              <button type="button" onClick={() => dismiss()}>Отмена</button>
              <button
                className="primary"
                disabled={!selection.length}
                onClick={() =>
                  action(async () => {
                    await post('publish', { caseId: id, calc: v.id, cards: selection, conclusion });
                    dismiss(() => action(async () => {
                      await load();
                      await refresh();
                    }));
                  })
                }
              >
                Опубликовать
              </button>
            </footer>
          </div>}
        </Dialog>
      )}
    </>
  );
}
type SourceVersion = { version: string; created: number; total: number; origin: string | null; author: string | null; active: boolean };

function SourceHistory({ file, current }: { file: string; current: string }) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<SourceVersion[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let active = true;
    setHistory([]);
    setError('');
    post<{versions: SourceVersion[]}>('source-history', { file }).then(
      value => { if (active) setHistory(value.versions); },
      failure => { if (active) setError(failure.message); },
    );
    return () => { active = false; };
  }, [file, current, open]);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>История версий</summary>
    {error && <p role="alert">{error}</p>}
    {!history.length && !error && <p role="status">Загружаем версии…</p>}
    {history.length > 0 && <ul>{history.map(version => <li key={version.version}>
      {version.total > 0
        ? <a href={'#knowledge-source/' + version.version}>{new Date(version.created).toLocaleString('ru-RU')} · {version.version.slice(0, 8)}</a>
        : <time dateTime={new Date(version.created).toISOString()}>{new Date(version.created).toLocaleString('ru-RU')}</time>}
      {' · '}{version.origin || 'Ранее загруженная версия'}
      {version.author && ' · ' + version.author}
      {version.active && ' · Текущая'}
    </li>)}</ul>}
  </details>;
}

function Sources({ home, action, refresh }: { home: Home; action: Action; refresh: () => Promise<void> }) {
  const [notice, say] = useState('');
  const [selected,select]=useState<File>();
  const [origin,setOrigin]=useState('');
  const [target,setTarget]=useState('');
  const versionFile=home.archiveOnly && selected && /\.(xlsx|pptx)$/i.test(selected.name) ? selected : undefined;
  const sourceFile=target || selected?.name || '';
  const current=home.sources.find(s=>s.file===sourceFile);
  const admin = home.user.role === 'admin';
  return (
    <>
      <div className="page-head">
        <h1>Источники</h1>
      </div>
      {admin && (
        <section className="paper">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const file = new FormData(e.currentTarget).get('file') as File;
              action(async () => {
                say('Читаем материалы…');
                const r = await fetch('/api/team/upload', {
                  method: 'POST',
                  headers: { 'X-File-Name': encodeURIComponent(versionFile?sourceFile:file.name) },
                  body: file,
                });
                const v = await r.json();
                if (!r.ok) {
                  say('');
                  throw Error(v.error);
                }
                say(home.archiveOnly && !v.inserted ? 'Файл уже был загружен.' : 'Добавлено версий: ' + v.inserted);
                await refresh();
              });
            }}
          >
            <label>
              Книга, презентация или архив
              <input name="file" type="file" accept=".xlsx,.pptx,.zip" required onChange={e=>{select(e.currentTarget.files?.[0]);setTarget('');setOrigin('');say('');}} />
            </label>
            {versionFile && <>
              <label>Версия книги<select value={sourceFile} onChange={e=>setTarget(e.target.value)}>
                <option value={versionFile.name}>{versionFile.name}</option>
                {home.sources.filter(s=>s.file.endsWith('/'+versionFile.name)).map(s=><option key={s.file}>{s.file}</option>)}
              </select></label>
              <label>Происхождение материала<input value={origin} onChange={e=>setOrigin(e.target.value)} maxLength={400}/></label>
              <button type="button" disabled={!origin.trim()} onClick={()=>action(async()=>{
                const bytes=await crypto.subtle.digest('SHA-256',await versionFile.arrayBuffer());
                const sha=Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('');
                await post('approve-source',{sha,file:sourceFile,origin,previous:current?.version??null});
                say('Версия согласована. Можно загрузить книгу.');
              })}>Согласовать версию</button>
            </>}
            <div className="actions source-actions">
              <button className="primary">Загрузить и пересчитать</button>
              {!home.archiveOnly && <button
                type="button"
                onClick={() =>
                  action(async () => {
                    try {
                      const r = await post<{ inserted: number }>('metrika');
                      say('Метрика ответила. Добавлено версий: ' + r.inserted);
                    } finally {
                      await refresh();
                    }
                  })
                }
              >
                Синхронизировать Метрику
              </button>}
            </div>
          </form>
        </section>
      )}
      {!home.archiveOnly && home.user.space === 'team' && <MetrikaJournal status={home.metrikaSync} />}
      <section className="paper">
        <h3>Загруженные материалы</h3>
        {home.sources.map((s) => (
          <div className="event-row" key={s.file}>
            <b>{s.total !== 0 && /\.(xlsx|pptx)$/i.test(s.file) ? <a href={'#knowledge-source/'+s.version}>{s.file}</a> : s.file}</b>
            <small>
              {s.role === 'reference' ? 'Справочный файл · содержимое не индексируется · ' : s.total !== undefined && `Распознано записей: ${s.total} · `}
              Версий: {s.versions} · {new Date(s.updated).toLocaleDateString('ru-RU')}
            </small>
            {(s.role === 'reference' || ((home.archiveOnly || s.versions > 1) && /\.(xlsx|pptx)$/i.test(s.file))) &&
              <SourceHistory file={s.file} current={s.version} />}
          </div>
        ))}
        {!home.sources.length && <p>Источники пока не загружены.</p>}
      </section>
      {notice && <p className="notice" role="status">{notice}</p>}
    </>
  );
}

const deliveryState: Record<string, string> = {
  queued:'В очереди', sending:'Отправляется', delivered:'Доставлено', distributed:'Разложено по получателям',
  uncertain:'Доставка не подтверждена', review:'Требуется сверка', cancelled:'Отменено',
};
const deliveryChannel: Record<string, string> = { telegram:'Telegram',smtp:'Электронная почта' };
const settingsLinks = [
  { scope: 'personal', href: '#settings/personal', label: 'Мои настройки', icon: 'settings' },
  { scope: 'team', href: '#settings', label: 'Настройки команды', icon: 'people' },
] as const;

function Settings({ home, action, refresh, menu, changeMenu, scope }: {
  home: Home;
  action: Action;
  refresh: () => Promise<void>;
  menu: MenuLayout;
  changeMenu: (layout: MenuLayout) => void;
  scope: 'team' | 'personal';
}) {
  const [notice, say] = useState('');
  const admin = home.user.role === 'admin';
  return (
    <>
      <a className="crumb" href="#profile" aria-label="Вернуться в профиль">← Профиль</a>
      <div className="page-head">
        <h1>{scope === 'personal' ? 'Мои настройки' : 'Настройки команды'}</h1>
      </div>
      <InvestigationSettings scope={scope} admin={admin} />
      <Connections home={home} action={action} refresh={refresh} scope={scope} />
      {scope === 'team' && admin && home.archiveOnly && (
        <section className="paper">
          <h3>Яндекс Метрика</h3>
          <p>Проверка Reports API на тестовом счётчике. Источник чисел разбора — архив организатора.</p>
          <button type="button" onClick={() => action(async () => {
            try { await post('metrika-probe'); }
            finally { await refresh(); }
          })}>Проверить Reports API</button>
          {home.metrikaProbe && <p role="status">
            {home.metrikaProbe.status === 'ready' ? 'Reports API ответил' : 'Ошибка Reports API · ' + home.metrikaProbe.reason}
            {' · '}<time dateTime={new Date(home.metrikaProbe.at).toISOString()}>{new Date(home.metrikaProbe.at).toLocaleString('ru-RU')}</time>
          </p>}
        </section>
      )}
      {scope === 'personal' && home.user.role !== 'judge' && <NotificationSettings />}
      {scope === 'team' && <MetricRules admin={admin} refresh={refresh}/>}
      {scope === 'team' && admin && (
        <section className="paper">
          <h3>Правило уведомления</h3>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const threshold = new FormData(e.currentTarget).get('threshold');
              action(async () => {
                await post('rules', { threshold });
                await refresh();
                say('Правило сохранено');
              });
            }}
          >
            <label>
              Снижение четырёхнедельного индекса к предыдущим 12 неделям, %
              <input type="number" min="1" max="100" name="threshold" defaultValue={home.rules.threshold} />
            </label>
            <button>Сохранить</button>
          </form>
        </section>
      )}
      {scope === 'team' && admin && (
        <section className="paper">
          <h3>Доставка уведомлений</h3>
          <p>Фоновые уведомления {home.notificationsEnabled ? 'включены' : 'выключены'}.</p>
          {Object.entries(deliveryChannel).filter(([channel]) => !home.notificationChannels.includes(channel)).map(([channel,label]) =>
            <p key={channel}>{label} · канал выключен</p>)}
          {home.deliveries.length ? <dl>{home.deliveries.map(({channel,state,n}) => (
            <div className="event-row" key={channel+'/'+state}>
              <dt>{deliveryChannel[channel] || channel} · {deliveryState[state] || state}</dt>
              <dd>{n.toLocaleString('ru-RU')}</dd>
            </div>
          ))}</dl> : <p>Записей о доставке пока нет.</p>}
        </section>
      )}
      {scope === 'team' && admin && (
        <section className="paper">
          <h3>Участники команды</h3>
            <button
              onClick={() =>
                action(async () => {
                  const r = await post<{ code: string }>('invite');
                  say(location.origin + '/#join/' + r.code);
                })
              }
            >
              Пригласить участника
            </button>
        </section>
      )}
      {scope === 'personal' && <>
        <section className="paper" aria-labelledby="appearance-title">
          <h3 id="appearance-title">Оформление</h3>
          <ThemeSwitch />
        </section>
        <section className="paper menu-preference" aria-labelledby="menu-preference-title">
          <h3 id="menu-preference-title">Положение меню</h3>
          <div className="actions menu-preference-options">
            <button type="button" aria-pressed={menu !== 'top'} onClick={() => changeMenu('left')}>
              <Icon name="panelLeft" />Слева
            </button>
            <button type="button" aria-pressed={menu === 'top'} onClick={() => changeMenu('top')}>
              <Icon name="panelTop" />Сверху
            </button>
          </div>
        </section>
        <section className="paper">
          <h3>Личный доступ</h3>
          <div className="actions">
          <button
            onClick={() =>
              action(async () => {
                const r = await post<{ key: string }>('mcp-key');
                say('Персональный ключ MCP: ' + r.key);
              })
            }
          >
            Выпустить ключ MCP
          </button>
          </div>
        </section>
      </>}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
    </>
  );
}
function Snapshot({
  id,
  selected,
  embedded = false,
  previewTitle,
}: {
  id: string;
  selected?: string;
  embedded?: boolean;
  previewTitle?: string;
}) {
  const [v, set] = useState<View | InvestigationCalculation | null>(null),
    [err, fail] = useState(''),
    [open, setOpen] = useState(false);
  useEffect(() => {
    let active = true;
    set(null);
    fail('');
    post<View | InvestigationCalculation>('calc', { id })
      .then((result) => {
        if (active) set(result);
      })
      .catch((e) => {
        if (active) fail(e.message);
      });
    return () => {
      active = false;
    };
  }, [id]);
  if (v && 'findings' in v) return <InvestigationSnapshot calculation={v} selected={selected} embedded={embedded} />;
  const custom = v as unknown as {
    kind?: string;
    metric: string;
    step?: number;
    title: string;
    unit: string;
    segment: string;
    points: { date: string; value: number | null }[];
  };
  if (custom?.kind === 'evidence-search' && v)
    return (
      <section className="paper">
        <h2>{custom.title}</h2>
        {v.evidence.map((e) => (
          <div key={e.kind + e.key} className="excerpt">
            <small>{e.source}</small>
            <p>{typeof e.data === 'string' ? e.data : e.data.title || e.data.description}</p>
          </div>
        ))}
      </section>
    );
  if (custom?.kind === 'metric-chart') {
    const pts = custom.points.map((p) => ({ at: Date.parse(p.date + 'T00:00:00Z'), value: p.value }));
    const step =
      custom.step || (pts.length > 1 ? Math.min(...pts.slice(1).map((p, i) => p.at - pts[i].at)) : DAY);
    const unit = custom.unit === 'ratio' ? '%' : custom.unit;
    const lines = [
      {
        key: custom.segment,
        name: custom.segment,
        color: 'var(--series-main)',
        points: pts.map((p) => ({
          ...p,
          value: p.value != null && custom.unit === 'ratio' ? 100 * p.value : p.value,
        })),
      },
    ];
    const detail = (
      <section className="paper">
        <h2>{custom.title}</h2>
        <RangeChart
          title={custom.title}
          unit={unit}
          step={step}
          pick={(series, ranges) => ({
            label: custom.title,
            selection: { source: 'metric', calcId: id, version: id, metric: custom.metric, series, ranges },
          })}
          lines={lines}
        />
      </section>
    );
    if (!previewTitle) return detail;
    return (
      <div className="material-card chart">
        <a
          className="material-preview"
          href={'#snapshot/' + id}
          aria-haspopup="dialog"
          onClick={(e) => {
            if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
              e.preventDefault();
              setOpen(true);
            }
          }}
        >
          <strong>{previewTitle}</strong>
          <MiniPlot plot={{ unit, step, lines }} />
          <span>Раскрыть график ↗</span>
        </a>
        {open && (
          <Dialog title={previewTitle} close={() => setOpen(false)} wide>
            {detail}
            <a href={'#snapshot/' + id} target="_blank" rel="noreferrer">
              Открыть по ссылке ↗
            </a>
          </Dialog>
        )}
      </div>
    );
  }
  return (
    <>
      {!embedded && <a href="#cases">← Разборы</a>}
      {!embedded && <h1>Сохранённый расчёт</h1>}
      {v ? (
        <Cards
          view={{ ...v, id }}
          cards={(selected?.split(',') || initialCards).filter((k) => k in labels)}
          backlog={(v as View & { backlog?: Detail['backlog'] }).backlog || []}
        />
      ) : (
        <p>{err || 'Загрузка…'}</p>
      )}
    </>
  );
}
function Workspace({ user, onLogout, onUpdate }: { user: User; onLogout: () => void; onUpdate: (user: User) => void }) {
  const [requestedRoute, id, selected] = useRoute(),
    [home, setHome] = useState<Home | null>(null),
    [err, fail] = useState(''),
    [filter, setFilter] = useState(''),
    [caseType, setCaseType] = useState<CaseType>('all'),
    [newCaseRelease, showCaseForm] = useState<string | null>(null),
    [menu, setMenu] = useState(readMenuLayout);
  const sidebar = useSidebarWidth();
  const bridgePages = Boolean(home?.bridgeEnabled);
  const route = home && !bridgePages && ['knowledge', 'demo-page'].includes(requestedRoute) ? 'cases' : requestedRoute;
  const documentation = bridgePages && selected?.split('?')[0] === 'documentation'
    ? selected.slice('documentation'.length) : undefined;
  const settings = route === 'settings' || (route === 'cases' && id === 'settings');
  const settingsScope = route === 'settings' && id === 'personal' ? 'personal' : 'team';
  const homeVersion = useRef(0);
  const refresh = useCallback(async (onLoad?: (data: Home) => void) => {
    const version = ++homeVersion.current;
    const next = await post<Home>('overview');
    if (homeVersion.current !== version) return;
    setHome(next);
    onLoad?.(next);
  }, []);
  function updateThreads(update: (threads: Thread[]) => Thread[]) {
    homeVersion.current++;
    setHome((current) => current && ({
      ...current,
      threads: update(current.threads),
    }));
  }
  useEffect(() => {
    let active = true;
    refresh((next) => {
      if (!active || route !== 'release-detail') return;
      const release = next.releases.find((entry) => entry.release_id === id);
      location.replace(release?.decisionAvailable ? releaseAssessmentHref(id) : '#releases-list');
    }).catch((e) => {
      if (active) fail(e.message);
    });
    return () => { active = false; };
  }, [refresh, route, id]);
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [route, id]);
  const action: Action = (fn) => {
    fail('');
    void fn().catch((e) => fail(e.message));
  };
  function changeMenu(next: MenuLayout) {
    moveMenu(next, () => {
      setMenu(next);
      try { localStorage.setItem(menuLayoutKey, next); } catch {}
    });
  }
  const tabs = [
    ['overview', 'Обзор'],
    ['chats', 'Чаты'],
    ['releases-list', 'Релизы'],
    ['cases', 'Разборы'],
    ...(bridgePages ? [['knowledge', 'База знаний']] : []),
    ['sources', 'Источники'],
  ];
  const content = (
    <div className="team-app" data-menu={menu} style={{
      '--sidebar-width': `${sidebar.width}px`,
      '--sidebar-min-width': `${minSidebarWidth}px`,
    } as React.CSSProperties}>
      <aside className="side" id="workspace-sidebar" data-compact-logo={sidebar.width < 118}>
        <a className="brand" href="#overview" aria-label="Софтлайн Решения — обзор">
          <BrandLogo />
          <span className="brand-emblem"><BrandLogo compact /></span>
        </a>
        <nav aria-label="Основные разделы">
          {tabs.map(([k, t]) => {
            const active = !settings && (route === k || (k === 'knowledge' && route === 'demo-page') ||
              (k === 'releases-list' && ['release-detail', 'release', 'releases', 'calc', 'release-decision'].includes(route)) ||
              (k === 'cases' && ['case', 'snapshot', 'range', 'material', 'demo-issue'].includes(route)));
            return (
            <a
              className={active ? 'active' : ''}
              aria-current={active ? 'page' : undefined}
              aria-label={t}
              title={t}
              key={k}
              href={'#' + k}
            >
              <Icon name={k === 'chats' ? 'chat' : k === 'knowledge' ? 'sources' : k === 'releases-list' ? 'calendar' : k} />
              <span className="menu-label">{t}</span>
            </a>
            );
          })}
        </nav>
        <div className="side-bottom">
          {settingsLinks.map(({ scope, href, label, icon }) => (
            <a key={scope} className="side-setting" href={href} aria-label={label} title={label}
              aria-current={settings && scope === settingsScope ? 'page' : undefined}>
              <Icon name={icon} /><span className="menu-label">{label}</span>
            </a>
          ))}
          <ProfileEntry user={user} active={route === 'profile'} />
        </div>
      </aside>
      {menu === 'left' && <SidebarResizeHandle {...sidebar} />}
      <main className="content">
        {err && (
          <p role="alert" className="error">
            {err} <button aria-label="Закрыть сообщение" onClick={() => fail('')}>×</button>
          </p>
        )}
        <div className="workspace-page" data-route={route} key={route === 'chats' ? route : [route, id, selected].join('/')}>
        {route === 'profile' ? (
          <ProfilePage user={user} onUpdate={onUpdate} onLogout={() => action(async () => {
            await post('logout');
            onLogout();
          })} />
        ) : !home || route === 'release-detail' ? (
          <p className="empty" role="status">Загрузка…</p>
        ) : route === 'demo-page' || route === 'demo-issue' ? (
          <DemoObject key={route+id} service={route} id={id}/>
        ) : route === 'material' ? (
          <section className="paper">
            <MaterialDetail id={id} />
          </section>
        ) : ['releases', 'release', 'calc'].includes(route) ? (
          <ReleaseAnalytics route={route} requestedId={id} user={user} />
        ) : route === 'release-decision' ? (
          <ReleaseDecision key={id} action={action} initialRelease={id || undefined} renderChat={(thread, caseId, releaseId, product, decisionContext) => (
            <Chat key={thread} id={thread} caseId={caseId} decisionReleaseId={releaseId} decisionContext={decisionContext} product={product}
              userId={user.id} avatar={user.avatar} threads={home.threads} action={action} />
          )} />
        ) : route === 'case' ? (
          <Investigation key={home.user.id + '/' + id} id={id} selected={selected} documentation={documentation}
            home={home} avatar={user.avatar} action={action} refresh={refresh} />
        ) : route === 'range' ? (
          <RangeResult id={id} />
        ) : route === 'snapshot' ? (
          <Snapshot id={id} selected={selected} />
        ) : settings ? (
          <Settings home={home} action={action} refresh={refresh} menu={menu} changeMenu={changeMenu}
            scope={settingsScope} />
        ) : route === 'knowledge-source' ? (
          <SourceExtract key={id+selected} version={id} loc={selected && decodeURIComponent(selected)} />
        ) : route === 'knowledge' ? (
          <Knowledge admin={user.role === 'admin'} />
        ) : route === 'sources' ? (
          <Sources home={home} action={action} refresh={refresh} />
        ) : route === 'chats' ? (
          <ChatWorkspace
            home={home}
            id={id}
            avatar={user.avatar}
            action={action}
            refresh={refresh}
            onRename={(renamed) => updateThreads((threads) => threads.map((thread) =>
              thread.id === renamed.id ? { ...thread, title: renamed.title } : thread
            ))}
            onDelete={(deleted) => updateThreads((threads) => threads.filter((thread) => thread.id !== deleted))}
          />
        ) : route === 'releases-list' ? (
          <>
            <div className="page-head releases-head">
              <h1>Журнал релизов</h1>
              <a className="primary" href="#releases">Аналитика по событиям CSV</a>
            </div>
            <section className="paper release-calendar">
              <h2>Календарь из источников</h2>
              {!home.releases.length && <p>В загруженных источниках пока нет релизов.</p>}
              {home.releases.map((release) => {
                const summary = <>
                  <small>{release.release_id} · {release.release_date}</small>
                  <span>{release.description}</span>
                </>;
                return (
                  <div className="release-row" key={release.release_id}>
                    {release.decisionAvailable ? (
                      <a className="release-summary" href={releaseAssessmentHref(release.release_id)}>{summary}</a>
                    ) : (
                      <div className="release-summary">{summary}</div>
                    )}
                    <button
                      type="button"
                      aria-label={'Запланировать разбор ' + release.release_id}
                      onClick={() => {
                        showCaseForm(release.release_id);
                        jump('cases');
                      }}
                    >
                      Запланировать разбор
                    </button>
                  </div>
                );
              })}
            </section>
          </>
        ) : route === 'cases' ? (
          <>
            <div className="page-head">
              <h1>Разборы</h1>
              <button className="primary" aria-expanded={newCaseRelease !== null}
                onClick={() => moveView(() => showCaseForm(current => current === null ? '' : null))}>
                Новый разбор
              </button>
            </div>
            {newCaseRelease !== null && (
              <form
                key={newCaseRelease}
                className="paper"
                onSubmit={(e) => {
                  e.preventDefault();
                  const b = measurementPayload(e.currentTarget);
                  action(async () => {
                    if (!b.from) delete b.from;
                    if (!b.through) delete b.through;
                    const r = await post<{ id: string }>('create-case', b);
                    showCaseForm(null);
                    await refresh();
                    jump('case/' + r.id);
                  });
                }}
              >
                <label>
                  Вопрос или гипотеза
                  <input name="title" required />
                </label>
                <label>
                  Продукт
                  {home.archiveOnly ? <select name="product" required defaultValue="">
                    <option value="" disabled>{home.products.length ? 'Выберите семейство' : 'Нет семейств в загруженном архиве'}</option>
                    {home.products.map(product => <option key={product}>{product}</option>)}
                  </select> : <>
                    <input name="product" required list="products" />
                    <datalist id="products">
                      {home.products.map(product => <option key={product}>{product}</option>)}
                    </datalist>
                  </>}
                </label>
                <label>
                  Связанный релиз
                  <select name="release" defaultValue={newCaseRelease}>
                    <option value="">Без релиза</option>
                    {home.releases.map((r) => (
                      <option key={r.release_id}>{r.release_id}</option>
                    ))}
                  </select>
                </label>
                <details>
                  <summary>Гипотеза и критерии до разработки</summary>
                  <label>Начало исследования<input type="date" name="from" /></label>
                  <label>Срез исследования по дату<input type="date" name="through" /></label>
                  <label>
                    Гипотеза
                    <textarea name="hypothesis" />
                  </label>
                  <MeasurementFields />
                </details>
                <button>Создать личный разбор</button>
              </form>
            )}
            <div className="toolbar case-filters">
              <label>
                Тип{' '}
                <select value={caseType} onChange={(e) => setCaseType(e.target.value as CaseType)}>
                  {Object.entries(caseTypeLabels).map(([value, label]) => (
                    <option value={value} key={value}>{label}</option>
                  ))}
                </select>
              </label>
              <label>
                Состояние{' '}
                <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                  {['', 'Исследуем', 'Нужно решение', 'Наблюдаем эффект', 'Завершено'].map((x) => (
                    <option value={x} key={x}>
                      {x || 'Все состояния'}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <CaseList
              items={home.cases.filter((c) => (!filter || c.state === filter) && matchesCaseType(c, caseType))}
              showTypes
              emptyMessage={filter || caseType !== 'all' ? 'По выбранным фильтрам разборов нет.' : undefined}
            />
          </>
        ) : (
          <Overview
            home={home}
            onAsk={() =>
              action(async () => {
                const t = await post<{ id: string }>('thread', { title: 'Личный вопрос' });
                await refresh();
                jump('chats/' + t.id);
              })
            }
          />
        )}
        </div>
      </main>
    </div>
  );
  return (
    <MaterialsProvider caseId={route === 'case' ? id : undefined}>
      <BridgePages.Provider value={bridgePages}>{content}</BridgePages.Provider>
    </MaterialsProvider>
  );
}
function Root() {
  const [user, set] = useState<User | null | undefined>(undefined),
    [error, fail] = useState('');
  const [route, code] = useRoute();
  const joinCode = route === 'join' ? code ?? '' : undefined;
  useEffect(() => {
    fetch('/api/team/session')
      .then((r) => r.json())
      .then((v) => set(v.user))
      .catch((e) => fail(e.message));
  }, []);
  return user === undefined ? (
    <p>{error || 'Открываем приложение…'}</p>
  ) : user ? (
    <Workspace
      user={user}
      onUpdate={(updated) => set(current => current?.id === updated.id ? updated : current)}
      onLogout={() => {
        set(null);
        jump('overview');
      }}
    />
  ) : (
    <Login key={joinCode === undefined ? 'login' : 'join/' + joinCode} onLogin={set} joinCode={joinCode} />
  );
}
styleFormValidation();
createRoot(document.getElementById('root')!).render(<ThemeProvider><Root /></ThemeProvider>);
