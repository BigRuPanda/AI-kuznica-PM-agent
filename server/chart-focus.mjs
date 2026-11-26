import { access } from './chart-ranges.mjs';
import { DAY } from './import.mjs';
import { fmt } from './evidence.mjs';

const generic = new Set(
  'график графика графику графике графики диаграмма покажи почему такой такую этот этого этом здесь именно который какую'.split(
    ' ',
  ),
);
const words = (text) => [
  ...new Set(
    (
      text
        .toLowerCase()
        .replaceAll('ё', 'е')
        .match(/[\p{L}\d_]+/gu) || []
    )
      .filter((w) => w.length >= 3 && !generic.has(w))
      .map((w) => w.slice(0, 5)),
  ),
];
const pointer =
  /(?:^|\s)(?:этот|этом|этого|это|этой|он|она|его|ему|ней|здесь|тут)(?=[\s,.?!]|$)|^(?:а )?почему(?:\s+(?:так|график\s+так)(?=[\s?.!]|$)|[?!. ]*$)/iu;
const followUp = /график|диаграмм|крив[аяуюой]+|я (?:про|имел[аи]? в виду)|^(?:нет,?\s+)?про\s/iu;
const draw = /постро[йи]|нарисуй|визуализируй|(?:пришли|покажи|добавь|дай)[^.!?\n]{0,40}(?:график|диаграмм)|(?:покажи|пришли)\s+его/i;
export const asksToDraw = (q) => draw.test(q);

// Only references that had actually appeared in this conversation before this question qualify.
// Looking up references independently of the model's text window also works after a restart.
export function resolveChartFocus(db, user, b, shared) {
  const q = b.question.toLowerCase();
  const before = b.questionSeq ?? Number.MAX_SAFE_INTEGER;
  const rows =
    db.prepare(`SELECT body FROM chat_items WHERE thread=? AND COALESCE(json_extract(body,'$.inReplyTo'),seq) < ?
    AND (json_type(body,'$.focusMaterialId')='text' OR json_array_length(body,'$.materials')>0
      OR json_array_length(body,'$.chartChoices')>0 OR json_extract(body,'$.contextReset')=1 OR json_type(body,'$.rangeId')='text')
    ORDER BY COALESCE(json_extract(body,'$.inReplyTo'),seq) DESC,seq DESC LIMIT 128`);
  const ordinal = q.trim().match(/^(?:про\s+)?(перв|втор)(?:ый|ой|ую|ого)(?:\s+график)?[.!? ]*$/u);
  const referring = followUp.test(q) || pointer.test(q);
  if (b.materialIds?.length && (!referring || /сравни|сопостав|оба график|обоих|между ними/i.test(q))) return null;
  // In a correction the positive half names the intended chart ("не индекс, а про визиты").
  const subject = q.split(/я про\s+|,?\s+а (?:про\s+|именно\s+)?/iu).at(-1);
  const tokens = words(subject),
    groups = [];
  const namedMetric = subject.match(/\b(?:[a-z]+_[a-z_\d]+|ctr)\b/iu)?.[0];
  const segment = /десктоп|компьютер|desktop/i.test(subject)
    ? 'desktop'
    : /мобильн|телефон|mobile/i.test(subject)
      ? 'mobile'
      : null;
  const family = /каспер|kaspersky/i.test(subject)
    ? /каспер|kaspersky/i
    : /астр|astra/i.test(subject)
      ? /астр|astra/i
      : null;
  const previous =
    db.prepare(`SELECT json_extract(m.body,'$.title') title,json_extract(m.body,'$.product') product,
    json_extract(m.body,'$.plot.base.metric') metric,json_extract(m.body,'$.plot.base.calcId') calc,
    (SELECT group_concat(json_extract(value,'$.key'),' / ') FROM json_each(m.body,'$.plot.lines')) series,
    json_extract(m.body,'$.ranges') ranges,
    (SELECT json_extract(f.body,'$.metric_name') FROM facts f WHERE f.kind='dictionary' AND f.key=json_extract(m.body,'$.plot.base.metric')) label
    FROM materials m WHERE id=? AND json_extract(m.body,'$.kind')='chart'`);
  const seen = new Set();
  const references = new Map();
  const candidates=b.materialIds?.length ? [{body:JSON.stringify({chartChoices:b.materialIds})}] : rows.iterate(b.thread,before);
  for (const row of candidates) {
    const body = JSON.parse(row.body);
    if (!groups.length && !body.chartChoices?.length && (!referring || ordinal)) return null;
    const ids = body.chartChoices?.length
      ? body.chartChoices
      : body.focusMaterialId
        ? [body.focusMaterialId]
        : (body.materials || []).filter((m) => m.kind === 'chart').map((m) => m.id);
    const group = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      try {
        access(db, user, id, shared);
      } catch {
        continue;
      }
      const m = previous.get(id);
      if (!m) continue;
      if (namedMetric && !(m.metric || '').includes(namedMetric)) continue;
      if (segment && !(m.series || '').toLowerCase().includes(segment)) continue;
      if (family && !family.test(m.product || '')) continue;
      const signature = JSON.stringify([m.calc, m.series, m.ranges]);
      if (references.has(signature)) continue;
      const description = [m.title, m.label, m.metric, m.product, m.series].filter(Boolean).join(' ');
      const terms = new Set(words(description));
      const score = tokens.filter((t) => terms.has(t)).length;
      const candidate = {
        id,
        score,
        series: JSON.stringify([m.metric, m.product, m.series, m.ranges]),
        label: [m.label || m.title, m.product, m.series].filter(Boolean).join(' · '),
      };
      references.set(signature, candidate);
      group.push(candidate);
    }
    if (group.length) groups.push(group);
    if (ordinal || body.chartChoices?.length || body.rangeId || body.contextReset || seen.size >= 64) break;
  }
  if (!groups.length) return null;
  const latest = groups[0];
  if (ordinal) {
    const choice = latest[ordinal[1] === 'перв' ? 0 : 1];
    return latest.length > 1 && choice ? { id: choice.id } : null;
  }
  const best = Math.max(...[...references.values()].map((c) => c.score));
  let options;
  if (best > 0) {
    const current = latest.filter((c) => c.score === best);
    if (current.length) options = current;
    else {
      const series = new Map();
      for (const c of references.values())
        if (c.score === best && !series.has(c.series)) series.set(c.series, c);
      options = [...series.values()];
    }
  } else {
    // A new named metric must not silently inherit the last chart.
    if (!pointer.test(q) || (draw.test(q) && !/этот график|его (?:ещ[её] раз|снова)/i.test(q))) return null;
    options = latest;
  }
  return options.length === 1 ? { id: options[0].id } : { choices: options };
}

export function chartObservations(material) {
  if (!material.plot) return [];
  const { lines, step, unit } = material.plot;
  return lines.map((line) => {
    const observed = line.points.filter(
      (p) =>
        Number.isFinite(p.value) &&
        !p.partial &&
        (!material.ranges?.length || material.ranges.some((r) => p.at >= r.from && p.at < r.to)),
    );
    if (!observed.length) return { series: line.key, count: 0 };
    const summary = {
      series: line.key,
      count: observed.length,
      from: new Date(observed[0].at).toISOString().slice(0, 10),
      through: new Date(observed.at(-1).at).toISOString().slice(0, 10),
      first: observed[0].value,
      last: observed.at(-1).value,
    };
    if (step === DAY && /^(visits|views|events|count|orders|шт\.)$/i.test(unit)) {
      const weekdays = { total: 0, days: 0 },
        weekends = { total: 0, days: 0 };
      for (const p of observed) {
        const day = new Date(p.at).getUTCDay();
        const bucket = day === 0 || day === 6 ? weekends : weekdays;
        bucket.total += p.value;
        bucket.days++;
      }
      if (weekdays.days && weekends.days)
        summary.byDayType = {
          workdays: { days: weekdays.days, mean: weekdays.total / weekdays.days },
          weekends: { days: weekends.days, mean: weekends.total / weekends.days },
        };
    }
    return summary;
  });
}

export function chartFindings(m, observations) {
  return observations.map((s) => {
    if (!s.count) return s.series + ' · нет полных наблюдений.';
    const period = s.from + ' — ' + s.through;
    const unit = m.plot.unit === 'visits' ? 'визитов' : m.plot.unit;
    if (s.byDayType) {
      const { workdays, weekends } = s.byDayType;
      return (
        s.series +
        ' · ' +
        period +
        '. В среднем за будний день ' +
        fmt(workdays.mean) +
        ' ' +
        unit +
        ' (' +
        workdays.days +
        ' дн.), за выходной — ' +
        fmt(weekends.mean) +
        ' (' +
        weekends.days +
        ' дн.).'
      );
    }
    return (
      s.series +
      ' · ' +
      period +
      ' · ' +
      fmt(s.first) +
      ' → ' +
      fmt(s.last) +
      ' ' +
      unit +
      '. Полных наблюдений: ' +
      s.count +
      '.'
    );
  });
}
