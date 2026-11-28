import React, { useEffect, useState } from 'react';
import { post } from './team-data';

export const researchModes = {
  lead: 'Только ведущий',
  review: 'Ведущий и рецензент',
  roles: 'По ролям',
};
type Mode = keyof typeof researchModes;
type Settings = {
  team: Mode; personal: Mode | 'inherit'; effective: Mode;
  maxConcurrentChecks: number; automaticRetries: boolean;
};

function InvestigationLimit({ limit, admin, onSave }: { limit: number; admin: boolean; onSave: (n: number) => void }) {
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState('');
  const [error,setError] = useState('');
  const label = 'Максимум одновременных ИИ-проверок';
  if (!admin) return <p>{label} · {limit}</p>;
  return <form onSubmit={async event => {
    event.preventDefault();
    if (busy) return;
    const input = event.currentTarget.elements.namedItem('limit') as HTMLInputElement;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await post<{maxConcurrentChecks:number}>('save-investigation-limit',{maxConcurrentChecks:input.valueAsNumber});
      onSave(result.maxConcurrentChecks);
      setMessage('Лимит сохранён');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }}>
    <label>{label}
      <input type="number" name="limit" min={1} max={Number.MAX_SAFE_INTEGER} step={1} required defaultValue={limit}
        disabled={busy} onChange={() => { setMessage(''); setError(''); }} />
    </label>
    <button disabled={busy}>Сохранить лимит</button>
    {message && <span role="status">{message}</span>}
    {error && <span role="alert">{error}</span>}
  </form>;
}

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
          const modes = await post<Settings>('save-research-settings', { scope, mode });
          setSettings(current => current && {...current,team:modes.team,personal:modes.personal,effective:modes.effective});
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
    {team && settings && <>
      <InvestigationLimit limit={settings.maxConcurrentChecks} admin={admin}
        onSave={n => setSettings(current => current && {...current,maxConcurrentChecks:n})} />
      <AutomaticRetrySetting enabled={settings.automaticRetries} admin={admin}
        onSave={automaticRetries => setSettings(current => current && {...current,automaticRetries})} />
    </>}
  </section>;
}

function AutomaticRetrySetting({enabled,admin,onSave}: {enabled: boolean; admin: boolean; onSave: (enabled: boolean) => void}) {
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  if (!admin) return <p>Автоматические повторы ИИ-проверок · {enabled ? 'включены' : 'выключены'}</p>;
  return <div>
    <label className="tracker-search-switch">
      <input type="checkbox" role="switch" className="search-switch-track" checked={enabled} disabled={busy} onChange={async event => {
        const automaticRetries = event.currentTarget.checked;
        setBusy(true);
        setError('');
        try {
          const saved = await post<{automaticRetries: boolean}>('save-investigation-auto-retry', {automaticRetries});
          onSave(saved.automaticRetries);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }} />
      Автоматически повторять ИИ-проверки
    </label>
    {error && <p role="alert">{error}</p>}
  </div>;
}
