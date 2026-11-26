import { randomUUID } from 'node:crypto';
import { plain } from './tracker-clients.mjs';
import { facts } from './evidence.mjs';

export function initTrackerDemo(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS demo_issue_details(key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS demo_pages(key TEXT PRIMARY KEY,case_id TEXT,title TEXT,storage TEXT,version INTEGER);
    CREATE TABLE IF NOT EXISTS private_wiki_pages(page TEXT PRIMARY KEY,user TEXT NOT NULL);`);
}
export function localHref(service, key) {
  return '#' + (service === 'redmine' ? 'demo-issue/' : 'demo-page/') + encodeURIComponent(key);
}
export function demoClient(db, user, service, caseId, sharedOnly = false) {
  function visible(id) {
    if (!id) return true;
    const c = db.prepare('SELECT body FROM cases WHERE id=?').get(id);
    if (!c) return false;
    const owner = JSON.parse(c.body).owner;
    return !owner || (!sharedOnly && owner === user.id);
  }
  if (service === 'confluence') {
    function visiblePage(row) {
      const acl = db.prepare('SELECT user FROM private_wiki_pages WHERE page=?').get(row.key);
      return visible(row.case_id) && (!acl || (!sharedOnly && acl.user === user.id));
    }
    function read(key) {
      const r = db.prepare('SELECT * FROM demo_pages WHERE key=?').get(key);
      if (!r || !visiblePage(r)) throw Error('Страница недоступна');
      return { ...r, url: localHref(service, key) };
    }
    return {
      read,
      search(q) {
        return db
          .prepare('SELECT key,title,storage,case_id FROM demo_pages ORDER BY rowid DESC')
          .all()
          .filter(
            (r) =>
              visiblePage(r) &&
              (r.title + ' ' + r.key + ' ' + plain(r.storage)).toLowerCase().includes(q.toLowerCase()),
          )
          .slice(0, 25)
          .map((r) => ({ key: r.key, title: r.title, url: localHref(service, r.key) }));
      },
      save(key, title, storage, version) {
        if (key) {
          read(key);
          if (
            !db
              .prepare('UPDATE demo_pages SET title=?,storage=?,version=version+1 WHERE key=? AND version=?')
              .run(title, storage, key, version).changes
          )
            throw Object.assign(Error('Версия страницы изменилась'), { status: 409 });
        } else {
          key = 'PAGE-' + randomUUID();
          db.prepare('INSERT INTO demo_pages VALUES(?,?,?,?,1)').run(key, caseId, title, storage);
        }
        return { key, url: localHref(service, key) };
      },
      recover(key, title, marker) {
        return db
          .prepare('SELECT key,case_id FROM demo_pages WHERE instr(storage,?)>0')
          .all(marker)
          .filter((r) => visiblePage(r) && (!key || key === r.key))
          .map((r) => read(r.key))[0];
      },
    };
  }
  const priorities = ['Low', 'Normal', 'High', 'Urgent'].map((name) => ({ id: name, name }));
  const statuses = ['Новая', 'В работе', 'Завершена'].map((name) => ({ id: name, name }));
  const assignees = [{ id: user.id, name: user.name || 'Участник' }];
  function tasks() {
    const imported = facts(db, 'backlog').map((f) => ({
      key: f.key,
      title: f.data.title,
      description: f.data.description_short || '',
      priority: 'Normal',
    }));
    if (!imported.length)
      imported.push({
        key: 'DEMO-START',
        title: 'Проверить путь покупки',
        description: 'Исследовать переход из подбора в корзину',
        priority: 'Normal',
      });
    const items = new Map(imported.map((i) => [i.key, i]));
    for (const i of db.prepare('SELECT * FROM local_issues').all()) {
      if (visible(i.case_id)) items.set(i.key, i);
      else items.delete(i.key);
    }
    return items;
  }
  function read(key) {
    const i = tasks().get(key);
    if (!i) throw Error('Задача недоступна в локальном бэклоге');
    const data = JSON.parse(
      db.prepare('SELECT data FROM demo_issue_details WHERE key=?').get(key)?.data || '{}',
    );
    return {
      key,
      title: i.title,
      description: i.description,
      priority: i.priority,
      priorityId: i.priority,
      comments: [],
      statusId: 'Новая',
      status: 'Новая',
      assigneeId: '',
      assignee: '',
      ...data,
      statuses,
      url: localHref(service, key),
    };
  }
  return {
    read,
    options: () => ({ priorities, assignees, trackers: [{ id: 'task', name: 'Задача' }] }),
    search(q) {
      return [...tasks().values()]
        .filter((i) => (i.title + ' ' + i.description + ' ' + i.key).toLowerCase().includes(q.toLowerCase()))
        .slice(0, 25)
        .map((i) => ({ key: i.key, title: i.title, url: localHref(service, i.key) }));
    },
    save(key, changes, marker) {
      const old = key ? read(key) : { comments: [], priorityId: 'Normal', statusId: 'Новая', assigneeId: '' };
      key ||= 'DEMO-' + randomUUID();
      const next = { ...old, ...changes },
        comments = [...old.comments];
      if (changes.comment) comments.push({ author: user.name || 'Участник', text: changes.comment });
      const metadata = {
        comments,
        markers: [...(old.markers || []), marker],
        status: next.statusId,
        statusId: next.statusId,
        assigneeId: next.assigneeId,
        assignee: next.assigneeId === user.id ? assignees[0].name : next.assigneeId ? old.assignee : '',
      };
      db.prepare(
        'INSERT INTO local_issues VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET title=excluded.title,description=excluded.description,priority=excluded.priority,updated=excluded.updated',
      ).run(key, next.title, next.description || '', next.priorityId, caseId || '', Date.now());
      db.prepare('INSERT OR REPLACE INTO demo_issue_details VALUES(?,?)').run(key, JSON.stringify(metadata));
      return { key, url: localHref(service, key) };
    },
    recover(key, marker) {
      for (const i of tasks().values())
        if ((!key || key === i.key) && read(i.key).markers?.includes(marker)) return read(i.key);
    },
  };
}
