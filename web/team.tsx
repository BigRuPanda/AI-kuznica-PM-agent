import { RangeResult } from './range-result';
import { rangeLabel, RangeChart, DAY } from './range-chart';
import type { Attachment } from './range-chart';
import { SavedChart } from './calculations';
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
import './chat.css';

type Action = (fn: () => Promise<void>) => void;
type ThreadTitle = Pick<Thread, 'id' | 'title'>;
function useRoute() {
  const [route, set] = useState(location.hash.slice(1) || 'overview');
  const current = useRef(route);
  useEffect(() => {
    const section = (value: string) => value.split('/', 1)[0];
    const change = () => {
      const read = () => location.hash.slice(1) || 'overview';
      const update = () => {
        current.current = read();
        set(current.current);
      };
      if (section(current.current) === 'chats' && section(read()) === 'chats') update();
      else moveView(update);
    };
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
        <button onClick={onAsk}>Спросить помощника</button>
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
  threads,
  action,
  onResult,
  context,
  clearContext,
  attachment,
  screen,
  onAdd,
  headerActions,
}: {
  id: string;
  userId: string;
  caseId?: string;
  threads: Thread[];
  action: Action;
  onResult?: (b: Msg['body']) => void;
  context?: string;
  clearContext?: () => void;
  attachment?: Attachment;
  screen?: { calc: string; full: boolean; control?: string; cards: string[] };
  onAdd?: (s: NonNullable<Msg['body']['suggestions']>[number]) => void;
  headerActions?: React.ReactNode;
}) {
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
  const [attached, setAttached] = useState<Attachment | undefined>(() => {
    try {
      return JSON.parse(sessionStorage.getItem('pm-attachment/' + id) || 'null') || undefined;
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
    if (attachment) {
      setAttached(attachment);
      sessionStorage.setItem('pm-attachment/' + id, JSON.stringify(attachment));
      box.current?.focus();
    }
  }, [attachment, id]);
  useEffect(() => {
    if (sessionStorage.getItem('pm-attachment/' + id)) box.current?.focus();
  }, [id]);
  function clearAttachment() {
    setAttached(undefined);
    sessionStorage.removeItem('pm-attachment/' + id);
  }
  const last = useRef(-1);
  const refresh = useCallback(async () => {
    return await post<{ items: Msg[]; jobs: unknown[] }>('messages', { thread: id });
  }, [id]);
  useEffect(() => {
    let valid = true;
    last.current = -1;
    setItems([]);
    setLoaded(false);
    setErr('');
    const read = async () => {
      try {
        const data = await refresh();
        if (!valid) return;
        setItems(data.items);
        work(!!data.jobs.length);
        setLoaded(true);
        setErr('');
        const latest = data.items.at(-1);
        if (latest && last.current >= 0 && latest.seq > last.current && latest.role === 'assistant')
          onResult?.(latest.body);
        last.current = latest?.seq || 0;
      } catch (e) {
        if (valid) {
          setErr((e as Error).message);
          setLoaded(true);
        }
      }
    };
    void read();
    const t = setInterval(read, 1400);
    return () => {
      valid = false;
      clearInterval(t);
    };
  }, [id, refresh, onResult]);
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
    if (follow.current && history.current) history.current.scrollTop = history.current.scrollHeight;
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
            {m.body.text && (m.role === 'assistant' ? <Answer text={m.body.text} /> : <p>{m.body.text}</p>)}
            {m.body.rangeId && (
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
            {m.body.suggestions?.map((s) => (
              <div className="tool-receipt" key={s.calc}>
                <a
                  href={
                    (s.source === 'release'
                      ? '/?legacy=1#calc/'
                      : s.source === 'range'
                        ? '#range/'
                        : '#snapshot/') + s.calc
                  }
                >
                  {s.title}
                </a>
                {onAdd && <button onClick={() => onAdd(s)}>Добавить на экран</button>}
              </div>
            ))}
            {m.body.actions?.map((a, i) => (
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
                {a.destination && (
                  <small>
                    {a.destination} ·{' '}
                    {a.key ? 'Изменить ' + a.key + ' · приоритет ' + a.priority : 'Новая задача'}
                  </small>
                )}
                {a.recipient && <small>Получатели: {a.recipient}</small>}
                {a.rangeId && <a href={'#range/' + a.rangeId}>Проверить выделенные периоды</a>}
                {a.cards?.length ? (
                  <small>Материалы: {a.cards.map((k) => labels[k] || k).join(', ')}</small>
                ) : null}
                {a.id &&
                  a.canConfirm !== false &&
                  ['draft', 'prepare_publish'].includes(a.op) &&
                  (a.state === 'done' || receipts[a.id] ? (
                    <small>{receipts[a.id] || a.external || 'Подтверждено'}</small>
                  ) : (
                    <button
                      onClick={() =>
                        action(async () => {
                          const r = await post<{ key?: string; id?: string }>(
                            a.op === 'draft' ? 'confirm' : 'approve_preview',
                            { id: a.id },
                          );
                          showReceipt((prev) => ({ ...prev, [a.id!]: r.key || 'Опубликовано' }));
                        })
                      }
                    >
                      {a.op === 'draft' ? 'Подтвердить задачу' : 'Подтвердить публикацию'}
                    </button>
                  ))}
              </div>
            ))}
            {!!m.body.steps?.length && (
              <details>
                <summary>Проверки</summary>
                <small>{m.body.steps.join(' → ')}</small>
              </details>
            )}
            {m.body.warning && <small>{m.body.warning}</small>}
            {m.body.calc && (
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
            <span aria-hidden="true"><i /><i /><i /></span> Помощник отвечает
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
              question: (context ? 'О графике «' + context + '». ' : '') + q,
              caseId,
              screen,
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
            setQ('');
            work(!groupMessage);
            clearContext?.();
          });
        }}
      >
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
            placeholder="Спросить помощника…"
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
      sessionStorage.removeItem('pm-chat-draft/' + home.user.id + '/' + deleted);
      sessionStorage.removeItem('pm-pending/' + home.user.id + '/' + deleted);
      sessionStorage.removeItem('pm-attachment/' + deleted);
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
  home,
  action,
  refresh,
}: {
  id: string;
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
    [additional, addCheck] = useState<NonNullable<Msg['body']['suggestions']>>([]),
    [tid, thread] = useState(''),
    [preview, show] = useState(false),
    [conclusion, writeConclusion] = useState(''),
    [selection, select] = useState<string[]>([]),
    [hits, search] = useState<{ key: string; title: string }[]>([]),
    [key, setKey] = useState(''),
    [err, fail] = useState(''),
    [confirmation, confirm] = useState<'reset' | 'finish'>(),
    [updating, setUpdating] = useState(false);
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
      if (m.personal && m.personal.caseId === id) {
        layout([...new Set([...pinned, ...m.personal.cards])]);
        if (m.personal.full !== undefined) filter(m.personal.full);
        if (m.personal.control) control(m.personal.control);
        if (m.personal.pin) pin([...new Set([...pinned, ...m.personal.cards])]);
      }
      if (m.cards && !m.rangeId) {
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
  const taskTitle = useRef<HTMLHeadingElement>(null);
  const effectSection = useRef<HTMLDetailsElement>(null);
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
          <a href={'#snapshot/' + c.body.origin.calc + '/' + c.body.origin.cards.join(',')}>
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
        </div>
        <div className="actions">
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
          {additional.map((s) => (
            <section className="paper" key={s.calc}>
              <button onClick={() => addCheck((xs) => xs.filter((x) => x.calc !== s.calc))}>
                Убрать дополнительную проверку
              </button>
              {s.source === 'release' ? (
                <SavedChart id={s.calc} />
              ) : s.source === 'range' ? (
                <RangeResult id={s.calc} />
              ) : (
                <Snapshot id={s.calc} selected={s.cards.join(',')} embedded />
              )}
            </section>
          ))}
          <section className="paper task-panel">
            <div className="row-between">
              <h3 tabIndex={-1} ref={taskTitle}>Решение по задаче</h3>
              <span className="state">{home.issueMode === 'local' ? 'Демо-бэклог' : 'Jira'}</span>
            </div>
            <button
              onClick={() =>
                action(async () => {
                  const r = await post<{ items: typeof hits }>('jira-search', { query: c.product });
                  search(r.items);
                })
              }
            >
              Найти похожие задачи
            </button>
            {hits.map((h) => (
              <label key={h.key}>
                <input type="radio" name="issue" checked={key === h.key} onChange={() => setKey(h.key)} />
                {h.key} · {h.title}
              </label>
            ))}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const b = Object.fromEntries(new FormData(e.currentTarget));
                action(async () => {
                  await post('draft', { ...b, key, caseId: id });
                  await load();
                });
              }}
            >
              <label>
                Заголовок
                <input name="title" defaultValue={'Проверить путь покупки · ' + c.product} required />
              </label>
              <label>
                Проверка и критерий успеха
                <textarea
                  name="description"
                  rows={3}
                  defaultValue={
                    'Проверить выбор лицензии, фактическое добавление в корзину и доставку события в аналитику. Источник: ' +
                    v.id
                  }
                />
              </label>
              {key && (
                <>
                  <label>
                    Приоритет для {key}
                    <input name="priority" required placeholder="High" />
                  </label>
                  <button type="button" onClick={() => setKey('')}>
                    Создать отдельную задачу
                  </button>
                </>
              )}
              <button>Подготовить черновик</button>
            </form>
            {d.drafts.map((r) => (
              <div key={r.id} className="excerpt">
                <b>{r.body.title}</b>
                <p>{r.body.description}</p>
                <small>
                  {r.body.key || 'Новая задача'} {r.body.priority} · сгенерирована ИИ-помощником
                </small>
                {r.state === 'done' ? (
                  <strong className="state issue-key">{r.external}</strong>
                ) : (
                  <button
                    className="primary"
                    onClick={() =>
                      action(async () => {
                        await post('confirm', { id: r.id });
                        await load();
                      })
                    }
                  >
                    Подтвердить запись
                  </button>
                )}
              </div>
            ))}
          </section>
          <details className="paper effect-panel" ref={effectSection}>
            <summary>Проверка эффекта</summary>
            <p>{d.effect?.state || 'Укажите дату выкладки и цель.'}</p>
            {d.effect?.weeks != null && <small>Полных недель по продукту: {d.effect.weeks} из 4</small>}
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
            onAdd={(s) => addCheck((xs) => (xs.some((x) => x.calc === s.calc) ? xs : [...xs, s]))}
            clearContext={() => {
              ask('');
              attach(undefined);
            }}
            onResult={result}
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
function Sources({ home, action, refresh }: { home: Home; action: Action; refresh: () => Promise<void> }) {
  const [notice, say] = useState('');
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
                  headers: { 'X-File-Name': encodeURIComponent(file.name) },
                  body: file,
                });
                const v = await r.json();
                if (!r.ok) throw Error(v.error);
                say('Добавлено версий: ' + v.inserted);
                await refresh();
              });
            }}
          >
            <label>
              Книга, презентация или архив
              <input name="file" type="file" accept=".xlsx,.pptx,.zip" required />
            </label>
            <div className="actions source-actions">
              <button className="primary">Загрузить и пересчитать</button>
              <button
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
              </button>
            </div>
          </form>
        </section>
      )}
      <section className="paper">
        <h3>Загруженные материалы</h3>
        {home.sources.map((s) => (
          <div className="event-row" key={s.file}>
            <b>{s.file}</b>
            <small>
              Версий: {s.versions} · {new Date(s.updated).toLocaleDateString('ru-RU')}
            </small>
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
          {home.user.role !== 'judge' && (
            <button
              onClick={() => action(async () => say((await post<{ command: string }>('bind')).command))}
            >
              Привязать Telegram
            </button>
          )}
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
function Snapshot({ id, selected, embedded = false }: { id: string; selected?: string; embedded?: boolean }) {
  const [v, set] = useState<View | null>(null),
    [err, fail] = useState('');
  useEffect(() => {
    post<View>('calc', { id })
      .then(set)
      .catch((e) => fail(e.message));
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
    return (
      <section className="paper">
        <h2>{custom.title}</h2>
        <RangeChart
          title={custom.title}
          unit={custom.unit === 'ratio' ? '%' : custom.unit}
          step={step}
          pick={(series, ranges) => ({
            label: custom.title,
            selection: { source: 'metric', calcId: id, version: id, metric: custom.metric, series, ranges },
          })}
          lines={[
            {
              key: custom.segment,
              name: custom.segment,
              color: 'var(--series-main)',
              points: pts.map((p) => ({
                ...p,
                value: p.value != null && custom.unit === 'ratio' ? 100 * p.value : p.value,
              })),
            },
          ]}
        />
      </section>
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
  const [route, id, selected] = useRoute(),
    [home, setHome] = useState<Home | null>(null),
    [err, fail] = useState(''),
    [filter, setFilter] = useState(''),
    [create, newCase] = useState(false),
    [releaseRef, selectRelease] = useState(''),
    [menu, setMenu] = useState(readMenuLayout);
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
  useEffect(() => {
    if (['release', 'calc', 'releases'].includes(route)) location.reload();
  }, [route]);
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
  ];
  return (
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
            const active = !settings && (route === k || (k === 'cases' && route === 'case'));
            return (
            <a
              className={active ? 'active' : ''}
              aria-current={active ? 'page' : undefined}
              aria-label={t}
              title={t}
              key={k}
              href={'#' + k}
            >
              <Icon name={k === 'chats' ? 'chat' : k} />
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
        <div className="workspace-page" key={route === 'chats' ? route : [route, id, selected].join('/')}>
        {!home ? (
          <p className="empty" role="status">Загрузка…</p>
        ) : route === 'case' ? (
          <Investigation key={id} id={id} home={home} action={action} refresh={refresh} />
        ) : route === 'range' ? (
          <RangeResult id={id} />
        ) : route === 'snapshot' ? (
          <Snapshot id={id} selected={selected} />
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
            <section className="paper">
              {home.releases.map((r) => (
                <a className="release-row" href={'#release-detail/' + r.release_id} key={r.release_id}>
                  <small>
                    {r.release_id} · {r.release_date}
                  </small>
                  {r.description}
                </a>
              ))}
              <a href="/?legacy=1#releases">
                Архив прежнего прототипа
              </a>
            </section>
          </>
        ) : route === 'release-detail' ? (
          (() => {
            const r = home.releases.find((x) => x.release_id === id);
            return (
              <>
                <a href="#releases-list">← Журнал релизов</a>
                <h1>{r?.release_id}</h1>
                <section className="paper">
                  <small>{r?.release_date}</small>
                  <p>{r?.description}</p>
                  <p>Связанные задачи: {r?.related_task_ids}</p>
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
                  <input name="product" required list="products" />
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
