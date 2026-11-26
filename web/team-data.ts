export type User = { id: string; name: string; login: string; role: string; space: string };
export type Signal = {
  rule: string;
  start: string;
  week: string;
  change: number | null;
  value: number;
  count: number;
  threshold: number;
};
export type Watch = { state: string; weeks: number; controlWeeks: number; start: string; end: string; actual?: number; ctrl?: number };
export type Case = {
  id: string;
  product: string;
  title: string;
  state: string;
  body: {
    signal?: Signal;
    owner?: string;
    origin?: { calc: string; cards: string[]; full: boolean };
    release?: string;
    watch?: { deployed: string; target: number; control: string };
    notes?: { author: string; created: number; text: string; rangeId?: string }[];
    plan?: { hypothesis: string; metric: string; baseline: string; control: string; success: string };
  };
  effect?: Watch;
};
export type Thread = { id: string; title: string; scope: string; canRename: boolean; canDelete: boolean };
export type Source = { file: string; versions: number; updated: number };
export type Release = {
  release_id: string;
  release_date: string;
  description: string;
  related_task_ids: string;
};
export type Home = {
  bridgeEnabled: boolean;
  integrations: Record<'redmine' | 'confluence', import('./tracking').Integration>;
  user: User;
  cases: Case[];
  threads: Thread[];
  sources: Source[];
  products: string[];
  rules: { threshold: number; recovery: number };
  releases: Release[];
  deliveries: { state: string; channel: string; n: number }[];
};
export type Sample = {
  week: string;
  value: number;
  partial: boolean;
  source: string;
  version: string;
  rolling?: number | null;
};
export type Comparison = {
  product: string;
  before: number | null;
  after: number | null;
  change: number | null;
  baseWeeks: number;
  weeks: number;
  rows: Sample[];
};
export type Evidence = {
  kind: string;
  key: string;
  source: string;
  data: string | { title?: string; description_short?: string; description?: string };
};
export type View = {
  id: string;
  product: string;
  base: string;
  pivot: string;
  cut: string;
  full: boolean;
  summary: Comparison[];
  timeline: { file: string; loc: string; data: Release }[];
  evidence: Evidence[];
  corrections: { source: string; comment: string; author: string }[];
  ctr: { n: number; d: number; sources: string[] };
  reach: { n: number; d: number; sources?: string[] };
  gap?: string;
  signal?: Signal;
};
export type Issue = { key: string; title: string; category: string; reason: string; source: string };
export type Detail = {
  case: Case;
  personal?: { revision?: string; cards: string[]; full?: boolean; control?: string; pin?: boolean };
  view: View;
  effect: Watch | null;
  backlog: Issue[];
  published: {
    id: string;
    user: string;
    body: { calc?: string; rangeId?: string; cards: string[]; conclusion?: string };
  }[];
  drafts: import('./tracking').TrackerPreview[];
};
export type Msg = {
  seq: number;
  author: string;
  role: string;
  body: {
    text: string;
    materials?: import('./materials').MaterialRef[];
    checks?: string[];
    jobId?: string;
    canResume?: boolean;
    mode?: string;
    outcome?: string;
    calc?: string;
    caseId?: string;
    product?: string;
    rangeId?: string;
    selection?: import('./range-chart').GraphSelection;
    suggestions?: { calc: string; cards: string[]; title: string; source?: string }[];
    actions?: {
      canConfirm?: boolean;
      similar?: { key: string; title: string }[];
      destination?: string;
      rangeId?: string;
      calc?: string;
      cards?: string[];
      op: string;
      id?: string;
      caseId?: string;
      title?: string;
      description?: string;
      conclusion?: string;
      key?: string;
      priority?: string;
      recipient?: string;
      state?: string;
      external?: string;
    }[];
    personal?: { caseId: string; cards: string[]; full?: boolean; control?: string; pin?: boolean };
    rounds?: number;
    steps?: string[];
    readSources?: { url: string; label: string }[];
    full?: boolean;
    sourceQuery?: string;
    cards?: string[];
    warning?: string;
  };
};
export async function post<T>(op: string, data: unknown = {}): Promise<T> {
  const r = await fetch('/api/team/' + op, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const v = await r.json();
  if (!r.ok) throw Error(v.error || 'Ошибка запроса');
  return v;
}
export const num = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
export function jump(path: string) {
  location.hash = path;
}
export const sourceText = (e: Evidence) =>
  typeof e.data === 'string' ? e.data : e.data.title || e.data.description || e.data.description_short || '';
