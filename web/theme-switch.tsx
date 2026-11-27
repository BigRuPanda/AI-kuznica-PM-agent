import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Icon } from './icons';

type Theme = 'light' | 'dark';
const storageKey = 'pm-theme';
const ThemeContext = createContext<{ theme: Theme; toggle: () => void } | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const root = document.documentElement;
  const [theme, setTheme] = useState<Theme>(() => root.dataset.theme === 'dark' ? 'dark' : 'light');

  useEffect(() => {
    function syncStorage(event: StorageEvent) {
      if (event.key !== storageKey && event.key !== null) return;
      const next = event.newValue === 'dark' ? 'dark' : 'light';
      root.dataset.theme = next;
      setTheme(next);
    }
    window.addEventListener('storage', syncStorage);
    return () => window.removeEventListener('storage', syncStorage);
  }, [root]);

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    setTheme(next);
    try { localStorage.setItem(storageKey, next); } catch {}
  }

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export function ThemeSwitch() {
  const { theme, toggle } = useContext(ThemeContext)!;
  return (
    <button
      className="theme-switch"
      type="button"
      aria-pressed={theme === 'dark'}
      aria-label="Тёмная тема"
      title={theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'}
      onClick={toggle}
    >
      <Icon name={theme === 'dark' ? 'moon' : 'sun'} />
      <span className="menu-label">Тема</span>
    </button>
  );
}
