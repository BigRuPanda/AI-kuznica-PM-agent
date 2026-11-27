import React, { useCallback, useEffect, useRef, useState } from 'react';
import { post } from './team-data';
import './notifications.css';

type Contacts = {
  email: string | null;
  pending: string | null;
  telegram: boolean;
  smtpReady: boolean;
  testMailbox: boolean;
  telegramReady: boolean;
};

type ContactAction = 'address' | 'code' | 'unlink-email' | 'telegram';

function ContactError({ message, id }: { message?: string; id?: string }) {
  return message ? <p id={id} role="alert" className="field-warning">{message}</p> : null;
}

export function NotificationSettings() {
  const [contacts, setContacts] = useState<Contacts | null>(null);
  const [loadError, setLoadError] = useState('');
  const [errors, setErrors] = useState<Partial<Record<ContactAction, string>>>({});
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState('');
  const [editingAddress, setEditingAddress] = useState(false);
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const focusNextEmailField = useRef(false);
  const focusEmailField = useCallback((input: HTMLInputElement | null) => {
    if (input && focusNextEmailField.current) {
      input.focus();
      focusNextEmailField.current = false;
    }
  }, []);

  useEffect(() => {
    if (busy) return;
    let active = true;
    let loading = false;
    async function load() {
      if (loading) return;
      loading = true;
      try {
        const current = await post<Contacts>('contacts');
        if (!active) return;
        setContacts(current);
        setLoadError('');
        if (current.telegram) setLink('');
      } catch (error) {
        if (active) setLoadError((error as Error).message);
      } finally {
        loading = false;
      }
    }
    void load();
    window.addEventListener('focus', load);
    const timer = link ? window.setInterval(load, 5000) : undefined;
    return () => {
      active = false;
      window.removeEventListener('focus', load);
      window.clearInterval(timer);
    };
  }, [busy, link]);

  async function run(action: ContactAction, change: () => Promise<void>) {
    setBusy(true);
    setErrors((current) => ({ ...current, [action]: undefined }));
    try {
      await change();
    } catch (error) {
      setErrors((current) => ({ ...current, [action]: (error as Error).message }));
    } finally {
      setBusy(false);
    }
  }

  function clearEmailForm() {
    setEditingAddress(false);
    setAddress('');
    setCode('');
    setErrors(({ telegram }) => ({ telegram }));
  }

  async function unlinkEmail() {
    setContacts(await post<Contacts>('contact-unlink', { channel: 'smtp' }));
    clearEmailForm();
  }

  function beginAddressChange() {
    setErrors(({ telegram }) => ({ telegram }));
    setAddress(contacts?.pending ?? '');
    focusNextEmailField.current = true;
    setEditingAddress(true);
  }

  const showAddress = contacts?.smtpReady && (editingAddress || (!contacts.email && !contacts.pending));
  const emailStatus = contacts?.email ? 'Подключена' : contacts?.pending ? 'Ожидает подтверждения'
    : contacts?.smtpReady ? 'Не подключена' : 'Недоступна';
  const telegramStatus = contacts?.telegram ? 'Личный чат подключён' : !contacts?.telegramReady ? 'Недоступен'
    : link ? 'Ожидает подключения' : 'Не подключён';

  return (
    <section className="notification-settings" aria-labelledby="notification-contacts-title">
      <h3 id="notification-contacts-title">Мои уведомления</h3>
      <ContactError message={loadError} />
      {!contacts && !loadError && <p className="muted" role="status">Загружаем настройки…</p>}
      {contacts && (
        <div className="notification-cards">
          <fieldset disabled={busy} className="paper notification-card" aria-labelledby="notification-email-title">
            <div className="notification-card-content">
              <header>
                <h4 id="notification-email-title">Почта</h4>
                <span className="notification-status" data-connected={!!contacts.email} role="status">{emailStatus}</span>
              </header>
              {contacts.email && <p className="notification-address">
                {(contacts.pending || editingAddress) && <small>Текущий адрес</small>}
                <b>{contacts.email}</b>
              </p>}
              {showAddress && contacts.pending && <small>Ждёт подтверждения · {contacts.pending}</small>}
              {showAddress ? (
                <form
                  key="address"
                  className="notification-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run('address', async () => {
                      const current = await post<Contacts>('email-request', { address });
                      focusNextEmailField.current = !!current.pending;
                      setContacts(current);
                      clearEmailForm();
                    });
                  }}
                >
                  <label htmlFor="notification-email-address">{contacts.email ? 'Новый адрес' : 'Адрес почты'}</label>
                  <input
                    id="notification-email-address"
                    ref={focusEmailField}
                    type="email"
                    autoComplete="email"
                    value={address}
                    aria-describedby={errors.address ? 'notification-email-address-error' : undefined}
                    onChange={(event) => {
                      setAddress(event.target.value);
                      if (errors.address) setErrors((current) => ({ ...current, address: undefined }));
                    }}
                    required
                  />
                  <ContactError message={errors.address} id="notification-email-address-error" />
                  <div className="notification-actions">
                    <button className="primary">Получить код</button>
                    {editingAddress && <button type="button" onClick={clearEmailForm}>Отмена</button>}
                  </div>
                </form>
              ) : contacts.pending && (
                <form
                  key="code"
                  className="notification-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run('code', async () => {
                      setContacts(await post<Contacts>('email-confirm', { code }));
                      clearEmailForm();
                    });
                  }}
                >
                  <label htmlFor="notification-email-code">Код из письма на {contacts.pending}</label>
                  <input
                    id="notification-email-code"
                    ref={focusEmailField}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{8}"
                    maxLength={8}
                    value={code}
                    aria-invalid={errors.code ? true : undefined}
                    aria-describedby={errors.code ? 'notification-email-code-error' : undefined}
                    onChange={(event) => {
                      setCode(event.target.value);
                      if (errors.code) setErrors((current) => ({ ...current, code: undefined }));
                    }}
                    required
                  />
                  <ContactError message={errors.code} id="notification-email-code-error" />
                  <button className="primary">Подтвердить почту</button>
                </form>
              )}
              {!showAddress && contacts.smtpReady && (contacts.email || contacts.pending) && (
                <button type="button" className={contacts.pending ? 'text-action' : 'primary'} onClick={beginAddressChange}>
                  Изменить адрес
                </button>
              )}
              {!contacts.pending && <ContactError message={errors.code} />}
              {!contacts.smtpReady && <small>Почтовая отправка не настроена.</small>}
              {contacts.testMailbox && <small>Письма и коды поступают в локальный тестовый ящик.</small>}
              {(contacts.email || contacts.pending) && (
                <div className="notification-actions">
                  <button type="button" className="text-action" onClick={() => void run('unlink-email', unlinkEmail)}>
                    {contacts.email ? 'Отвязать почту' : 'Отменить подтверждение'}
                  </button>
                </div>
              )}
              <ContactError message={errors['unlink-email']} />
            </div>
          </fieldset>
          <fieldset disabled={busy} className="paper notification-card" aria-labelledby="notification-telegram-title">
            <div className="notification-card-content">
              <header>
                <h4 id="notification-telegram-title">Telegram</h4>
                <span className="notification-status" data-connected={contacts.telegram} role="status">{telegramStatus}</span>
              </header>
              {contacts.telegram ? (
                <button type="button" className="text-action" onClick={() => void run('telegram', async () => {
                  setContacts(await post<Contacts>('contact-unlink', { channel: 'telegram' }));
                  setLink('');
                })}>
                  Отвязать Telegram
                </button>
              ) : contacts.telegramReady && (
                <>
                  {link && (
                    <>
                      <a className="primary" href={link} target="_blank" rel="noreferrer"
                        aria-describedby="notification-telegram-hint">
                        Открыть бота в Telegram
                      </a>
                      <small id="notification-telegram-hint">Нажмите «Старт» в чате с ботом. Ссылка действует 10 минут.</small>
                    </>
                  )}
                  <button
                    type="button"
                    className={link ? 'text-action' : 'primary'}
                    onClick={() => void run('telegram', async () => {
                      const { url } = await post<{ url?: string }>('bind');
                      if (!url) throw Error('Не удалось получить ссылку. Проверьте настройки бота.');
                      setLink(url);
                    })}
                  >
                    {link ? 'Получить новую ссылку' : 'Привязать Telegram'}
                  </button>
                </>
              )}
              {!contacts.telegramReady && <small>Бот Telegram не настроен.</small>}
              <ContactError message={errors.telegram} />
            </div>
          </fieldset>
        </div>
      )}
    </section>
  );
}
