import { digest, fmt } from './evidence.mjs';
import { access, grant, readRange, readSnapshot } from './chart-ranges.mjs';
import { DAY } from './import.mjs';

export function initMaterials(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS materials(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS case_materials(user TEXT,case_id TEXT,material TEXT REFERENCES materials(id),PRIMARY KEY(user,case_id,material));
    CREATE TABLE IF NOT EXISTS material_case_requests(user TEXT,request TEXT,case_id TEXT,PRIMARY KEY(user,request));
    CREATE TABLE IF NOT EXISTS job_research(job TEXT PRIMARY KEY,body TEXT NOT NULL);`);
  if (!db.prepare("SELECT 1 FROM settings WHERE key='personal_material_access_v1'").get()) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const pin of db.prepare('SELECT DISTINCT user,material FROM case_materials').all())
        retainMaterial(db, pin.user, pin.material);
      db.exec(`INSERT OR IGNORE INTO snapshot_access
        SELECT json_extract(body,'$.origin.calc'),'user',json_extract(body,'$.owner') FROM cases
        WHERE json_type(body,'$.origin.calc')='text' AND json_type(body,'$.owner')='text';
        INSERT OR IGNORE INTO settings VALUES('personal_material_access_v1','true'); COMMIT`);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

// A personal pin keeps the frozen material tree, including nested charts. Its
// backing calculation can contain other private rows and has its own access rules.
export function retainMaterial(db, userId, materialId) {
  db.prepare(`WITH RECURSIVE tree(id) AS (
      SELECT id FROM materials WHERE id=?
      UNION
      SELECT json_extract(child.value,'$.id') FROM tree
        JOIN materials m ON m.id=tree.id JOIN json_each(m.body,'$.children') child
    ) INSERT OR IGNORE INTO snapshot_access(id,scope,ref)
      SELECT id,'user',? FROM tree WHERE id IS NOT NULL`).run(materialId, userId);
}

export function materialRef(id, m) {
  return { id, kind: m.kind, title: m.title };
}

export function saveMaterial(db, threadId, material) {
  const body = JSON.stringify(material),
    id = digest('material/v1/' + body);
  db.prepare('INSERT OR IGNORE INTO materials VALUES(?,?)').run(id, body);
  grant(db, id, 'thread', threadId);
  return materialRef(id, material);
}

export function readMaterial(db, user, id, shared = false) {
  access(db, user, id, shared);
  const row = db.prepare('SELECT body FROM materials WHERE id=?').get(id);
  if (!row) throw Error('Материал не найден');
  return { id, ...JSON.parse(row.body) };
}

export function materialPreview(m) {
  const plot = m.plot && {
    ...m.plot,
    lines: m.plot.lines.map((s) => ({
      key: s.key,
      points: s.points.map(({ at, value }) => ({ at, value })),
    })),
  };
  return { ...materialRef(m.id, m), product: m.product, plot };
}

export function attachedMaterials(db, user, ids = [], conversation, share = false) {
  if (!Array.isArray(ids) || ids.length > 8) throw Error('Можно приложить до восьми материалов');
  const sharedOnly = conversation.scope === 'group' && !share;
  const seen = new Map();
  function attach(id) {
    if (seen.has(id)) return seen.get(id);
    const m = readMaterial(db, user, id, sharedOnly);
    const ref = materialRef(id, m);
    seen.set(id, ref);
    for (const child of m.children || []) attach(child.id);
    grant(db, id, 'thread', conversation.id);
    return ref;
  }
  return [...new Set(ids)].map(attach);
}

// Publish exactly the visible chart rows. The backing case may contain private notes or other periods.
export function selectionForMaterial(db, user, id, selection, shared) {
  const m = readMaterial(db, user, id, shared),
    plot = m.plot;
  if (!plot || selection.calcId !== plot.base.calcId || plot.base.source === 'release') return selection;
  try {
    access(db, user, selection.calcId, shared);
    return selection;
  } catch {
    /* Only the material was shared. */
  }
  const base = plot.base;
  let snapshot;
  if (base.source === 'weekly') {
    snapshot = {
      product: m.product,
      base: '',
      pivot: '',
      cut: dateOf(Math.max(...plot.lines.flatMap((l) => l.points.map((p) => p.at)))),
      timeline: [],
      evidence: [],
      corrections: [],
      backlog: [],
      scopeLimited: true,
      full: false,
      metricVersions: [],
      summary: plot.lines.map((l) => ({
        product: l.key,
        rows: l.points.map((p) => ({
          week: dateOf(p.at),
          value: p.value,
          partial: p.partial,
          source: p.source || m.title,
        })),
      })),
    };
  } else {
    const r = JSON.parse(db.prepare('SELECT body FROM evidence_calcs WHERE id=?').get(base.calcId).body);
    const dates = new Set(plot.lines[0].points.map((p) => dateOf(p.at)));
    snapshot = {
      ...r,
      scopeLimited: true,
      metricVersions: [],
      points: r.points.filter((p) => dates.has(p.date)),
    };
  }
  const raw = JSON.stringify(snapshot),
    calcId = digest(raw);
  db.prepare('INSERT OR IGNORE INTO evidence_calcs VALUES(?,?)').run(calcId, raw);
  grant(db, calcId, 'user', user.id);
  if (shared) grant(db, calcId, 'thread', 'group');
  return { ...selection, ...base, calcId, version: calcId };
}
const dateOf = (time) => new Date(time).toISOString().slice(0, 10);

export function sourceSection(evidence = []) {
  return {
    title: 'Свидетельства',
    columns: ['Источник', 'Содержание'],
    rows: evidence.map((e) => [
      e.source,
      typeof e.data === 'string'
        ? [e.data, e.metadata?.hypothesis && ('Гипотеза «' + e.metadata.hypothesis + '» · ' + e.metadata.relation)].filter(Boolean).join('\n')
        : e.data?.description || e.data?.title || e.data?.description_short || '',
    ]),
  };
}

function chartFromSnapshot(v, id) {
  if (v.kind === 'metric-chart') {
    const ratio = v.unit === 'ratio';
    return {
      title: v.title,
      unit: ratio ? '%' : v.unit,
      step: v.step || DAY,
      base: { source: 'metric', metric: v.metric, calcId: id, version: id },
      lines: [
        {
          key: v.segment,
          points: v.points.map((p) => ({
            at: Date.parse(p.date),
            value: p.value == null ? null : p.value * (ratio ? 100 : 1),
            partial: p.partial,
            source: p.source,
          })),
        },
      ],
    };
  }
  if (v.summary?.length)
    return {
      title: 'Индекс заказов',
      unit: 'п. индекса',
      step: 7 * DAY,
      base: { source: 'weekly', metric: 'orders_index', calcId: id, version: id },
      lines: v.summary.map((s) => ({
        key: s.product,
        points: s.rows.map((r) => ({
          at: Date.parse(r.week),
          value: r.value,
          partial: r.partial,
          source: r.source,
        })),
      })),
    };
}

// Adapt only references which came from a stored assistant reply in an accessible conversation.
export function materialForResult(db, user, threadId, s, summary = '') {
  let plot,
    product,
    sections = [],
    title = s.title,
    ranges = s.ranges;
  if (s.source === 'range') {
    const r = readRange(db, user, s.calc);
    product = r.product;
    ranges = r.ranges;
    plot = {
      title: r.title,
      unit: r.unit,
      step: r.step,
      base: { source: r.source, calcId: r.calcId, version: r.version, metric: r.metric },
      lines: r.series.map((key) => ({ key, points: r.points[key] })),
    };
    sections.push({
      title: 'Выбранные периоды',
      columns: ['Период', 'Ряд', r.unit, 'Покрытие'],
      rows: r.periods.flatMap((p, i) =>
        p.series.map((row) => [i ? 'B' : 'A', row.key, fmt(row.value), row.available + '/' + p.expected]),
      ),
    });
  } else if (s.source === 'release') {
    const row = db.prepare('SELECT body FROM calculations WHERE id=?').get(s.calc);
    if (!row) return null;
    const c = JSON.parse(row.body);
    if (c.op !== 'build_chart') return null;
    title = c.result.title;
    plot = {
      title,
      unit: c.result.unit,
      step: DAY,
      base: { source: 'release', calcId: s.calc, version: c.context.version, metric: 'derived' },
      lines: [
        {
          key: 'all',
          points: c.result.daily.map((p, i) => ({ at: c.launch + c.result.days[i] * DAY, value: p.value })),
        },
      ],
    };
    sections.push({ title: 'Формула', text: c.result.formula });
  } else {
    const v = readSnapshot(db, user, s.calc);
    product = v.product;
    const cards = s.cards || [];
    if (v.kind === 'metric-chart' || cards.includes('trend') || cards.includes('summary') || !cards.length)
      plot = chartFromSnapshot(v, s.calc);
    if (v.summary && plot)
      sections.push({
        title: 'Сравнение периодов',
        columns: ['Продукт', 'До', 'После', 'Недель до / после'],
        rows: v.summary.map((x) => [x.product, fmt(x.before), fmt(x.after), x.baseWeeks + ' / ' + x.weeks]),
      });
    if (cards.includes('timeline'))
      sections.push({
        title: 'Релизы',
        columns: ['Дата', 'Событие', 'Источник'],
        rows: v.timeline.map((e) => [e.data.release_date, e.data.description, e.file + ' · ' + e.loc]),
      });
    if (cards.includes('evidence') || v.kind === 'evidence-search') sections.push(sourceSection(v.evidence));
    if (cards.includes('backlog'))
      sections.push({
        title: 'Задачи',
        columns: ['Задача', 'Название'],
        rows: (v.backlog || []).map((x) => [x.key, x.title]),
      });
    if (cards.includes('gap')) sections.push({ title: 'Ограничения', text: v.gap });
    for (const k of ['ctr', 'reach'])
      if (cards.includes(k) && v[k])
        sections.push({
          title: k === 'ctr' ? 'CTR рекомендаций' : 'Охват конфигуратора',
          text: fmt(v[k].n) + ' из ' + fmt(v[k].d),
          sources: v[k].sources,
        });
  }
  return saveMaterial(db, threadId, {
    kind: plot ? 'chart' : 'report',
    title: title || plot?.title || 'Сохранённый расчёт',
    product,
    summary,
    plot,
    ranges,
    sections,
    sourceId: s.calc,
  });
}

export function materialsFromReply(db, user, threadId, body) {
  const suggestions = [...(body.suggestions || [])];
  if (body.calc && !suggestions.some((s) => s.calc === body.calc))
    suggestions.push({
      calc: body.calc,
      cards: body.cards,
      title: 'Расчёт · ' + (body.product || 'показатели'),
    });
  if (body.rangeId && !suggestions.some((s) => s.calc === body.rangeId))
    suggestions.push({ calc: body.rangeId, source: 'range', title: 'Выделенный участок' });
  const refs = [];
  for (const s of suggestions) {
    try {
      const ref = materialForResult(db, user, threadId, s, body.text);
      if (ref && !refs.some((x) => x.id === ref.id)) refs.push(ref);
    } catch (e) {
      if (!/недоступен|не найден/.test(e.message)) throw e;
    }
  }
  return refs;
}

export function telegramParts(result, base) {
  const plain = result.text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
  const links = (result.materials || []).map(
    (m) => m.title + '\n' + base.replace(/\/$/, '') + '/#material/' + m.id,
  );
  for(const source of result.readSources || []) {
    if (/^https?:\/\//i.test(source.url) || /^#(?:knowledge-source|range|material)\//.test(source.url)) {
      links.push(source.label+'\n'+new URL(source.url,base).href);
    }
  }
  const parts = [];
  let chunk = '';
  for (const token of [plain, ...links].join('\n\n').match(/\s+|\S+/gu) || []) {
    if (chunk && chunk.length + token.length > 3900) {
      parts.push(chunk);
      chunk = '';
    }
    for (const char of token) {
      if (chunk.length + char.length > 3900) {
        parts.push(chunk);
        chunk = '';
      }
      chunk += char;
    }
  }
  if (chunk) parts.push(chunk);
  return parts;
}
