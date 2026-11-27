import { Icon } from './icons';
import type { User } from './team-data';
import './profile.css';

function ProfileAvatar({ user }: { user: User }) {
  const name = user.name.trim() || user.login;
  const initials = name.split(/[\s_-]+/).filter(Boolean).slice(0, 2)
    .map(part => Array.from(part)[0]).join('').toLocaleUpperCase('ru-RU');
  return <span className="profile-avatar" aria-hidden="true">{initials || '•'}</span>;
}

export function ProfileEntry({ user, current }: { user: User; current?: 'page' | 'location' }) {
  return <a className="profile-entry" href="#profile" aria-label="Профиль" title="Профиль" aria-current={current}>
    <ProfileAvatar user={user} />
    <span className="profile-entry-label">Профиль</span>
    <Icon name="right" />
  </a>;
}

const roleLabel: Record<string, string> = {
  admin: 'Администратор',
  member: 'Участник',
  judge: 'Демо · жюри',
};

export function ProfilePage({ user, onLogout }: { user: User; onLogout: () => void }) {
  const name = user.name.trim() || user.login;
  return (
    <div className="profile-page">
      <div className="page-head"><h1>Профиль</h1></div>
      <section className="paper profile-identity" aria-label="Учётная запись">
        <ProfileAvatar user={user} />
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
      </section>
      <nav className="profile-settings" aria-label="Настройки профиля">
        <a href="#settings/personal">
          <span className="profile-setting-icon"><Icon name="settings" /></span>
          <span><strong>Мои настройки</strong><small>Тема, меню и личные подключения</small></span>
          <Icon name="right" />
        </a>
        <a href="#settings">
          <span className="profile-setting-icon"><Icon name="people" /></span>
          <span><strong>Настройки команды</strong><small>Мониторинг метрик и подключения команды</small></span>
          <Icon name="right" />
        </a>
      </nav>
      <div className="profile-actions">
        <button type="button" className="profile-logout" onClick={onLogout}><Icon name="logout" /> Выйти</button>
      </div>
    </div>
  );
}
