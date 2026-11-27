import { access, neighboring, readRange, readSnapshot, grant } from './chart-ranges.mjs';
import { analysisView, digest, fmt, listSales, productFamily as family } from './evidence.mjs';
import { materialForResult, readMaterial, sourceSection } from './materials.mjs';
import { DAY } from './import.mjs';
import { chartFindings, chartObservations } from './chart-focus.mjs';
import { aggregateMetric, normalizeObservation, observationKey } from './metric-observations.mjs';

const date = (ms) => new Date(ms).toISOString().slice(0, 10);
const metrics = [
  ['cfg_reach_rate', 'Открытие конфигуратора', 'configurator_visits', 'family_visits'],
  ['cfg_completion_rate', 'Завершение подбора', 'complete', 'open'],
  ['cfg_add_to_cart_rate', 'Добавление в корзину', 'add_to_cart', 'open'],
];
const devices = { desktop: 'Компьютеры', mobile: 'Телефоны', tablet: 'Планшеты' };
export const newTopic = (q) =>
  /(?:сменим тему|друг(?:ая|ой|ую) (?:тем[ау]|вопрос)|перейд[её]м к|забудь выделение)|^(?:что такое|что означает|объясни термин)\s+(?!эт)|^(?:привет|спасибо)[!.? ]*$/iu.test(
    q.trim(),
  );
export const resetsChartTopic = (q) => newTopic(q) && !/^(?:привет|спасибо)[!.? ]*$/iu.test(q.trim());
export const screenRequest = (q) =>
  /с экран[а-я]*|на экран[еа]|открыт[а-я]* (?:расч[её]т|срез)|повтори показател/i.test(q);
export function rangeComparisonText(range) {
  const lines = range.periods.flatMap((period, index) => period.series.map((row) => {
    const label = (index ? 'B' : 'A') + ' · ' + row.key + ': ';
    const measured = row.value == null ? row.reason || 'Нет наблюдений' : fmt(row.value) + ' ' + range.unit;
    return label + measured + ' (' + row.available + ' из ' + period.expected + ')';
  }));
  for (const change of range.differences || []) {
    if (Number.isFinite(change.absolute))
      lines.push('Изменение B относительно A · ' + change.key + ': ' + fmt(change.absolute) +
        (range.unit === '%' ? ' п.п.' : ' ' + range.unit));
  }
  return [...lines, 'Причину изменения нужно отдельно сверить с релизами и исследованиями.'].join('\n');
}

export function researchIntent(q) {
  if (/^(?:что (?:такое|означает|значит)|как (?:посчитать|рассчитать))\s/iu.test(q.trim())) return {};
  const chart =
    /график|покажи динамику|построй динамику|визуализируй|диаграмм/i.test(q) &&
    !/на этом графике|об этом графике/i.test(q);
  // The user delegated the choice. Prefer the real series on their current investigation.
  const representativeChart =
    chart &&
    /(?:показательн|информативн|наглядн|главн|ключев)[а-яё]*\s+(?:график|диаграмм)[а-яё]*(?=\s+(?:и\s|для этого разбора)|\s*[.!?,…]|\s*$)/iu.test(
      q,
    ) &&
    !/\b(?:cfg_|ctr\b)|воронк|корзин|визит|трафик|конверси|выручк|медиан|скорост/i.test(q);
  const funnel =
    /воронк|завершени[еяй].{0,16}подбор|теряем пользовател|шаг[аиу]?.{0,12}конфигуратор|добавлени[еяй].{0,10}корзин/i.test(
      q,
    );
  const report =
    /разберись|разбери|расслед|почему|причин|гипотез|опроверг|проверь|исследуй|сравни/i.test(q) ||
    (funnel && !chart);
  return {
    chart,
    representativeChart,
    report,
    funnel,
    analytical:
      chart ||
      report ||
      funnel ||
      /посчитай|скажи.{0,12}(индекс|конверси)|продаж|показател[ия].{0,15}период/i.test(q),
  };
}

function frozenSources(db, view) {
  const versions = view.metricVersions || [
    ...new Set(
      [
        ...(view.summary || []).flatMap((s) => s.rows.map((r) => r.version)),
        ...(view.points || []).map((p) => p.version),
      ].filter(Boolean),
    ),
  ];
  const rows = new Map(),
    releases = new Map();
  const releaseVersions = new Set(view.releaseVersions || versions);
  const metricVersions = new Set(versions);
  const docs = db.prepare(`SELECT version,body FROM documents
    WHERE version IN (SELECT value FROM json_each(?)) ORDER BY rowid`);
  for (const {version, body} of docs.iterate(JSON.stringify([...new Set([...versions, ...releaseVersions])]))) {
    const { file, facts } = JSON.parse(body);
    for (const f of facts) {
      if (f.kind === 'releases' && f.row && releaseVersions.has(version))
        releases.set(f.row.release_id, { ...f.row, source: file + ' · ' + f.loc });
      if (f.kind === 'metrics' && f.row && metricVersions.has(version)) {
        const r = normalizeObservation(f.row, file);
        if ((view.sourceId && view.sourceId !== r.source_id && view.sourceId !== r.combine_group) ||
            (view.definitionId && view.definitionId !== r.definition_id)) continue;
        rows.set(observationKey(r), {
          ...r,
          selectedSource: view.sourceId,
          version,
          source: file + ' · ' + f.loc,
        });
      }
    }
  }
  return { rows: [...rows.values()], releases: [...releases.values()] };
}

function measure(rows, period, metric, segment) {
  const agg = aggregateMetric(rows, metric[0], { segment, from: date(period.from),
    through: date(period.to - 1), sourceId: rows[0]?.selectedSource });
  return {
    n: agg.n,
    d: agg.d,
    days: agg.d == null ? 0 : agg.dates.length * agg.stepDays,
    expected: (period.to - period.from) / DAY,
    percent: agg.value,
    reason: agg.reason,
    sources: agg.selectedRows.map(r => r.source),
  };
}
function intervalRows(rows, metric, periods) {
  return rows.filter(r => {
    if (r.metric_id !== metric) return false;
    const start = Date.parse(r.date), end = start + r.step_days * DAY;
    return periods.some(p => start >= p.from && end <= p.to);
  });
}
function measurePeriods(rows, periods, metric, segment) {
  const scoped = intervalRows(rows, metric[0], periods);
  const comparison = aggregateMetric(scoped, metric[0], {segment, sourceId: rows[0]?.selectedSource});
  if (comparison.choices.length) {
    return periods.map(p => ({days:0, expected:(p.to - p.from) / DAY, percent:null,
      reason:comparison.reason, sources:[]}));
  }
  return periods.map(p => measure(rows, p, metric, segment));
}
const measured = (v) =>
  v.days
    ? (v.percent == null ? 'Нет знаменателя' : fmt(v.percent) + '%') + ' (' + v.n + '/' + v.d + ')'
    : v.reason || 'Нет наблюдений';
const coverage = (v) => v.days + ' из ' + v.expected + ' дн.';

function funnelSections(rows, periods, product) {
  const segmentKeys = [...new Set(rows.map((r) => r.segment).filter((s) => s in devices))];
  const sections = [],
    findings = [];
  for (const metric of metrics) {
    const table = [],
      sources = new Set();
    for (const key of [null, ...segmentKeys]) {
      const values = measurePeriods(rows, periods, metric, key);
      table.push([
        key ? devices[key] : 'Все устройства',
        ...values.map((v) => measured(v) + ' · ' + coverage(v)),
      ]);
      values.forEach((v) => v.sources.forEach((s) => sources.add(s)));
      if ((!key || metric[0] === 'cfg_completion_rate') && values.some((v) => v.days))
        findings.push(
          (key ? devices[key] + ' · ' : product + ' · ') +
            metric[1] +
            ' — ' +
            values.map(measured).join(' → ') +
            '.',
        );
    }
    sections.push({
      title: metric[1],
      columns: ['Устройство', ...periods.map((_, i) => (i ? 'B' : 'A'))],
      rows: table,
      sources: [...sources],
    });
  }
  const stepRows = rows.filter((r) => r.metric_id === 'cfg_step_dropoff');
  const stepTable = [],
    losses = [];
  for (const [i, p] of periods.entries()) {
    const weeks = stepRows.filter((r) => r.date >= date(p.from) && Date.parse(r.date) + 7 * DAY <= p.to);
    const steps = [...new Set(weeks.flatMap((r) => Object.keys(r.details.visits_reached_step || {})))].sort(
      (a, b) => Number(a) - Number(b),
    );
    for (const step of steps) {
      let reached = 0,
        before = 0,
        count = 0;
      for (const r of weeks) {
        const s = r.details.visits_reached_step;
        if (!Number.isFinite(s?.[step]) || (Number(step) > 1 && !Number.isFinite(s[Number(step) - 1])))
          continue;
        reached += s[step];
        before += s[Number(step) - 1] ?? s[step];
        count++;
      }
      stepTable.push([
        i ? 'B' : 'A',
        step,
        String(reached),
        Number(step) === 1 ? '—' : String(before - reached),
        String(count),
      ]);
      if (count && before > 0 && Number(step) > 1) losses.push({ period: i, step, before, reached, count });
    }
  }
  sections.push({
    title: 'Достижение шагов',
    columns: ['Период', 'Шаг', 'Дошли', 'Потеря от прошлого шага', 'Недель'],
    rows: stepTable,
    text: stepTable.length
      ? 'Потери рассчитаны по неделям, где зарегистрированы оба соседних шага.'
      : 'Для этого продукта нет наблюдений по шагам.',
    sources: stepRows
      .filter((r) => periods.some((p) => r.date >= date(p.from) && r.date < date(p.to)))
      .map((r) => r.source),
  });
  const last = losses
    .filter((x) => x.period === periods.length - 1)
    .sort((a, b) => b.before - b.reached - (a.before - a.reached))[0];
  if (last)
    findings.push(
      'Наибольшая наблюдаемая потеря визитов в последнем периоде — переход с шага ' +
        (Number(last.step) - 1) +
        ' на ' +
        last.step +
        ': ' +
        last.before +
        ' → ' +
        last.reached +
        ' за ' +
        last.count +
        ' нед.',
    );
  const changes = segmentKeys
    .map((key) => {
      const values = measurePeriods(rows, periods, metrics[1], key);
      return { key, values };
    })
    .filter((x) => x.values.length === 2 && x.values.every((v) => v.percent != null));
  if (changes.length > 1) {
    sections.push({
      title: 'Альтернативное объяснение · состав устройств',
      text: 'Сравнение внутри каждого устройства помогает отличить изменение конверсии от изменения состава открытий.',
      columns: ['Устройство', 'Изменение завершения, п.п.', 'Открытия A', 'Открытия B'],
      rows: changes.map(({ key, values: [a, b] }) => [
        devices[key],
        fmt(b.percent - a.percent),
        String(a.d),
        String(b.d),
      ]),
    });
  }
  return { sections, findings };
}

function funnelChart(db, user, b, rows, metric, periods, product, segment) {
  const byDate = new Map();
  const scoped = intervalRows(rows, metric[0], periods);
  const limits = {segment, sourceId: rows[0]?.selectedSource};
  const selected = aggregateMetric(scoped, metric[0], limits);
  for (const r of selected.selectedRows) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }
  if (!byDate.size) return null;
  const points = [...byDate.entries()].map(([date, group]) => {
    const result = aggregateMetric(group, metric[0], limits);
    const sources = group.map(({source, version}) => ({source, version}));
    return {date, value:result.value == null ? null : result.value / 100,
      numerator:result.n, denominator:result.d, reason:result.reason, combineMembers:result.combineMembers,
      details:{[metric[2]]:result.n,[metric[3]]:result.d}, sources,
      source:sources.map(r => r.source).join(', '), version:sources[0].version,
      partial:group.some(r => r.partial || /неполн/i.test(r.comment || ''))};
  });
  if (!points.some(p => Number.isFinite(p.value))) return null;
  for (const p of periods)
    for (const at of selected.stepDays === 1 ? [p.from, p.to - DAY] : []) {
      if (!points.some((row) => row.date === date(at)))
        points.push({ date: date(at), value: null, details: {}, source: 'Нет наблюдений' });
    }
  points.sort((a, b) => a.date.localeCompare(b.date));
  const v = {
    kind: 'metric-chart',
    metric: metric[0],
    title: metric[1] + ' · ' + product + (segment ? ' · ' + devices[segment] : ''),
    product,
    segment: segment || 'Все устройства',
    step: DAY * selected.stepDays,
    sourceId: selected.sourceId,
    definitionId: selected.definitionId,
    unit: 'ratio',
    points,
    metricVersions: [...new Set(rows.map((r) => r.version))],
  };
  const raw = JSON.stringify(v),
    id = digest(raw);
  db.prepare('INSERT OR IGNORE INTO evidence_calcs VALUES(?,?)').run(id, raw);
  grant(db, id, 'thread', b.thread);
  const values = measurePeriods(rows, periods, metric, segment);
  return materialForResult(
    db,
    user,
    b.thread,
    { calc: id, title: v.title, ranges: periods },
    values.map((v, i) => (i ? 'B' : 'A') + ' · ' + measured(v) + ' · ' + coverage(v)).join('\n'),
  );
}

export function prepareResearch(store, user, b, history, job, intent = researchIntent(b.question)) {
  const db = store.db;
  if (!intent.analytical || /черновик|подготовь задач|опубликуй/i.test(b.question)) return null;
  const cached = job && db.prepare('SELECT body FROM job_research WHERE job=?').get(job);
  if (cached) return JSON.parse(cached.body);
  const previous = !newTopic(b.question) && history.findLast((m) => m.body.rangeId || m.body.contextReset);
  const attached = b.materialIds?.length ? readMaterial(db, user, b.materialIds[0]) : null;
  const rangeId = b.rangeId || (!attached && previous?.body.rangeId);
  const shared = db.prepare('SELECT scope FROM conversations WHERE id=?').get(b.thread)?.scope === 'group';
  if (rangeId) access(db, user, rangeId, shared);
  const range = rangeId ? readRange(db, user, rangeId) : null;
  let sourceId = range?.calcId || attached?.plot?.base?.calcId || attached?.contextCalc || b.screen?.calc;
  let view;
  if (sourceId) {
    if (range?.source === 'release' || attached?.plot?.base?.source === 'release') return null;
    try {
      access(db, user, sourceId, shared);
      view = readSnapshot(db, user, sourceId);
    } catch {
      return null;
    } // A published interval can be narrower than its source.
  }
  const sales = [...new Set(listSales(db).map((s) => s.product))];
  const priorProduct =
    !newTopic(b.question) && history.findLast((m) => m.body.product || m.body.contextReset)?.body.product;
  const named = sales.find((p) => family(b.question).includes(family(p)));
  const product =
    range?.product ||
    attached?.product ||
    b.product ||
    named ||
    view?.product ||
    (b.caseId && db.prepare('SELECT product FROM cases WHERE id=?').get(b.caseId)?.product) ||
    priorProduct ||
    (sales.length === 1 && sales[0]);
  if (!product) return null;
  if (!view || (b.analysisPeriod && !range && !attached && !b.screen?.requested)) {
    view = analysisView(db, { product, caseId: b.caseId, full: b.screen?.full, ...b.analysisPeriod });
    grant(db, view.id, 'thread', b.thread);
    sourceId = view.id;
  }
  const periods =
    range?.ranges ||
    attached?.ranges ||
    (view.base && view.pivot && view.cut
      ? [
          { from: Date.parse(view.base), to: Math.min(Date.parse(view.pivot), Date.parse(view.cut) + DAY) },
          { from: Math.max(Date.parse(view.base), Date.parse(view.pivot) + 7 * DAY),
            to: Date.parse(view.cut) + (view.calendarPeriod ? DAY : 7 * DAY) },
        ].filter((p) => p.to > p.from)
      : view.points?.length
        ? [
            {
              from: Date.parse(view.points[0].date),
              to: Date.parse(view.points.at(-1).date) + (view.step || DAY),
            },
          ]
        : []);
  const sections = [],
    findings = [],
    children = [],
    checks = [];
  if (periods.length)
    sections.push({
      title: 'Периоды',
      text: periods.map((p, i) => (i ? 'B' : 'A') + ' · ' + date(p.from) + ' — ' + date(p.to - 1)).join('\n'),
    });
  const chartMetric = /корзин/i.test(b.question)
    ? metrics[2]
    : /охват|открыти/i.test(b.question)
      ? metrics[0]
      : metrics[1];
  let requestedChart = null,
    funnelAvailable = false;
  if (intent.funnel && periods.length) {
    const frozen = frozenSources(db, view);
    const rows = frozen.rows
      .filter((r) => metrics.some((m) => m[0] === r.metric_id) || r.metric_id === 'cfg_step_dropoff')
      .filter((r) => !view.full || !r.partial && !/неполн/i.test(r.comment || ''))
      .map((r) => ({ ...r, details: JSON.parse(r.detail_json || '{}') }));
    const selectedSegment = /мобильн|телефон/i.test(b.question)
      ? 'mobile'
      : /компьютер|десктоп/i.test(b.question)
        ? 'desktop'
        : /планшет/i.test(b.question)
          ? 'tablet'
          : view.kind === 'metric-chart' && view.segment in devices
            ? view.segment
            : undefined;
    const primary = rows.filter(
      (r) => family(r.product) === family(product) && (!selectedSegment || r.segment === selectedSegment),
    );
    const f = funnelSections(primary, periods, product);
    sections.push(...f.sections);
    findings.push(...f.findings);
    const earliest = periods.reduce((a, b) => (a.from < b.from ? a : b));
    const prior = { from: earliest.from - (earliest.to - earliest.from), to: earliest.from };
    const [preceding] = measurePeriods(primary, [prior, ...periods], chartMetric, selectedSegment);
    sections.push({
      title: 'Предшествующий период · ' + chartMetric[1],
      text:
        date(prior.from) +
        ' — ' +
        date(prior.to - 1) +
        ' · ' +
        measured(preceding) +
        ' · ' +
        coverage(preceding),
      sources: preceding.sources,
    });
    checks.push('Проверен предшествующий период воронки');
    const end = Math.max(...periods.map((p) => p.to));
    const events = frozen.releases
      .filter((e) => family(e.description) === family(product) && e.release_date <= date(end - 1))
      .sort((a, b) => b.release_date.localeCompare(a.release_date))
      .slice(0, 8);
    if (events.length)
      sections.push({
        title: 'Изменения продукта к окончанию проверки',
        columns: ['Дата', 'Изменение', 'Источник'],
        rows: events.map((e) => [e.release_date, e.description, e.source]),
        text: 'Совпадение дат и динамики само по себе не устанавливает причину.',
      });
    funnelAvailable = f.findings.length > 0 || f.sections.at(-1).rows.length > 0;
    checks.push('Проверены счётчики и покрытие этапов');
    requestedChart = funnelChart(db, user, b, primary, chartMetric, periods, product, selectedSegment);
    if (requestedChart) children.push(requestedChart);
    const peer = view.summary?.find((s) => family(s.product) !== family(product))?.product;
    if (peer) {
      const other = rows.filter((r) => family(r.product) === family(peer));
      sections.push({
        title: 'Сопоставимость с контролем · ' + peer,
        columns: ['Этап', 'Покрытие по периодам'],
        rows: metrics.map((m) => [m[1], measurePeriods(other, periods, m).map(coverage).join(' / ')]),
      });
    }
  }
  if (attached?.plot && !range && !intent.funnel) {
    requestedChart = { id: attached.id, kind: attached.kind, title: attached.title };
    children.push(requestedChart);
    findings.push(...chartFindings(attached, chartObservations(attached)));
    checks.push('Проверены значения обсуждаемого графика');
  } else if (range && !intent.funnel) {
    children.push(
      materialForResult(db, user, b.thread, { calc: range.id, source: 'range', title: range.title }),
    );
    for (const key of range.series)
      findings.push(
        key +
          ' — ' +
          range.periods.map((p) => fmt(p.series.find((s) => s.key === key)?.value)).join(' → ') +
          ' ' +
          range.unit +
          '.',
      );
  } else if (view.summary?.length && !intent.funnel) {
    const id = sourceId || view.id;
    grant(db, id, 'thread', b.thread);
    children.push(
      materialForResult(db, user, b.thread, {
        calc: id,
        cards: ['summary', 'trend'],
        title: 'Индекс заказов · ' + product,
      }),
    );
    findings.push(
      ...view.summary.map((s) => s.product + ' — ' + fmt(s.before) + ' → ' + fmt(s.after) + ' п. индекса.'),
    );
  }
  if (
    intent.chart &&
    !intent.funnel &&
    (intent.representativeChart ||
      /индекс|продаж|заказ/i.test(b.question) ||
      (range && !/ctr|выручк|медиан|скорост|сумм/i.test(b.question))) &&
    children[0]?.kind === 'chart' &&
    (!intent.representativeChart ||
      range ||
      view.summary?.some((s) => s.rows.some((row) => Number.isFinite(row.value))))
  )
    requestedChart = children[0];
  if (range) {
    const near = neighboring(store, user, range.id, shared);
    if (near.comparison) {
      grant(db, near.comparison.id, 'thread', b.thread);
      children.push(
        materialForResult(db, user, b.thread, {
          calc: near.comparison.id,
          source: 'range',
          title: 'Соседний период',
        }),
      );
      checks.push('Сопоставлен соседний период');
      sections.push({
        title: 'Значения в соседнем периоде',
        columns: ['С', 'По', 'Ряд', 'Значение', 'Наблюдений'],
        rows: near.comparison.periods.flatMap((p) =>
          p.series.map((s) => [date(p.from), date(p.to - 1), s.key, fmt(s.value), String(s.available)]),
        ),
      });
    }
  }
  if (view.timeline?.length)
    sections.push({
      title: 'События около сравнения',
      columns: ['Дата', 'Релиз', 'Источник'],
      rows: view.timeline.map((e) => [e.data.release_date, e.data.description, e.file + ' · ' + e.loc]),
    });
  if (view.evidence?.length) sections.push(sourceSection(view.evidence));
  if (view.gap) sections.push({ title: 'Ограничения измерения', text: view.gap });
  if (view.corrections?.length)
    sections.push({
      title: 'Поправки команды',
      text: view.corrections.map((c) => c.source + ' — ' + c.comment).join('\n'),
    });
  if (view.evidence || view.timeline) checks.push('Сверены источники и релизы');
  const result = {
    product,
    contextCalc: sourceId || view.id,
    intent,
    periods,
    findings,
    sections,
    children: children.filter(Boolean),
    checks,
    requestedChart,
    chartMetric: intent.funnel ? chartMetric[0] : undefined,
    funnelAvailable,
  };
  if (job) db.prepare('INSERT OR REPLACE INTO job_research VALUES(?,?)').run(job, JSON.stringify(result));
  return result;
}

export function researchContext(r) {
  if (!r) return undefined;
  return {
    product: r.product,
    periods: r.periods,
    findings: r.findings,
    checks: r.checks,
    evidence: r.sections.map(({ title, text, rows }) => ({ title, text, rows: rows?.slice(0, 12) })),
    chartReady: !!r.requestedChart,
    savedChart: r.requestedChart
      ? { title: r.requestedChart.title, metric: r.chartMetric, material: r.requestedChart.id }
      : undefined,
  };
}
