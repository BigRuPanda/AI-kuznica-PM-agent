import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { root } from './config.mjs';
import { integrationTransport, checkDestination, checkSmtp, localData } from './data-profile.mjs';
import { ratioFields, reportDefinition } from './metric-observations.mjs';
export async function python(script, args, input, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      env.PYTHON_BIN || (process.platform === 'win32' ? 'py' : 'python3'),
      [join(root, 'scripts', script), ...args],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const chunks = [];
    let bytes = 0,
      err = '';
    const timer = setTimeout(() => child.kill(), 120000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.stdout.on('data', (b) => {
      bytes += b.length;
      if (bytes > 48e6) child.kill();
      else chunks.push(b);
    });
    child.stderr.on('data', (b) => {
      err = (err + b.toString()).slice(-400);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0)
        return reject(
          Object.assign(Error(
            script === 'office_import.py'
              ? 'Ошибка чтения документа. ' + err
              : 'Не удалось выполнить операцию SMTP.',
          ), { exitCode: code }),
        );
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
function required(env, key) {
  if (!env[key]) throw Error('Заполните ' + key + ' в .env');
  return env[key];
}
async function request(send, url, options = {}) {
  const res = await send(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(25000) });
  if (!res.ok) {
    const e = Error('Сервис вернул HTTP ' + res.status);
    e.status = res.status;
    throw e;
  }
  return res.status === 204 ? {} : await res.json();
}
function metrikaEndpoint(env) {
  const replay = env.METRIKA_REPLAY_ORIGIN;
  if (replay && (!localData(env) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(replay)))
    throw Error('Воспроизведение Метрики доступно в локальном профиле на loopback.');
  return (replay || 'https://api-metrika.yandex.net') + '/stat/v1/data';
}
function metrikaCounters(env) {
  const ids = required(env, 'METRIKA_COUNTER_IDS');
  if (!/^\d+(,\d+)*$/.test(ids)) throw Error('Проверьте METRIKA_COUNTER_IDS');
  return ids.split(',');
}
export async function probeMetrika(env = process.env, send = fetch) {
  const [counter] = metrikaCounters(env);
  const query = new URLSearchParams({
    ids: counter, dimensions: 'ym:s:date', metrics: 'ym:s:visits',
    date1: '7daysAgo', date2: 'yesterday', limit: '1',
  });
  const report = await request(integrationTransport(env, send), metrikaEndpoint(env) + '?' + query, {
    headers: { Authorization: 'OAuth ' + required(env, 'METRIKA_TOKEN') },
  });
  if (!Array.isArray(report?.data) || !Number.isSafeInteger(report.total_rows) || report.total_rows < report.data.length)
    throw Error('Метрика вернула неполный ответ');
  return { at: Date.now(), status: 'ready' };
}
export async function metrika(env = process.env, send = fetch) {
  send = integrationTransport(env, send);
  const endpoint = metrikaEndpoint(env);
  const replay = env.METRIKA_REPLAY_ORIGIN;
  const counters = metrikaCounters(env), token = required(env, 'METRIKA_TOKEN');
  const maps = JSON.parse(
    env.METRIKA_REPORTS_JSON || '[{"id":"visits","metric":"ym:s:visits","unit":"visits"}]',
  );
  if (!Array.isArray(maps) || !maps.length) throw Error('В METRIKA_REPORTS_JSON нужен хотя бы один отчёт');
  const facts = [],
    samples = [];
  for (const counter of new Set(counters))
    for (const map of maps) {
      if (typeof map?.id !== 'string' || !map.id.trim()) throw Error('Укажите идентификатор отчёта Метрики');
      const ratio = map.numerator !== undefined || map.denominator !== undefined;
      if (ratio && [map.numerator, map.denominator].some(field => typeof field !== 'string' || !field.trim() || field.includes(',')))
        throw Error('Для доли укажите метрики numerator и denominator');
      if (!ratio && (typeof map.metric !== 'string' || !map.metric || map.metric.includes(',')))
        throw Error('Для отчёта нужна одна metric или пара numerator, denominator');
      const metric = ratio ? [map.numerator, map.denominator].join(',') : map.metric;
      const dimensions = map.dimensions || 'ym:s:date';
      if (typeof dimensions !== 'string') throw Error('Укажите группировки отчёта Метрики через запятую');
      const fields = dimensions.split(',');
      const firstDimension = fields[0];
      const step = firstDimension === 'ym:s:date' ? 1 : firstDimension === 'ym:s:startOfWeek' ? 7 : 0;
      if (!step) throw Error('Первая группировка Метрики должна задавать день или начало недели');
      const unit = ratio ? 'ratio' : map.unit || 'count';
      const definition = reportDefinition(metric, dimensions, map.filters || '', unit);
      const combine = map.disjointCounters;
      if (combine !== undefined && (!Array.isArray(combine) || combine.length < 2 || combine.some(id => !/^\d+$/.test(String(id))) ||
          new Set(combine.map(String)).size !== combine.length || !map.product))
        throw Error('Для группы непересекающихся счётчиков укажите продукт и разные ID счётчиков');
      const combineMembers = combine?.map(String).sort();
      const seen = new Set();
      let offset = 1, total;
      for (;;) {
        const q = new URLSearchParams({
          ids: counter,
          metrics: metric,
          dimensions,
          date1: map.date1 || '30daysAgo',
          date2: map.date2 || 'yesterday',
          limit: '10000',
          offset: String(offset),
          accuracy: 'full',
          ...(map.filters ? { filters: map.filters } : {}),
        });
        const r = await request(send, endpoint + '?' + q, {
          headers: { Authorization: 'OAuth ' + token },
        });
        samples.push({
          counter,
          id: map.id,
          query: q.toString(),
          sampled: r.sampled,
          share: r.sample_share,
          lag: r.data_lag,
        });
        if (!Array.isArray(r.data) || r.total_rows_rounded === true || !Number.isSafeInteger(r.total_rows) || r.total_rows < 0 ||
            (total !== undefined && r.total_rows !== total))
          throw Error('Метрика вернула неполный или изменившийся отчёт. Повторите синхронизацию.');
        total = r.total_rows;
        if (offset - 1 + r.data.length > total || (!r.data.length && offset <= total))
          throw Error('Метрика вернула неполную страницу отчёта. Повторите синхронизацию.');
        for (const [index, p] of r.data.entries()) {
          if (!Array.isArray(p?.dimensions) || p.dimensions.length !== fields.length ||
              p.dimensions.some(x => typeof x?.name !== 'string'))
            throw Error('Метрика вернула неполные группировки отчёта. Повторите синхронизацию.');
          const date = p.dimensions[0].name;
          if (!/^\d{4}-\d\d-\d\d$/.test(date) || !Number.isFinite(Date.parse(date)) ||
              new Date(date).toISOString().slice(0, 10) !== date || !Array.isArray(p.metrics) ||
              p.metrics.length !== (ratio ? 2 : 1) || p.metrics.some(x => x !== null && !Number.isFinite(x)))
            throw Error('Некорректная дата или значение в отчёте Метрики');
          const labels = p.dimensions.map(x => x.name);
          const key = JSON.stringify(labels);
          if (seen.has(key)) throw Error('Метрика вернула повторяющееся наблюдение. Повторите синхронизацию.');
          seen.add(key);
          const [n, d] = p.metrics;
          if (ratio && ((n !== null && n < 0) || (d !== null && d < 0) || (n !== null && d !== null && n > d)))
            throw Error('Некорректные основания доли в отчёте Метрики');
          const pair = ratioFields[map.id];
          const parts = labels.slice(1);
          const detail = { counter, sample_share: r.sample_share, query: q.toString() };
          if (ratio && pair) { detail[pair[0]] = n; detail[pair[1]] = d; }
          facts.push({
            kind: 'metrics',
            loc: 'Счётчик ' + counter + ' · ' + map.id + ' · ' + (offset + index),
            row: {
              date,
              source_id: 'metrika:' + counter + ':' + map.id,
              counter_id: counter,
              definition_id: definition,
              ...(combineMembers?.includes(counter) && {combine_group:'group:' + map.id, combine_members:combineMembers}),
              step_days: step,
              dimensions: parts,
              metric_id: map.id,
              product: map.product || counter,
              segment: parts.join('/') || 'all',
              value: ratio ? (d && n !== null ? n / d : null) : n,
              numerator: ratio ? n : null,
              denominator: ratio ? d : null,
              unit,
              sample_size: null,
              detail_json: JSON.stringify(detail),
              comment: replay ? 'Тестовый счётчик, воспроизведение' : 'API Яндекс Метрики',
            },
          });
        }
        offset += r.data.length;
        if (offset > total) break;
      }
    }
  return { docs: [{ file: replay ? 'Яндекс Метрика API · воспроизведение' : 'Яндекс Метрика API', facts }], samples };
}
const telegramOrigin = 'https://api.telegram.org';
export function telegramConfigured(env) {
  try {
    checkDestination(env, telegramOrigin);
    return !!env.TELEGRAM_BOT_TOKEN;
  } catch {
    return false;
  }
}

export async function telegram(method, data, env = process.env, send = fetch) {
  send = integrationTransport(env, send);
  const response = await send(telegramOrigin + '/bot' + required(env, 'TELEGRAM_BOT_TOKEN') + '/' + method, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    redirect: 'error', signal: AbortSignal.timeout(25000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok === false || !payload || !Object.hasOwn(payload, 'result')) {
    const status = response.ok ? payload?.error_code : response.status;
    const delay = payload?.parameters?.retry_after ?? Number(response.headers.get('Retry-After'));
    throw Object.assign(Error(status ? 'Telegram вернул ошибку ' + status : 'Telegram не подтвердил запрос'), {
      status,
      retryAfter: Number.isSafeInteger(delay) && delay > 0 ? delay : undefined,
    });
  }
  return payload.result;
}

export function smtpConfigured(env) {
  try {
    checkSmtp(env);
    return !!(env.SMTP_HOST?.trim() && env.SMTP_FROM?.trim());
  } catch {
    return false;
  }
}

export async function mail(text, env = process.env, recipient = env.SMTP_TO) {
  checkSmtp(env);
  const config = Object.fromEntries(
    ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM', 'SMTP_TO', 'SMTP_TLS'].map((k) => [
      k,
      env[k] || '',
    ]),
  );
  config.SMTP_TO = recipient || '';
  required(config, 'SMTP_HOST');
  required(config, 'SMTP_FROM');
  required(config, 'SMTP_TO');
  await python('mail_delivery.py', [], JSON.stringify({ ...config, text, DATA_PROFILE:env.DATA_PROFILE,
    LOCAL_SMTP_TARGET:env.LOCAL_SMTP_TARGET }), env);
}
