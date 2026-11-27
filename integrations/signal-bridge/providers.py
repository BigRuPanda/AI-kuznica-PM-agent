import json
from urllib import error, parse, request

from config import setting


class ServiceError(ValueError):
    def __init__(self, message, code=0, retry_after=60):
        super().__init__(message)
        self.code = code
        self.retry_after = retry_after


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def request_json(url, headers=None, data=None, method=None, timeout=18):
    headers = {'Accept':'application/json', **(headers or {})}
    body = None
    if data is not None:
        body = json.dumps(data,ensure_ascii=False).encode()
        headers['Content-Type'] = 'application/json'
    req = request.Request(url,data=body,headers=headers,method=method)
    handlers = [NoRedirect()]
    if parse.urlsplit(url).hostname in ('127.0.0.1','localhost','::1'):
        handlers.append(request.ProxyHandler({}))
    try:
        with request.build_opener(*handlers).open(req,timeout=timeout) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}
    except error.HTTPError as exc:
        wait = exc.headers.get('Retry-After','60')
        try:
            payload = json.loads(exc.read(32768))
            wait = payload.get('parameters',{}).get('retry_after',wait)
        except (ValueError,AttributeError,OSError):
            pass
        raise ServiceError(f'{parse.urlsplit(url).hostname} · HTTP {exc.code}',exc.code,
                           int(wait) if str(wait).isdigit() else 60) from None
    except (OSError,ValueError) as exc:
        raise ServiceError(f'{parse.urlsplit(url).hostname} · нет подтверждённого ответа') from None


def redmine_url():
    url = setting('REDMINE_URL').rstrip('/')
    target = parse.urlsplit(url)
    if (not target.hostname or target.username or target.password or target.query or target.fragment
        or not (target.scheme=='https' or (target.scheme=='http' and target.hostname in ('127.0.0.1','localhost','::1')))):
        raise ValueError('Настройте REDMINE_URL. HTTP разрешён для локального стенда.')
    return url


def redmine(path,data=None,method=None):
    key = setting('REDMINE_API_KEY')
    if not key:
        raise ValueError('Требуется REDMINE_API_KEY.')
    return request_json(redmine_url()+'/'+path,{'X-Redmine-API-Key':key},data,method)


def project():
    ident = setting('REDMINE_PROJECT')
    if not ident:
        raise ValueError('Требуется REDMINE_PROJECT.')
    return redmine('projects/'+parse.quote(ident,safe='')+'.json')['project']['id']


def find_marker(project_id, marker):
    offset, matches = 0, []
    while True:
        query = parse.urlencode(dict(project_id=project_id,status_id='*',limit=100,offset=offset,sort='id:asc'))
        page = redmine('issues.json?'+query)
        issues = page['issues']
        matches.extend(i for i in issues if i['project']['id']==project_id and marker in (i.get('description') or '').splitlines())
        offset += len(issues)
        if offset>=page['total_count']:
            return matches
        if not issues:
            raise ServiceError('Redmine вернул неполный список задач.')

def project_issues(queries):
    """Return metadata for public, untracked issues within the configured project."""
    if not 1 <= len(queries) <= 6 or any(not 1 <= len(q.strip()) <= 240 for q in queries):
        raise ValueError('Укажите до шести поисковых фраз длиной до 240 символов.')
    terms = {' '.join(q.casefold().split()) for q in queries}
    project_id, offset, matches = project(), 0, []
    base = (setting('REDMINE_PUBLIC_URL') or redmine_url()).rstrip('/')
    while True:
        params = parse.urlencode(dict(project_id=project_id, subproject_id='!*',
                                      status_id='*', limit=100, offset=offset, sort='updated_on:desc,id:desc'))
        page = redmine('issues.json?'+params)
        issues = page['issues']
        for issue in issues:
            if issue['project']['id'] != project_id or issue.get('is_private') is not False:
                continue
            description = issue.get('description') or ''
            if any(line.startswith('Signal-Ref: ') for line in description.splitlines()):
                continue
            title = issue['subject']
            normalized = ' '.join(title.casefold().split())
            searchable = normalized + ' ' + ' '.join(description.casefold().split())
            if any(term in searchable for term in terms):
                matches.append((normalized in terms, dict(key='Redmine #'+str(issue['id']),
                    url=base+'/issues/'+str(issue['id']), title=title, status=issue['status']['name'])))
        offset += len(issues)
        if offset >= page['total_count']:
            matches.sort(key=lambda row: row[0], reverse=True)
            return [item for _, item in matches[:25]]
        if not issues:
            raise ServiceError('Redmine вернул неполный список задач.')


def telegram(method, data, token=None, timeout=18):
    import re
    token = token or setting('TELEGRAM_BOT_TOKEN')
    if not re.fullmatch(r'[0-9]+:[A-Za-z0-9_-]+',token):
        raise ValueError('Требуется токен Telegram-бота.')
    value = request_json('https://api.telegram.org/bot'+token+'/'+method,data=data,timeout=timeout)
    if value.get('ok') is not True:
        raise ServiceError('Telegram не подтвердил операцию.')
    return value['result']


def send_message(text):
    chat = setting('TELEGRAM_CHAT_ID')
    if not chat or not setting('TELEGRAM_BOT_TOKEN'):
        raise ValueError('Telegram ожидает привязки чата.')
    result = telegram('sendMessage',dict(chat_id=chat,text=text,link_preview_options={'is_disabled':True}))
    if str(result['chat']['id'])!=str(chat) or not isinstance(result.get('message_id'),int):
        raise ServiceError('Telegram не подтвердил сообщение в выбранном чате.')
    return result['message_id']
