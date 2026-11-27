import { useRef, useState } from 'react';
import { Icon } from './icons';
import { post } from './team-data';
import type { User } from './team-data';
import './profile.css';

export function ProfileAvatar({ name, avatar, className = 'profile-avatar' }: {
  name: string; avatar?: User['avatar']; className?: string;
}) {
  const initials = name.trim().split(/[\s_-]+/).filter(Boolean).slice(0, 2)
    .map(part => Array.from(part)[0]).join('').toLocaleUpperCase('ru-RU');
  return <span className={className} aria-hidden="true">{avatar ? <img src={avatar} alt="" /> : initials || '•'}</span>;
}

export function ProfileEntry({ user, active }: { user: User; active: boolean }) {
  return <a className="profile-entry" href="#profile" aria-label="Профиль" title="Профиль" aria-current={active ? 'page' : undefined}>
    <ProfileAvatar name={user.name.trim() || user.login} avatar={user.avatar} />
    <span className="profile-entry-label">Профиль</span>
    <Icon name="right" />
  </a>;
}

const roleLabel: Record<string, string> = {
  admin: 'Администратор',
  member: 'Участник',
  judge: 'Демо · жюри',
};

const photoTypes = ['image/jpeg', 'image/png', 'image/webp'];
async function prepareAvatar(file: File) {
  if (!photoTypes.includes(file.type) || file.size > 10 * 1024 * 1024)
    throw Error('Выберите фото JPEG, PNG или WebP размером до 10 МБ.');
  const image = await createImageBitmap(file).catch(() => { throw Error('Не удалось открыть фото.'); });
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 192;
    const context = canvas.getContext('2d');
    if (!context) throw Error('Не удалось подготовить фото.');
    const side = Math.min(image.width, image.height);
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0,
      canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.9);
  } finally {
    image.close();
  }
}

export function ProfilePage({ user, onLogout, onUpdate }: {
  user: User; onLogout: () => void; onUpdate: (user: User) => void;
}) {
  const name = user.name.trim() || user.login;
  const avatar = user.avatar ?? null;
  const [draft, setDraft] = useState<{ name: string; avatar: string | null } | null>(null);
  const [busy, setBusy] = useState<'photo' | 'save' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const editButton = useRef<HTMLButtonElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const changed = draft && (draft.name.trim() !== name || draft.avatar !== avatar);
  function closeEditor() {
    setDraft(null);
    setError('');
    requestAnimationFrame(() => editButton.current?.focus());
  }
  async function choosePhoto(file: File) {
    setError('');
    setBusy('photo');
    try {
      const next = await prepareAvatar(file);
      setDraft(current => current && { ...current, avatar: next });
    } catch (error) {
      if (photoInput.current) photoInput.current.value = '';
      setError(error instanceof Error ? error.message : 'Не удалось открыть фото.');
    } finally {
      setBusy(null);
    }
  }
  async function saveProfile() {
    if (!draft || busy || !changed) return;
    setError('');
    setBusy('save');
    const nextName = draft.name.trim();
    try {
      const updated = await post<User>('profile', {
        name: nextName === name ? undefined : nextName,
        avatar: draft.avatar === avatar ? undefined : draft.avatar,
      });
      onUpdate(updated);
      closeEditor();
      setNotice('Профиль сохранён.');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Не удалось сохранить профиль.');
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="profile-page">
      <div className="page-head"><h1>Профиль</h1></div>
      <section className="paper profile-identity" aria-label="Учётная запись">
        <div className="profile-overview">
          <ProfileAvatar name={user.name.trim() || user.login} avatar={draft ? draft.avatar : avatar} />
          <div className="profile-details">
            <div className="profile-name">
              <h2>{name}</h2>
              <span className="profile-role">{roleLabel[user.role] ?? roleLabel.member}</span>
            </div>
            {name !== user.login && <dl className="profile-login">
              <dt>Логин</dt>
              <dd>{user.login}</dd>
            </dl>}
          </div>
          <button ref={editButton} type="button" className="profile-edit-toggle" hidden={Boolean(draft)}
            onClick={() => { setNotice(''); setDraft({ name, avatar }); }}>
            <Icon name="edit" /> Редактировать профиль
          </button>
        </div>
        {draft && <form className="profile-form" onSubmit={event => { event.preventDefault(); void saveProfile(); }}>
          <label>
            Имя
            <input autoFocus autoComplete="name" name="name" value={draft.name} required maxLength={100}
              disabled={busy === 'save'} onChange={event => setDraft({ ...draft, name: event.currentTarget.value })} />
          </label>
          <div className="profile-photo">
            <div className="profile-photo-picker">
              <label>
                Фото профиля
                <input ref={photoInput} type="file" accept={photoTypes.join(',')} disabled={Boolean(busy)}
                  aria-describedby="profile-photo-hint" onChange={event => {
                    const file = event.currentTarget.files?.[0];
                    if (file) void choosePhoto(file);
                  }} />
              </label>
              <small id="profile-photo-hint">JPEG, PNG или WebP до 10 МБ</small>
            </div>
            {draft.avatar && <button type="button" className="text-action" disabled={Boolean(busy)}
              onClick={() => {
                if (photoInput.current) photoInput.current.value = '';
                setError('');
                setDraft({ ...draft, avatar: null });
              }}>Убрать фото</button>}
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="profile-form-actions">
            <button type="submit" className="primary" disabled={Boolean(busy) || !changed || !draft.name.trim()}>
              {busy === 'save' ? 'Сохраняем…' : 'Сохранить профиль'}
            </button>
            <button type="button" disabled={Boolean(busy)} onClick={closeEditor}>Отмена</button>
          </div>
        </form>}
        {notice && <p className="profile-notice" role="status">{notice}</p>}
      </section>
      <div className="profile-actions">
        <button type="button" className="profile-logout" onClick={onLogout}><Icon name="logout" /> Выйти</button>
      </div>
    </div>
  );
}
