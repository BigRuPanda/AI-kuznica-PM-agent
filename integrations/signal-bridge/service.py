import argparse
import json
import logging
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, unquote, parse_qs

import bridge
from config import setting
from providers import ServiceError


def record_job(name, func):
    try:
        result = func()
        error = result.get('error') or result.get('errors') or None
    except Exception as exc:
        error = str(exc) if isinstance(exc,(ValueError,OSError)) else type(exc).__name__
    with bridge.db() as c:
        c.execute('INSERT OR REPLACE INTO meta VALUES(?,?)',('job:'+name,json.dumps(dict(at=bridge.now(),error=error),ensure_ascii=False)))


def worker(stop, refresh_reports=True):
    next_report = 0
    while not stop.is_set():
        if refresh_reports and time.monotonic()>=next_report:
            record_job('metrika',bridge.refresh_report)
            next_report = time.monotonic()+900
        record_job('redmine',bridge.sync_tasks)
        record_job('telegram',bridge.deliver)
        stop.wait(60)


class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):
        pass

    def reply(self, status, value):
        data = json.dumps(value,ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Content-Length',str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def route(self, post=False):
        host = self.headers.get('Host','')
        port = self.server.server_port
        if host not in (f'127.0.0.1:{port}',f'localhost:{port}'):
            return self.reply(403,{'error':'Разрешён только локальный хост.'})
        if self.headers.get('Origin') not in (None,'http://'+host):
            return self.reply(403,{'error':'Вызывайте модуль из серверной части приложения.'})
        try:
            path = urlsplit(self.path).path
            if post:
                size = int(self.headers.get('Content-Length','0'))
                if self.headers.get_content_type()!='application/json' or not 1<=size<=32768:
                    return self.reply(400,{'error':'Нужен JSON до 32 КиБ.'})
                p = json.loads(self.rfile.read(size))
                if not isinstance(p,dict):
                    raise ValueError('Нужен объект JSON.')
                if path=='/tasks': result = bridge.create_task(p)
                elif path.startswith('/tasks/') and path.endswith('/changes'):
                    result = bridge.change_issue(unquote(path[7:-8]),p)
                elif path=='/reports/refresh': result = bridge.refresh_report()
                elif path=='/sync': result = dict(redmine=bridge.sync_tasks(),telegram=bridge.deliver())
                else: return self.reply(404,{'error':'Метод не найден.'})
            elif path=='/health':
                with bridge.db() as c:
                    jobs = {r['key'][4:]:json.loads(r['value']) for r in c.execute("SELECT * FROM meta WHERE key LIKE 'job:%'")}
                    queue = {r[0]:r[1] for r in c.execute('SELECT state,count(*) FROM events GROUP BY state')}
                result = dict(service='signal-bridge',version=1,jobs=jobs,queue=queue,configured={
                    'metrika':bool(setting('METRIKA_TOKEN')),'redmine':bool(setting('REDMINE_URL') and setting('REDMINE_API_KEY') and setting('REDMINE_PROJECT')),
                    'telegram':bool(setting('TELEGRAM_BOT_TOKEN') and setting('TELEGRAM_CHAT_ID'))})
            elif path=='/reports/latest': result = bridge.get_report()
            elif path=='/issue-options': result = bridge.issue_options()
            elif path.startswith('/tasks/') and path.endswith('/details'):
                result = bridge.issue_details(unquote(path[7:-8]))
            elif path.startswith('/reports/'): result = bridge.get_report(path[9:])
            elif path.startswith('/tasks/'): result = bridge.task(unquote(path[7:]))
            elif path=='/events': result = bridge.events()
            elif path=='/closures':
                after = parse_qs(urlsplit(self.path).query).get('after',['0'])[0]
                result = bridge.closures(int(after))
            else: return self.reply(404,{'error':'Метод не найден.'})
            self.reply(200,result)
        except ServiceError as exc:
            status = exc.code if exc.code in (400,401,403,404,409,422,429) else 502
            self.reply(status,{'error':str(exc)})
        except LookupError as exc:
            self.reply(404,{'error':str(exc)})
        except (ValueError,TypeError) as exc:
            self.reply(400,{'error':str(exc)})
        except (ConnectionResetError,BrokenPipeError):
            pass
        except Exception as exc:
            logging.error('Bridge operation failed: %s',type(exc).__name__)
            self.reply(500,{'error':'Ошибка модуля: '+type(exc).__name__})

    def do_GET(self):
        self.route()

    def do_POST(self):
        self.route(post=True)


if __name__=='__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port',type=int,default=18880)
    parser.add_argument('--cached-report',action='store_true',help='Use the saved report without polling Metrika')
    args = parser.parse_args()
    bridge.init()
    server = ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    stop = threading.Event()
    threading.Thread(target=worker,args=(stop,not args.cached_report),daemon=True).start()
    print('Signal Bridge · http://127.0.0.1:'+str(args.port)+'/health',flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        server.server_close()
