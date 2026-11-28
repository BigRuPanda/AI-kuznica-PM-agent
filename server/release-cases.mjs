import { z } from 'zod/v4';
import { digest } from './evidence.mjs';
import { syncInvestigations } from './case-investigations.mjs';
import { matchedProducts, released } from './release-decision.mjs';
import { legacyOrderMetric, measuredSignal } from './watch-measurement.mjs';

const field = z.string().min(1).max(150);
const releaseCaseInput = z.object({ releaseId: field, product: field.optional(), metric: field.optional() });
const releaseCaseId = releaseId => digest(JSON.stringify(['release-case', releaseId]));

export function findReleaseCaseId(db, releaseId) {
  if (!releaseId) return null;
  return db.prepare('SELECT id FROM cases WHERE id=?').get(releaseCaseId(releaseId))?.id ?? null;
}

function releaseScope(db, releaseId) {
  const stored = db.prepare("SELECT body FROM facts WHERE kind='releases' AND key=?").get(releaseId);
  if (!stored) return null;
  const row = { data: JSON.parse(stored.body) };
  if (!released(row)) return null;
  const releaseDay = new Date(row.data.release_date + 'T00:00:00Z');
  if (!Number.isFinite(releaseDay.getTime()) || releaseDay.toISOString().slice(0, 10) !== row.data.release_date)
    return null;
  releaseDay.setUTCDate(releaseDay.getUTCDate() - (releaseDay.getUTCDay() + 6) % 7);

  const products = db.prepare(`SELECT DISTINCT json_extract(body,'$.product_family') AS product
    FROM facts WHERE kind='sales' AND product IS NOT NULL ORDER BY product`).all().map(row => row.product);
  const affected = String(row.data.affected_metrics || '').split(/[,;|]/u).map(id => id.trim()).filter(Boolean);
  const metrics = [...new Set(affected.map(id => legacyOrderMetric(id) ? 'orders_index' : id)
    .filter(id => id === 'orders_index' || measuredSignal(id)))];
  const canInferMetric = metrics.length > 0 || affected.length === 0;
  if (!metrics.includes('lk_reco_ctr') &&
    affected.some(id => id === 'lk_reco_click_visits' || id === 'lk_reco_viewed_visits'))
    metrics.push('lk_reco_ctr');
  const options = matchedProducts(row, products)
    .map(product => ({ product, metrics: metrics.length || product === 'ЛК' ? metrics : ['orders_index'] }))
    .filter(option => option.metrics.length);
  return { releaseWeek: releaseDay.toISOString().slice(0, 10), options, canInferMetric };
}

function defaultSelection({ options, canInferMetric }) {
  return canInferMetric && options.length === 1 && options[0].metrics.length === 1
    ? { product: options[0].product, metric: options[0].metrics[0] }
    : null;
}

export function releaseInvestigationInput(db, releaseId) {
  const scope = releaseScope(db, releaseId);
  const selection = scope && defaultSelection(scope);
  return selection && { releaseId, ...selection };
}

export function ensureReleaseCase(db, { releaseId, product, metric }) {
  const existing = findReleaseCaseId(db, releaseId);
  if (existing) return { caseId: existing };
  const scope = releaseScope(db, releaseId);
  if (!scope) throw Error('Выберите выпущенный релиз из календаря.');
  const { releaseWeek, options } = scope;
  if (!product && !metric) {
    const selection = defaultSelection(scope);
    if (!selection) return { caseId: null, options };
    ({ product, metric } = selection);
  }
  if (!options.some(option => option.product === product && option.metrics.includes(metric)))
    throw Error('Выберите продукт и метрику этого релиза.');

  const caseId = releaseCaseId(releaseId);
  db.prepare('INSERT INTO cases VALUES(?,?,?,?,?)').run(
    caseId, product, ('Разбор релиза ' + releaseId + ' · ' + product).slice(0, 240), 'Исследуем',
    JSON.stringify({ release: releaseId, responsible: 'Команда', plan: { metric }, period: { releaseWeek } }),
  );
  syncInvestigations(db, caseId);
  return { caseId };
}

export function openReleaseCase(store, input) {
  const params = releaseCaseInput.parse(input);
  return store.tx(() => ensureReleaseCase(store.db, params));
}
