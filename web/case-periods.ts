import { num } from './team-data';
import type { Case, Signal, View } from './team-data';

const day = 86_400_000;
const week = 7 * day;
const formatDate = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
});

function dateValue(iso: string) {
  return Date.parse(iso + 'T00:00:00Z');
}

function period(start: number, end: number) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return '—';
  return start === end ? formatDate.format(start) : formatDate.formatRange(start, end);
}

export function signalPeriod(signal: Signal) {
  const latest = dateValue(signal.week);
  if (signal.rule !== 'relative') return period(latest, latest + 6 * day);
  return period(latest - 3 * week, latest + 6 * day);
}

export function signalEvidenceWeek(start: string) {
  const first = dateValue(start);
  return period(first, first + 6 * day);
}

export function signalBaseline(signal: Signal) {
  if (signal.baselineFrom && signal.baselineThrough) return period(dateValue(signal.baselineFrom),dateValue(signal.baselineThrough));
  const latest = dateValue(signal.week);
  return period(latest - 15 * week, latest - 3 * week - day);
}

export function analysisPeriods(view: View) {
  const pivot = dateValue(view.pivot);
  const start = dateValue(view.base);
  const end = dateValue(view.cut) + (view.calendarPeriod ? 0 : 6 * day);
  return {
    before: period(start, Math.min(pivot - day, end)),
    after: period(Math.max(start, pivot + week), end),
  };
}

export function changeLabel(change: number | null, unit = '%') {
  return change == null ? '—' : (change > 0 ? '+' : '') + num(change) + (unit === '%' ? unit : ' ' + unit);
}

export function caseHeading(item: Case) {
  const suffix = ' · ' + item.product;
  return item.body.signal && item.title.endsWith(suffix) ? item.title.slice(0, -suffix.length) : item.title;
}
