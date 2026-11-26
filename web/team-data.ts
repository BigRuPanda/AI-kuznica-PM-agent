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
export type Watch = { state: string; weeks?: number; actual?: number };
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
    watch?: unknown;
    plan?: { hypothesis: string; metric: string; baseline: string; control: string; success: string };
  };
  effect?: Watch;
};
export type Thread = { id: string; title: string; scope: string };
export type Source = { file: string; versions: number; updated: number };
export type Release = {
  release_id: string;
  release_date: string;
  description: string;
  related_task_ids: string;
};
export type Home = {
  issueMode: 'jira' | 'local';
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
  view: View;
  effect: Watch | null;
  backlog: Issue[];
  published: { id: string; user: string; body: { calc: string; cards: string[] } }[];
  drafts: {
    id: string;
    body: { title: string; description: string; key: string; priority: string };
    external: string;
    state: string;
  }[];
};
export type Msg = {
  seq: number;
  author: string;
  role: string;
  body: {
    text: string;
    calc?: string;
    caseId?: string;
    product?: string;
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
