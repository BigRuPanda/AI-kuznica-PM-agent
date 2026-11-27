import { cases, facts, fmt, listSales, metricStepDays, productFamily, setting } from './evidence.mjs';
import { workspaceOperation } from './workspace-operations.mjs';

const normalize = text => String(text || '').toLowerCase().replace(/ё/gu, 'е')
  .replace(/[^\p{L}\p{N}_]+/gu, ' ').trim();
const mentions = (question, text) => !!text && (' ' + question + ' ').includes(' ' + normalize(text) + ' ');
const day = 86400000;
const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * day).toISOString().slice(0, 10);
const localDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' });
const countWords = ['одну', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять', 'одиннадцать', 'двенадцать'];
const genitive = ['одно', 'двух', 'трех', 'четырех', 'пяти', 'шести', 'семи', 'восьми', 'девяти', 'десяти', 'одиннадцати', 'двенадцати'];
const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const number = '(\\d+|' + countWords.join('|') + '|одна)';
const pair = '(?:два|две|двух|двум|двумя|2)';
const weeks = number + '(?:\\s*[-–]\\s*недельн[\\p{L}]*|\\s+(?:полн[\\p{L}]*\\s+)?недел[\\p{L}]*)';
const weekCount = value => value && (/^\d+$/u.test(value) ? Number(value) : value === 'одна' ? 1 : countWords.indexOf(value) + 1);

function windows(question) {
  const adjective = question.match(new RegExp(pair + '\\s+(' + genitive.join('|') + ')недельн[\\p{L}]*\\s+ок[но][\\p{L}]*', 'u'))?.[1];
  const both = weekCount(question.match(new RegExp('(?<![\\p{L}])по\\s+' + weeks, 'u'))?.[1] ||
    question.match(new RegExp(weeks + '\\s+(?:до\\s+и\\s+после|в каждом|с каждой стороны)', 'u'))?.[1] ||
    question.match(new RegExp(pair + '\\s+' + number + '\\s*[-–]\\s*недельн[\\p{L}]*', 'u'))?.[1]) ||
    (adjective ? genitive.indexOf(adjective) + 1 : undefined);
  const side = name => weekCount(question.match(new RegExp(weeks + '\\s+(?:' + name + ')(?![\\p{L}])', 'u'))?.[1] ||
    question.match(new RegExp('(?<![\\p{L}])(?:' + name + ')\\s*[:=—–-]\\s*' + weeks, 'u'))?.[1]);
  return [side('до|перед') ?? both, side('после') ?? both];
}

function cutoff(question) {
  const dates = [...question.matchAll(new RegExp('(?<!\\d)(\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[./]\\d{1,2}[./]\\d{4}|\\d{1,2}\\s+(?:' +
    months.join('|') + ')\\s+\\d{4})(?!\\d)', 'gu'))];
  const marked = dates.filter(m => /(?<![\p{L}])(?:по состоянию на|на дату|данные по|данными по|наблюдения по|до конца|к концу|срез(?:а|е)?(?: на| по)?|as\s*of|на|к)\s*[:=]?\s*$/iu.test(question.slice(0, m.index)));
  const candidates = marked.length ? marked : dates.filter(m => !/(?:релиз|выкладк)[\p{L}]*\s+от\s*$/u.test(question.slice(0, m.index)));
  if (!candidates.length && /(?:на|срез на) сегодня|по состоянию на сегодня/u.test(question)) return localDate.format();
  if (!candidates.length) return;
  const distinct = [...new Set(candidates.map(([raw]) => {
    const [d, m, y] = raw.split(/[./\s]+/u);
    const month = months.includes(m) ? String(months.indexOf(m) + 1) : m;
    return y ? y + '-' + month.padStart(2, '0') + '-' + d.padStart(2, '0') : raw;
  }))];
  return distinct.length === 1 && Number.isFinite(Date.parse(distinct[0])) && addDays(distinct[0], 0) === distinct[0]
    ? distinct[0] : '';
}

const identifiers = (question, prefix) => [...new Set(
  [...question.matchAll(new RegExp('(?<![\\p{L}\\p{N}_])' + prefix + '\\s*[-–‑]\\s*(\\d+)(?![\\p{L}\\p{N}_])', 'giu'))]
    .map(([, id]) => prefix + '-' + id),
)];
const segments = {
  desktop: /(?:^| )(?:desktop|десктоп[\p{L}]*|компьютер[\p{L}]*)(?: |$)/u,
  mobile: /(?:^| )(?:mobile|мобайл[\p{L}]*|мобильн[\p{L}]*|телефон[\p{L}]*)(?: |$)/u,
  tablet: /(?:^| )(?:tablet|планшет[\p{L}]*)(?: |$)/u,
  all: /(?:^| )(?:all|все устройства|всем устройствам)(?: |$)/u,
};
const observation = /окн[аоуе]|недел|эффект|наблюден|прирост|изменени|динамик|сравни|(?:до|перед).{0,40}после/u;
const launchFacts = /(?:когда|дата).{0,40}(?:вышел|выпущ|выклад|релиз)|(?:связан[\p{L}]*.{0,20}задач|задач[\p{L}]*.{0,30}связан)/u;
const separateRequest = /(?:построй|нарисуй|визуализируй|график|диаграмм|создай|заведи|оформи|подготовь|составь|сохрани|запиши|закрепи|опубликуй|отправь|экспортируй|закрой|назначь|поставь|обнови|прокомментируй|отслеживай|добавь|(?:нужно|надо|прошу)\s+(?:создать|завести|оформить|добавить)|(?:найди|покажи|перечисли|расскажи).{0,30}(?:комментари|интервью|конкурент|confluence)|(?:объясни(?![\p{L}])|почему|причина).{0,25}(?:упал|рос|сниз|выро[сш]|измен)|redmine)/gu;
const metrikaRequested = /метрик[\p{L}]* магазина|яндекс\s*\.?\s*метрик|reports api|сч[её]тчик|(?:жив|реальн)[\p{L}]*.{0,18}данн[\p{L}]*.{0,20}метрик/u;
const ordersAttribution = /(?:можно ли|может ли).{0,60}(?:объяснить|связать|установить).{0,45}(?:заказ|bi[\s-]*индекс)/u;
const ref = (row, detail) => ({
  url: '#knowledge-source/' + row.version + '/' + encodeURIComponent(row.loc),
  label: row.file + ' · ' + row.loc,
  ...(detail && { detail }),
});

const titleWords = title => normalize(title).split(' ').filter(word => word.length >= 4 || word === 'ctr');
function similarWord(a, b) {
  if (a === b) return true;
  if (!/^[а-я]+$/u.test(a) || !/^[а-я]+$/u.test(b)) return false;
  const aStem = a.replace(/[аеиоуыюя]$/u, ''), bStem = b.replace(/[аеиоуыюя]$/u, '');
  if (aStem.length >= 3 && aStem === bStem) return true;
  const prefix = Math.max(4, Math.ceil(Math.min(a.length, b.length) / 2));
  return a.length >= prefix && b.length >= prefix && a.slice(0, prefix) === b.slice(0, prefix);
}

function namedMetrics(question, options) {
  const clauses = question.split(/[.!?;,\n]/u).map(titleWords);
  const matches = options.map(metric => ({ metric, words: titleWords(metric.title) })).filter(({ metric, words }) =>
    mentions(normalize(question), metric.title) || words.length >= 2 && clauses.some(clause =>
      clause.some((first, index) => similarWord(first, words[0]) &&
        words.every(word => clause.slice(index, index + words.length + 5).some(part => similarWord(part, word))))));
  return matches.filter(match => !matches.some(other => other.words.length > match.words.length &&
    match.words.every(word => other.words.some(part => similarWord(part, word))))).map(match => match.metric);
}

function missingDates(period, step) {
  const observed = new Set(period.sources.map(row => row.date));
  const gaps = [];
  let count = 0;
  for (let offset = 0; offset < period.expected; offset++) {
    const date = addDays(period.from, offset * step);
    if (observed.has(date)) continue;
    count++;
    const previous = gaps.at(-1);
    if (previous && addDays(previous[1], step) === date) previous[1] = date;
    else gaps.push([date, date]);
  }
  const ranges = gaps.map(([from, through]) => from === through ? from : from + ' – ' + through);
  return { count, ranges };
}

function periodText(title, p, step) {
  const missing = missingDates(p, step);
  const scale = step === 7 ? 'недель' : 'дней';
  const unit = p.unit?.replace(' в день', '/день').replace(' в неделю', '/неделю');
  const aggregate = p.value === null ? '' :
    '. ' + (p.total == null ? fmt(p.value) : fmt(p.total) + ' / ' + p.expected + ' ≈ ' + fmt(p.value)) + ' ' + unit;
  let text = title + ' ' + p.from + ' – ' + p.through + ' · ' + (p.expected - missing.count) + '/' + p.expected + ' ' + scale + aggregate + '.';
  if (missing.count) text += ' Не хватает наблюдений за ' + missing.count + ' ' + (step === 7 ? 'нед.' : 'дн.') + ' (' +
    (step === 7 ? 'даты начала недель: ' : '') + missing.ranges.join(', ') + ').';
  return text;
}

function metrikaStatus(db, env, result) {
  if (env.SOURCE_ARCHIVE_SHA256) {
    const probe = setting(db, 'metrika_probe', null);
    const status = probe?.status === 'ready' && Number.isFinite(probe.at)
      ? ' Reports API ответил на проверку тестового счётчика ' + localDate.format(probe.at) + '.'
      : probe?.status === 'error'
        ? ' Последняя проверка Reports API на тестовом счётчике завершилась ошибкой.'
        : ' Доступность Reports API на тестовом счётчике проверяется отдельно в настройках.';
    return 'Данные рабочего счётчика Метрики магазина за этот период недоступны в разборе. Источник наблюдений — архив организатора.' + status;
  }
  const rows = [result.baseline, result.observed].flatMap(p => p?.sources || []);
  const apiDays = rows.filter(row => row.file === 'Яндекс Метрика API').length;
  return apiDays
    ? 'В сохранённом ряду за эти окна есть ' + apiDays + ' строк из Reports API. Принадлежность счётчика рабочему магазину в источниках разбора не подтверждена.'
    : 'В сохранённом ряду за эти окна нет строк из Reports API для выбранного продукта, показателя и разреза.';
}

export function releaseObservationAnswer(store, user, b, env, shared, history) {
  const question = b.question.toLowerCase().replace(/ё/gu, 'е');
  const plain = normalize(question);
  if (b.rangeId || b.materialIds?.length || /^(?:что (?:такое|значит|означает)|как (?:посчитать|рассчитать)) /u.test(question) ||
      [...question.matchAll(separateRequest)].some(m => !/(?<![\p{L}])(?:не|без)\s*$/u.test(question.slice(0, m.index)))) return;
  const [baselineWeeks, observationWeeks] = windows(question);
  const releaseIds = identifiers(question, 'R');
  const taskIds = identifiers(question, 'T');
  const asOf = cutoff(question);
  const segmentIds = Object.entries(segments).filter(([, pattern]) => pattern.test(plain)).map(([id]) => id);
  const metricIds = [...new Set(plain.match(/(?<![\p{L}\p{N}_])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![\p{L}\p{N}_])/gu) || [])];
  const previous = history.at(-1)?.body.releaseObservation;
  const db = store.db;
  const shortReply = /^(?:тогда |для |возьми |выбери |дата |срез )*(?:на |по |as\s*of |по состоянию на )?(?:\d|desktop|mobile|tablet|all|компьютер|десктоп|мобильн|телефон|планшет|[a-z]+_|(?:одну|одна|две|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать)\s)/u;
  const followsPending = previous?.pending && !releaseIds.length && !taskIds.length && question.length <= 180;
  const followupMetric = followsPending && previous.pending === 'metric' && namedMetrics(question,
    facts(db, 'dictionary').map(({ data }) => ({ id: data.metric_id, title: data.metric_name }))).length > 0;
  const followup = followsPending && (followupMetric || shortReply.test(question.trim()) &&
    (asOf !== undefined || metricIds.length || segmentIds.length || baselineWeeks !== undefined || observationWeeks !== undefined));
  if (!followup && (!(releaseIds.length || b.decisionReleaseId) || !observation.test(question) && !launchFacts.test(question))) return;
  const params = {
    ...(followup ? previous : {}),
    releaseId: releaseIds[0] || (followup && previous.releaseId) || b.decisionReleaseId,
    taskId: taskIds[0] || (followup ? previous.taskId : undefined),
    metric: metricIds[0] || (followup && !followupMetric ? previous.metric : undefined),
    segment: segmentIds[0] || (followup ? previous.segment : undefined),
    baselineWeeks: baselineWeeks ?? (followup ? previous.baselineWeeks : undefined),
    observationWeeks: observationWeeks ?? (followup ? previous.observationWeeks : undefined),
    asOf: asOf ?? (followup ? previous.asOf : undefined),
    effect: !!(followup && previous.effect || observation.test(question) || metricIds.length),
    metrika: !!(followup && previous.metrika || metrikaRequested.test(question) ||
      /(?<![\p{L}])Метрик[аиуе](?![\p{L}])/u.test(b.question)),
    ordersAttribution: !!(followup && previous.ordersAttribution || ordersAttribution.test(question)),
  };
  const result = { mode: 'release-observation', outcome: 'done', steps: [], readSources: [] };
  const respond = (text, pending = false) => ({ ...result, text, releaseObservation: { ...params, pending } });
  const ask = (text, pending = true) => respond(text, pending);
  if (releaseIds.length > 1 || taskIds.length > 1 || metricIds.length > 1 || segmentIds.length > 1) return;
  if (params.asOf === '') return ask('Какую дату взять для среза? Укажите одну календарную дату с годом.');
  if (!params.releaseId) return ask('Какой релиз проверить? Укажите его идентификатор из журнала.');
  const accessible = cases(db).filter(c => !c.body.owner || (!shared && c.body.owner === user.id));
  const catalog = [...new Set([...listSales(db).map(r => r.product), ...accessible.map(c => c.product)])];
  const named = catalog.filter(name => mentions(plain, name) || mentions(plain, productFamily(name)));
  if (named.length > 1) return ask('Для какого семейства проверить релиз? Укажите один продукт.');
  let current = accessible.find(c => c.id === (b.caseId || (followup ? previous.caseId : undefined)));
  if (b.caseId && !current) throw Error('Разбор недоступен в этом пространстве.');
  if (named.length && current?.product !== named[0])
    current = accessible.find(c => c.product === named[0] && c.body.release === params.releaseId) ||
      accessible.find(c => c.product === named[0]);
  if (!current && !named.length) {
    current = accessible.find(c => c.body.release === params.releaseId);
    if (!current) {
      const release = facts(db, 'releases').find(r => r.data.release_id === params.releaseId);
      const title = normalize(release?.data.description);
      const matching = catalog.filter(name => mentions(title, name) || mentions(title, productFamily(name)));
      if (matching.length === 1) current = accessible.find(c => c.product === matching[0]);
    }
  }
  if (!current) return ask('Какой доступный разбор использовать для ' + params.releaseId + '? Откройте его или укажите семейство продукта.');
  params.caseId = current.id;
  result.caseId = current.id;
  result.product = current.product;
  const call = (op, input) => workspaceOperation(store, user, op, { caseId: current.id, ...input }, env, undefined, shared);
  const options = call('watch-options');
  const release = options.releases.find(r => r.id === params.releaseId);
  if (!release || params.asOf && release.date > params.asOf)
    return ask('В журнале семейства ' + current.product + ' ' + (params.asOf ? 'на ' + params.asOf + ' ' : '') +
      'нет выпущенного релиза ' + params.releaseId + '. Уточните релиз или дату среза.');
  const tasks = options.tasks.filter(t => t.releaseIds.includes(release.id) &&
    (!params.asOf || t.created && t.created <= params.asOf));
  const task = params.taskId ? tasks.find(t => t.id === params.taskId) : tasks.length === 1 ? tasks[0] : undefined;
  const title = release.title?.trim().replace(/[.!?]?$/u, '.');
  const lines = [[release.id + ' вышел ' + release.date + '.', title].filter(Boolean).join(' '),
    tasks.length ? 'Связанные задачи · ' + tasks.map(t => t.id + ' — ' + t.title).join(', ') + '.' :
      'В журнале на дату среза связанная задача не подтверждена.'];
  result.steps.push('watch-options');
  result.readSources.push(ref(release.source), ...tasks.map(t => ref(t.source)));
  const clarify = (text, pending) => ask([...lines, text].join('\n\n'), pending);
  if (params.taskId && !task) {
    params.taskId = undefined;
    return clarify('Указанная задача не связана с этим релизом на дату среза. Какую задачу проверить?');
  }
  if (!params.effect)
    return respond([...lines, params.metrika && metrikaStatus(db, env, {})].filter(Boolean).join('\n\n'));

  const measures = params.metric ? [] : namedMetrics(question, options.metrics);
  if (measures.length > 1)
    return clarify('Какой показатель проверить: ' + measures.map(m => '«' + m.title + '»').join(' или ') + '?', 'metric');
  params.metric ||= measures[0]?.id;
  if (params.metric === 'family_orders_idx') params.metric = 'orders_index';
  const metric = options.metrics.find(m => m.id === params.metric);
  const linkedMetrics = options.metrics.filter(m => release.metrics.includes(m.id) ||
    m.id === 'orders_index' && release.metrics.includes('family_orders_idx'));
  if (!metric) return clarify((params.metric ? 'Для этого семейства нет доступного ряда ' + params.metric + '. ' : '') +
    'Какой показатель проверить? ' + (linkedMetrics.length
      ? 'В релизе указаны ' + linkedMetrics.map(m => '«' + m.title + '»').join(', ') + '.'
      : 'Укажите название показателя.'), 'metric');
  params.segment ||= [...new Set(options.metrics.flatMap(m => m.segments))]
    .find(s => mentions(plain, s));
  if (!params.segment || metric.segments.length && !metric.segments.includes(params.segment))
    return clarify((params.segment ? 'В источнике нет разреза ' + params.segment + ' для ' + metric.id + '. ' : '') +
      'Какой разрез выбрать?' + (metric.segments.length ? ' Доступны ' + metric.segments.join(', ') + '.' : ''));
  if (!params.asOf) return clarify('На какую дату среза оценить ' + metric.id + ' по ' + params.segment + '?');
  if (params.asOf > localDate.format()) return clarify('Дата среза ещё не наступила. Какую прошедшую дату использовать?');
  if (![params.baselineWeeks, params.observationWeeks].every(n => Number.isInteger(n) && n >= 1 && n <= 12))
    return clarify('Сколько недель взять до релиза и сколько после? Укажите для каждого окна от 1 до 12 недель.');

  const { metric: metricId, releaseId, segment } = params;
  const effect = call('effect-preview', {
    metric: metricId, releaseId, segment, taskId: task?.id,
    baselineWeeks: params.baselineWeeks, observationWeeks: params.observationWeeks, asOf: params.asOf,
  });
  result.steps.push('effect-preview');
  const { baseline, observed } = effect;
  lines.push('Срез на ' + effect.asOf + ' · ' + effect.plan.title + ' (' + metricId + ') · ' + segment + '.');
  const step = metricStepDays(metricId);
  if (baseline) lines.push(periodText('До релиза', baseline, step));
  if (observed) lines.push(periodText('После релиза', observed, step));
  lines.push(effect.actual == null
    ? 'Изменение по этим окнам пока нельзя оценить. ' + (effect.checkAfter > effect.asOf && !effect.breaks?.length
      ? 'Окно наблюдения заканчивается ' + effect.checkAfter + '.' : effect.state + '.')
    : 'Наблюдаемое изменение · ' + (effect.change > 0 ? '+' : '') + fmt(effect.change) + ' ' +
      (effect.unit === '%' ? 'п. п.' : effect.unit) + '. Для вывода о влиянии релиза нужна отдельная проверка.');
  if (effect.breaks?.length)
    lines.push('На сопоставимость повлияли изменения учёта · ' + effect.breaks.map(r => r.id + ' ' + r.date + ' — ' + r.title).join(', ') + '.');
  if (params.ordersAttribution)
    lines.push('По этому сравнению нельзя установить причину изменения индекса самостоятельных заказов. Для такого вывода нужно проверить оба ряда и другие изменения в этот период.');
  if (params.metrika) lines.push(metrikaStatus(db, env, effect));
  const representative = p => p?.sources.length > 5 ? [p.sources[0], p.sources.at(-1)] : p?.sources || [];
  const unique = new Map(result.readSources.map(item => [item.url, item]));
  if (metric.source) unique.set(ref(metric.source).url, ref(metric.source));
  for (const row of [...representative(baseline), ...representative(observed), ...(effect.breaks || [])]) {
    const citation = ref(row, row.date + (Number.isFinite(row.value) ? ' · ' + fmt(row.value) : ''));
    unique.set(citation.url, citation);
  }
  result.readSources = [...unique.values()];
  return respond(lines.join('\n\n'));
}
