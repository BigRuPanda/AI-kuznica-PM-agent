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
export function jira(env = process.env, send = fetch) {
  const cloud = (env.JIRA_EDITION || 'cloud') === 'cloud';
  const base = new URL(required(env, 'JIRA_BASE_URL'));
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname))
    throw Error('Для Jira нужен HTTPS');
  const project = required(env, 'JIRA_PROJECT');
  if (!/^[A-Z][A-Z0-9_]*$/.test(project)) throw Error('Проверьте ключ проекта Jira');
  const prefix = base.toString().replace(/\/$/, '') + '/rest/api/' + (cloud ? '3' : '2');
  const token = required(env, 'JIRA_TOKEN');
  const auth = cloud
    ? 'Basic ' + Buffer.from(required(env, 'JIRA_EMAIL') + ':' + token).toString('base64')
    : 'Bearer ' + token;
  const call = (path, method = 'GET', data) =>
    request(send, prefix + path, {
      method,
      headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: data ? JSON.stringify(data) : undefined,
    });
  const checkKey = (key) => {
    if (!new RegExp('^' + project + '-[1-9][0-9]*$').test(key))
      throw Error('Укажите задачу из подключённого проекта');
    return key;
  };
  return {
    check: () => call('/project/' + project),
    async search(query) {
      const clean = String(query)
        .replace(/[^ \p{L}\p{N}_-]/gu, ' ')
        .trim()
        .slice(0, 120);
      const jql =
        'project = ' + project + (clean ? ' AND text ~ "' + clean + '"' : '') + ' ORDER BY updated DESC';
      const r = await call(cloud ? '/search/jql' : '/search', 'POST', {
        jql,
        fields: ['summary', 'status', 'priority'],
        maxResults: 20,
      });
      return (r.issues || []).map((i) => ({
        key: i.key,
        title: i.fields.summary,
        status: i.fields.status?.name,
        priority: i.fields.priority?.name,
      }));
    },
    get: (key) => call('/issue/' + checkKey(key) + '?fields=summary,status,priority'),
    async create(title, description, marker) {
      const text = description + '\n\nсгенерирована ИИ-помощником';
      const fields = {
        ...JSON.parse(env.JIRA_EXTRA_FIELDS_JSON || '{}'),
        project: { key: project },
        issuetype: { name: env.JIRA_ISSUE_TYPE || 'Task' },
        summary: title,
        labels: ['ai-generated', marker],
        description: cloud
          ? { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
          : text,
      };
      return await call('/issue', 'POST', { fields });
    },
    async findMarker(marker) {
      if (!/^pm-[a-f0-9-]+$/.test(marker)) throw Error('Некорректная ссылка на черновик');
      const result = await call(cloud ? '/search/jql' : '/search', 'POST', {
        jql: 'project = ' + project + ' AND labels = "' + marker + '"',
        fields: ['summary'],
        maxResults: 2,
      });
      return result.issues?.[0]?.key;
    },
    prioritize: (key, priority) =>
      call('/issue/' + checkKey(key), 'PUT', { fields: { priority: { name: priority } } }),
  };
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
export async function mail(text, env = process.env) {
  const config = Object.fromEntries(
    ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM', 'SMTP_TO', 'SMTP_TLS'].map((k) => [
      k,
      env[k] || '',
    ]),
  );
  required(config, 'SMTP_HOST');
  required(config, 'SMTP_TO');
  await python('mail_delivery.py', [], JSON.stringify({ ...config, text }), env);
}
