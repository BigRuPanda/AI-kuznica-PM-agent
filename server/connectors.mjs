import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { root } from './config.mjs';
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
          Error(
            script === 'office_import.py'
              ? 'Ошибка чтения документа. ' + err
              : 'Не удалось выполнить операцию SMTP.',
          ),
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
export async function probeMetrika(env = process.env, send = fetch) {
  const ids = required(env, 'METRIKA_COUNTER_IDS');
  if (!/^\d+(,\d+)*$/.test(ids)) throw Error('Проверьте METRIKA_COUNTER_IDS');
  const counter = ids.split(',')[0];
  const query = new URLSearchParams({
    ids: counter, dimensions: 'ym:s:date', metrics: 'ym:s:visits',
    date1: '7daysAgo', date2: 'yesterday', limit: '1',
  });
  const url = 'https://api-metrika.yandex.net/stat/v1/data?' + query;
  const report = await request(send, url, { headers: { Authorization: 'OAuth ' + required(env, 'METRIKA_TOKEN') } });
  if (!Array.isArray(report?.data) || !Number.isSafeInteger(report.total_rows) || report.total_rows < 0)
    throw Error('Метрика вернула неполный ответ');
  return { at: Date.now(), status: 'ready' };
}
export async function metrika(env = process.env, send = fetch) {
  const ids = required(env, 'METRIKA_COUNTER_IDS'),
    token = required(env, 'METRIKA_TOKEN');
  if (!/^\d+(,\d+)*$/.test(ids)) throw Error('Проверьте METRIKA_COUNTER_IDS');
  const maps = JSON.parse(
    env.METRIKA_REPORTS_JSON || '[{"id":"visits","metric":"ym:s:visits","unit":"visits"}]',
  );
  const facts = [],
    samples = [];
  for (const counter of ids.split(','))
    for (const map of maps) {
      for (let offset = 1; ; offset += 10000) {
        const q = new URLSearchParams({
          ids: counter,
          metrics: map.metric,
          dimensions: map.dimensions || 'ym:s:date',
          date1: map.date1 || '30daysAgo',
          date2: map.date2 || 'yesterday',
          limit: '10000',
          offset: String(offset),
          accuracy: 'full',
          ...(map.filters ? { filters: map.filters } : {}),
        });
        const r = await request(send, 'https://api-metrika.yandex.net/stat/v1/data?' + q, {
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
        for (const [index, p] of r.data.entries())
          facts.push({
            kind: 'metrics',
            loc: 'Счётчик ' + counter + ' · ' + map.id + ' · ' + (offset + index),
            row: {
              date: p.dimensions[0].name,
              metric_id: map.id,
              product: map.product || counter,
              segment:
                p.dimensions
                  .slice(1)
                  .map((x) => x.name)
                  .join('/') || 'all',
              value: p.metrics[0],
              unit: map.unit || 'count',
              sample_size: null,
              detail_json: JSON.stringify({ counter, sample_share: r.sample_share, query: q.toString() }),
              comment: 'API Яндекс Метрики',
            },
          });
        if (!r.data.length || offset + r.data.length > r.total_rows) break;
      }
    }
  return { docs: [{ file: 'Яндекс Метрика API', facts }], samples };
}
export async function telegram(method, data, env = process.env, send = fetch) {
  const r = await request(
    send,
    'https://api.telegram.org/bot' + required(env, 'TELEGRAM_BOT_TOKEN') + '/' + method,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) },
  );
  return r.result;
}
export async function mail(text, env = process.env, recipient = env.SMTP_TO) {
  const config = Object.fromEntries(
    ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM', 'SMTP_TO', 'SMTP_TLS'].map((k) => [
      k,
      env[k] || '',
    ]),
  );
  config.SMTP_TO = recipient || '';
  required(config, 'SMTP_HOST');
  required(config, 'SMTP_TO');
  await python('mail_delivery.py', [], JSON.stringify({ ...config, text }), env);
}
