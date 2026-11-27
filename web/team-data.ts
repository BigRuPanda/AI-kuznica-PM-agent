export type User = { id: string; name: string; login: string; role: string; space: string };
export type SignalWeekEvidence = {
  week: string;
  n: number;
  d: number;
  rows: { date: string; segment?: string; n?: number; d?: number; sourceId?: string; source: string; version: string }[];
};
export type Signal = {
  status?: 'provisional' | 'confirmed' | 'withdrawn';
  revision?: number;
  rule: string;
  metric?: string;
  segment?: string;
  source?: string;
  sourceId?: string;
  definitionId?: string;
  stepDays?: number;
  evidence?: { baseline: SignalWeekEvidence[]; latest: SignalWeekEvidence };
  minDenominator?: number;
  releaseId?: string;
  changeUnit?: string;
  n?: number;
  d?: number;
  baseN?: number;
  baseD?: number;
  baseValue?: number;
  baselineFrom?: string;
  baselineThrough?: string;
  start: string;
  week: string;
  change: number | null;
  value: number;
  count: number;
  threshold: number;
};
export type Measurement = {
  metric: string; product?: string; segment?: string; sourceId?: string; definitionId?: string;
  control?: string; controlSegment?: string; controlSourceId?: string; controlDefinitionId?: string; unit?: string;
  baselineFrom?: string; baselineThrough?: string; comparison: 'gte' | 'lte';
  targetMode: 'absolute' | 'baseline_percent'; targetValue: number; minDenominator?: number;
};
export type WatchSample = {
  value: number | null; n?: number | null; d?: number | null; sourceId?: string;
  definitionId?: string; sources?: string[]; versions: string[];
};
export type MeasurementAgreement = {
  id: string; runId: string; signalRevision: number; target: number; tolerance: number;
  baseline: WatchSample; controlBaseline?: WatchSample;
};
export type WatchPlan = {
  deployed: string; target: number; control?: string; revision?: number; measurement?: Measurement;
  baseline?: WatchSample; controlBaseline?: WatchSample; tolerance?: number;
  agreementId?: string; signalRevision?: number;
};
export type Watch = {
  state: string; reason?: string; weeks: number; controlWeeks: number; start?: string; end?: string;
  actual?: number | null; ctrl?: number | null; unit?: string; metric?: string; target?: number;
  sample?: WatchSample; peer?: WatchSample;
};
export type Monitoring = { plan: WatchPlan; result: Watch };
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
    watch?: WatchPlan;
    watchHistory?: { revision: number; calc: string; deployed: string }[];
    notes?: { author: string; created: number; text: string; rangeId?: string }[];
    plan?: {
      hypothesis?: string; metric?: string; baseline?: string; control?: string; success?: string;
      measurement?: Measurement; measurementAgreement?: MeasurementAgreement;
    };
  };
  effect?: Watch;
};
export type Thread = { id: string; title: string; scope: string; caseId: string | null; canRename: boolean; canDelete: boolean };
export type Source = { file: string; versions: number; updated: number };
export type Release = {
  release_id: string;
  release_date: string;
  description: string;
  related_task_ids: string;
};
export type Home = {
  integrations: Record<'redmine' | 'confluence', import('./tracking').Integration>;
  user: User;
  cases: Case[];
  threads: Thread[];
  sources: Source[];
  metrikaSync?: import('./metrika-status').MetrikaStatus;
  products: string[];
  rules: { threshold: number; recovery: number };
  releases: Release[];
  notificationsEnabled: boolean;
  notificationChannels: string[];
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
  metadata?: {question?: string; hypothesis?: string; relation?: string; date?: string};
  data: string | { title?: string; description_short?: string; description?: string };
};
export type MetricSeries = { product: string; segment: string; sourceId: string; definitionId: string };
export type MetricChoice = MetricSeries & { metric: string; stepDays: number; unit: string };
export type RatioSelections = Partial<Record<'ctr' | 'reach', MetricSeries>>;
type RatioCard = { n: number | null; d: number | null; reason?: string; choices?: MetricChoice[]; selection?: Partial<MetricSeries> };
export type View = {
  id: string;
  product: string;
  base: string;
  pivot: string;
  cut: string;
  calendarPeriod?: boolean;
  requested?: { from?: string; through?: string; releaseWeek?: string };
  full: boolean;
  summary: Comparison[];
  timeline: { file: string; loc: string; data: Release }[];
  evidence: Evidence[];
  corrections: { source: string; comment: string; author: string }[];
  ctr: RatioCard & { sources: string[] };
  reach: RatioCard & { sources?: string[] };
  gap?: string;
  signal?: Signal;
  monitoring?: Monitoring;
};
export type Issue = { key: string; title: string; category: string; reason: string; source: string };
export type InvestigationSource = { label: string; calcId?: string; findingId?: string; url?: string };
export type InvestigationHypothesis = {
  title: string; for: string[]; against: string[]; test: string;
  sourceRefs?: { for: InvestigationSource[]; against: InvestigationSource[] };
};
export type InvestigationResult = {
  summary: string; action: string; plan: string; outcomes: string[];
  hypotheses: InvestigationHypothesis[]; issueQuery?: string; issueSourceKey?: string;
};
export type InvestigationCheck = {
  role: string; question: string; status: string; result: string; impact: string; period?: string;
  sources: InvestigationSource[];
};
export type InvestigationRun = {
  id: string; caseId: string; revision: number | string; owner: string | null; mode: string;
  status: 'queued' | 'running' | 'waiting' | 'retry' | 'ready' | 'superseded';
  reason?: string; question?: string; parentId?: string; published?: boolean; publishedBy?: string;
  result?: InvestigationResult | null; checks: InvestigationCheck[]; calcId?: string;
  period?: string; unit?: string; created?: number; summary?: string;
  measurementContext?: Pick<Measurement, 'baselineFrom' | 'baselineThrough' | 'control'>;
};
export type InvestigationBundle = { current: InvestigationRun | null; alternatives: InvestigationRun[]; history: InvestigationRun[] };
export type Detail = {
  case: Case;
  investigation?: InvestigationBundle;
  signalHistory?: {
    revision: number;
    created: number;
    status: NonNullable<Signal['status']>;
    event: 'confirmed' | 'corrected' | 'withdrawn' | null;
    metric: string | null;
    week: string;
    value: number;
    imported: { file: string; version: string }[];
  }[];
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
