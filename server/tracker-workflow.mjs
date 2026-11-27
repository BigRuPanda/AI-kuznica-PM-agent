import { randomUUID } from 'node:crypto';
import { targetFor, remoteClient, initConnections, connectionInfo } from './tracker-connections.mjs';
import { escapeXml, plain, decodeText, storageOffset } from './tracker-clients.mjs';
import { demoClient, initTrackerDemo, localHref } from './tracker-demo.mjs';
import { initRedmine, bridgeTracker, draftReport } from './redmine-bridge.mjs';
import { initWatches, watchIssue } from './redmine-watch.mjs';
import { sourceLinks } from './knowledge.mjs';

export function initTracking(db, env = process.env) {
  initConnections(db);
  initTrackerDemo(db);
  initRedmine(db);
  initWatches(db);
  for (const row of db
    .prepare(
      "SELECT id,case_id,body,external,state FROM draft_actions WHERE json_extract(body,'$.target') IS NULL",
    )
    .all()) {
    const b = JSON.parse(row.body);
    const tracked = db.prepare('SELECT reference,report FROM redmine_drafts WHERE draft=?').get(row.id);
    b.target = tracked
      ? {
          service: 'redmine',
          bridge: true,
          url: env.SIGNAL_BRIDGE_URL?.replace(/\/+$/, ''),
          scope: 'Signal Bridge',
        }
      : { service: 'redmine', local: true };
    if (tracked) b.report = { id: tracked.report };
    b.kind = 'issue';
    if (row.state === 'done' && row.external) {
      const result =
        tracked &&
        db
          .prepare(
            "SELECT json_extract(body,'$.url') AS url FROM redmine_results WHERE json_extract(body,'$.reference')=? LIMIT 1",
          )
          .get(tracked.reference);
      b.receipt = {
        key: row.external,
        url: tracked ? result?.url || '#case/' + row.case_id : localHref('redmine', row.external),
      };
    }
    b.diff = b.key
      ? [{ field: 'Приоритет', before: '', after: b.priority }]
      : [{ field: 'Описание', before: '', after: b.description }];
    b.changes = b.key ? { priorityId: b.priority } : { title: b.title, description: b.description };
    db.prepare('UPDATE draft_actions SET body=? WHERE id=?').run(JSON.stringify(b), row.id);
  }
}
export function trackerClient(store, user, target, env, send, caseId, sharedOnly = false) {
  if (target.bridge) {
    const current = targetFor(store.db, user, 'redmine', env);
    if (sharedOnly || !current.bridge || (target.url && current.url !== target.url))
      throw Error('Назначение Signal Bridge изменилось или недоступно');
    return bridgeTracker(store.db, user, env, send);
  }
  if (!target.local) return remoteClient(store.db, user, target, env, send);
  const api = demoClient(store.db, user, target.service, caseId, sharedOnly);
  return {
    ...api,
    save: (...args) => {
      const beforeWrite = args.pop();
      return store.tx(() => {
        beforeWrite();
        return api.save(...args);
      });
    },
  };
}
function locationName(t) {
  if (t.bridge) return 'Redmine · Signal Bridge';
  return t.local
    ? t.service === 'redmine'
      ? 'Локальный демо-бэклог'
      : 'Встроенная база знаний'
    : t.url + ' · ' + t.scope;
}
export function preview(row) {
  const b = JSON.parse(row.body);
  return {
    id: row.id,
    caseId: row.case_id,
    state: row.state,
    external: row.external,
    kind: b.kind,
    title: b.title,
    description: b.description,
    key: b.key,
    priority: b.changes?.priorityId,
    destination: locationName(b.target),
    diff: b.diff || [],
    revision: b.revision,
    conflict: b.conflict,
    latestPage: b.latestPage,
    sourceUrl: b.sourceUrl,
    version: b.version,
    receipt: b.receipt,
    issue: b.issue,
    reason: b.reason,
  };
}
const fields = {
  title: 'Заголовок',
  description: 'Описание',
  assigneeId: 'Исполнитель',
  priorityId: 'Приоритет',
  statusId: 'Статус',
  trackerId: 'Тип задачи',
  comment: 'Комментарий',
};
async function issueDraft(client, input, target) {
  const current = input.key ? await client.read(input.key) : {};
  const changes = {};
  for (const k of Object.keys(fields))
    if (input[k] !== undefined && input[k] !== current[k]) changes[k] = input[k];
  if (input.priority && !changes.priorityId) changes.priorityId = input.priority;
  if (!input.key && !changes.title?.trim()) throw Error('Введите заголовок задачи');
  if (changes.title !== undefined && !changes.title.trim()) throw Error('Введите заголовок задачи');
  if (!input.key && changes.comment) throw Error('Добавьте комментарий к существующей задаче');
  if (changes.statusId && !current.statuses?.some((s) => s.id === changes.statusId))
    throw Error('Переход статуса недоступен');
  const diff = [];
  const options = ['priorityId', 'assigneeId', 'trackerId'].some((k) => k in changes)
    ? await client.options()
    : {};
  const lookup = {
    statusId: current.statuses,
    priorityId: options.priorities,
    assigneeId: options.assignees,
    trackerId: options.trackers,
  };
  for (const [key, value] of Object.entries(changes)) {
    const choices = lookup[key];
    if (choices && value && !choices.some((o) => o.id === value))
      throw Error('Недопустимое значение поля «' + fields[key] + '»');
    const name = (v) => choices?.find((i) => i.id === v)?.name || v || '';
    diff.push({ field: fields[key], before: name(current[key]), after: name(value) });
  }
  if (!diff.length) throw Error('Укажите изменение задачи');
  return {
    kind: 'issue',
    target,
    key: current.key || '',
    title: changes.title || current.title,
    description: changes.description || changes.comment || '',
    changes,
    diff,
  };
}
function replaceText(storage, fragment, replacement) {
  // Match text across inline formatting, but never cross a block, link, macro or CDATA boundary.
  const tokens =
    storage.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/g) || [];
  let macroDepth = 0,
    run = '',
    nodes = [],
    matches = 0;
  function finishRun() {
    const begin = run.indexOf(fragment);
    if (begin >= 0) {
      const end = begin + fragment.length;
      if (++matches > 1 || run.indexOf(fragment, begin + 1) >= 0)
        throw Error('Выберите уникальный фрагмент текста');
      for (const { index, start, length } of nodes) {
        if (start >= end || start + length <= begin) continue;
        const raw = tokens[index];
        const from = storageOffset(raw, Math.max(0, begin - start));
        const to = storageOffset(raw, Math.min(length, end - start));
        tokens[index] = raw.slice(0, from) + (start <= begin ? escapeXml(replacement) : '') + raw.slice(to);
      }
    }
    run = '';
    nodes = [];
  }
  for (const [index, token] of tokens.entries()) {
    if (token.startsWith('<')) {
      if (/^<\/?(?:strong|b|em|i|u|s|span|sup|sub|code)\b/i.test(token)) continue;
      finishRun();
      if (/^<ac:structured-macro\b/.test(token) && !token.endsWith('/>')) macroDepth++;
      if (/^<\/ac:structured-macro\s*>/.test(token)) macroDepth--;
    } else if (!macroDepth) {
      const text = decodeText(token);
      nodes.push({ index, start: run.length, length: text.length });
      run += text;
    }
  }
  finishRun();
  if (!matches) throw Error('Выберите фрагмент обычного текста на свежей версии страницы');
  return tokens.join('');
}
function pageDraft(input, current, target, issue, marker) {
  const version = current?.version || 0;
  const title = input.title?.trim() || current?.title;
  if (!title) throw Error('Введите название страницы');
  const content = input.content || '';
  let storage = current?.storage || '';
  const diff = [];
  if (title !== current?.title)
    diff.push({ field: 'Название страницы', before: current?.title || '', after: title });
  if (input.fragment) {
    storage = replaceText(storage, input.fragment, content);
    diff.push({ field: 'Заменить текст', before: input.fragment, after: content });
  } else if (content.trim()) {
    storage += content
      .split(/\r?\n/)
      .map((s) => '<p>' + escapeXml(s) + '</p>')
      .join('');
    diff.push({ field: 'Добавить в конец страницы', before: '', after: content });
  }
  if (issue && !storage.includes('href="' + escapeXml(issue.url) + '"')) {
    storage += '<p><a href="' + escapeXml(issue.url) + '">Задача ' + escapeXml(issue.key) + '</a></p>';
    diff.push({ field: 'Ссылка на задачу', before: '', after: issue.url });
  }
  for (const source of input.sources || []) {
    if (storage.includes('href="' + escapeXml(source.url) + '"')) continue;
    const label = source.file + ' · ' + source.version.slice(0, 12);
    storage += '<p><a href="' + escapeXml(source.url) + '">' + escapeXml(label) + '</a></p>';
    diff.push({ field: 'Источник Excel', before: '', after: label });
  }
  const linkOnly = !!current && !!issue && !diff.length;
  if (issue) diff.push({ field: 'Обратная ссылка в Redmine', before: '', after: issue.url });
  if (!diff.length && !issue) throw Error('Укажите изменение страницы');
  storage +=
    '<ac:structured-macro ac:name="anchor"><ac:parameter ac:name="">' +
    marker +
    '</ac:parameter></ac:structured-macro>';
  return {
    kind: 'page',
    sourceUrl: current?.url,
    target,
    key: current?.key || '',
    title,
    version,
    storage,
    diff,
    input: { ...input, title: input.title === current?.title ? undefined : input.title },
    ...(linkOnly && { linkOnly: true }),
    issue,
    revision: randomUUID(),
  };
}
export async function prepareTracker(store, user, kind, input, env, send, requestId, sharedOnly = false) {
  const db = store.db,
    id = requestId || randomUUID();
  const existing = db.prepare('SELECT * FROM draft_actions WHERE id=? AND user=?').get(id, user.id);
  if (existing) return preview(existing);
  const target = targetFor(db, user, kind === 'page' ? 'confluence' : 'redmine', env);
  const client = await trackerClient(store, user, target, env, send, input.caseId, sharedOnly);
  let body;
  if (kind === 'issue') {
    body = await issueDraft(client, input, target);
    if (input.includeReport && !env.SOURCE_ARCHIVE_SHA256 && !input.key && !target.local && env.SIGNAL_BRIDGE_URL) {
      if (target.bridge && !body.description.trim())
        throw Error('Укажите описание проверки для задачи с отчётом Метрики');
      body.report = await draftReport(env, send);
      const report = body.report;
      const source = [report.start + ' — ' + report.end, report.status, report.web].join('\n');
      body.diff.push({ field: 'Снимок Метрики', before: '', after: source });
      if (!target.bridge)
        body.changes.description = [body.description, 'Снимок Метрики', source].filter(Boolean).join('\n');
    }
  } else {
    let issue;
    if (input.issueKey) {
      const t = targetFor(db, user, 'redmine', env);
      if (t.local && !target.local)
        throw Error('Для публикации в корпоративном Confluence выберите реальную задачу Redmine');
      const i = await (
        await trackerClient(store, user, t, env, send, input.caseId, sharedOnly)
      ).read(input.issueKey);
      issue = { key: i.key, url: i.url, target: t };
    }
    const current = input.key ? await client.read(input.key) : null;
    const originKey = input.resultPage || (target.local && input.key);
    const versions = new Set(input.sourceVersions);
    if (originKey) {
      const origin = demoClient(db, user, 'confluence', input.caseId, sharedOnly).read(originKey);
      const result = db
        .prepare(
          `SELECT r.body,r.case_id FROM redmine_results r JOIN redmine_result_pages rp ON rp.result=r.id
        WHERE rp.page=? ORDER BY r.created DESC LIMIT 1`,
        )
        .get(originKey);
      if (result && (result.case_id !== input.caseId || (issue && JSON.parse(result.body).url !== issue.url)))
        throw Error('Страница закрытия относится к другой задаче или разбору');
      if (input.resultPage && !target.local) {
        for (const link of publicPage(origin).links) {
          const match = link.url.match(/^#knowledge-source\/([a-f0-9]{64})$/);
          if (match) versions.add(match[1]);
        }
      }
    }
    const sources = sourceLinks(db, versions, target, env);
    body = pageDraft({ ...input, sources }, current, target, issue, 'pm-' + id);
    if (current && input.baseVersion !== undefined && input.baseVersion !== current.version)
      body.conflict = 'Страница изменилась. Сравните с версией ' + current.version;
  }
  db.prepare("INSERT OR IGNORE INTO draft_actions VALUES(?,?,?,?,'draft',NULL)").run(
    id,
    input.caseId,
    user.id,
    JSON.stringify(body),
  );
  return preview(db.prepare('SELECT * FROM draft_actions WHERE id=? AND user=?').get(id, user.id));
}
function cleanReceipt(r) {
  return { key: r.key, url: r.url };
}
export async function confirmTracker(store, user, row, revision, env, send) {
  const db = store.db,
    b = JSON.parse(row.body),
    id = row.id,
    marker = 'pm-' + id;
  if (row.state === 'done')
    return { ...(b.receipt || {}), key: row.external, local: !!b.target.local, state: 'done' };
  if (b.kind === 'page' && revision !== b.revision)
    throw Error('Откройте и подтвердите актуальный предпросмотр страницы');
  if (
    row.state === 'sending' ||
    !db.prepare("UPDATE draft_actions SET state='sending' WHERE id=? AND state=?").run(id, row.state).changes
  )
    throw Error('Подтверждение уже выполняется');
  const persist = (state) =>
    db
      .prepare('UPDATE draft_actions SET state=?,body=?,external=? WHERE id=?')
      .run(state, JSON.stringify(b), b.receipt?.key || null, id);
  let attempted = false;
  let uncertain = !!b.uncertain || (row.state === 'uncertain' && !!b.inFlight);
  function beforeWrite() {
    attempted = true;
    b.inFlight = b.receipt ? 'backlink' : 'main';
    persist('sending');
  }
  const getClient = (t) => trackerClient(store, user, t, env, send, row.case_id);
  async function refreshPage(client) {
    const current = await client.read(b.key);
    let fresh;
    try {
      fresh = pageDraft(b.input, current, b.target, b.issue, marker);
    } catch (e) {
      b.latestPage = publicPage(current);
      b.conflict = e.message;
      b.revision = randomUUID();
      b.reason = 'Исходный фрагмент изменился. Выберите текст для замены в свежей версии.';
      persist('obsolete');
      return { ...preview({ ...row, state: 'obsolete', body: JSON.stringify(b) }), state: 'obsolete' };
    }
    delete b.inFlight;
    Object.assign(b, fresh, {
      linkOnly: !!fresh.linkOnly,
      latestPage: publicPage(current),
      conflict: 'Страница изменилась. Проверьте изменения для версии ' + current.version,
      reason: '',
    });
    persist('draft');
    return preview({ ...row, state: 'draft', body: JSON.stringify(b) });
  }
  try {
    if (row.state === 'obsolete') throw Error('Подготовьте новый черновик по текущей версии');
    if (!b.receipt) {
      const api = await getClient(b.target);
      let result;
      if (uncertain) {
        result =
          b.kind === 'page' ? await api.recover(b.key, b.title, marker) : await api.recover(b.key, marker);
        if (!result)
          throw Error('Запись пока не подтверждена сервисом. Повторите сверку после проверки результата.');
      } else {
        if (b.key) {
          const current = await api.read(b.key);
          if (b.kind === 'page' && current.version !== b.version) return await refreshPage(api);
        }
        if (b.kind === 'page' && b.linkOnly) {
          result = { key: b.key, url: b.sourceUrl };
        } else if (b.kind === 'page') {
          try {
            result = await api.save(b.key, b.title, b.storage, b.version, beforeWrite);
          } catch (e) {
            if (e.status === 409 && b.key) {
              attempted = false;
              return await refreshPage(api);
            }
            throw e;
          }
        } else result = await api.save(b.key, b.changes, marker, beforeWrite);
      }
      b.receipt = cleanReceipt(result);
      delete b.inFlight;
      attempted = false;
      uncertain = false;
      b.uncertain = false;
      // A restart after this checkpoint may only reconcile or write the backlink.
      if (b.issue) persist('sending');
    }
    if (b.issue) {
      const api = await getClient(b.issue.target),
        backMarker = marker + '-link';
      const issue = await api.read(b.issue.key);
      const pageUrl =
        b.target.local && !b.issue.target.local
          ? new URL(b.receipt.url, env.APP_BASE_URL || 'http://127.0.0.1:8090').href
          : b.receipt.url;
      const note = (b.target.local ? 'База знаний · ' : 'Confluence · ') + pageUrl;
      const linked =
        issue.comments.some((c) =>
          c.text.split(/\r?\n/).some((line) => line === note || line === 'Confluence · ' + b.receipt.url),
        ) ||
        (uncertain && (await api.recover(b.issue.key, backMarker)));
      if (!linked) {
        if (uncertain) throw Error('Проверьте обратную ссылку в задаче и повторите сверку');
        await api.save(b.issue.key, { comment: note }, backMarker, beforeWrite);
      }
    }
    delete b.inFlight;
    b.reason = '';
    b.uncertain = false;
    watchIssue(db, row, b);
    persist('done');
    return { ...b.receipt, state: 'done', local: !!b.target.local };
  } catch (e) {
    const ambiguous = attempted && (!e.status || e.status >= 500 || e.status === 408);
    b.uncertain = uncertain || ambiguous;
    if (!b.uncertain) delete b.inFlight;
    b.reason = e.message;
    const state =
      row.state === 'obsolete' ? 'obsolete' : b.uncertain ? 'uncertain' : b.receipt ? 'partial' : 'draft';
    persist(state);
    if (b.receipt) return { ...b.receipt, state, reason: 'Страница сохранена. Обратная ссылка: ' + b.reason };
    throw e;
  }
}

export async function revisePage(store, user, row, input, env, send) {
  const old = JSON.parse(row.body);
  if (row.state !== 'obsolete' || old.revision !== input.revision || row.user !== user.id)
    throw Error('Откройте актуальный предпросмотр');
  if (typeof input.fragment !== 'string' || !input.fragment.trim() || input.fragment.length > 10000)
    throw Error('Выберите фрагмент свежей версии');
  const api = await trackerClient(store, user, old.target, env, send, row.case_id);
  const current = await api.read(old.key);
  const fresh = pageDraft(
    { ...old.input, fragment: input.fragment },
    current,
    old.target,
    old.issue,
    'pm-' + row.id,
  );
  const body = JSON.stringify(fresh);
  const saved = store.db
    .prepare(
      "UPDATE draft_actions SET body=?,state='draft' WHERE id=? AND user=? AND body=? AND state='obsolete'",
    )
    .run(body, row.id, user.id, row.body);
  if (!saved.changes) throw Error('Предпросмотр уже обновлён');
  return preview({ ...row, state: 'draft', body });
}

export async function caseLinks(store, user, caseId, env, send, sharedOnly) {
  const rows = store.db
    .prepare('SELECT body FROM draft_actions WHERE case_id=? AND external IS NOT NULL ORDER BY rowid DESC')
    .all(caseId);
  const candidates = new Map();
  for (const row of rows) {
    const b = JSON.parse(row.body);
    if (b.receipt) candidates.set(b.receipt.url, { ...b.receipt, target: b.target });
    if (b.issue) candidates.set(b.issue.url, b.issue);
  }
  const settings = connectionInfo(store.db, user, env),
    items = [];
  for (const { target, key } of candidates.values()) {
    const current = targetFor(store.db, user, target.service, env);
    if (
      !target.local &&
      (sharedOnly ||
        !settings[target.service].connected ||
        JSON.stringify(current) !== JSON.stringify(target))
    )
      continue;
    try {
      const api = await trackerClient(store, user, target, env, send, caseId, sharedOnly);
      const object = await api.read(key);
      items.push({ service: target.service, key: object.key, url: object.url, title: object.title });
    } catch (e) {
      if (!target.local && ![401, 403, 404].includes(e.status)) throw e;
    }
  }
  return { items };
}

export function publicPage(page) {
  return {
    key: page.key,
    title: page.title,
    version: page.version,
    url: page.url,
    text: page.storage
      .replace(
        /<ac:structured-macro ac:name="anchor"><ac:parameter ac:name="">pm-[\w-]+<\/ac:parameter><\/ac:structured-macro>/g,
        '',
      )
      .split(/<\/(?:p|h[1-6]|li|tr)>|<br\s*\/?>/i)
      .map(plain)
      .filter(Boolean)
      .join('\n'),
    links: [...page.storage.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
      .map((m) => ({ url: plain(m[1]), title: plain(m[2]) }))
      .filter((l) => /^(https?:\/\/|#demo-(issue|page)\/|#knowledge-source\/[a-f0-9]{64}$)/i.test(l.url)),
  };
}
