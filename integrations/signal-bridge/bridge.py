import datetime as dt
import hashlib
import json
import re
import sqlite3
import threading
import time
from contextlib import contextmanager
from urllib.parse import urlsplit

import metrika
import providers as services
from config import STATE, setting

report_lock = threading.Lock()
status_lock = threading.Lock()


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')


def encode(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'))


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


@contextmanager
def db():
    STATE.mkdir(mode=0o700,parents=True,exist_ok=True)
    c = sqlite3.connect(STATE/'bridge.sqlite',timeout=30)
    c.row_factory = sqlite3.Row
    try:
        with c:
            yield c
    finally:
        c.close()


def init():
    with db() as c:
        c.executescript('''
        CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY,body TEXT NOT NULL,checked TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tasks(ref TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,marker TEXT UNIQUE NOT NULL,
            report_id TEXT NOT NULL,title TEXT NOT NULL,remote INTEGER UNIQUE,status TEXT,closed INTEGER DEFAULT 0,
            episode INTEGER DEFAULT 0,updated TEXT,checked TEXT);
        CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,kind TEXT NOT NULL,text TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'pending',ready REAL DEFAULT 0,message_id INTEGER,error TEXT,created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS closures(seq INTEGER PRIMARY KEY,ref TEXT NOT NULL,episode INTEGER NOT NULL,
            body TEXT NOT NULL, UNIQUE(ref,episode));
        ''')


def event(c, key, kind, text):
    c.execute('INSERT OR IGNORE INTO events(id,kind,text,created) VALUES(?,?,?,?)',(key,kind,text,now()))


def refresh_report():
    with report_lock:
        data = metrika.fetch()
        threshold,minimum = float(setting('SIGNAL_THRESHOLD','20')),int(setting('SIGNAL_MIN_VISITS','20'))
        if not 0<threshold<=100 or minimum<1:
            raise ValueError('Проверьте SIGNAL_THRESHOLD и SIGNAL_MIN_VISITS.')
        status,delta = metrika.assess(data,threshold,minimum)
        record = {k:data[k] for k in ('counter','goals','start','end','periods','web')}
        record.update(status=status,delta_percent=delta,minimum_visits=minimum,threshold_percent=threshold)
        key = digest(encode(record))[:24]
        record['id'] = key
        stamp = now()
        with db() as c:
            c.execute('BEGIN IMMEDIATE')
            c.execute('INSERT OR REPLACE INTO reports VALUES(?,?,?)',(key,encode(record),stamp))
            c.execute('INSERT OR REPLACE INTO meta VALUES(?,?)',('latest',key))
            rule = 'incident:'+encode([record['counter'],record['goals'][-1],minimum,threshold])
            active = c.execute('SELECT value FROM meta WHERE key=?',(rule,)).fetchone()
            if status=='Сигнал' and not active:
                c.execute('INSERT INTO meta VALUES(?,?)',(rule,key))
                a,b = record['periods']
                event(c,'metrika:'+key,'metric_alert',f"Signal · доля визитов с корзиной снизилась. {a[-1]}/{a[0]} → {b[-1]}/{b[0]} ({delta:+.1f}%).\n{record['start']} — {record['end']}\n{record['web']}")
            if status=='Наблюдение':
                c.execute('DELETE FROM meta WHERE key=?',(rule,))
        return dict(record,checked_at=stamp)


def get_report(key=None):
    with db() as c:
        row = c.execute('SELECT body,checked FROM reports WHERE id=COALESCE(?,(SELECT value FROM meta WHERE key=?))',(key,'latest')).fetchone()
        if not row:
            raise LookupError('Отчёт не найден. Запросите POST /reports/refresh.')
        return dict(json.loads(row['body']),checked_at=row['checked'])


def task_view(row):
    result = dict(reference=row['ref'],report_id=row['report_id'],title=row['title'],redmine_id=row['remote'],
                  status=row['status'],closed=bool(row['closed']),checked_at=row['checked'])
    base = setting('REDMINE_PUBLIC_URL') or services.redmine_url()
    result['url'] = base.rstrip('/')+'/issues/'+str(row['remote']) if row['remote'] else None
    return result


def bind_target(c):
    target = services.redmine_url()+'|'+setting('REDMINE_PROJECT')
    c.execute('INSERT OR IGNORE INTO meta VALUES(?,?)',('tracker',target))
    if c.execute("SELECT value FROM meta WHERE key='tracker'").fetchone()[0]!=target:
        raise ValueError('Для другого проекта Redmine задайте отдельный SIGNAL_BRIDGE_STATE.')


def task(ref):
    with db() as c:
        bind_target(c)
        row = c.execute('SELECT * FROM tasks WHERE ref=?',(ref,)).fetchone()
        if not row:
            raise LookupError('Задача не зарегистрирована.')
        return task_view(row)


def choices(rows):
    return [{'id':str(r['id']), 'name':r['name']} for r in rows]


def issue_options():
    project = services.redmine(f'projects/{services.project()}.json?include=trackers')['project']
    priorities = services.redmine('enumerations/issue_priorities.json')['issue_priorities']
    members = []
    offset = 0
    while True:
        try:
            page = services.redmine(f"projects/{project['id']}/memberships.json?limit=100&offset={offset}")
        except services.ServiceError as exc:
            if exc.code == 403:
                break
            raise
        rows = page['memberships']
        members.extend(m['user'] for m in rows if 'user' in m)
        offset += len(rows)
        if not rows or offset >= page.get('total_count',offset):
            break
    return dict(trackers=choices(project['trackers']),priorities=choices(priorities),assignees=choices(members))


def issue_details(ref):
    tracked = task(ref)
    key = tracked['redmine_id']
    if not key:
        raise LookupError('Ожидается номер задачи Redmine.')
    issue = services.redmine(f'issues/{key}.json?include=journals,allowed_statuses')['issue']
    if issue['id'] != key or issue['project']['id'] != services.project():
        raise ValueError('Задача находится в другом проекте Redmine.')
    assignee = issue.get('assigned_to') or {}
    priority = issue.get('priority') or {}
    return dict(key='Redmine #'+str(key),url=tracked['url'],title=issue['subject'],description=issue.get('description') or '',
                status=issue['status']['name'],statusId=str(issue['status']['id']),statuses=choices(issue.get('allowed_statuses',[])),
                closingNote=closing_note(issue) if issue.get('closed_on') else None,
                priority=priority.get('name',''),priorityId=str(priority.get('id','')),assignee=assignee.get('name',''),
                assigneeId=str(assignee.get('id','')),comments=[{'author':j['user']['name'],'text':j['notes']}
                for j in issue.get('journals',[]) if j.get('notes') and not j.get('private_notes')])


def issue_fields(changes, creating=False):
    if not isinstance(changes,dict):
        raise ValueError('Некорректные поля Redmine.')
    fields = {}
    ids = {'trackerId':'tracker_id','priorityId':'priority_id','assigneeId':'assigned_to_id'}
    if not creating:
        ids['statusId'] = 'status_id'
    for k,v in changes.items():
        if k in ids:
            if k == 'assigneeId' and v == '':
                fields[ids[k]] = None
            elif re.fullmatch('[1-9][0-9]*',str(v)):
                fields[ids[k]] = int(v)
            else:
                raise ValueError('Некорректный идентификатор поля Redmine.')
        elif not creating and k in ('title','description','comment') and isinstance(v,str):
            fields[{'title':'subject','description':'description','comment':'notes'}[k]] = v
        else:
            raise ValueError('Неизвестное поле Redmine.')
    return fields


def change_issue(ref, payload):
    marker = payload.get('marker','')
    if payload.get('confirmed') is not True or not re.fullmatch(r'pm-[\w-]{1,140}',marker):
        raise ValueError('Нужны подтверждение и метка черновика.')
    current = issue_details(ref)
    if not any(marker in j['text'].splitlines() for j in current['comments']):
        fields = issue_fields(payload['changes'])
        if 'description' in fields:
            # Preserve the creation marker for reconciliation after edits.
            original = current['description']
            _, separator, tail = original.rpartition('\n\nSignal-Ref: ')
            if separator and tail and '\n' not in tail and ('Signal-Ref: '+tail) not in fields['description'].splitlines():
                fields['description'] += '\n\nSignal-Ref: '+tail
        fields['notes'] = '\n\n'.join(filter(None,[fields.get('notes'),marker]))
        services.redmine(f"issues/{task(ref)['redmine_id']}.json",{'issue':fields},'PUT')
    return {'key':current['key'],'url':current['url']}


def closing_note(issue):
    for journal in reversed(issue.get('journals',[])):
        if not any(d.get('name')=='status_id' and str(d.get('new_value'))==str(issue['status']['id'])
                   for d in journal.get('details',[])):
            continue
        if not journal.get('private_notes') and (journal.get('notes') or '').strip():
            # The PM workflow uses a separate line as its recovery marker.
            lines = [s for s in journal['notes'].splitlines() if not re.fullmatch(r'pm-[\w-]+',s)]
            text = '\n'.join(lines).strip()
            if text:
                return {'text':text,'author':(journal.get('user') or {}).get('name',''),'at':journal.get('created_on')}
        break
    return None


def report_text(report):
    a,b = report['periods']
    return (f"Источник: Яндекс Метрика, счётчик {report['counter']}. {report['start']} — {report['end']}.\n"
            f"Два окна по 7 дней, визиты с корзиной / все визиты: {a[-1]}/{a[0]} → {b[-1]}/{b[0]}. "
            f"Итог проверки: {report['status']}. Тестовые визиты исключены.\n{report['web']}")


def create_task(p):
    ref,title,detail = [str(p.get(k,'')).strip() for k in ('reference','title','description')]
    if (p.get('confirmed') is not True or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,99}',ref)
            or not 1<=len(title)<=240 or not 1<=len(detail)<=12000 or not isinstance(p.get('report_id'),str)):
        raise ValueError('Нужны reference, report_id, title, description и явное confirmed=true.')
    report_id = p['report_id']
    report = get_report(report_id) if report_id else None
    extra = issue_fields(p.get('fields',{}),creating=True)
    fingerprint = digest(encode([ref,title,detail,report_id] + ([extra] if extra else [])))
    project_id = services.project()
    marker = 'Signal-Ref: '+digest(encode([services.redmine_url(),project_id,ref]))[:36]
    with db() as c:
        c.execute('BEGIN IMMEDIATE')
        bind_target(c)
        existing = c.execute('SELECT * FROM tasks WHERE ref=?',(ref,)).fetchone()
        if existing:
            if existing['fingerprint']!=fingerprint:
                raise ValueError('Этот reference уже использован с другим содержимым.')
            if existing['remote']:
                return task_view(existing)
        else:
            c.execute('INSERT INTO tasks(ref,fingerprint,marker,report_id,title) VALUES(?,?,?,?,?)',
                      (ref,fingerprint,marker,report_id,title))
    if existing:
        found = services.find_marker(project_id,marker)
        if len(found)!=1:
            raise ValueError('Отправка ожидает сверки в Redmine. Число задач с меткой: '+str(len(found))+'. '+marker)
        issue = found[0]
    else:
        fields = dict(project_id=project_id,subject=title,description='\n\n'.join(filter(None,[detail,report_text(report) if report else None,marker])))
        tracker_id = setting('REDMINE_TRACKER_ID')
        if tracker_id:
            fields['tracker_id'] = int(tracker_id)
        fields.update(extra)
        try:
            issue = services.redmine('issues.json',{'issue':fields})['issue']
        except services.ServiceError as exc:
            if exc.code in (400,401,403,404,422,429):
                with db() as c:
                    c.execute('DELETE FROM tasks WHERE ref=? AND remote IS NULL',(ref,))
            raise
    if issue['project']['id']!=project_id:
        raise ValueError('Ответ Redmine относится к другому проекту.')
    with db() as c:
        c.execute('UPDATE tasks SET remote=?,status=?,checked=? WHERE ref=? AND remote IS NULL',
                  (int(issue['id']),issue['status']['name'],now(),ref))
    return task(ref)


def sync_tasks():
    with status_lock:
        with db() as c:
            bind_target(c)
            tasks = c.execute('''SELECT ref,remote,closed,EXISTS(SELECT 1 FROM closures
                WHERE closures.ref=tasks.ref AND closures.episode=tasks.episode) AS recorded
                FROM tasks WHERE remote IS NOT NULL ORDER BY ref''').fetchall()
        if not tasks:
            return {'checked':0,'errors':[]}
        project_id = services.project()
        statuses = {s['id']:s for s in services.redmine('issue_statuses.json')['issue_statuses']}
        errors = []
        for item in tasks:
            try:
                remote = services.redmine(f"issues/{item['remote']}.json")['issue']
                if remote['id']!=item['remote'] or remote['project']['id']!=project_id:
                    raise ValueError('Задача больше не принадлежит настроенному проекту Redmine.')
                status = statuses[remote['status']['id']]
                closed = status.get('is_closed',False)
                if closed and (not item['closed'] or not item['recorded']):
                    remote = services.redmine(f"issues/{item['remote']}.json?include=journals")['issue']
                    if remote['id']!=item['remote'] or remote['project']['id']!=project_id:
                        raise ValueError('Задача больше не принадлежит настроенному проекту Redmine.')
                    status = statuses[remote['status']['id']]
                    closed = status.get('is_closed',False)
                with db() as c:
                    c.execute('BEGIN IMMEDIATE')
                    row = c.execute('SELECT * FROM tasks WHERE ref=?',(item['ref'],)).fetchone()
                    episode = row['episode']
                    if closed and not row['closed']:
                        episode += 1
                        base = setting('REDMINE_PUBLIC_URL') or services.redmine_url()
                        link = '' if urlsplit(base).hostname in ('localhost','127.0.0.1','::1') else '\n'+base.rstrip('/')+'/issues/'+str(remote['id'])
                        if not item['ref'].startswith('web-draft-'):
                            event(c,f"closed:{row['marker']}:{episode}",'issue_closed',
                                  f"Redmine · задача #{remote['id']} закрыта\n{remote['subject']}\nСтатус: {status['name']} · {item['ref']}{link}")
                    if closed and not c.execute('SELECT 1 FROM closures WHERE ref=? AND episode=?',(item['ref'],episode)).fetchone():
                        report = json.loads(c.execute('SELECT body FROM reports WHERE id=?',(row['report_id'],)).fetchone()[0]) if row['report_id'] else None
                        base = setting('REDMINE_PUBLIC_URL') or services.redmine_url()
                        snapshot = dict(reference=item['ref'],episode=episode,issue=remote['id'],title=remote['subject'],
                                        status=status['name'],observed=now(),closed_on=remote.get('closed_on'),closing_note=closing_note(remote),
                                        url=base.rstrip('/')+'/issues/'+str(remote['id']),
                                        report={k:report[k] for k in ('id','start','end','periods','status','web')} if report else None)
                        c.execute('INSERT INTO closures(ref,episode,body) VALUES(?,?,?)',(item['ref'],episode,encode(snapshot)))
                    c.execute('UPDATE tasks SET status=?,closed=?,episode=?,updated=?,checked=? WHERE ref=?',
                              (status['name'],int(closed),episode,remote['updated_on'],now(),item['ref']))
            except (services.ServiceError,KeyError,ValueError) as exc:
                errors.append({'reference':item['ref'],'error':str(exc)})
        return {'checked':len(tasks)-len(errors),'errors':errors}


def deliver():
    if not setting('TELEGRAM_CHAT_ID') or not setting('TELEGRAM_BOT_TOKEN'):
        return {'sent':0,'configured':False}
    count = 0
    while True:
        with db() as c:
            c.execute('BEGIN IMMEDIATE')
            c.execute("UPDATE events SET state='uncertain',error='Проверьте историю доставки' WHERE state='sending' AND ready<?",(time.time()-120,))
            item = c.execute("SELECT * FROM events WHERE state='pending' AND ready<=? ORDER BY created,id LIMIT 1",(time.time(),)).fetchone()
            if not item:
                return {'sent':count,'configured':True}
            c.execute("UPDATE events SET state='sending',ready=? WHERE id=?",(time.time(),item['id']))
        try:
            message = services.send_message(item['text'])
        except (ValueError,KeyError,OSError) as exc:
            code = getattr(exc,'code',0)
            # A timeout can follow a successful send. Blind retry would duplicate it.
            state = 'pending' if code in (400,401,403,404,429) else 'uncertain'
            delay = max(1,getattr(exc,'retry_after',60))
            with db() as c:
                c.execute('UPDATE events SET state=?,ready=?,error=? WHERE id=?',(state,time.time()+delay,str(exc),item['id']))
            return {'sent':count,'configured':True,'error':str(exc),'state':state}
        with db() as c:
            c.execute("UPDATE events SET state='sent',message_id=?,error=NULL WHERE id=?",(message,item['id']))
        count += 1


def events():
    with db() as c:
        return [dict(r) for r in c.execute('SELECT id,kind,state,message_id,error,created,text FROM events ORDER BY created DESC,id LIMIT 100')]


def closures(after):
    if after < 0:
        raise ValueError('Нужен неотрицательный курсор.')
    with db() as c:
        return [dict(json.loads(r['body']),seq=r['seq']) for r in
                c.execute('SELECT seq,body FROM closures WHERE seq>? ORDER BY seq LIMIT 100',(after,))]
