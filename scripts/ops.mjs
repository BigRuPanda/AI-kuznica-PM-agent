import { readFile, mkdir, copyFile, access, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { databasePath } from '../server/config.mjs';
import { openStore } from '../server/store.mjs';
import { initEvidence, cases, analysisView, setSetting, digest } from '../server/evidence.mjs';
import { initSourcePolicy, sourcePermission, importApproved } from '../server/source-policy.mjs';
import { metrika, probeMetrika, telegram, python, mail } from '../server/connectors.mjs';
import { openAccounts, workspacePath } from '../server/accounts.mjs';
import { initConnections, personalConnection, targetFor } from '../server/tracker-connections.mjs';
const [op, file] = process.argv.slice(2),
  base = databasePath(),
  env = process.env;
async function backupRestore() {
  const { readdir } = await import('node:fs/promises');
  const dir = dirname(base),
    out = join(dir, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(out, { recursive: true });
  const work = join(dir, 'workspaces'),
    items = [base, join(dir, 'accounts.sqlite')];
  try {
    for (const n of await readdir(work)) if (n.endsWith('.sqlite')) items.push(join(work, n));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  let count = 0;
  for (const path of items) {
    try {
      await access(path);
    } catch {
      continue;
    }
    const dest = dirname(path) === work ? join(out, 'workspaces', basename(path)) : join(out, basename(path));
    await mkdir(dirname(dest), { recursive: true });
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      await backup(db, dest);
    } finally {
      db.close();
    }
    const snapshot = new DatabaseSync(dest, { readOnly: true });
    const restored = dest + '.restore-test';
    try {
      await backup(snapshot, restored);
    } finally {
      snapshot.close();
    }
    const check = new DatabaseSync(restored, { readOnly: true });
    try {
      if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok')
        throw Error('Нарушена целостность копии');
    } finally {
      check.close();
    }
    const { unlink } = await import('node:fs/promises');
    await unlink(restored);
    count++;
  }
  if (!count) throw Error('Базы для копирования не найдены');
  console.log('Проверено восстановление ' + count + ' баз: ' + out);
}
async function main() {
  if (op === 'backup') return backupRestore();
  if (op === 'links') {
    const url = env.APP_BASE_URL || 'http://127.0.0.1:' + (env.PORT || 8090);
    const accounts = openAccounts(join(dirname(base), 'accounts.sqlite'));
    try {
      if (!accounts.db.prepare("SELECT id FROM users WHERE role='admin'").get() && env.ADMIN_INVITE_KEY)
        console.log('Первый администратор: ' + url + '/#join/' + env.ADMIN_INVITE_KEY);
      if (env.DEMO_INVITE_KEY) console.log('Регистрация жюри: ' + url + '/#join/' + env.DEMO_INVITE_KEY);
    } finally {
      accounts.db.close();
    }
    return;
  }
  if (op === 'check-redmine' || op === 'check-confluence') {
    if (!env.MCP_ACCESS_TOKEN) throw Error('Укажите свой персональный ключ приложения в MCP_ACCESS_TOKEN');
    const accounts = openAccounts(join(dirname(base), 'accounts.sqlite'));
    try {
      const user = accounts.bearer(env.MCP_ACCESS_TOKEN);
      if (!user) throw Error('Персональный ключ приложения недействителен');
      const service = op.slice('check-'.length);
      const db = new DatabaseSync(workspacePath(base, user.space));
      try {
        initConnections(db);
        if (targetFor(db, user, service, env).local) throw Error('Выбрано локальное демо. Настройте адрес сервиса');
        await personalConnection(db, user, {service, action:'check'}, env, fetch);
        console.log('Личный доступ подтверждён · ' + service);
      } finally {
        db.close();
      }
    } finally {
      accounts.db.close();
    }
    return;
  }
  if (op === 'check-metrika') {
    if (env.SOURCE_ARCHIVE_SHA256) {
      await probeMetrika(env);
      console.log('Ответ Reports API получен. Данные счётчика не загружены.');
      return;
    }
    const r = await metrika();
    console.log('Ответ API получен. Строк: ' + r.docs[0].facts.length);
    return;
  }
  if (op === 'check-telegram') {
    console.log('Telegram: @' + (await telegram('getMe', {})).username);
    return;
  }
  if (op === 'register-webhook') {
    if (!env.APP_BASE_URL?.startsWith('https://') || !env.TELEGRAM_WEBHOOK_SECRET)
      throw Error('Нужны HTTPS и TELEGRAM_WEBHOOK_SECRET.');
    await telegram('setWebhook', {
      url: env.APP_BASE_URL.replace(/\/$/, '') + '/api/telegram',
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ['message'],
    });
    console.log('Webhook установлен.');
    return;
  }
  if (op === 'check-smtp') {
    const config = Object.fromEntries(
      ['SMTP_HOST', 'SMTP_PORT', 'SMTP_TLS', 'SMTP_USER', 'SMTP_PASSWORD'].map((k) => [k, env[k] || '']),
    );
    await python('mail_delivery.py', ['--check'], JSON.stringify(config));
    console.log('Соединение с SMTP подтверждено.');
    return;
  }
  if (op === 'test-smtp') {
    await mail('Проверка доставки Softline Store');
    console.log('Передано SMTP-серверу');
    return;
  }
  if (op === 'invite') {
    const accounts = openAccounts(join(dirname(base), 'accounts.sqlite'));
    try {
      const code = accounts.invite('team');
      console.log((env.APP_BASE_URL || 'http://127.0.0.1:8090') + '/#join/' + code);
    } finally {
      accounts.db.close();
    }
    return;
  }
  const store = openStore(base, { seedDemo: !env.SOURCE_ARCHIVE_SHA256 });
  try {
    initEvidence(store.db);
    initSourcePolicy(store.db);
    if (op === 'import' || op === 'prepare-demo') {
      if (!file) throw Error('Укажите путь к XLSX, PPTX или ZIP');
      const path = resolve(file);
      const bytes = await readFile(path);
      const permission = sourcePermission(store.db, env.SOURCE_ARCHIVE_SHA256, bytes, basename(path));
      if (op === 'prepare-demo' && permission && !permission.archive)
        throw Error('Для демо-набора используйте исходный ZIP организатора.');
      const docs = permission?.alreadyImported ? [] : JSON.parse(await python('office_import.py', [basename(path)], bytes));
      console.log(importApproved(store, docs, permission, op === 'import' && env.NOTIFICATIONS_ENABLED === 'true'));
      if (op === 'prepare-demo') {
        setSetting(
          store.db,
          'demo_versions',
          permission?.archive
            ? store.db.prepare('SELECT version FROM source_revisions WHERE rowid IN (SELECT max(rowid) FROM source_revisions WHERE sha=? GROUP BY file) ORDER BY file').all(permission.sha).map(row => row.version)
            : docs.map(d => digest(JSON.stringify(d))),
        );
        console.log('Демо-набор для новых аккаунтов жюри сохранён.');
      }
      return;
    }
    if (op === 'audit') {
      for (const c of cases(store.db)) {
        const v = analysisView(store.db, { caseId: c.id });
        console.log(
          c.title,
          c.body.signal?.week,
          v.summary.map((s) => [s.product, s.before, s.after, s.change]),
          v.ctr.n + '/' + v.ctr.d,
        );
      }
      return;
    }
    if (op === 'cost') {
      const rows = store.db
        .prepare(
          'SELECT job,model,count(*) calls,sum(elapsed) ms,sum(input) input,sum(output) output,count(input) recorded FROM costs GROUP BY job,model',
        )
        .all();
      const price = (k) => (env[k] && Number.isFinite(Number(env[k])) ? Number(env[k]) : null);
      const pin = price('PRICE_INPUT_MILLION'),
        pout = price('PRICE_OUTPUT_MILLION'),
        infra = price('MONTHLY_INFRA_COST'),
        volume = price('MONTHLY_REQUESTS');
      const lines = [
        'request,model,calls,elapsed_ms,input_tokens,output_tokens,model_cost,infra_cost,total_cost',
      ];
      for (const r of rows) {
        const cost =
            r.recorded === r.calls && pin !== null && pout !== null
              ? (r.input * pin + r.output * pout) / 1e6
              : null,
          share = infra !== null && volume > 0 ? infra / volume : null;
        lines.push(
          [
            r.job,
            r.model,
            r.calls,
            r.ms,
            r.input,
            r.output,
            cost,
            share,
            cost !== null && share !== null ? cost + share : null,
          ].join(','),
        );
      }
      const out = join(dirname(base), 'cost-per-request.csv');
      await writeFile(out, '\ufeff' + lines.join('\r\n'));
      console.log(out + ' · запросов ' + rows.length);
      return;
    }
    throw Error(
      'Доступно: backup | import <file> | audit | invite | cost | check-redmine | check-confluence | check-metrika | check-telegram | check-smtp | test-smtp | register-webhook',
    );
  } finally {
    store.close();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
