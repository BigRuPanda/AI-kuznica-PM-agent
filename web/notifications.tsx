import React, { useEffect, useState } from 'react';
import { post } from './team-data';
import type { Workbook } from './knowledge-source';

type Contacts = {
  email: string | null;
  pending: string | null;
  telegram: boolean;
  smtpReady: boolean;
  testMailbox: boolean;
  testInboxPort: number;
  telegramReady: boolean;
};
export function NotificationSettings() {
  const [contacts, set] = useState<Contacts | null>(null),
    [error, fail] = useState(''),
    [busy, wait] = useState(false);
  const [link, linkTo] = useState(''),
    [address, setAddress] = useState(''),
    [code, setCode] = useState('');
  async function refresh() {
    const current = await post<Contacts>('contacts');
    set(current);
    if (current.telegram) linkTo('');
  }
  useEffect(() => {
    const load = () => {
      void refresh().catch((e) => fail(e.message));
    };
    load();
    window.addEventListener('focus', load);
    const timer = link ? window.setInterval(load, 5000) : undefined;
    return () => {
      window.removeEventListener('focus', load);
      window.clearInterval(timer);
    };
  }, [link]);
  async function run(f: () => Promise<void>) {
    wait(true);
    fail('');
    try {
      await f();
    } catch (e) {
      fail((e as Error).message);
    } finally {
      wait(false);
    }
  }
  async function unlink(channel: string) {
    set(await post<Contacts>('contact-unlink', { channel }));
    if (channel === 'telegram') linkTo('');
    else {
      setAddress('');
      setCode('');
    }
  }
  return (
    <section className="paper">
      <h3>Мои уведомления</h3>
      <p>Получайте сообщение, когда в Redmine закрывают задачу, которую вы подтвердили в приложении.</p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {contacts && (
        <fieldset disabled={busy} className="contact-fields">
          <legend>Почта</legend>
          {contacts.testMailbox && (
            <p>
              На этом стенде все письма, включая код, поступают в тестовый ящик Mailpit.
              {['127.0.0.1', 'localhost'].includes(location.hostname) && (
                <>
                  {' '}
                  <a
                    href={'http://127.0.0.1:' + contacts.testInboxPort + '/'}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Открыть ящик
                  </a>
                </>
              )}
            </p>
          )}
          {contacts.email && (
            <p>
              Подключена почта <b>{contacts.email}</b>
            </p>
          )}
          {contacts.smtpReady ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  set(await post<Contacts>('email-request', { address }));
                  setCode('');
                });
              }}
            >
              <label>
                {contacts.email ? 'Новый адрес' : 'Адрес почты'}
                <input
                  type="email"
                  autoComplete="email"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  required
                />
              </label>
              <button>Получить код</button>
            </form>
          ) : (
            <p>Для подключения почты администратору нужно указать SMTP-сервер и отправителя.</p>
          )}
          {contacts.pending && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  set(await post<Contacts>('email-confirm', { code }));
                  setCode('');
                  setAddress('');
                });
              }}
            >
              <label>
                Код из письма на {contacts.pending}
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{8}"
                  maxLength={8}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                />
              </label>
              <button>Подтвердить почту</button>
            </form>
          )}
          {(contacts.email || contacts.pending) && (
            <button onClick={() => void run(() => unlink('smtp'))}>Отвязать почту</button>
          )}
        </fieldset>
      )}
      {contacts && (
        <fieldset disabled={busy} className="contact-fields">
          <legend>Telegram</legend>
          {contacts.telegram ? (
            <>
              <p>Личный чат подключён</p>
              <button onClick={() => void run(() => unlink('telegram'))}>Отвязать Telegram</button>
            </>
          ) : contacts.telegramReady ? (
            <>
              <button
                onClick={() =>
                  void run(async () => {
                    linkTo((await post<{ url: string }>('bind')).url);
                  })
                }
              >
                {link ? 'Получить новую ссылку' : 'Привязать Telegram'}
              </button>
              {link && (
                <p>
                  <a href={link} target="_blank" rel="noreferrer">
                    Открыть бота в Telegram
                  </a>{' '}
                  и нажать «Старт». Ссылка действует 10 минут.
                </p>
              )}
            </>
          ) : (
            <p>Для подключения Telegram администратору нужно настроить бота.</p>
          )}
        </fieldset>
      )}
    </section>
  );
}

type Result = {
  reference: string;
  episode: number;
  caseId: string;
  issue: number | string;
  pageKey: string;
  title: string;
  status: string;
  description: string;
  url: string;
  observed: string;
  closed_on: string | null;
  closing_note?: { text: string; author: string } | null;
  report: { start: string; end: string; periods: number[][]; web: string; status: string } | null;
};
type Publication = { id: string; caseId: string; title: string; conclusion: string; created: number };
type WikiPage = { key: string; title: string; version: number; caseId: string };
export function Knowledge({ admin }: { admin: boolean }) {
  const [data, set] = useState<{
      results: Result[];
      publications: Publication[];
      sources: Workbook[];
      pages: WikiPage[];
    } | null>(null),
    [query, search] = useState(''),
    [error, fail] = useState('');
  useEffect(() => {
    post<NonNullable<typeof data>>('knowledge')
      .then(set)
      .catch((e) => fail(e.message));
  }, []);
  const match = (s: string) => s.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const seenPages = new Set<string>();
  const results = (data?.results || []).filter((r) => {
    if (
      seenPages.has(r.pageKey) ||
      !match([r.issue, r.title, r.description, r.status, r.closing_note?.text].join(' '))
    )
      return false;
    seenPages.add(r.pageKey);
    return true;
  });
  const pubs = data?.publications.filter((p) => match(p.title + ' ' + p.conclusion)) || [];
  const sources = data?.sources.filter((s) => match(s.file + ' ' + s.version)) || [];
  const shown = new Set(results.map((r) => r.pageKey));
  const pages = data?.pages.filter((p) => !shown.has(p.key) && match(p.title)) || [];
  return (
    <>
      <div className="page-head">
        <h1>База знаний</h1>
        {admin && <a href="#settings/sources">Загрузить Excel</a>}
      </div>
      <section className="paper">
        <label>
          Поиск по задачам, страницам и источникам
          <input type="search" value={query} onChange={(e) => search(e.target.value)} />
        </label>
      </section>
      {error && <p role="alert">{error}</p>}
      {data && !results.length && !pubs.length && !sources.length && !pages.length && (
        <p>
          {query
            ? 'Совпадений нет.'
            : 'Здесь появятся источники Excel, страницы и результаты закрытых задач Redmine.'}
        </p>
      )}
      {results.map((r) => (
        <article className="paper" key={r.reference + r.episode}>
          <small>
            Redmine #{r.issue} · {r.status} ·{' '}
            {new Date(r.closed_on || r.observed).toLocaleDateString('ru-RU')}
          </small>
          <h3>{r.title}</h3>
          <p>{r.description}</p>
          {r.closing_note && <p>Комментарий при закрытии · {r.closing_note.text}</p>}
          {r.report && (
            <>
              <p>
                Отчёт при создании задачи · {r.report.start} — {r.report.end}. {r.report.status}.
              </p>
              <p>
                Визиты с корзиной / все визиты по неделям:{' '}
                {r.report.periods.map((p) => p[p.length - 1] + '/' + p[0]).join(' → ')}.
              </p>
            </>
          )}
          <div className="actions">
            <a href={r.url} target="_blank" rel="noreferrer">
              Задача Redmine
            </a>
            {r.report && (
              <a href={r.report.web} target="_blank" rel="noreferrer">
                Отчёт Метрики
              </a>
            )}
            <a href={'#demo-page/' + encodeURIComponent(r.pageKey)}>Страница по задаче</a>
            <a
              href={
                '#case/' +
                r.caseId +
                '/documentation?' +
                new URLSearchParams({ issue: String(r.issue), page: r.pageKey })
              }
            >
              Оформить документацию
            </a>
          </div>
        </article>
      ))}
      {pages.map((p) => (
        <article className="paper" key={p.key}>
          <small>Страница · версия {p.version}</small>
          <h3>
            <a href={'#demo-page/' + encodeURIComponent(p.key)}>{p.title}</a>
          </h3>
          <a href={'#case/' + p.caseId}>Разбор</a>
        </article>
      ))}
      {sources.length > 0 && (
        <section className="paper">
          <h3>Источники Excel</h3>
          {sources.map((s) => (
            <div key={s.version} className="event-row">
              <a href={'#knowledge-source/' + s.version}>{s.file}</a>
              <small>
                Версия {s.version.slice(0, 12)} · {s.total} записей
              </small>
            </div>
          ))}
        </section>
      )}
      {pubs.map((p) => (
        <article className="paper" key={p.id}>
          <small>Опубликованный разбор · {new Date(p.created).toLocaleDateString('ru-RU')}</small>
          <h3>{p.title}</h3>
          {p.conclusion && <p>{p.conclusion}</p>}
          <a href={'#case/' + p.caseId}>Открыть разбор</a>
        </article>
      ))}
    </>
  );
}
