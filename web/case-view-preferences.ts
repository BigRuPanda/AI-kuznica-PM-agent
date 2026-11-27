export type CaseViewPreferences = {
  cards: string[];
  pinned: string[];
  full: boolean;
  control: string;
  sourceQuery: string;
};

export function readCaseViewObject<T extends object>(key: string): Partial<T> | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {}
}

export function readCaseView(key: string): Partial<CaseViewPreferences> | undefined {
  const value = readCaseViewObject<CaseViewPreferences>(key);
  if (!value) return;
  const list = (field: unknown): string[] | undefined =>
    Array.isArray(field) && field.every(item => typeof item === 'string') ? field : undefined;
  return {
    cards: list(value.cards),
    pinned: list(value.pinned),
    full: typeof value.full === 'boolean' ? value.full : undefined,
    control: typeof value.control === 'string' ? value.control : undefined,
    sourceQuery: typeof value.sourceQuery === 'string' ? value.sourceQuery : undefined,
  };
}

export function patchCaseView(key: string, patch: Partial<CaseViewPreferences>): void {
  try {
    const current = readCaseViewObject<CaseViewPreferences>(key);
    localStorage.setItem(key, JSON.stringify({ ...current, ...patch }));
  } catch {}
}
