import { randomUUID } from 'node:crypto';
import { digest, getCase } from './evidence.mjs';
import { targetFor, remoteClient, initConnections, connectionInfo } from './tracker-connections.mjs';
import { aiOrigin, aiNotice, withAiNotice, escapeXml, plain, decodeText, storageOffset } from './tracker-clients.mjs';
import { demoClient, initTrackerDemo, localHref } from './tracker-demo.mjs';
import { requireActionableRun, visibleRun } from './case-investigations.mjs';
import { initRedmine, bridgeTracker, draftReport } from './redmine-bridge.mjs';
import { initWatches, watchIssue } from './redmine-watch.mjs';

export function initTracking(db, env = process.env) {
  initConnections(db);
  initTrackerDemo(db);
  initRedmine(db);
  for (const row of db
    .prepare("SELECT id,case_id,body,external,state FROM draft_actions WHERE json_extract(body,'$.target') IS NULL")
    .all()) {
    const b = JSON.parse(row.body);
    const tracked = db.prepare('SELECT reference,report FROM redmine_drafts WHERE draft=?').get(row.id);
    b.target = tracked
      ? { service: 'redmine', bridge: true, url: env.SIGNAL_BRIDGE_URL?.replace(/\/+$/, ''), scope: 'Signal Bridge' }
      : { service: 'redmine', local: true };
    if (tracked) b.report = { id: tracked.report };
    b.kind = 'issue';
    if (row.state === 'done' && row.external) {
      const result = tracked && db.prepare(`SELECT json_extract(body,'$.url') AS url FROM redmine_results
        WHERE json_extract(body,'$.reference')=? LIMIT 1`).get(tracked.reference);
      b.receipt = { key: row.external, url: tracked ? result?.url || '#case/' + row.case_id : localHref('redmine', row.external) };
    }
    b.diff = b.key
      ? [{ field: 'Приоритет', before: '', after: b.priority }]
      : [{ field: 'Описание', before: '', after: b.description }];
    b.changes = b.key ? { priorityId: b.priority } : { title: b.title, description: b.description };
    db.prepare('UPDATE draft_actions SET body=? WHERE id=?').run(JSON.stringify(b), row.id);
  }
  initWatches(db);
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
    ...(api.repairOrigin && {
      repairOrigin: (issue, beforeRepair) => store.tx(() => {
        beforeRepair?.();
        return api.repairOrigin(issue);
      }),
    }),
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
    ? 'Локальное демо · ' + (t.service === 'redmine' ? 'задачи' : 'страницы')
    : t.url + ' · ' + t.scope;
}
export function preview(row) {
  const b = JSON.parse(row.body);
  return {
    id: row.id,
    caseId: row.case_id,
    investigationId: b.investigationId,
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
async function issueDraft(client, input, target, assistantAuthored) {
  const current = input.key ? await client.read(input.key) : {};
  const generated = !input.key && assistantAuthored;
  if (generated || (current.origin === aiOrigin && input.description !== undefined))
    input = {...input, description: withAiNotice(input.description)};
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
  if (generated) {
    changes.origin = aiOrigin;
    diff.push({field: 'Происхождение задачи', before: '', after: aiOrigin});
  }
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
    issue,
    revision: randomUUID(),
  };
}
function sameTarget(db, user, target, env) {
  const current = targetFor(db, user, target.service, env);
  if (target.bridge && current.bridge && !target.url) return true;
  return JSON.stringify(current) === JSON.stringify(target);
}

function requireDraftVersion(db, user, caseId, draft, env) {
  if (draft.investigationId) {
    requireActionableRun(db, user, caseId, draft.investigationId);
    if (!sameTarget(db, user, draft.target, env))
      throw Error('Назначение изменилось. Подготовьте новый черновик.');
  }
  if (draft.signalRevision !== undefined) {
    const c = getCase(db, caseId);
    const signal = c.body.signal;
    if (c.body.owner && c.body.owner !== user.id) throw Error('Разбор недоступен');
    if (!signal || signal.status === 'withdrawn' || c.state === 'Завершено')
      throw Error('В разборе нет действующего сигнала');
    if ((signal.revision ?? 0) !== draft.signalRevision)
      throw Error('Сигнал изменился. Подготовьте черновик по текущей версии.');
  }
}

function legacySignalRevision(row, draft) {
  if (draft.kind !== 'issue' || draft.key || !draft.description) return;
  const prefix = 'Разбор ' + row.case_id + ', версия сигнала ';
  for (const line of draft.description.split(/\r?\n/)) {
    if (!line.startsWith(prefix)) continue;
    const raw = line.slice(prefix.length);
    if (!/^\d+\.$/.test(raw)) continue;
    const revision = Number(raw.slice(0, -1));
    if (row.id === digest(JSON.stringify(['signal-issue-draft', row.user, row.case_id, revision])))
      return revision;
  }
}

export async function prepareTracker(store, user, kind, input, env, send, requestId, sharedOnly = false, assistantAuthored = false, binding) {
  const db = store.db,
    id = requestId || randomUUID();
  const select = db.prepare('SELECT * FROM draft_actions WHERE id=? AND user=?');
  const existing = select.get(id, user.id);
  if (existing && !binding?.selection && !(binding && existing.state === 'obsolete')) return preview(existing);
  const service = kind === 'page' ? 'confluence' : 'redmine';
  const target = binding?.target || (input.local ? { service, local: true } : targetFor(db, user, service, env));
  const client = await trackerClient(store, user, target, env, send, input.caseId, sharedOnly);
  let body;
  if (kind === 'issue') {
    const selection = binding?.selection;
    if (selection) {
      const items = await client.search(selection.query);
      if (!items.some(item => item.key === selection.key && item.url === selection.url))
        throw Error('Выберите доступную задачу из результатов поиска.');
    }
    body = await issueDraft(client, input, target, assistantAuthored);
    if (!body.key && !target.local && !target.bridge) {
      await client.checkOriginConfiguration(body.changes.origin);
      if (env.REDMINE_REQUIRE_AI_FLAG === 'true') body.requireGeneratedFlag = true;
    }
    if (input.includeReport && !env.SOURCE_ARCHIVE_SHA256 && !body.key && !target.local && env.SIGNAL_BRIDGE_URL) {
      if (!input.description?.trim()) throw Error('Укажите описание проверки для задачи с отчётом Метрики');
      const report = body.report = await draftReport(env, send);
      const source = [report.start + ' — ' + report.end, report.status, report.web].join('\n');
      body.diff.push({ field: 'Снимок Метрики', before: '', after: source });
      if (!target.bridge) body.changes.description = [body.description, 'Снимок Метрики', source].join('\n');
    }
    if (selection) {
      if (body.key !== selection.key) throw Error('Выберите доступную задачу из результатов поиска.');
      body.sourceUrl = selection.url;
    }
  } else {
    let issue;
    if (input.issueKey) {
      const t = targetFor(db, user, 'redmine', env);
      if (!!t.local !== !!target.local)
        throw Error('Для взаимных ссылок настройте обе системы в одном режиме');
      const i = await (
        await trackerClient(store, user, t, env, send, input.caseId, sharedOnly)
      ).read(input.issueKey);
      issue = { key: i.key, url: i.url, target: t };
    }
    const current = input.key ? await client.read(input.key) : null;
    body = pageDraft(input, current, target, issue, 'pm-' + id);
    if (current && input.baseVersion !== undefined && input.baseVersion !== current.version)
      body.conflict = 'Страница изменилась. Сравните с версией ' + current.version;
  }
  const save = () => {
    if (binding) {
      body.investigationId = binding.runId;
      body.signalRevision = binding.signalRevision;
      requireDraftVersion(db, user, input.caseId, body, env);
    }
    const serialized = JSON.stringify(body);
    if (binding && existing) {
      db.prepare(`UPDATE draft_actions SET body=?,state='draft'
        WHERE id=? AND user=? AND state='obsolete' AND external IS NULL
          AND json_extract(body,'$.receipt') IS NULL AND json_extract(body,'$.inFlight') IS NULL
          AND json_extract(body,'$.uncertain') IS NOT 1`).run(serialized, id, user.id);
    }
    db.prepare("INSERT OR IGNORE INTO draft_actions VALUES(?,?,?,?,'draft',NULL)")
      .run(id, input.caseId, user.id, serialized);
    return preview(select.get(id, user.id));
  };
  return binding ? store.tx(save) : save();
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
  b.signalRevision ??= legacySignalRevision(row, b);
  const versionBound = b.investigationId || b.signalRevision !== undefined;
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
  let obsolete = row.state === 'obsolete';
  function checkVersion() {
    if (!versionBound) return;
    try {
      requireDraftVersion(db, user, row.case_id, b, env);
    } catch (e) {
      obsolete = true;
      throw e;
    }
  }
  function checkWriteAccess() {
    checkVersion();
    const owner = getCase(db, row.case_id).body.owner;
    if (owner && owner !== user.id) throw Error('Разбор недоступен');
    const target = b.receipt && b.issue ? b.issue.target : b.target;
    if (!target.local && !sameTarget(db, user, target, env))
      throw Error('Назначение изменилось. Подготовьте новый черновик.');
  }
  function beforeWrite(addMapping) {
    checkWriteAccess();
    const checkpoint = () => {
      b.inFlight = b.receipt ? 'backlink' : 'main';
      persist('sending');
      addMapping?.();
    };
    if (addMapping) store.tx(checkpoint);
    else checkpoint();
    attempted = true;
  }
  const getClient = (t) => trackerClient(store, user, t, env, send, row.case_id);
  const verifyOrigin = b.kind === 'issue' && !b.key && !b.target.bridge &&
    (b.changes?.origin === aiOrigin || b.requireGeneratedFlag);
  const hasReceipt = !!b.receipt;
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
      latestPage: publicPage(current),
      conflict: 'Страница изменилась. Проверьте изменения для версии ' + current.version,
      reason: '',
    });
    persist('draft');
    return preview({ ...row, state: 'draft', body: JSON.stringify(b) });
  }
  try {
    if (obsolete) throw Error('Подготовьте новый черновик по текущей версии');
    if (!b.receipt) {
      if (!uncertain) checkVersion();
      const api = await getClient(b.target);
      let result;
      if (uncertain) {
        result =
          b.kind === 'page' ? await api.recover(b.key, b.title, marker) : await api.recover(b.key, marker, checkWriteAccess);
        if (!result)
          throw Error('Запись пока не подтверждена сервисом. Повторите сверку после проверки результата.');
      } else {
        if (b.key) {
          const current = await api.read(b.key);
          if (b.investigationId && current.key !== b.key) {
            obsolete = true;
            throw Error('Задача изменилась. Подготовьте новый черновик.');
          }
          if (b.kind === 'page' && current.version !== b.version) return await refreshPage(api);
        }
        if (b.kind === 'page') {
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
      if (b.issue || b.kind === 'issue') persist('sending');
    }
    if (verifyOrigin) {
      // A field mapping may be corrected between confirmations. Keep the issue on its original site/project.
      const target = hasReceipt && !b.target.local
        ? { ...b.target, originFieldId: targetFor(db, user, 'redmine', env).originFieldId }
        : b.target;
      const api = await getClient(target);
      let issue = await api.read(b.receipt.key);
      const verified = issue => (b.changes?.origin !== aiOrigin || issue.origin === aiOrigin) && issue.description.split(/\r?\n/).includes(aiNotice) &&
        (!b.requireGeneratedFlag || issue.generatedFlag);
      if (issue.key !== b.receipt.key) throw Error('Redmine не подтвердил номер сохранённой задачи.');
      if (!verified(issue) && hasReceipt) {
        const checkRepair = () => {
          if (versionBound) requireDraftVersion(db, user, row.case_id, {...b, target}, env);
          const owner = getCase(db, row.case_id).body.owner;
          if (owner && owner !== user.id) throw Error('Разбор недоступен');
          if (!target.local && !sameTarget(db, user, target, env))
            throw Error('Назначение изменилось. Проверьте настройки Redmine.');
        };
        if (target.local) await api.repairOrigin(issue, checkRepair);
        else {
          await api.repairOrigin(issue, {
            generated: b.changes?.origin === aiOrigin, required: b.requireGeneratedFlag, beforeRepair: checkRepair,
          });
        }
        issue = await api.read(b.receipt.key);
      }
      if (!verified(issue)) throw Error('Метка ai-generated или пометка в описании отсутствует при чтении. Проверьте поле и права, затем повторите сверку.');
      b.target = target;
    }
    if (b.issue) {
      const api = await getClient(b.issue.target),
        backMarker = marker + '-link';
      const issue = await api.read(b.issue.key);
      const linked =
        issue.comments.some((c) => c.text.split(/\r?\n/).includes('Confluence · ' + b.receipt.url)) ||
        (uncertain && (await api.recover(b.issue.key, backMarker)));
      if (!linked) {
        if (uncertain) throw Error('Проверьте обратную ссылку в задаче и повторите сверку');
        await api.save(b.issue.key, { comment: 'Confluence · ' + b.receipt.url }, backMarker, beforeWrite);
      }
    }
    delete b.inFlight;
    b.reason = '';
    b.uncertain = false;
    store.tx(() => {
      watchIssue(db, row, b);
      persist('done');
    });
    return { ...b.receipt, state: 'done', local: !!b.target.local };
  } catch (e) {
    const ambiguous = attempted && !(versionBound && b.target.local) && (!e.status || e.status >= 500 || e.status === 408);
    b.uncertain = uncertain || ambiguous;
    if (!b.uncertain) delete b.inFlight;
    b.reason = e.message;
    const state =
      obsolete ? 'obsolete' : b.uncertain ? 'uncertain' : b.receipt ? 'partial' : 'draft';
    persist(state);
    if (b.receipt) return { ...b.receipt, state, reason: (b.kind === 'issue' ? 'Задача сохранена. ' : 'Страница сохранена. Обратная ссылка: ') + b.reason };
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
  const { db } = store;
  const rows = db
    .prepare('SELECT body FROM draft_actions WHERE case_id=? AND external IS NOT NULL ORDER BY rowid DESC')
    .all(caseId);
  const candidates = new Map();
  const visible = id => !id || visibleRun(db, user, caseId, id, sharedOnly);
  for (const row of rows) {
    const b = JSON.parse(row.body);
    if (!visible(b.investigationId)) continue;
    if (b.receipt) candidates.set(b.receipt.url, { ...b.receipt, target: b.target, investigationId: b.investigationId });
    if (b.issue) candidates.set(b.issue.url, b.issue);
  }
  const settings = connectionInfo(store.db, user, env),
    items = [];
  for (const { target, key, investigationId } of candidates.values()) {
    if (
      !target.local &&
      (sharedOnly ||
        !settings[target.service].connected ||
        !sameTarget(db, user, target, env))
    )
      continue;
    try {
      const api = await trackerClient(store, user, target, env, send, caseId, sharedOnly);
      const object = await api.read(key);
      if (visible(investigationId))
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
    text: plain(
      page.storage.replace(
        /<ac:structured-macro ac:name="anchor"><ac:parameter ac:name="">pm-[\w-]+<\/ac:parameter><\/ac:structured-macro>/g,
        '',
      ),
    ),
    links: [...page.storage.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
      .map((m) => ({ url: plain(m[1]), title: plain(m[2]) }))
      .filter((l) => /^(https?:\/\/|#demo-(issue|page)\/)/i.test(l.url)),
  };
}
