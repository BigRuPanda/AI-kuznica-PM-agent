import { ReleaseAnalytics } from './app';
import { ChatTrackerPreview, Connections, DemoObject, Tracking } from './tracking';
import { BridgePages, useTrackingVisibility } from './tracking-visibility';
import { RangeResult } from './range-result';
import { Knowledge, NotificationSettings } from './notifications';
import { SourceExtract } from './knowledge-source';
import { EffectPlan } from './effect-plan';
import { ReleaseDecision } from './release-decision';
import { ChatPresentation, PresentationMaterials } from './presentations';
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
import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { post, jump, num } from './team-data';
import type { Home, User, Case, Detail, View, Msg, Thread } from './team-data';
import { Cards, initialCards, labels } from './work-cards';
import { Icon } from './icons';
import { Dialog } from './dialog';
import { ChatMenu } from './chat-menu';
import type { ChatAction } from './chat-menu';
import { ThemeSwitch } from './theme-switch';
import { caseHeading, changeLabel, signalBaseline, signalPeriod } from './case-periods';
import { Answer } from './answer';
import { moveMenu, moveView } from './motion';
import { styleFormValidation } from './form-validation';
import { menuLayoutKey, readMenuLayout } from './menu-layout';
import type { MenuLayout } from './menu-layout';
import { minSidebarWidth, SidebarResizeHandle, useSidebarWidth } from './sidebar-width';
import { BrandLogo } from './brand-logo';
import './team.css';
import './tracking.css';
import './chat.css';

type Action = (fn: () => Promise<void>) => void;
type ThreadTitle = Pick<Thread, 'id' | 'title'>;
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
  return route.split('/');
}
function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [route, code] = useRoute(),
    [register, mode] = useState(route === 'join'),
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
              if (route === 'join') jump('overview');
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
              <input name="code" defaultValue={code || ''} required />
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
function CaseList({ items }: { items: Case[] }) {
  return (
    <div className="case-list">
      {items.length ? (
        items.map((c) => (
          <a key={c.id} href={'#case/' + c.id}>
            <div>
              <span className="state">{c.state}</span>
              <h3>{c.title}</h3>
              <small>{c.body.signal?.week || c.product}</small>
            </div>
            <div className="case-value" data-negative={(c.body.signal?.change ?? 0) < 0}>
              {c.body.signal?.rule === 'relative'
                ? changeLabel(c.body.signal.change)
                : c.body.signal
                  ? num(c.body.signal.value) + ' п.'
                  : <Icon name="arrow" />}
            </div>
          </a>
        ))
      ) : (
        <p className="empty">Разборы появятся после загрузки данных или нового поручения.</p>
      )}
    </div>
  );
}
const stepNames: Record<string, string> = {
  overview: 'Открыт обзор',
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
  'knowledge-sources': 'Найдены книги Excel',
  'knowledge-source': 'Прочитаны строки документа',
  release_decision: 'Проверены данные по релизу',
  source_value: 'Проверено значение в исходной книге',
  web_search: 'Выполнен поиск в Яндексе',
  competitor_check: 'Проверено публичное предложение продавца',
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
    .filter((c) => (c.state === 'Исследуем' && c.body.signal) || c.state === 'Нужно решение')
    .sort((a, b) => (b.body.signal?.week || '').localeCompare(a.body.signal?.week || ''));
  const featured = attention.find((c) => c.body.signal);
  const signal = featured?.body.signal;
  const relative = signal?.rule === 'relative';

  return (
    <>
      <div className="page-head overview-head">
        <div>
          <h1>Обзор</h1>
          {home.user.role === 'judge' && <span className="state">Демо</span>}
        </div>
        <div className="actions">
          {home.archiveOnly && home.products.length > 0 &&
            <a className="primary arrow-action" href="#release-decision">Решение по релизу <Icon name="arrow" /></a>}
          <button onClick={onAsk}>Спросить помощника</button>
        </div>
      </div>
      <section aria-labelledby="attention-title">
        <h2 id="attention-title">Требует внимания</h2>
        {featured && signal && (
          <article className="signal-panel">
            <div className="signal-main">
              <span className="state">{featured.state}</span>
              <h3>{caseHeading(featured)}</h3>
              <p className="signal-product">{featured.product}</p>
              <strong className="signal-metric">
                {relative ? changeLabel(signal.change) : num(signal.value) + ' п.'}
              </strong>
            </div>
            <div className="signal-comparison">
              <dl className="signal-periods">
                <div>
                  <dt>{relative ? '4 полные недели' : 'Неделя сигнала'}</dt>
                  <dd>{signalPeriod(signal)}</dd>
                </div>
                {relative && (
                  <div>
                    <dt>Предыдущие 12 недель</dt>
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
  caseId,
  decisionReleaseId,
  threads,
  action,
  onResult,
  context,
  clearContext,
  attachment,
  screen,
  onAttachFocus,
  headerActions,
}: {
  id: string;
  userId: string;
  caseId?: string;
  decisionReleaseId?: string;
  threads: Thread[];
  action: Action;
  onResult?: (b: Msg['body']) => void;
  context?: string;
  clearContext?: () => void;
  attachment?: Attachment;
  screen?: { calc: string; full: boolean; control?: string; cards: string[] };
  onAttachFocus?: () => void;
  headerActions?: React.ReactNode;
}) {
  const { visibleTrackerStep } = useTrackingVisibility();
  const { open: openMaterial, load: loadMaterial, listen } = useMaterials();
  const [progress, setProgress] = useState<string[]>([]);
  const [jobIssue, setJobIssue] = useState('');
  const [material, setMaterial] = useState<MaterialRef | null>(null);
  const [sharing, setSharing] = useState(false);
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
    [q, setQ] = useState(() => {
      try { return sessionStorage.getItem(draftKey) || readPending()?.text || ''; }
      catch { return ''; }
    }),
    [err, setErr] = useState(''),
    [loaded, setLoaded] = useState(false),
    [away, setAway] = useState(false),
    [copied, setCopied] = useState<number>();
  const activeThread = threads.find((t) => t.id === id);
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
  const [webSearch, setWebSearch] = useState(false);
  useEffect(() => setWebSearch(false), [id]);
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
      if (q) sessionStorage.setItem(draftKey, q);
      else sessionStorage.removeItem(draftKey);
    } catch {}
  }, [q, draftKey]);
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
    setQ(question);
    box.current?.focus();
  }
  return (
    <section className={!caseId ? 'chat-box standalone-chat' : 'chat-box'} aria-label="Переписка">
      <header className="conversation-heading">
        <span className="chat-avatar" aria-hidden="true"><Icon name={isGroup ? 'people' : 'agent'} /></span>
        <div className="conversation-title">
          <h3>{caseId ? 'Обсудить разбор' : activeThread?.title || 'Чат'}</h3>
          <small>{isGroup ? 'Командный чат' : 'Личный чат'}</small>
        </div>
        {headerActions}
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
                {m.role === 'assistant' ? <Icon name="agent" /> : m.author.trim().slice(0, 1).toUpperCase()}
              </span>
              <b>{m.author}</b>
            </div>
            {m.body.resuming ? <p role="status">Повторно обрабатываю вопрос…</p> : m.role === 'assistant' ? (
              <Answer text={m.body.text} openMaterial={openMaterial} />
            ) : (
              <p>{m.body.text}</p>
            )}
            {m.body.readSources?.map((source) => (
              <div key={source.url}><a href={source.url} {...(/^https?:\/\//i.test(source.url) && { target: '_blank', rel: 'noreferrer' })}>{source.label}</a>{source.detail && <small> · {source.detail}</small>}</div>
            ))}
            {m.body.materials?.map((item) => (
              <MaterialCard key={item.id} item={item} />
            ))}
            {m.body.presentationId && m.body.presentationStatus==='ready' &&
              <ChatPresentation id={m.body.presentationId} />}
            {m.body.mode==='presentation' && m.body.outcome==='clarification' && <a href="#cases">Открыть разборы</a>}
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
            {!m.body.resuming && m.body.warning && !m.body.text.includes(m.body.warning) && <small>{m.body.warning}</small>}
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
                {m.body.missingPresentation ? 'Собрать презентацию' : m.body.steps?.length || m.body.materials?.length || m.body.checks?.length || m.body.actions?.length || m.body.rangeId ? 'Продолжить с сохранённого шага' : 'Повторить запрос'}
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
              question: (context && !webSearch ? 'О графике «' + context + '». ' : '') + q,
              typedQuestion: q.trim(),
              webSearch: !groupMessage && webSearch,
              decisionReleaseId,
              caseId,
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
            follow.current = true;
            setAway(false);
            clearAttachment();
            setMaterial(null);
            sessionStorage.removeItem('pm-material-draft/' + storageId);
            setQ('');
            setWebSearch(false);
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
                  setQ(
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
          <textarea
            ref={box}
            id={'q' + id}
            placeholder={webSearch ? 'Что найти в интернете?' : 'Спросить помощника…'}
            value={q}
            rows={1}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.nativeEvent.isComposing) return;
              e.preventDefault();
              if (q.trim() && !sending) e.currentTarget.form?.requestSubmit(send.current ?? undefined);
            }}
            required
          />
          <button ref={send} type="submit" className="primary chat-send" aria-label={isGroup ? 'Спросить помощника' : 'Отправить'} title="Отправить (Enter)" disabled={sending || !q.trim()}>
            <Icon name="arrowUp" />
          </button>
        </div>
        <label className="chat-web-search"><input type="checkbox" checked={webSearch}
          onChange={e => setWebSearch(e.target.checked)} /> Поиск в интернете</label>
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
  close: () => void;
  onRename: (renamed: ThreadTitle) => void;
}) {
  const [saving, save] = useState(false);
  const [error, fail] = useState('');
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  return (
    <Dialog title="Переименовать чат" close={close}>
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

function ChatWorkspace({ home, id, action, refresh, onRename, onDelete }: {
  home: Home;
  id: string;
  action: Action;
  refresh: () => Promise<void>;
  onRename: (renamed: ThreadTitle) => void;
  onDelete: (id: string) => void;
}) {
  const [query, search] = useState('');
  const [listOpen, toggleList] = useState(false);
  const [creating, create] = useState(false);
  const [saving, save] = useState(false);
  const [editing, edit] = useState<{ thread: Thread; action: ChatAction } | null>(null);
  const activeId = id || 'group';
  const activeThread = home.threads.find((thread) => thread.id === activeId);
  const term = query.trim().toLocaleLowerCase('ru');
  const threads = home.threads.filter((thread) => thread.title.toLocaleLowerCase('ru').includes(term));
  const openAction = (thread: Thread, action: ChatAction) => edit({ thread, action });

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
      <div className="chat-layout">
        <aside className="threads-panel" aria-label="Чаты" data-open={listOpen}>
          <button
            type="button"
            className="threads-toggle"
            aria-expanded={listOpen}
            aria-controls="thread-panel-content"
            onClick={() => toggleList(!listOpen)}
          >
            <Icon name="chat" /> Список чатов <Icon name="down" />
          </button>
          <div id="thread-panel-content" className="thread-panel-content">
            <label className="thread-search">
              <Icon name="search" />
              <span className="sr">Поиск чатов</span>
              <input type="search" placeholder="Найти чат" value={query} onChange={(e) => search(e.target.value)} />
            </label>
            <nav className="thread-list" aria-label="Переписки">
              {threads.map((t) => (
                <div className="thread-row" key={t.id}>
                  <a
                    aria-current={activeId === t.id ? 'page' : undefined}
                    href={'#chats/' + t.id}
                    onClick={() => toggleList(false)}
                  >
                    <span className="thread-icon"><Icon name={t.scope === 'group' ? 'people' : 'chat'} /></span>
                    <span className="thread-title">{t.title}</span>
                  </a>
                  <ChatMenu thread={t} onAction={openAction} />
                </div>
              ))}
              {!threads.length && <p className="muted">{query ? 'Чаты не найдены' : 'Пока нет чатов'}</p>}
            </nav>
          </div>
        </aside>
        <Chat
          key={activeId}
          userId={home.user.id}
          id={activeId}
          threads={home.threads}
          action={action}
          headerActions={activeThread && <ChatMenu thread={activeThread} onAction={openAction} />}
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
        <RenameChatDialog thread={editing.thread} close={() => edit(null)} onRename={(renamed) => {
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
  section,
  home,
  action,
  refresh,
}: {
  id: string;
  section?: string;
  home: Home;
  action: Action;
  refresh: () => Promise<void>;
}) {
  const [d, set] = useState<Detail | null>(null),
    [full, filter] = useState(false),
    [peer, control] = useState(''),
    [sourceQuery, findSources] = useState(''),
    [cards, layout] = useState(initialCards),
    [pinned, pin] = useState<string[]>([]),
    [ctx, ask] = useState(''),
    [attachment, attach] = useState<Attachment>(),
    [tid, thread] = useState(''),
    [preview, show] = useState(false),
    [conclusion, writeConclusion] = useState(''),
    [selection, select] = useState<string[]>([]),
    [err, fail] = useState(''),
    [confirmation, confirm] = useState<'reset' | 'finish'>(),
    [updating, setUpdating] = useState(false);
  const [presentationAction,setPresentationAction] = useState<HTMLSpanElement|null>(null);
  const [versionFromChat,setVersionFromChat] = useState<string>();
  const prefix = 'pm-view/' + home.user.id + '/' + id;
  const load = useCallback(
    async () =>
      set(await post<Detail>('view', { caseId: id, full, control: peer || undefined, sourceQuery })),
    [id, full, peer, sourceQuery],
  );
  useEffect(() => {
    setUpdating(true);
    fail('');
    let valid = true;
    post<Detail>('view', { caseId: id, full, control: peer || undefined, sourceQuery })
      .then((v) => {
        if (valid) {
          set(v);
          if (v.personal?.revision && localStorage.getItem(prefix + '/revision') !== v.personal.revision) {
            localStorage.setItem(prefix + '/revision', v.personal.revision);
            localStorage.setItem(
              prefix,
              JSON.stringify({
                ...v.personal,
                pinned: v.personal.pin ? v.personal.cards : [],
                sourceQuery: '',
              }),
            );
            layout(v.personal.cards);
            if (v.personal.full !== undefined) filter(v.personal.full);
            if (v.personal.control) control(v.personal.control);
            if (v.personal.pin) pin(v.personal.cards);
          }
          if (v.case.body.origin && !localStorage.getItem(prefix)) {
            const snapshot = v.case.body.origin;
            localStorage.setItem(prefix, JSON.stringify(snapshot));
            filter(!!snapshot.full);
            layout(snapshot.cards || initialCards);
          }
        }
      })
      .catch((e) => { if (valid) fail(e.message); })
      .finally(() => { if (valid) setUpdating(false); });
    return () => {
      valid = false;
    };
  }, [id, full, peer, sourceQuery]);
  useEffect(() => {
    post<{ id: string }>('case-thread', { caseId: id })
      .then((r) => thread(r.id))
      .catch((e) => fail(e.message));
    try {
      const v = JSON.parse(localStorage.getItem(prefix) || '{}');
      filter(!!v.full);
      findSources(v.sourceQuery || '');
      if (v.control) control(v.control);
      layout(v.cards || initialCards);
      pin(v.pinned || []);
    } catch {}
  }, [id, prefix]);
  const result = useCallback(
    (m: Msg['body']) => {
      if (m.presentationId) setVersionFromChat(m.presentationId);
      if (m.personal && m.personal.caseId === id) {
        layout([...new Set([...pinned, ...m.personal.cards])]);
        if (m.personal.full !== undefined) filter(m.personal.full);
        if (m.personal.control) control(m.personal.control);
        if (m.personal.pin) pin([...new Set([...pinned, ...m.personal.cards])]);
      }
      if (m.mode !== 'analysis' && m.cards && !m.rangeId) {
        const next = [...new Set([...pinned, ...m.cards])];
        layout(next);
        filter(!!m.full);
        findSources(m.sourceQuery || '');
        localStorage.setItem(
          prefix,
          JSON.stringify({ full: !!m.full, cards: next, pinned, sourceQuery: m.sourceQuery }),
        );
      }
    },
    [pinned, prefix],
  );
  const [mobileChat, chatMode] = useState(false);
  const [advancedEffectOpen, setAdvancedEffectOpen] = useState(false);
  const taskTitle = useRef<HTMLHeadingElement>(null);
  const effectSection = useRef<HTMLDetailsElement>(null);
  const effectReady = !!d;
  useEffect(() => {
    if (section !== 'effect' || !effectReady || !effectSection.current) return;
    effectSection.current.open = true;
    effectSection.current.scrollIntoView({block:'start'});
  }, [section, effectReady]);
  if (!d) return <p className={err ? 'error' : 'empty'} role={err ? 'alert' : 'status'}>{err || 'Загружаем разбор…'}</p>;
  const v = d.view,
    c = d.case;
  const watchNext = c.state === 'Наблюдаем эффект';
  const completed = c.state === 'Завершено';
  const openShare = () => {
    select(cards);
    writeConclusion(v.summary.filter((s) => s.change != null).map((s) => s.product + ' ' + changeLabel(s.change)).join(' · '));
    show(true);
  };
  const openNext = () => {
    chatMode(false);
    requestAnimationFrame(() => {
      if (watchNext && effectSection.current) effectSection.current.open = true;
      const target = watchNext ? effectSection.current?.querySelector('summary') : taskTitle.current;
      target?.focus();
    });
  };
  return (
    <>
      <a className="crumb" href="#cases">
        ← Разборы
      </a>
      {c.body.origin && (
        <p>
          <a href={'#snapshot/' + c.body.origin.calc + '/' + (c.body.origin.cards || initialCards).join(',')}>
            Исходный ответ и расчёт
          </a>
        </p>
      )}
      <div className="page-head investigation-head">
        <div>
          <small>
            {c.product} · {c.body.owner ? 'Личный разбор' : 'Команда'}
          </small>
          <h1>{caseHeading(c)}</h1>
          <span className="state">{c.state}</span>
        </div>
        <div className="actions">
          <span ref={setPresentationAction} />
          {!completed && <button onClick={openShare} disabled={updating}>Поделиться</button>}
          <button className="primary arrow-action" disabled={updating && completed} onClick={completed ? openShare : openNext}>
            {completed ? 'Поделиться' : watchNext ? 'Проверить эффект' : 'К задаче'}
            <Icon name="arrow" />
          </button>
        </div>
      </div>
      {tid && (
        <button className="mobile-toggle" aria-expanded={mobileChat} onClick={() => moveView(() => chatMode(!mobileChat))}>
          <Icon name="down" /> {mobileChat ? 'К разбору' : 'Обсудить'}
        </button>
      )}
      <div className={'case-layout ' + (mobileChat ? 'show-chat' : '')}>
        <div className="case-main" aria-busy={updating}>
          {err && <p role="alert">{err}</p>}
          <div className="toolbar">
            <label>
              <input
                type="checkbox"
                checked={full}
                onChange={(e) => {
                  filter(e.target.checked);
                  localStorage.setItem(prefix, JSON.stringify({ full: e.target.checked, cards, pinned }));
                }}
              />{' '}
              Только полные недели
            </label>
            <label>
              Контроль{' '}
              <select value={peer || v.summary[1]?.product || ''} onChange={(e) => control(e.target.value)}>
                {home.products
                  .filter((p) => p !== c.product)
                  .map((p) => (
                    <option key={p}>{p}</option>
                  ))}
              </select>
            </label>
            <button
              onClick={() => confirm('reset')}
            >
              Сбросить вид
            </button>
          </div>
          <Cards
            view={v}
            cards={cards}
            backlog={d.backlog}
            pinned={pinned}
            onAttach={(a) => {
              attach(a);
              chatMode(true);
            }}
            onAsk={(x) => {
              ask(x);
              chatMode(true);
            }}
            onPin={(k) => {
              const next = pinned.includes(k) ? pinned.filter((p) => p !== k) : [...pinned, k];
              pin(next);
              localStorage.setItem(prefix, JSON.stringify({ cards, full, pinned: next }));
            }}
          />
          {c.body.plan?.hypothesis && (
            <section className="paper">
              <h3>План до разработки</h3>
              <p>{c.body.plan.hypothesis}</p>
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
          <Tracking
            headingRef={taskTitle}
            documentation={section?.startsWith('documentation?') ? new URLSearchParams(section.slice(14)) : undefined}
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
            {home.archiveOnly || (d.effect && 'plan' in d.effect) ?
              <EffectPlan caseId={id} saved={d.effect} archiveOnly={home.archiveOnly} reload={async () => {await load(); await refresh();}}/> : <>
            <p>{d.effect?.state || 'Укажите дату выкладки и цель.'}</p>
            {c.body.watch && d.effect && <dl className="comparison-dates">
              <div><dt>Дата выкладки</dt><dd>{c.body.watch.deployed}</dd></div>
              <div><dt>Окно наблюдения</dt><dd>{d.effect.start} — {d.effect.end}</dd></div>
              <div><dt>Цель / факт, п. индекса</dt><dd>{num(c.body.watch.target)} / {num(d.effect.actual ?? null)}</dd></div>
              <div><dt>Изменение контроля · {c.body.watch.control}</dt><dd>{changeLabel(d.effect.ctrl ?? null)}</dd></div>
              <div><dt>Полные недели, продукт / контроль</dt><dd>{d.effect.weeks} / {d.effect.controlWeeks} из 4</dd></div>
            </dl>}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const b = Object.fromEntries(new FormData(e.currentTarget));
                action(async () => {
                  await post('watch', { ...b, caseId: id, control: v.summary[1]?.product });
                  await load();
                  await refresh();
                });
              }}
            >
              <label>
                Дата выкладки
                <input type="date" name="deployed" required />
              </label>
              <label>
                Целевой процент от базы
                <input name="percent" type="number" min="1" max="300" defaultValue="90" required />
              </label>
              <button>Назначить проверку</button>
            </form>
            <details onToggle={event => setAdvancedEffectOpen(event.currentTarget.open)}>
              <summary>Настроить метрику и окно наблюдения</summary>
              {advancedEffectOpen && <EffectPlan caseId={id} saved={null} reload={async () => {await load(); await refresh();}}/>}
            </details></>}
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
        </div>
        {tid && (
          <Chat
            id={tid}
            userId={home.user.id}
            caseId={id}
            threads={home.threads}
            action={action}
            context={ctx}
            attachment={attachment}
            screen={{ calc: v.id, full, control: peer || v.summary[1]?.product, cards }}
            clearContext={() => {
              ask('');
              attach(undefined);
            }}
            onResult={result}
            onAttachFocus={() => chatMode(true)}
          />
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
                    layout(initialCards);
                    filter(false);
                    control('');
                    findSources('');
                    pin([]);
                    localStorage.setItem(prefix, JSON.stringify({ cards: initialCards, full: false, pinned: [] }));
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
            {cards.map((k) => (
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
      <a href={'#knowledge-source/' + version.version}>{new Date(version.created).toLocaleString('ru-RU')} · {version.version.slice(0, 8)}</a>
      {' · '}{version.origin || 'Ранее загруженная версия'}
      {version.author && ' · ' + version.author}
      {version.active && ' · Текущая'}
    </li>)}</ul>}
  </details>;
}

function Sources({ home, action, refresh }: { home: Home; action: Action; refresh: () => Promise<void> }) {
  const [notice, say] = useState('');
  const [selected, select] = useState<File>();
  const [origin, setOrigin] = useState('');
  const admin = home.user.role === 'admin';
  const versionFile = home.archiveOnly && selected && /\.(xlsx|pptx)$/i.test(selected.name) ? selected : null;
  const current = versionFile ? home.sources.find(source => source.file === versionFile.name) : undefined;
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
              const file = selected;
              if (!file) return;
              action(async () => {
                say('');
                const r = await fetch('/api/team/upload', {
                  method: 'POST',
                  headers: { 'X-File-Name': encodeURIComponent(file.name) },
                  body: file,
                });
                const v = await r.json();
                if (!r.ok) throw Error(v.error);
                say(v.inserted ? 'Добавлено версий: ' + v.inserted : 'Файл уже был загружен.');
                await refresh();
              });
            }}
          >
            <label>
              Книга, презентация или архив
              <input name="file" type="file" accept=".xlsx,.pptx,.zip" required onChange={e => {
                select(e.currentTarget.files?.[0]);
                setOrigin('');
                say('');
              }} />
            </label>
            {home.archiveOnly && <p>Загрузите исходный ZIP. Чтобы добавить или обновить один материал, согласуйте его версию.</p>}
            {versionFile && <label>
              Происхождение материала
              <input value={origin} onChange={e => setOrigin(e.currentTarget.value)} maxLength={400} />
            </label>}
            <div className="actions source-actions">
              {versionFile && <button type="button" disabled={!origin.trim()} onClick={() => action(async () => {
                say('');
                const bytes = await versionFile.arrayBuffer();
                const checksum = await crypto.subtle.digest('SHA-256', bytes);
                const sha = Array.from(new Uint8Array(checksum), b => b.toString(16).padStart(2, '0')).join('');
                await post('approve-source', { sha, file: versionFile.name, origin, previous: current?.version ?? null });
                say('Версия согласована. Теперь её можно загрузить.');
              })}>
                Согласовать версию
              </button>}
              <button className="primary">Загрузить и пересчитать</button>
              {!home.archiveOnly && <button
                type="button"
                onClick={() =>
                  action(async () => {
                    const r = await post<{ inserted: number }>('metrika');
                    say('Метрика ответила. Добавлено версий: ' + r.inserted);
                    await refresh();
                  })
                }
              >
                Синхронизировать Метрику
              </button>}
            </div>
          </form>
        </section>
      )}
      <section className="paper">
        <h3>Загруженные материалы</h3>
        {home.sources.map((s) => (
          <div className="event-row" key={s.file}>
            <b>{s.total > 0 && /\.(xlsx|pptx)$/i.test(s.file) ? <a href={'#knowledge-source/'+s.version}>{s.file}</a> : s.file}</b>
            <small>
              {s.role === 'reference' ? 'Справочный файл · содержимое не индексируется' : 'Распознано записей: ' + s.total}
              {' · '}Версий: {s.versions} · {new Date(s.updated).toLocaleDateString('ru-RU')}
            </small>
            {home.archiveOnly && /\.(xlsx|pptx)$/i.test(s.file) && <SourceHistory file={s.file} current={s.version} />}
          </div>
        ))}
        {!home.sources.length && <p>Источники пока не загружены.</p>}
      </section>
      {notice && <p className="notice" role="status">{notice}</p>}
    </>
  );
}

function Settings({ home, action, refresh, menu, changeMenu }: {
  home: Home;
  action: Action;
  refresh: () => Promise<void>;
  menu: MenuLayout;
  changeMenu: (layout: MenuLayout) => void;
}) {
  const [notice, say] = useState('');
  const admin = home.user.role === 'admin';
  return (
    <>
      <div className="page-head">
        <h1>Настройки команды</h1>
      </div>
      <Connections home={home} action={action} refresh={refresh} />
      {admin && home.archiveOnly && (
        <section className="paper">
          <h3>Яндекс Метрика</h3>
          <p>Проверка Reports API на тестовом счётчике. Источник чисел разбора — архив организатора.</p>
          <button type="button" onClick={() => action(async () => {
            try { await post('metrika-probe'); }
            finally { await refresh(); }
          })}>Проверить Reports API</button>
          {home.metrikaProbe && <p role="status">
            {home.metrikaProbe.status === 'ready' ? 'Reports API ответил' : 'Ошибка Reports API · ' + home.metrikaProbe.reason}
            {' · '}{new Date(home.metrikaProbe.at).toLocaleString('ru-RU')}
          </p>}
        </section>
      )}
      {home.user.role !== 'judge' && <NotificationSettings />}
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
      {admin && (
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
          {home.deliveries.map((r) => (
            <p key={r.channel + r.state}>
              {r.channel} · {r.state}: {r.n}
            </p>
          ))}
        </section>
      )}
      <section className="paper">
        <h3>Доступ</h3>
        <div className="actions">
          {admin && (
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
          )}
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
  const [v, set] = useState<View | null>(null),
    [err, fail] = useState(''),
    [open, setOpen] = useState(false);
  useEffect(() => {
    let active = true;
    set(null);
    fail('');
    post<View>('calc', { id })
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
function Workspace({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [requestedRoute, id, selected] = useRoute(),
    [home, setHome] = useState<Home | null>(null),
    [err, fail] = useState(''),
    [filter, setFilter] = useState(''),
    [create, newCase] = useState(false),
    [releaseRef, selectRelease] = useState(''),
    [menu, setMenu] = useState(readMenuLayout);
  const bridgePages = !!home?.bridgeEnabled;
  const pageHidden = ['demo-page', 'knowledge'].includes(requestedRoute) && !bridgePages;
  const route = pageHidden ? 'cases' : requestedRoute;
  const sidebar = useSidebarWidth();
  const settings = route === 'settings' || (route === 'cases' && id === 'settings');
  const homeVersion = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++homeVersion.current;
    const next = await post<Home>('overview');
    if (homeVersion.current === version) setHome(next);
  }, []);
  function updateThreads(update: (threads: Thread[]) => Thread[]) {
    homeVersion.current++;
    setHome((current) => current && ({
      ...current,
      threads: update(current.threads),
    }));
  }
  useEffect(() => {
    refresh().catch((e) => fail(e.message));
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
    ['cases', 'Разборы'],
    ['sources', 'Источники'],
    ...(bridgePages ? [['knowledge', 'База знаний']] : []),
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
            const active = !settings && (route === k || (k === 'overview' && route === 'release-decision') ||
              (k === 'cases' && ['case','snapshot','range','material','demo-issue','demo-page','releases-list','release-detail','release','releases','calc'].includes(route)));
            return (
            <a
              className={active ? 'active' : ''}
              aria-current={active ? 'page' : undefined}
              aria-label={t}
              title={t}
              key={k}
              href={'#' + k}
            >
              <Icon name={k === 'chats' ? 'chat' : k === 'knowledge' ? 'sources' : k} />
              <span className="menu-label">{t}</span>
            </a>
            );
          })}
        </nav>
        <div className="side-bottom">
          <a className="menu-command" href="#settings" aria-label="Настройки" title="Настройки" aria-current={settings ? 'page' : undefined}>
            <Icon name="settings" /><span className="menu-label">Настройки</span>
          </a>
          <ThemeSwitch />
          <span className="session-role" title={user.role === 'admin' ? 'Администратор' : undefined}>
            {user.role === 'admin' ? <><span className="full-role">Администратор</span><span className="short-role">Админ</span></> :
              user.role === 'judge' ? 'Демо · жюри' : 'Участник'}
          </span>
          <small>{user.name}</small>
          <button
            className="menu-command"
            aria-label="Выйти"
            title="Выйти"
            onClick={() =>
              action(async () => {
                await post('logout');
                onLogout();
              })
            }
          >
            <Icon name="logout" /><span className="menu-label">Выйти</span>
          </button>
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
        {!home ? (
          <p className="empty" role="status">Загрузка…</p>
        ) : route === 'demo-page' || route === 'demo-issue' ? (
          <DemoObject key={route+id} service={route} id={id}/>
        ) : route === 'material' ? (
          <section className="paper">
            <MaterialDetail id={id} />
          </section>
        ) : route === 'release-decision' ? (
          <ReleaseDecision action={action} initialRelease={id || undefined} renderChat={(thread, caseId, releaseId) => (
            <Chat key={thread + '/' + releaseId} id={thread} caseId={caseId} decisionReleaseId={releaseId}
              userId={home.user.id} threads={home.threads} action={action} />
          )} />
        ) : ['releases', 'release', 'calc'].includes(route) ? (
          <ReleaseAnalytics route={route} requestedId={id} author={user.name} admin={user.role === 'admin'} />
        ) : route === 'case' ? (
          <Investigation key={id+'/' + (selected || '')} id={id} section={selected} home={home} action={action} refresh={refresh} />
        ) : route === 'range' ? (
          <RangeResult id={id} />
        ) : route === 'snapshot' ? (
          <Snapshot id={id} selected={selected} />
        ) : route === 'knowledge' ? (
          <Knowledge admin={home.user.role==='admin'} />
        ) : route === 'knowledge-source' ? (
          <SourceExtract key={id+selected} version={id} loc={selected && decodeURIComponent(selected)} />
        ) : settings ? (
          <Settings home={home} action={action} refresh={refresh} menu={menu} changeMenu={changeMenu} />
        ) : route === 'sources' ? (
          <Sources home={home} action={action} refresh={refresh} />
        ) : route === 'chats' ? (
          <ChatWorkspace
            home={home}
            id={id}
            action={action}
            refresh={refresh}
            onRename={(renamed) => updateThreads((threads) => threads.map((thread) =>
              thread.id === renamed.id ? { ...thread, title: renamed.title } : thread
            ))}
            onDelete={(deleted) => updateThreads((threads) => threads.filter((thread) => thread.id !== deleted))}
          />
        ) : route === 'releases-list' ? (
          <>
            <a href="#cases">← Разборы</a>
            <h1>Журнал релизов</h1>
            <a className="primary" href="#releases">Аналитика по событиям CSV</a>
            <section className="paper">
              <h2>Календарь из источников</h2>
              {!home.releases.length && <p>В загруженных источниках пока нет релизов.</p>}
              {home.releases.map((r) => (
                <a className="release-row" href={'#release-detail/' + r.release_id} key={r.release_id}>
                  <small>
                    {r.release_id} · {r.release_date}
                  </small>
                  {r.description}
                </a>
              ))}
            </section>
          </>
        ) : route === 'release-detail' ? (
          (() => {
            const r = home.releases.find((x) => x.release_id === id);
            if (!r) return <p role="alert">Запись календаря не найдена. <a href="#releases-list">Журнал релизов</a></p>;
            return (
              <>
                <a href="#releases-list">← Журнал релизов</a>
                <h1>{r?.release_id}</h1>
                <section className="paper">
                  <small>{r?.release_date}</small>
                  <p>{r?.description}</p>
                  <p>Связанные задачи: {r?.related_task_ids}</p>
                  {['major', 'minor'].includes(r.release_type) && /^(выпущен[аоы]?|released)$/iu.test(r.status) &&
                    <a href={'#release-decision/' + r.release_id}>Решение по релизу</a>}
                  <button
                    onClick={() => {
                      selectRelease(id);
                      newCase(true);
                      jump('cases');
                    }}
                  >
                    Запланировать оценку
                  </button>
                </section>
                <CaseList items={home.cases.filter((c) => c.body.release === id)} />
              </>
            );
          })()
        ) : route === 'cases' ? (
          <>
            <div className="page-head">
              <h1>Разборы</h1>
              <button className="primary" aria-expanded={create} onClick={() => moveView(() => newCase(!create))}>
                Новый разбор
              </button>
            </div>
            {create && (
              <form
                className="paper"
                onSubmit={(e) => {
                  e.preventDefault();
                  const b = Object.fromEntries(new FormData(e.currentTarget));
                  action(async () => {
                    const r = await post<{ id: string }>('create-case', b);
                    newCase(false);
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
                    <option value="" disabled>Выберите из загруженных данных</option>
                    {home.products.map(p => <option key={p}>{p}</option>)}
                  </select> : <input name="product" required list="products" />}
                  <datalist id="products">
                    {home.products.map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </datalist>
                </label>
                <label>
                  Связанный релиз
                  <select name="release" defaultValue={releaseRef}>
                    <option value="">Без релиза</option>
                    {home.releases.map((r) => (
                      <option key={r.release_id}>{r.release_id}</option>
                    ))}
                  </select>
                </label>
                <details>
                  <summary>Гипотеза и критерии до разработки</summary>
                  <label>
                    Гипотеза
                    <textarea name="hypothesis" />
                  </label>
                  <label>
                    Целевая метрика
                    <input name="metric" />
                  </label>
                  <label>
                    База сравнения
                    <input name="baseline" />
                  </label>
                  <label>
                    Контроль
                    <input name="control" />
                  </label>
                  <label>
                    Критерий успеха
                    <input name="success" />
                  </label>
                </details>
                <button>Создать личный разбор</button>
              </form>
            )}
            <div className="toolbar">
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
              <a href="#releases-list">Журнал релизов →</a>
            </div>
            <CaseList items={home.cases.filter((c) => !filter || c.state === filter)} />
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
    <MaterialsProvider home={home} caseId={route === 'case' ? id : undefined} refresh={refresh}>
      <BridgePages.Provider value={bridgePages}>{content}</BridgePages.Provider>
    </MaterialsProvider>
  );
}
function Root() {
  const [user, set] = useState<User | null | undefined>(undefined),
    [error, fail] = useState('');
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
      onLogout={() => {
        set(null);
        jump('overview');
      }}
    />
  ) : (
    <Login onLogin={set} />
  );
}
styleFormValidation();
createRoot(document.getElementById('root')!).render(<Root />);
