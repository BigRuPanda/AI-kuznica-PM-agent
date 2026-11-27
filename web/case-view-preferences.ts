import type { MetricSeries, RatioSelections } from './team-data';

export type CaseViewPreferences = {
  cards: string[];
  pinned: string[];
  full: boolean;
  control: string | false;
  sourceQuery: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readCaseViewObject(key: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    if (isRecord(value)) return value;
  } catch {}
}

export function readCaseView(key: string): Partial<CaseViewPreferences> | undefined {
  const value = readCaseViewObject(key);
  if (!value) return;
  const list = (field: unknown): string[] | undefined =>
    Array.isArray(field) && field.every(item => typeof item === 'string') ? field : undefined;
  return {
    cards: list(value.cards),
    pinned: list(value.pinned),
    full: typeof value.full === 'boolean' ? value.full : undefined,
    control: typeof value.control === 'string' || value.control === false ? value.control : undefined,
    sourceQuery: typeof value.sourceQuery === 'string' ? value.sourceQuery.slice(0, 400) : undefined,
  };
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function readCasePeriod(key: string): { from?: string; through?: string } {
  const { from, through } = readCaseViewObject(key) || {};
  if ((from !== undefined && !isCalendarDate(from)) || (through !== undefined && !isCalendarDate(through)) ||
    (from && through && from > through)) return {};
  return { from, through };
}

function isSeriesId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 150;
}

function readMetricSeries(value: unknown): MetricSeries | undefined {
  if (!isRecord(value)) return;
  const { product, segment, sourceId, definitionId } = value;
  if (isSeriesId(product) && isSeriesId(segment) && isSeriesId(sourceId) && isSeriesId(definitionId))
    return { product, segment, sourceId, definitionId };
}

export function readCaseRatioSelections(key: string): RatioSelections {
  const saved = readCaseViewObject(key);
  const ctr = readMetricSeries(saved?.ctr), reach = readMetricSeries(saved?.reach);
  return { ...(ctr && { ctr }), ...(reach && { reach }) };
}

export function patchCaseView(key: string, patch: Partial<CaseViewPreferences>): void {
  try {
    const current = readCaseViewObject(key);
    localStorage.setItem(key, JSON.stringify({ ...current, ...patch }));
  } catch {}
}
