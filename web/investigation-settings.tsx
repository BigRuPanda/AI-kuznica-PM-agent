import React, { useEffect, useState } from 'react';
import { post } from './team-data';

export const researchModes = {
  lead: 'Только ведущий',
  review: 'Ведущий и рецензент',
  roles: 'По ролям',
};
type Mode = keyof typeof researchModes;
type Settings = { team: Mode; personal: Mode | 'inherit'; effective: Mode };

export function InvestigationSettings({ scope, admin }: { scope: 'team' | 'personal'; admin: boolean }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const team = scope === 'team';

  useEffect(() => {
    let active = true;
    post<Settings>('research-settings')
      .then(result => { if (active) setSettings(result); })
      .catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);

  return <section className="paper">
    <h3>{team ? 'Исследования по сигналам' : 'Исследования по моим поручениям'}</h3>
    <p>{team
      ? 'Режим действует для новых автоматических разборов и для поручений участников, выбравших «Как у команды».'
      : 'Режим действует для ваших новых поручений, в том числе для проверки другой версии в разборе.'}</p>
    {error && <p role="alert">{error}</p>}
    {!settings && !error && <p role="status">Загрузка…</p>}
    {settings && (team && !admin ? <p>Режим команды · <strong>{researchModes[settings.team]}</strong></p> :
      <form onSubmit={async event => {
        event.preventDefault();
        const mode = new FormData(event.currentTarget).get('mode');
        setSaving(true);
        setError('');
        setSaved(false);
        try {
          setSettings(await post<Settings>('save-research-settings', { scope, mode }));
          setSaved(true);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setSaving(false);
        }
      }}>
        <label>{team ? 'Режим исследований по сигналам' : 'Режим моих поручений'}
          <select name="mode" defaultValue={settings[scope]} disabled={saving} onChange={() => setSaved(false)}>
            {!team && <option value="inherit">Как у команды · {researchModes[settings.team]}</option>}
            {Object.entries(researchModes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <button disabled={saving}>Сохранить режим</button>
        {saved && <span role="status">Режим сохранён</span>}
      </form>)}
  </section>;
}
