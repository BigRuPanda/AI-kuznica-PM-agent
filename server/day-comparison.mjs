import { facts, fmt, listSales, metricStepDays, productFamily, digest } from './evidence.mjs';
import { DAY } from './import.mjs';
import { access, grant, readRange, readSnapshot } from './chart-ranges.mjs';
import { materialForResult, readMaterial, saveMaterial } from './materials.mjs';

const moscowDate = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const offset = (date, days) => iso(Date.parse(date) + days * DAY);
const months = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];
const durations = { два: 2, две: 2, двое: 2, двух: 2, три: 3, трёх: 3, четыре: 4, пять: 5, семь: 7 };
const duration =
  /(?:за\s+|последн(?:ие|их)\s+)(?:(?:последн\S*|доступн\S*|календарн\S*|полн\S*)\s+)*(\d+|два|две|двое|двух|три|трёх|четыре|пять|семь)\s+(?:(?:последн\S*|доступн\S*|календарн\S*|полн\S*)\s+)*(?:дня|дней|день|дн\.|суток|сутки|даты)(?![а-яё])/iu;
const alternatives = ['cfg_family_views', 'cfg_open', 'cfg_reach_rate'];
const names = {
  orders_index: 'Индекс заказов',
  cfg_family_views: 'Визиты на страницу семейства',
  cfg_open: 'Открытия конфигуратора',
  cfg_reach_rate: 'Доля открывших конфигуратор',
};
const devices = { desktop: 'Компьютеры', mobile: 'Телефоны', tablet: 'Планшеты', all: 'Все' };
const countDays = (n) =>
  n +
  ' ' +
  (n % 10 === 1 && n % 100 !== 11
    ? 'день'
    : n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14)
      ? 'дня'
      : 'дней');

export function explicitDates(q, year) {
  const pair = q.match(/(\d{1,2})\s*(?:–|—|-|и|по)\s*(\d{1,2})\s+([а-яё]+)(?:\s+(20\d\d))?/iu);
  const numeric = [...q.matchAll(/(?<!\d)(20\d\d-\d\d-\d\d|\d{1,2}\.\d{1,2}(?:\.20\d\d)?)(?!\d)/g)].map(
    (m) => {
      if (!m[1].includes('.')) return m[1];
      const [day, month, y] = m[1].split('.');
      return [y || year, month.padStart(2, '0'), day.padStart(2, '0')].join('-');
    },
  );
  if (numeric.length) return numeric;
  const build = (day, m, y) =>
    [y || year, String(months.indexOf(m) + 1).padStart(2, '0'), day.padStart(2, '0')].join('-');
  if (pair && months.includes(pair[3]))
    return [build(pair[1], pair[3], pair[4]), build(pair[2], pair[3], pair[4])];
  return [...q.matchAll(/(\d{1,2})\s+([а-яё]+)(?:\s+(20\d\d))?/giu)]
    .filter((m) => months.includes(m[2]))
    .map((m) => build(m[1], m[2], m[3]));
}

function requestWindow(q, previous, today) {
  if (/вчера\s+и\s+сегодня|сегодня\s+и\s+вчера/i.test(q))
    return { mode: 'explicit', count: 2, from: offset(today, -1), to: today };
  if (/позавчера\s+и\s+вчера/i.test(q))
    return { mode: 'explicit', count: 2, from: offset(today, -2), to: offset(today, -1) };
  const matched = q.match(duration),
    dates = explicitDates(q, today.slice(0, 4));
  if (!matched && dates.length !== 2 && /недел|месяц|квартал|часа|часов|год/.test(q)) return null;
  const available =
    /доступн\S*\s+(?:дат|дн|сут)|(?:дня|дней|даты)\s+(?:с данными|в данных)|последн\S*\s+(?:данн|доступн)/i.test(
      q,
    );
  const follow =
    previous && (/^(?:а |тогда |давай |покажи |возьми |по |да,? |только )/i.test(q) || available);
  if (!matched && dates.length !== 2 && !follow && !(available && previous)) return null;
  if (
    !matched &&
    !dates.length &&
    !available &&
    !/визит|открыти|охват|телефон|мобил|компьютер|индекс|десктоп|корзин/i.test(q)
  )
    return null;
  const count = matched ? Number(matched[1]) || durations[matched[1]] : previous?.count;
  if (dates.length) {
    if (
      dates.length === 1 &&
      count >= 2 &&
      count <= 3660 &&
      Number.isFinite(Date.parse(dates[0])) &&
      iso(Date.parse(dates[0])) === dates[0]
    ) {
      if (/(?:по|до)\s+\d/i.test(q)) dates.unshift(offset(dates[0], 1 - count));
      else if (/(?:^|\s)с\s+\d/i.test(q)) dates.push(offset(dates[0], count - 1));
    }
    const valid =
      dates.length === 2 && dates.every((d) => Number.isFinite(Date.parse(d)) && iso(Date.parse(d)) === d);
    const span = valid ? (Date.parse(dates[1]) - Date.parse(dates[0])) / DAY + 1 : 0;
    if (span < 2 || (matched && count !== span))
      return {
        error:
          'Не могу определить период сравнения. Укажите две даты в порядке возрастания и согласуйте их с числом дней.',
      };
    return { mode: 'explicit', count: span, from: dates[0], to: dates[1] };
  }
  if (!matched && !available) return previous;
  if (
    !count ||
    count < 2 ||
    count > 3660 ||
    months.some((m) => q.includes(m)) ||
    /рабочи|сравн.{0,35}(?:предыдущ|предшеств)|прошл\S*\s+(?:месяц|недел)/i.test(q)
  )
    return {
      error: 'Для такого сравнения нужно уточнить даты. За какие два дня или интервалы показать изменения?',
    };
  const to = /сегодня|включая текущий/i.test(q) ? today : offset(today, -1);
  return {
    mode: available ? 'available' : 'calendar',
    count,
    ...(!available && { from: offset(to, 1 - count), to }),
  };
}

export function explicitDayWindow(question, now) {
  return requestWindow(question.toLowerCase(), null, moscowDate.format(now));
}

function namedMetric(q, definitions) {
  const code = q.match(/\b(?:cfg_|lk_|family_|orders_)[a-z_]+\b/i)?.[0];
  if (code) return code === 'family_orders_idx' ? 'orders_index' : code;
  const definition = definitions.find((d) => d.metric_name && q.includes(d.metric_name.toLowerCase()));
  if (definition) return definition.metric_id === 'family_orders_idx' ? 'orders_index' : definition.metric_id;
  for (const [pattern, metric] of [
    [/индекс|заказ|продаж/, 'orders_index'],
    [/дол[яю].*откры|охват/, 'cfg_reach_rate'],
    [/открыти/, 'cfg_open'],
    [/визит|посещени/, 'cfg_family_views'],
    [/корзин/, 'cfg_add_to_cart_rate'],
    [/завершени/, 'cfg_completion_rate'],
    [/ctr/i, 'lk_reco_ctr'],
  ])
    if (pattern.test(q)) return metric;
}

function sourceChart(db, user, b, history, shared) {
  const prior = history.findLast((m) => m.role === 'assistant')?.body.dayComparison;
  const rangeId = b.rangeId || (!b.materialIds?.length && !b.screen?.calc && prior?.sourceRangeId);
  if (rangeId) {
    access(db, user, rangeId, shared);
    const r = readRange(db, user, rangeId);
    return {
      product: r.product,
      metric: r.metric,
      unit: r.unit,
      step: r.step,
      ranges: r.ranges,
      rangeId,
      lines: r.series.map((key) => ({ key, points: r.points[key] })),
    };
  }
  const previous = history.findLast(
    (m) => m.body.contextReset || m.body.focusMaterialId || m.body.materials?.some((x) => x.kind === 'chart'),
  )?.body;
  const id =
    b.materialIds?.[0] ||
    (!b.screen?.calc &&
      (prior
        ? prior.sourceMaterialId
        : !previous?.contextReset &&
          (previous?.focusMaterialId || previous?.materials?.find((x) => x.kind === 'chart')?.id)));
  if (id) {
    const m = readMaterial(db, user, id, shared);
    if (m.plot)
      return {
        product: m.product,
        metric: m.plot.base.metric,
        unit: m.plot.unit,
        step: m.plot.step,
        ranges: m.ranges,
        lines: m.plot.lines,
        id,
      };
  }
  if (b.screen?.calc) {
    access(db, user, b.screen.calc, shared);
    const v = readSnapshot(db, user, b.screen.calc);
    if (v.summary) return { product: v.product, metric: 'orders_index', step: 7 * DAY };
  }
}

function finish(group, from, to) {
  const a = group.days.get(from),
    b = group.days.get(to);
  const delta = a && b ? b.value - a.value : null;
  return {
    product: group.product,
    metric: group.metric,
    segment: group.segment,
    unit: group.unit,
    from,
    to,
    a: a?.value ?? null,
    b: b?.value ?? null,
    delta,
    relative: delta !== null && a.value !== 0 ? (100 * delta) / a.value : null,
    sources: [a?.source, b?.source].filter(Boolean),
  };
}
const signed = (n) => (n > 0 ? '+' : '') + fmt(n);

export function dayComparison(db, user, b, history, shared, now) {
  const q = b.question.toLowerCase();
  const last = history.findLast((m) => m.role === 'assistant')?.body;
  const prior = last?.dayComparison;
  const metricTask =
    /измен|сравн|динамик|показател|метрик|индекс|заказ|продаж|визит|посещени|открыти|конверси|охват|корзин|cfg_|lk_|ctr|график|срез/i.test(
      q,
    );
  if (!metricTask && !prior && !/попросил|просил|имел[аи]? в виду|^(?:нет,?\s*)?(?:за |последн)/i.test(q))
    return null;
  if (
    !b.requestedPeriod &&
    !duration.test(q) &&
    !prior &&
    !/вчера\s+и|и\s+вчера|\d\s*(?:[–—-]|и|по)\s*\d|\d[.-]\d|\d\s+[а-яё]+\s+(?:и|по|—|–)\s*\d/.test(q)
  )
    return null;
  // A deadline or a monitoring instruction is handled by the action workflow.
  if (/напомни|назначь|через\s+\d|отслеживай|подготовь (?:черновик|задачу)|создай задачу/i.test(q))
    return null;
  const when =
    now ||
    db.prepare('SELECT created FROM chat_items WHERE seq=? AND thread=?').get(b.questionSeq ?? -1, b.thread)
      ?.created ||
    Date.now();
  const today = moscowDate.format(when);
  let window = b.requestedPeriod || requestWindow(q, prior?.window, today);
  if (
    !window &&
    prior?.window &&
    !prior.product &&
    listSales(db).some(
      (s) => q.includes(s.product.toLowerCase()) || productFamily(s.product) === productFamily(q),
    )
  )
    window = prior.window;
  if (!window) return null;
  if (
    prior?.window?.count === window.count &&
    window.mode === 'calendar' &&
    /(?:я\s+)?(?:просил|попросил|имел[аи]?\s+в\s+виду)/i.test(q) &&
    !/сегодня|вчера|календарн|доступн/i.test(q)
  )
    window = prior.window;
  const base = { mode: 'daily', materials: [] };
  if (window.error) return { ...base, text: window.error, outcome: 'clarification' };
  const raw = facts(db, 'metrics'),
    definitions = facts(db, 'dictionary').map((f) => f.data);
  const products = [
    ...new Set([...listSales(db).map((s) => s.product), ...raw.map((f) => f.data.product)].filter(Boolean)),
  ];
  const namedProducts = products.filter(
    (p) =>
      q.includes(p.toLowerCase()) ||
      (/(?:каспер|kaspersky)/i.test(q) && productFamily(p) === 'kaspersky') ||
      (/(?:астр|astra)/i.test(q) && productFamily(p) === 'astra'),
  );
  if (new Set(namedProducts.map(productFamily)).size > 1)
    return {
      ...base,
      dayComparison: { window },
      outcome: 'clarification',
      text: 'Для какого семейства посчитать изменение первым? В запросе указано несколько продуктов.',
    };
  const chart = sourceChart(db, user, b, history, shared);
  const product =
    namedProducts[0] ||
    chart?.product ||
    prior?.product ||
    (b.caseId && db.prepare('SELECT product FROM cases WHERE id=?').get(b.caseId)?.product) ||
    last?.product ||
    (products.length === 1 ? products[0] : null);
  if (!product)
    return {
      ...base,
      text: 'Для сравнения по дням нужен продукт. Укажите семейство и показатель.',
      outcome: 'clarification',
      dayComparison: { window, metric: namedMetric(q, definitions) },
    };
  const same = (p) => p && productFamily(p) === productFamily(product);
  const metric = /все дневные показатели|доступные дневные показатели/.test(q)
    ? null
    : namedMetric(q, definitions) ||
      (b.materialIds?.length && same(chart?.product) && chart.metric) ||
      (prior && (!prior.product || same(prior.product)) && prior.metric) ||
      (same(chart?.product) && chart.metric) ||
      (last?.calc && same(last.product) && 'orders_index') ||
      null;
  const segment = /мобил|телефон|mobile/.test(q)
    ? 'mobile'
    : /компьютер|десктоп|desktop/.test(q)
      ? 'desktop'
      : /планшет|tablet/.test(q)
        ? 'tablet'
        : same(prior?.product) && metric === prior.metric
          ? prior.segment
          : null;
  const label = (k) => definitions.find((d) => d.metric_id === k)?.metric_name || names[k] || k;
  const frozen =
    same(chart?.product) &&
    chart.metric === metric &&
    chart.step === DAY &&
    chart.lines &&
    (b.rangeId || b.materialIds?.length || !segment || chart.lines.some((l) => l.key === segment));
  const weekly =
    metric &&
    ((same(chart?.product) && metric === chart?.metric && chart.step > DAY) || metricStepDays(metric) > 1);
  const target = metric && !weekly ? [metric] : alternatives;
  const groups = new Map();
  function add(family, id, key, unit, date, value, partial, source, version, details) {
    if (!target.includes(id) || (segment && key !== segment)) return;
    const k = JSON.stringify([family, id, key]);
    if (!groups.has(k)) groups.set(k, { product: family, metric: id, segment: key, unit, days: new Map() });
    if (!partial && Number.isFinite(value)) groups.get(k).days.set(date, { value, source, version, details });
  }
  if (frozen) {
    for (const line of chart.lines)
      for (const p of line.points) {
        if (!chart.ranges?.length || chart.ranges.some((r) => p.at >= r.from && p.at < r.to))
          add(
            chart.product,
            metric,
            line.key,
            chart.unit,
            iso(p.at),
            p.value,
            p.partial,
            p.source,
            p.version,
            p.details,
          );
      }
  } else {
    for (const f of raw) {
      const r = f.data;
      if (!same(r.product) || metricStepDays(r.metric_id) !== 1) continue;
      add(
        r.product,
        r.metric_id,
        r.segment,
        r.unit === 'ratio' ? '%' : r.unit,
        r.date,
        r.unit === 'ratio' && Number.isFinite(r.value) ? 100 * r.value : r.value,
        /неполн/i.test(r.comment || ''),
        f.file + ' · ' + f.loc,
        f.version,
        r.detail_json,
      );
    }
  }
  const series = [...groups.values()];
  const latest = series.reduce(
    (max, g) => [...g.days.keys()].reduce((d, k) => (k <= today && k > d ? k : d), max),
    '',
  );
  let from = window.from,
    to = window.to;
  if (window.mode === 'available' && latest) {
    to = latest;
    from = offset(to, 1 - window.count);
  }
  const subject = label(metric || 'Дневные показатели') + ' · ' + product;
  const limits = [];
  if (weekly)
    limits.push(
      'Не могу рассчитать изменение за ' +
        countDays(window.count) +
        ' по показателю «' +
        label(metric) +
        '» для ' +
        product +
        ': источник хранит его по неделям.',
    );
  let comparisons = to ? series.map((g) => finish(g, from, to)) : [];
  const requested = comparisons;
  const hasPair = (rows) => rows.some((r) => r.delta !== null);
  if (!hasPair(requested)) {
    if (to)
      limits.push(
        'По ' +
          product +
          ' нет пары полных дневных наблюдений за ' +
          from +
          ' и ' +
          to +
          (metric && !weekly ? ' для показателя «' + label(metric) + '»' : '') +
          '.' +
          (latest ? ' Последняя доступная дата — ' + latest + '.' : ' Нужна дневная выгрузка за эти даты.'),
      );
    else limits.push('Для ' + subject + ' нет дневных наблюдений.');
    if (window.mode === 'calendar' && latest && latest < from) {
      to = latest;
      from = offset(to, 1 - window.count);
      comparisons = series.map((g) => finish(g, from, to));
    }
  }
  const rows = comparisons.filter((r) => r.a !== null || r.b !== null);
  if (hasPair(requested) && rows.some((r) => r.delta === null))
    limits.push(
      'Для части рядов отсутствует одно из двух значений. Изменение посчитано только по полным парам.',
    );
  if (rows.some((r) => r.a === 0 && r.b !== null))
    limits.push('Процентное изменение от нуля не определяется. Для таких рядов показана абсолютная разница.');
  if (/почему|причин|из-за чего|с чем связан/i.test(q))
    limits.push('По одному сравнению дневных значений причину изменения установить нельзя.');
  const caption =
    to &&
    (weekly || (to !== window.to && window.mode === 'calendar') ? 'Справочно. ' : '') +
      (weekly ? 'Дневные показатели · ' + product : subject) +
      ' · ' +
      from +
      ' → ' +
      to +
      (window.mode === 'available' || (window.mode === 'calendar' && to !== window.to)
        ? ' (последний доступный период).'
        : '.');
  const columns = ['Показатель', 'Сегмент', from, to, 'Разница', 'Изменение к первому дню'];
  const value = (v, unit) => (v === null ? 'Нет данных' : fmt(v) + (unit === '%' ? '%' : ''));
  const multipleProducts = new Set(rows.map((r) => r.product)).size > 1;
  const table = rows.map((r) => [
    label(r.metric) + (multipleProducts ? ' · ' + r.product : ''),
    devices[r.segment] || r.segment,
    value(r.a, r.unit),
    value(r.b, r.unit),
    r.delta === null ? 'Нет пары' : signed(r.delta) + (r.unit === '%' ? ' п.п.' : ''),
    r.relative === null ? '—' : signed(r.relative) + '%',
  ]);
  const text = [
    ...limits,
    rows.length && caption,
    rows.length &&
      [
        '| ' + columns.join(' | ') + ' |',
        '| --- | --- | --- | --- | --- | --- |',
        ...table.map((row) => '| ' + row.join(' | ') + ' |'),
      ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
  const evidence = {
    product,
    metric,
    segment,
    window,
    from,
    to,
    comparisons: rows,
    sourceMaterialId: frozen ? chart.id : undefined,
    sourceRangeId: frozen ? chart.rangeId : undefined,
  };
  const materials = [];
  if (rows.length && /график|динамик/i.test(q)) {
    for (const r of rows.filter((r) => r.delta !== null)) {
      const group = groups.get(JSON.stringify([r.product, r.metric, r.segment]));
      const points = [...group.days]
        .filter(([d]) => d >= from && d <= to)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, p]) => ({
          date,
          value: r.unit === '%' ? p.value / 100 : p.value,
          source: p.source,
          version: p.version,
          details: typeof p.details === 'string' ? JSON.parse(p.details) : p.details,
        }));
      const snap = {
        kind: 'metric-chart',
        title: label(r.metric) + ' · ' + r.segment,
        product: r.product,
        metric: r.metric,
        segment: r.segment,
        unit: r.unit === '%' ? 'ratio' : r.unit,
        step: DAY,
        points,
      };
      const raw = JSON.stringify(snap),
        id = digest(raw);
      db.prepare('INSERT OR IGNORE INTO evidence_calcs VALUES(?,?)').run(id, raw);
      grant(db, id, 'thread', b.thread);
      materials.push(
        materialForResult(db, user, b.thread, { calc: id, source: 'metric', title: snap.title }, caption),
      );
    }
  }
  if (table.length)
    materials.push(
      saveMaterial(db, b.thread, {
        kind: 'report',
        title: 'Дневное сравнение · ' + product,
        product,
        summary: [...limits, caption].filter(Boolean).join('\n'),
        sections: [
          {
            title: 'Значения и изменение',
            columns,
            rows: table,
            sources: [...new Set(rows.flatMap((r) => r.sources))],
          },
        ],
      }),
    );
  return {
    ...base,
    product,
    dayComparison: evidence,
    materials,
    text,
    outcome: weekly || !hasPair(requested) ? 'unavailable' : limits.length ? 'partial' : 'done',
  };
}
