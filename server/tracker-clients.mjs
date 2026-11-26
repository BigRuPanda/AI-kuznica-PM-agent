// Remote IDs and storage-format content are kept separate from user-visible labels.
export function numeric(value) {
  if (!/^[1-9]\d*$/.test(String(value))) throw Error('Некорректный номер внешнего объекта');
  return String(value);
}
export function escapeXml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c],
  );
}
const entityPattern = /&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi;
function decodeEntity(entity) {
  const key = entity.slice(1, -1).toLowerCase();
  if (key.startsWith('#')) {
    const n = key.startsWith('#x') ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : entity;
  }
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }[key];
}
export function decodeText(value) {
  return value.replace(entityPattern, decodeEntity);
}
export function storageOffset(raw, offset) {
  let extra = 0;
  for (const m of raw.matchAll(entityPattern)) {
    if (m.index - extra >= offset) break;
    extra += m[0].length - decodeEntity(m[0]).length;
  }
  return offset + extra;
}
export function plain(storage) {
  return decodeText(
    String(storage)
      .replace(/<\/(p|h[1-6]|li|tr)>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  ).trim();
}
export async function exchange(send, label, url, options = {}) {
  const response = await send(String(url), {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) {
    const reason = {
      401: 'переподключите личный доступ',
      403: 'недостаточно прав',
      404: 'объект недоступен',
      409: 'версия изменилась',
      422: 'проверьте поля и допустимые переходы',
      429: 'повторите запрос позже',
    }[response.status];
    throw Object.assign(
      Error(label + ' · ' + (reason || 'ошибка сервиса') + ' (HTTP ' + response.status + ')'),
      { status: response.status },
    );
  }
  const text = await response.text();
  return text.trim() ? JSON.parse(text) : {};
}
function client(send, label, base, headers) {
  return (path, method = 'GET', data) =>
    exchange(send, label, base + path, {
      method,
      headers: {
        ...headers,
        Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      body: data ? JSON.stringify(data) : undefined,
    });
}
const list = (rows = []) => rows.map((r) => ({ id: String(r.id), name: r.name }));
export function redmine(target, token, send) {
  const call = client(send, 'Redmine', target.url, { 'X-Redmine-API-Key': token });
  const projectPath = '/projects/' + encodeURIComponent(target.scope);
  async function project() {
    return (await call(projectPath + '.json?include=trackers')).project;
  }
  function item(i) {
    return {
      key: String(i.id),
      url: target.url + '/issues/' + numeric(i.id),
      title: i.subject,
      description: i.description || '',
      status: i.status?.name || '',
      priority: i.priority?.name || '',
      assignee: i.assigned_to?.name || '',
      statusId: String(i.status?.id || ''),
      priorityId: String(i.priority?.id || ''),
      assigneeId: String(i.assigned_to?.id || ''),
      comments: (i.journals || [])
        .filter((j) => j.notes)
        .map((j) => ({ author: j.user?.name, text: j.notes })),
      statuses: list(i.allowed_statuses),
    };
  }
  async function read(key) {
    const p = await project();
    const { issue } = await call(
      '/issues/' + numeric(String(key).trim().replace(/^#/, '')) + '.json?include=journals,allowed_statuses',
    );
    if (String(issue.project.id) !== String(p.id)) throw Error('Задача другого проекта');
    return item(issue);
  }
  async function search(query, all = false) {
    const p = await project();
    const params = new URLSearchParams({
      project_id: String(p.id),
      subproject_id: '!*',
      status_id: all ? '*' : 'open',
      limit: '20',
      sort: 'updated_on:desc',
    });
    const number = query.trim().match(/^#?([1-9]\d*)$/);
    if (number) {
      params.set('issue_id', number[1]);
      params.set('status_id', '*');
    } else if (query.trim()) {
      const q = new URLSearchParams({ q: query, issues: '1', limit: '20' });
      if (!all) q.set('open_issues', '1');
      const found = await call(projectPath + '/search.json?' + q);
      const ids = (found.results || [])
        .filter((r) => ['issue', 'issue-closed'].includes(r.type))
        .map((r) => numeric(r.id));
      if (!ids.length) return [];
      params.set('issue_id', ids.join(','));
    }
    return (await call('/issues.json?' + params)).issues
      .filter((i) => String(i.project.id) === String(p.id))
      .map(item);
  }
  return {
    async check() {
      const { user } = await call('/users/current.json');
      if (!user?.id) throw Error('Переподключите личный доступ к Redmine');
      return project();
    },
    read,
    search,
    async options() {
      const p = await project(),
        priorities = await call('/enumerations/issue_priorities.json');
      const members = [];
      for (let offset = 0; ; ) {
        const page = await call(projectPath + '/memberships.json?limit=100&offset=' + offset).catch((e) => {
          if (e.status === 403) return { memberships: [] };
          throw e;
        });
        const rows = page.memberships || [];
        members.push(...rows.map((r) => r.user || r.group).filter(Boolean));
        offset += rows.length;
        if (!rows.length || offset >= (page.total_count ?? offset)) break;
      }
      return {
        priorities: list(priorities.issue_priorities),
        assignees: list(members),
        trackers: list(p.trackers),
      };
    },
    async save(key, changes, marker, beforeWrite) {
      const fields = {};
      const names = {
        title: 'subject',
        description: 'description',
        statusId: 'status_id',
        priorityId: 'priority_id',
        assigneeId: 'assigned_to_id',
        trackerId: 'tracker_id',
      };
      for (const [k, v] of Object.entries(changes))
        if (names[k]) fields[names[k]] = k.endsWith('Id') ? (v ? Number(numeric(v)) : null) : v;
      if (key) {
        fields.notes = [changes.comment, marker].filter(Boolean).join('\n\n');
        beforeWrite?.();
        await call('/issues/' + numeric(key) + '.json', 'PUT', { issue: fields });
        return { key: String(key), url: target.url + '/issues/' + numeric(key) };
      }
      fields.project_id = (await project()).id;
      fields.description = [fields.description, 'Сгенерирована ИИ-помощником.', marker]
        .filter(Boolean)
        .join('\n\n');
      beforeWrite?.();
      const { issue } = await call('/issues.json', 'POST', { issue: fields });
      return { key: numeric(issue.id), url: target.url + '/issues/' + numeric(issue.id) };
    },
    async recover(key, marker) {
      const matches = key ? [await read(key)] : await search(marker, true);
      return matches.find(
        (i) => i.description.includes(marker) || i.comments.some((j) => j.text.includes(marker)),
      );
    },
  };
}

export function confluence(target, credential, send) {
  const cloud = target.edition === 'cloud';
  const api = cloud
    ? 'https://api.atlassian.com/ex/confluence/' + encodeURIComponent(credential.cloudId) + '/wiki'
    : target.url;
  const call = client(send, 'Confluence', api, { Authorization: 'Bearer ' + credential.token });
  const prefix = cloud ? '/api/v2/pages' : '/rest/api/content';
  const quote = (v) => '"' + String(v).replace(/([\\"])/g, '\\$1') + '"';
  async function space() {
    if (!cloud) return (await call('/rest/api/space/' + encodeURIComponent(target.scope))).id;
    const s = (await call('/api/v2/spaces?keys=' + encodeURIComponent(target.scope))).results.find(
      (s) => s.key === target.scope,
    );
    if (!s) throw Error('Пространство Confluence недоступно');
    return s.id;
  }
  function pageUrl(id) {
    return target.url + (cloud ? '/wiki' : '') + '/pages/viewpage.action?pageId=' + numeric(id);
  }
  async function read(id) {
    const p = await call(
      prefix + '/' + numeric(id) + (cloud ? '?body-format=storage' : '?expand=space,version,body.storage'),
    );
    if (cloud ? String(p.spaceId) !== String(await space()) : p.space?.key !== target.scope)
      throw Error('Страница другого пространства');
    if (p.type && p.type !== 'page') throw Error('Выберите страницу');
    if (typeof p.body?.storage?.value !== 'string') throw Error('Содержимое страницы недоступно');
    return {
      key: String(p.id),
      title: p.title,
      storage: p.body.storage.value,
      version: p.version.number,
      url: pageUrl(p.id),
    };
  }
  async function search(query, exact = false) {
    const cql =
      'type=page AND space=' +
      quote(target.scope) +
      (query ? ' AND ' + (exact ? 'title=' : 'text~') + quote(query) : '');
    const r = await call('/rest/api/content/search?' + new URLSearchParams({ cql, limit: '25' }));
    return (r.results || []).map((p) => ({ key: String(p.id), title: p.title, url: pageUrl(p.id) }));
  }
  return {
    async check() {
      if (!cloud) {
        const current = await call('/rest/api/user/current');
        if (current.type !== 'known' || !(current.userKey || current.username))
          throw Error('Переподключите личный доступ к Confluence');
      }
      return space();
    },
    read,
    search,
    async save(key, title, storage, version, beforeWrite) {
      const body = cloud
        ? { representation: 'storage', value: storage }
        : { storage: { representation: 'storage', value: storage } };
      const payload = cloud
        ? { spaceId: String(await space()), status: 'current', title, body }
        : { type: 'page', space: { key: target.scope }, title, body };
      if (key) {
        payload.id = numeric(key);
        payload.version = { number: version + 1 };
      }
      beforeWrite?.();
      const r = await call(prefix + (key ? '/' + key : ''), key ? 'PUT' : 'POST', payload);
      return { key: numeric(r.id || key), url: pageUrl(r.id || key) };
    },
    async recover(key, title, marker) {
      const candidates = key ? [{ key }] : await search(title, true);
      for (const candidate of candidates) {
        const p = await read(candidate.key);
        if (p.storage.includes(marker)) return p;
      }
    },
  };
}
