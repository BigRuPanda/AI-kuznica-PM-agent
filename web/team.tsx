import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { post, jump, num } from './team-data';
import type { Home, User, Case, Detail, View, Msg, Thread } from './team-data';
import { Cards, initialCards, labels } from './work-cards';
import './team.css';

type Action = (fn: () => Promise<void>) => void;
function useRoute() {
  const [route, set] = useState(location.hash.slice(1) || 'overview');
  useEffect(() => {
    const change = () => set(location.hash.slice(1) || 'overview');
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
        <div className="brand">
          <i />
          Softline <span>Store</span>
        </div>
        <h1>{register ? 'Создать аккаунт' : 'Вход в команду'}</h1>
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
              Имя для обсуждений
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
            <div className="case-value">
              {c.body.signal?.rule === 'relative'
                ? num(c.body.signal.change) + '%'
                : c.body.signal
                  ? num(c.body.signal.value)
                  : '↗'}
            </div>
          </a>
        ))
      ) : (
        <p className="empty">Разборы появятся после загрузки данных или нового поручения.</p>
      )}
    </div>
  );
}
function Chat({
  id,
  caseId,
  threads,
  action,
  onResult,
  context,
  clearContext,
}: {
  id: string;
  caseId?: string;
  threads: Thread[];
  action: Action;
  onResult?: (b: Msg['body']) => void;
  context?: string;
  clearContext?: () => void;
}) {
  const [items, setItems] = useState<Msg[]>([]),
    [running, work] = useState(false),
    [q, setQ] = useState(''),
    [err, setErr] = useState('');
  const last = useRef(-1),
    end = useRef<HTMLDivElement>(null);
  const refresh = useCallback(async () => {
    return await post<{ items: Msg[]; jobs: unknown[] }>('messages', { thread: id });
  }, [id]);
  useEffect(() => {
    let valid = true;
    last.current = -1;
    setItems([]);
    setErr('');
    const read = async () => {
      try {
        const data = await refresh();
        if (!valid) return;
        setItems(data.items);
        work(!!data.jobs.length);
        const latest = data.items.at(-1);
        if (latest && last.current >= 0 && latest.seq > last.current && latest.role === 'assistant')
          onResult?.(latest.body);
        last.current = latest?.seq || 0;
      } catch (e) {
        if (valid) setErr((e as Error).message);
      }
    };
    void read();
    const t = setInterval(read, 1400);
    return () => {
      valid = false;
      clearInterval(t);
    };
  }, [id, refresh, onResult]);
  useEffect(() => {
    if (items.length) end.current?.scrollIntoView({ block: 'nearest' });
  }, [items.length]);
  return (
    <section className="chat-box">
      <header>
        <small>
          {threads.find((t) => t.id === id)?.scope === 'group' ? 'Участники команды' : 'Только вы и агент'}
        </small>
        <h3>{caseId ? 'Обсудить разбор' : threads.find((t) => t.id === id)?.title || 'Чат'}</h3>
      </header>
      <div className="chat-history">
        {!items.length && <p className="muted">Задайте вопрос о продукте, данных или следующей задаче.</p>}
        {items.map((m) => (
          <article className={'bubble ' + m.role} key={m.seq}>
            <b>{m.author}</b>
            <p>{m.body.text}</p>
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
          </article>
        ))}
        {err && <p role="alert">{err}</p>}
        {running && <p role="status">Агент отвечает…</p>}
        <div ref={end} />
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!q.trim()) return;
          const groupMessage = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'message';
          action(async () => {
            await post(groupMessage ? 'say' : 'ask', {
              thread: id,
              question: (context ? 'О графике «' + context + '». ' : '') + q,
              caseId,
              requestId: crypto.randomUUID(),
            });
            setQ('');
            work(!groupMessage);
            clearContext?.();
          });
        }}
      >
        {context && (
          <button type="button" onClick={clearContext}>
            {context} ×
          </button>
        )}
        <label className="sr" htmlFor={'q' + id}>
          Вопрос агенту
        </label>
        <textarea
          id={'q' + id}
          placeholder="Спросить агента…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          required
        />
        <button className="primary">
          {threads.find((t) => t.id === id)?.scope === 'group' ? 'Спросить агента' : 'Отправить'}
        </button>
        {threads.find((t) => t.id === id)?.scope === 'group' && (
          <button type="submit" value="message">
            Написать команде
          </button>
        )}
      </form>
    </section>
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
    [tid, thread] = useState(''),
    [preview, show] = useState(false),
    [conclusion, writeConclusion] = useState(''),
    [selection, select] = useState<string[]>([]),
    [hits, search] = useState<{ key: string; title: string }[]>([]),
    [key, setKey] = useState(''),
    [err, fail] = useState('');
  const prefix = 'pm-view/' + home.user.id + '/' + id;
  const load = useCallback(
    async () =>
      set(await post<Detail>('view', { caseId: id, full, control: peer || undefined, sourceQuery })),
    [id, full, peer, sourceQuery],
  );
  useEffect(() => {
    set(null);
    let valid = true;
    post<Detail>('view', { caseId: id, full, control: peer || undefined, sourceQuery })
      .then((v) => {
        if (valid) {
          set(v);
          if (v.case.body.origin && !localStorage.getItem(prefix)) {
            const snapshot = v.case.body.origin;
            localStorage.setItem(prefix, JSON.stringify(snapshot));
            filter(!!snapshot.full);
            layout(snapshot.cards || initialCards);
          }
        }
      })
      .catch((e) => fail(e.message));
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
      layout(v.cards || initialCards);
      pin(v.pinned || []);
    } catch {}
  }, [id, prefix]);
  const result = useCallback(
    (m: Msg['body']) => {
      if (m.cards) {
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
  if (!d) return <p>{err || 'Загружаем разбор…'}</p>;
  const v = d.view,
    c = d.case;
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
      <div className="page-head">
        <div>
          <small>
            {c.product} · {c.body.owner ? 'Личный разбор' : 'Команда'}
          </small>
          <h1>{c.title}</h1>
          <span className="state">{c.state}</span>
        </div>
        <button
          onClick={() => {
            select(cards);
            writeConclusion(d.view.summary.map((s) => s.product + ' ' + num(s.change) + '%').join(' · '));
            show(true);
          }}
        >
          Поделиться
        </button>
      </div>
      <button className="mobile-toggle" onClick={() => chatMode(!mobileChat)}>
        {mobileChat ? 'К результату' : 'Обсудить разбор'}
      </button>
      <div className={'case-layout ' + (mobileChat ? 'show-chat' : '')}>
        <div className="case-main">
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
              onClick={() => {
                layout(initialCards);
                filter(false);
                pin([]);
                localStorage.removeItem(prefix);
              }}
            >
              Исходный вид
            </button>
          </div>
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
          <Cards
            view={v}
            cards={cards}
            backlog={d.backlog}
            pinned={pinned}
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
          <section className="paper">
            <h3>Решение по задаче</h3>
            <p className="muted">
              {home.issueMode === 'local'
                ? 'Локальный демо-бэклог · запись останется на этом стенде'
                : 'Jira · запись после подтверждения'}
            </p>
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
                  <strong>{r.external}</strong>
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
          <details className="paper">
            <summary>Проверка эффекта</summary>
            <p>{d.effect?.state || 'Укажите дату подтверждённой выкладки.'}</p>
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
              onClick={() =>
                action(async () => {
                  await post('decide', { caseId: id, state: 'Завершено' });
                  await load();
                  await refresh();
                })
              }
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
                  <a href={'#snapshot/' + p.body.calc + '/' + p.body.cards.join(',')}>
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
            caseId={id}
            threads={home.threads}
            action={action}
            context={ctx}
            clearContext={() => ask('')}
            onResult={result}
          />
        )}
      </div>
      {preview && (
        <div className="scrim">
          <section className="sheet" role="dialog" aria-modal="true" aria-label="Публикация">
            <h2>Поделиться с командой</h2>
            <p>
              В группе «Команда Store» появятся выбранные материалы. История личного чата останется у вас.
            </p>
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
              <button onClick={() => show(false)}>Отмена</button>
              <button
                className="primary"
                disabled={!selection.length}
                onClick={() =>
                  action(async () => {
                    await post('publish', { caseId: id, calc: v.id, cards: selection, conclusion });
                    show(false);
                    await load();
                    await refresh();
                  })
                }
              >
                Опубликовать
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
function Settings({ home, action, refresh }: { home: Home; action: Action; refresh: () => Promise<void> }) {
  const [notice, say] = useState('');
  const admin = home.user.role === 'admin';
  return (
    <>
      <div className="page-head">
        <h1>Настройки команды</h1>
      </div>
      {admin && (
        <section className="paper">
          <h3>Источники</h3>
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
            <button className="primary">Загрузить и пересчитать</button>
          </form>
          <button
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
function Snapshot({ id, selected }: { id: string; selected?: string }) {
  const [v, set] = useState<View | null>(null),
    [err, fail] = useState('');
  useEffect(() => {
    post<View>('calc', { id })
      .then(set)
      .catch((e) => fail(e.message));
  }, [id]);
  return (
    <>
      <a href="#cases">← Разборы</a>
      <h1>Сохранённый расчёт</h1>
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
    [group, newGroup] = useState(false),
    [releaseRef, selectRelease] = useState('');
  const refresh = useCallback(async () => setHome(await post<Home>('overview')), []);
  useEffect(() => {
    refresh().catch((e) => fail(e.message));
  }, [refresh, route, id]);
  useEffect(() => {
    if (!['release', 'calc', 'releases'].includes(route)) return;
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/legacy.css';
    document.head.append(css);
    const tag = document.createElement('script');
    tag.type = 'module';
    tag.src = '/legacy.js';
    document.body.append(tag);
  }, [route]);
  const action: Action = (fn) => {
    fail('');
    void fn().catch((e) => fail(e.message));
  };
  const tabs = [
    ['overview', 'Обзор'],
    ['chats', 'Чаты'],
    ['cases', 'Разборы'],
  ];
  return (
    <div className="team-app">
      <aside className="side">
        <div className="brand">
          <i />
          Softline <span>Store</span>
        </div>
        <nav aria-label="Основные разделы">
          {tabs.map(([k, t], i) => (
            <a
              className={route === k || (route === 'case' && k === 'cases') ? 'active' : ''}
              key={k}
              href={'#' + k}
            >
              <b aria-hidden="true">{['◫', '◌', '▤'][i]}</b>
              {t}
            </a>
          ))}
        </nav>
        <div className="side-bottom">
          <a href="#settings">Настройки</a>
          <small>
            {user.name} ·{' '}
            {user.role === 'judge' ? 'Демо' : user.role === 'admin' ? 'Администратор' : 'Команда'}
          </small>
          <button
            onClick={() =>
              action(async () => {
                await post('logout');
                onLogout();
              })
            }
          >
            Выйти
          </button>
        </div>
      </aside>
      <main className="content">
        {err && (
          <p role="alert" className="error">
            {err} <button onClick={() => fail('')}>×</button>
          </p>
        )}
        {!home ? (
          <p>Загрузка рабочего пространства…</p>
        ) : route === 'case' ? (
          <Investigation key={id} id={id} home={home} action={action} refresh={refresh} />
        ) : route === 'snapshot' ? (
          <Snapshot id={id} selected={selected} />
        ) : route === 'settings' ? (
          <Settings home={home} action={action} refresh={refresh} />
        ) : route === 'chats' ? (
          <>
            <div className="page-head">
              <h1>Чаты</h1>
              <button onClick={() => newGroup(!group)}>Новый чат</button>
            </div>
            {group && (
              <form
                className="paper inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const b = Object.fromEntries(new FormData(e.currentTarget));
                  action(async () => {
                    const r = await post<{ id: string }>('thread', {
                      title: b.title,
                      group: b.scope === 'group',
                    });
                    newGroup(false);
                    await refresh();
                    jump('chats/' + r.id);
                  });
                }}
              >
                <label>
                  Название
                  <input required name="title" />
                </label>
                <label>
                  Участники
                  <select name="scope">
                    <option value="private">Только я</option>
                    <option value="group">Вся команда</option>
                  </select>
                </label>
                <button>Создать</button>
              </form>
            )}
            <div className="chat-layout">
              <div className="paper thread-list">
                {home.threads.map((t) => (
                  <a key={t.id} className={id === t.id ? 'selected' : ''} href={'#chats/' + t.id}>
                    {t.title}
                    <small>{t.scope === 'group' ? 'Группа' : 'Личный'}</small>
                  </a>
                ))}
              </div>
              <Chat key={id || 'group'} id={id || 'group'} threads={home.threads} action={action} />
            </div>
          </>
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
              <a href="/?legacy=1#releases" onClick={() => setTimeout(() => location.reload(), 0)}>
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
              <button className="primary" onClick={() => newCase(!create)}>
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
          <>
            <div className="page-head">
              <div>
                <small>{user.role === 'judge' ? 'Демонстрационное пространство' : 'Команда Store'}</small>
                <h1>Обзор</h1>
              </div>
              <button
                className="primary"
                onClick={() =>
                  action(async () => {
                    const t = await post<{ id: string }>('thread', { title: 'Личный вопрос' });
                    await refresh();
                    jump('chats/' + t.id);
                  })
                }
              >
                Спросить агента ↗
              </button>
            </div>
            <h2>Требует внимания</h2>
            <CaseList
              items={home.cases
                .filter((c) => c.state !== 'Завершено' && (c.body.signal || c.state === 'Нужно решение'))
                .sort((a, b) =>
                  String(b.body.signal?.week || '').localeCompare(String(a.body.signal?.week || '')),
                )}
            />
            <h2>Наблюдение за эффектом</h2>
            {home.cases.some((c) => c.state === 'Наблюдаем эффект') ? (
              <CaseList items={home.cases.filter((c) => c.state === 'Наблюдаем эффект')} />
            ) : (
              <p className="empty">Назначенные проверки появятся после подтверждения даты выкладки.</p>
            )}
          </>
        )}
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
createRoot(document.getElementById('root')!).render(<Root />);
