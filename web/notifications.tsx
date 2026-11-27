import React, { useEffect, useState } from 'react';
import { post } from './team-data';

type Contacts = {
  email: string | null;
  pending: string | null;
  telegram: boolean;
  smtpReady: boolean;
  testMailbox: boolean;
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
    <section className="paper" aria-labelledby="notification-contacts-title">
      <h3 id="notification-contacts-title">Мои уведомления</h3>
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
              Письма и коды подтверждения поступают в локальный тестовый приёмник.
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
                    const { url } = await post<{ url?: string }>('bind');
                    if (!url) throw Error('Не удалось получить ссылку на бота. Проверьте его настройки.');
                    linkTo(url);
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
