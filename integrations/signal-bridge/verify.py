import datetime as dt
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

import bridge
import delivery
import metrika
import providers as svc
import service


class MetrikaRequestChecks(unittest.TestCase):
    def test_full_moscow_windows_exclude_qa_visits(self):
        class MoscowMidnight(dt.datetime):
            @classmethod
            def now(cls, timezone=None):
                utc = cls(2026, 11, 26, 21, 30, tzinfo=dt.timezone.utc)
                return utc.astimezone(timezone)

        settings = {'METRIKA_TOKEN': 'fixture', 'METRIKA_COUNTER': '10',
                    'METRIKA_STORE_GOALS': '1,2,3,4,5'}
        dates_and_carts = [('2026-11-13', 4), ('2026-11-19', 6),
                           ('2026-11-20', 3), ('2026-11-26', 5)]
        rows = [{'dimensions': [{'name': day}], 'metrics': [50, 0, 0, 0, 0, carts]}
                for day, carts in dates_and_carts]
        response = dict(data=rows, sampled=False, total_rows=4, totals=[200, 0, 0, 0, 0, 18])
        with patch.object(metrika.dt, 'datetime', MoscowMidnight), \
                patch.object(metrika, 'setting', side_effect=lambda key: settings.get(key, '')), \
                patch.object(metrika, 'request_json', return_value=response) as request:
            report = metrika.fetch()

        query = parse_qs(urlsplit(request.call_args.args[0]).query)
        self.assertEqual(query['date1'], ['2026-11-13'])
        self.assertEqual(query['date2'], ['2026-11-26'])
        self.assertEqual(query['timezone'], ['+03:00'])
        self.assertEqual(query['filters'], ["ym:s:startURL!@'signal_qa='"])
        self.assertEqual(report['periods'], [[100, 0, 0, 0, 0, 10], [100, 0, 0, 0, 0, 8]])
        self.assertEqual(metrika.assess(report, 20, 20), ('Сигнал', -20.0))


class Checks(unittest.TestCase):
    def test_private_binding_survives_poll_timeout(self):
        import connect_telegram as pairing
        def start(uid, sender, code):
            return {'update_id':uid,'message':{'chat':{'id':44,'type':'private'},
                    'from':{'id':sender},'text':'/start '+code}}
        replies=[{'username':'demo_bot'},{'url':''},svc.ServiceError('timeout'),
                 [start(1,45,'example'),start(2,44,'wrong')],[start(3,44,'example')]]
        with patch.object(pairing,'telegram',side_effect=replies) as api, patch.object(pairing,'save') as save, \
                patch.object(pairing.time,'sleep'), patch('builtins.print'):
            pairing.pair('test','example',open_browser=False)
            save.assert_called_once_with({'TELEGRAM_BOT_TOKEN':'test','TELEGRAM_CHAT_ID':'44'})
            self.assertEqual(api.call_args.args[1]['offset'],3)

    def setUp(self):
        self.enterContext(patch.object(bridge,'STATE',Path(self.enterContext(tempfile.TemporaryDirectory()))))
        self.config={'REDMINE_URL':'http://localhost:3000','REDMINE_PROJECT':'demo',
                     'TELEGRAM_BOT_TOKEN':'123:test','TELEGRAM_CHAT_ID':'44','REDMINE_REQUIRE_AI_FLAG':'true'}
        get=lambda k,default='':self.config.get(k,default)
        for mod in (bridge,svc):
            self.enterContext(patch.object(mod,'setting',side_effect=get))
        self.data=dict(counter='10',goals=['1','2','3','4','5'],start='2026-11-01',end='2026-11-14',
                       periods=[[100,90,80,70,60,20],[100,80,70,60,50,18]],web='https://example.org/report')
        self.enterContext(patch.object(metrika,'fetch',return_value=self.data))
        self.enterContext(patch.object(svc,'project',return_value=2))
        self.issue={'id':11,'project':{'id':2},'subject':'Проверка','status':{'id':1,'name':'Open'},'updated_on':'2026-11-26'}
        self.posts=[]
        self.flags=[{'id':3,'name':'сгенерирована ИИ-помощником'}]
        def redmine(path,data=None,method=None):
            if path=='projects/2.json?include=issue_custom_fields':
                return {'project':{'issue_custom_fields':self.flags}}
            if path=='issues.json' and data:
                expected=[{'id':3,'value':'1'}] if self.flags else []
                self.assertEqual(data['issue'].get('custom_fields',[]),expected)
                self.posts.append(data)
                self.issue['description']=data['issue']['description']
                self.issue['custom_fields']=expected
                return {'issue':self.issue}
            if path.startswith('issues.json?'):
                return {'issues':[self.issue],'total_count':1}
            if path in ('issues/11.json','issues/11.json?include=journals','issues/11.json?include=journals,allowed_statuses'):
                return {'issue':self.issue}
            if path=='issue_statuses.json':
                return {'issue_statuses':[dict(id=1,name='Open'),dict(id=4,name='Done',is_closed=True)]}
            raise AssertionError(path)
        self.remote=self.enterContext(patch.object(svc,'redmine',side_effect=redmine))
        bridge.init()
        self.report=bridge.refresh_report()
        self.p=dict(reference='SIG-8',title='Проверка',description='Проверить период',report_id=self.report['id'],confirmed=True)

    def test_flag_is_required_only_by_the_protected_profile(self):
        self.flags.clear()
        with self.assertRaisesRegex(ValueError, 'поле-флаг'):
            bridge.create_task(self.p)
        self.assertEqual(self.posts, [])
        self.config.pop('REDMINE_REQUIRE_AI_FLAG')
        self.assertEqual(bridge.create_task(self.p)['redmine_id'], 11)

    def test_task_without_report_does_not_attach_the_latest(self):
        with patch.object(bridge, 'get_report', side_effect=AssertionError('Unexpected report lookup')):
            task = bridge.create_task(dict(self.p, report_id=''))
        self.assertEqual(task['report_id'], '')
        self.assertNotIn(self.report['web'], self.posts[0]['issue']['description'])
        self.issue['status'] = {'id':4, 'name':'Done'}
        self.assertEqual(bridge.sync_tasks()['errors'], [])
        self.assertIsNone(bridge.closures(0)[0]['report'])

    def test_signal_requires_volume_and_notifies_once(self):
        self.data['periods'][1][-1]=16
        self.assertEqual(bridge.refresh_report()['status'],'Сигнал')
        bridge.refresh_report()
        self.data['periods'][1]=[0]*6
        self.assertEqual(bridge.refresh_report()['status'],'Мало данных')
        self.assertEqual(len(bridge.events()),1)
        self.assertEqual(bridge.get_report(self.report['id'])['periods'][1][-1],18)

    def test_cart_signal_limit_and_recurrence_with_the_same_report(self):
        for base, current in [((19, 10), (100, 8)), ((100, 10), (19, 8)), ((100, 0), (100, 8))]:
            with self.subTest(base=base, current=current):
                self.data['periods'] = [[visits, 0, 0, 0, 0, carts] for visits, carts in (base, current)]
                report = bridge.refresh_report()
                self.assertEqual((report['status'], report['delta_percent']), ('Мало данных', None))
                self.assertEqual(bridge.events(), [])

        self.data['periods'] = [[100, 0, 0, 0, 0, 10], [100, 0, 0, 0, 0, 8]]
        report = bridge.refresh_report()
        self.assertEqual((report['status'], report['delta_percent']), ('Сигнал', -20.0))
        self.assertEqual((report['minimum_visits'], report['threshold_percent']), (20, 20))
        bridge.refresh_report()
        first, = bridge.events()
        self.assertEqual(first['kind'], 'metric_alert')

        self.data['periods'][1][0] = 19
        self.assertEqual(bridge.refresh_report()['status'], 'Мало данных')
        self.data['periods'][1][0] = 100
        bridge.refresh_report()
        self.assertEqual(bridge.events(), [first])

        self.data['periods'][1][-1] = 9
        self.assertEqual(bridge.refresh_report()['status'], 'Наблюдение')
        self.data['periods'][1][-1] = 8
        self.assertEqual(bridge.refresh_report()['id'], report['id'])
        bridge.refresh_report()
        events = bridge.events()
        self.assertEqual(len(events), 2)
        self.assertIn(first['id'], {event['id'] for event in events})
        self.assertTrue(all(event['kind'] == 'metric_alert' for event in events))

    def http(self, method, path, body=b''):
        request = (f'{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:18880\r\n'
                   f'Content-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n')
        connection = Mock(makefile=lambda *args: io.BytesIO(request.encode('ascii') + body))
        with patch.object(service, 'setting', side_effect=self.config.get):
            service.Handler(connection, ('127.0.0.1', 12345), SimpleNamespace(server_port=18880))
        raw = b''.join(write.args[0] for write in connection.sendall.call_args_list)
        headers, _, raw_body = raw.partition(b'\r\n\r\n')
        payload = json.loads(raw_body)
        self.assertEqual(headers.split()[1], b'200', payload)
        return payload

    def test_standalone_http_reports_and_delivers_a_cart_alert_without_redmine(self):
        del self.config['REDMINE_URL']
        del self.config['REDMINE_PROJECT']
        self.config['METRIKA_TOKEN'] = 'fixture'
        self.data['periods'] = [[100, 0, 0, 0, 0, 10], [100, 0, 0, 0, 0, 8]]
        report = bridge.refresh_report()

        health = self.http('GET', '/health')
        self.assertEqual(health['service'], 'signal-bridge')
        self.assertEqual(health['queue'], {'pending': 1})
        self.assertEqual(health['configured'], {'metrika': True, 'redmine': False, 'telegram': True})
        self.assertEqual(self.http('GET', '/reports/latest'), report)
        reply = {'ok': True, 'result': {'chat': {'id': 44}, 'message_id': 12}}
        with patch.object(svc, 'request_json', return_value=reply) as telegram:
            first = self.http('POST', '/sync', b'{}')
            self.assertEqual(first['redmine'], {'checked': 0, 'errors': []})
            self.assertEqual(first['telegram']['sent'], 1)
            self.assertEqual(self.http('POST', '/sync', b'{}')['telegram']['sent'], 0)
            telegram.assert_called_once()
            self.assertEqual(telegram.call_args.kwargs['data']['chat_id'], '44')
            self.assertIn('10/100 → 8/100 (-20.0%)', telegram.call_args.kwargs['data']['text'])
        self.remote.assert_not_called()
        event, = self.http('GET', '/events')
        self.assertEqual((event['kind'], event['state'], event['message_id']),
                         ('metric_alert', 'sent', 12))

    def test_sync_reports_redmine_failure_and_still_delivers_a_cart_alert(self):
        self.config['REDMINE_API_KEY'] = 'fixture'
        bridge.create_task(self.p)
        self.remote.side_effect = svc.ServiceError('Redmine временно недоступен.', 503)
        self.data['periods'] = [[100, 0, 0, 0, 0, 10], [100, 0, 0, 0, 0, 8]]
        bridge.refresh_report()

        with patch.object(svc, 'send_message', return_value=12) as telegram:
            sync = self.http('POST', '/sync', b'{}')
            self.assertEqual(sync['redmine']['error'], 'Redmine временно недоступен.')
            self.assertEqual(sync['telegram']['sent'], 1)
            telegram.assert_called_once()

    def test_unusable_telegram_confirmation_leaves_delivery_uncertain(self):
        self.data['periods'] = [[100, 0, 0, 0, 0, 10], [100, 0, 0, 0, 0, 8]]
        bridge.refresh_report()
        with patch.object(svc, 'request_json', return_value={'ok': True, 'result': {'chat': None}}) as telegram:
            self.assertEqual(bridge.deliver()['state'], 'uncertain')
            self.assertEqual(bridge.deliver()['sent'], 0)
            telegram.assert_called_once()
        event, = bridge.events()
        self.assertEqual((event['state'], event['message_id']), ('uncertain', None))

    def test_restart_and_manual_reconciliation_of_cart_alert(self):
        self.data['periods'] = [[100, 0, 0, 0, 0, 10], [100, 0, 0, 0, 0, 8]]
        bridge.refresh_report()
        with patch.object(svc, 'send_message', side_effect=KeyboardInterrupt) as send:
            with self.assertRaises(KeyboardInterrupt):
                bridge.deliver()
            send.assert_called_once()
        event, = bridge.events()
        self.assertEqual(event['state'], 'sending')
        with bridge.db() as c:
            c.execute("UPDATE events SET ready=0 WHERE id=?", (event['id'],))
        env = dict(os.environ, SIGNAL_BRIDGE_STATE=str(bridge.STATE), TELEGRAM_CHAT_ID='44',
                   TELEGRAM_BOT_TOKEN='123:test')

        def run(*args):
            subprocess.run([sys.executable, *args], cwd=Path(__file__).resolve().parent,
                           env=env, check=True, timeout=10)

        check_restart = """
from unittest.mock import patch
import bridge
import providers

bridge.init()
with patch.object(providers, 'send_message', side_effect=AssertionError('Unexpected delivery')) as send:
    assert bridge.deliver()['sent'] == 0
    send.assert_not_called()
"""
        run('-c', check_restart)
        uncertain, = bridge.events()
        self.assertEqual((uncertain['id'], uncertain['state']), (event['id'], 'uncertain'))
        self.assertEqual((uncertain['telegram_bot_id'], uncertain['telegram_chat_id']), ('123', '44'))
        run('delivery.py', event['id'], '--observed-message-id', '42')
        run('-c', check_restart)
        reconciled, = bridge.events()
        self.assertEqual((reconciled['id'], reconciled['state'], reconciled['message_id']),
                         (event['id'], 'sent', 42))

    def test_uncertain_delivery_keeps_the_original_bot_and_chat(self):
        self.data['periods'] = [[100, 0, 0, 0, 0, 10], [100, 0, 0, 0, 0, 8]]
        bridge.refresh_report()
        with patch.object(svc, 'request_json', side_effect=svc.ServiceError('Нет подтверждённого ответа')) as send:
            self.assertEqual(bridge.deliver()['state'], 'uncertain')
            self.assertEqual(send.call_args.kwargs['data']['chat_id'], '44')
        event, = self.http('GET', '/events')
        self.assertEqual((event.get('telegram_bot_id'), event.get('telegram_chat_id')), ('123', '44'))
        self.assertNotIn(self.config['TELEGRAM_BOT_TOKEN'], json.dumps(event))

        for token, chat in [('123:test', '55'), ('456:test', '44')]:
            self.config.update(TELEGRAM_BOT_TOKEN=token, TELEGRAM_CHAT_ID=chat)
            for message_id in (None, 12):
                with self.assertRaisesRegex(ValueError, r'123.*44'):
                    delivery.resolve(event['id'], message_id)

        self.config.update(TELEGRAM_BOT_TOKEN='123:rotated', TELEGRAM_CHAT_ID='44')
        delivery.resolve(event['id'], None)
        self.config['TELEGRAM_CHAT_ID'] = '55'
        with patch.object(svc, 'request_json') as send:
            self.assertEqual(bridge.deliver()['sent'], 0)
            send.assert_not_called()
        self.assertEqual(bridge.events()[0]['state'], 'pending')
        self.config['TELEGRAM_CHAT_ID'] = '44'
        reply = {'ok': True, 'result': {'chat': {'id': 44}, 'message_id': 12}}
        with patch.object(svc, 'request_json', return_value=reply) as send:
            self.assertEqual(bridge.deliver()['sent'], 1)
            send.assert_called_once()
            self.assertEqual(send.call_args.kwargs['data']['chat_id'], '44')

    def test_legacy_uncertain_delivery_needs_an_explicit_original_destination(self):
        legacy_dir = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch.object(bridge, 'STATE', legacy_dir))
        with bridge.db() as c:
            c.execute("""CREATE TABLE events (
                id TEXT PRIMARY KEY,kind TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL,
                ready REAL DEFAULT 0,message_id INTEGER,error TEXT,created TEXT NOT NULL)""")
            c.executemany("INSERT INTO events(id,kind,text,state,ready,created) VALUES(?,?,?, ?,?,?)", [
                ('uncertain', 'metric_alert', 'test', 'uncertain', 0, bridge.now()),
                ('retry', 'metric_alert', 'test', 'pending', 1, bridge.now()),
            ])
        bridge.init()
        bridge.init()
        legacy = {event['id']: event for event in bridge.events()}
        self.assertEqual(legacy['uncertain']['state'], 'uncertain')
        self.assertEqual(legacy['retry']['state'], 'uncertain')
        self.assertIsNone(legacy['uncertain'].get('telegram_chat_id'))
        with self.assertRaisesRegex(ValueError, '--original-chat-id'):
            delivery.resolve('uncertain', 12)
        with self.assertRaisesRegex(ValueError, r'123.*55'):
            delivery.resolve('uncertain', None, original_bot_id='123', original_chat_id='55')
        delivery.resolve('uncertain', 12, original_bot_id='123', original_chat_id='44')
        reconciled = next(event for event in bridge.events() if event['id'] == 'uncertain')
        self.assertEqual((reconciled['state'], reconciled['message_id'], reconciled['telegram_chat_id']),
                         ('sent', 12, '44'))

    def test_ambiguous_create_reconciles_and_rejects_changed_payload(self):
        original=self.remote.side_effect
        def lose_reply(path,data=None,method=None):
            result=original(path,data,method)
            if path=='issues.json':
                raise svc.ServiceError('Нет ответа')
            return result
        self.remote.side_effect=lose_reply
        with self.assertRaises(svc.ServiceError): bridge.create_task(self.p)
        self.assertEqual(bridge.create_task(self.p)['redmine_id'],11)
        self.assertEqual(bridge.create_task(self.p)['redmine_id'],11)
        self.assertEqual(len(self.posts),1)
        self.assertIn(self.report['web'],self.posts[0]['issue']['description'])
        with self.assertRaises(ValueError): bridge.create_task(dict(self.p,title='Другой заголовок'))
        with self.assertRaises(ValueError): bridge.create_task(dict(self.p,confirmed=False))

    def test_closure_delivery_and_reopen(self):
        bridge.create_task(self.p)
        bridge.sync_tasks()
        self.assertEqual(bridge.events(),[])
        self.issue['status']['id']=4
        self.issue['journals']=[{'notes':'Проверена корзина\n\npm-abc','user':{'name':'Участник'},
                                 'details':[{'name':'status_id','new_value':'4'}]}]
        self.issue['closed_on']='2026-11-26T12:00:00Z'
        self.assertEqual(bridge.issue_details(self.p['reference'])['closingNote']['text'],'Проверена корзина')
        bridge.sync_tasks()
        bridge.sync_tasks()
        self.assertEqual(len(bridge.events()),1)
        with patch.object(svc,'request_json',return_value={'ok':True,'result':{'chat':{'id':44},'message_id':12}}) as remote:
            self.assertEqual(bridge.deliver()['sent'],1)
            self.assertEqual(bridge.deliver()['sent'],0)
            self.assertEqual(remote.call_count,1)
            self.assertEqual(remote.call_args.kwargs['data']['chat_id'],'44')
            self.assertIn('#11',remote.call_args.kwargs['data']['text'])
        self.assertEqual(bridge.events()[0]['message_id'],12)
        self.issue['status']['id']=1
        bridge.sync_tasks()
        self.issue['status']['id']=4
        bridge.sync_tasks()
        self.assertEqual(len(bridge.events()),2)
        first,second = bridge.closures(0)
        self.assertEqual((first['reference'],first['episode'],first['report']['id']),('SIG-8',1,self.report['id']))
        self.assertEqual(bridge.closures(first['seq']),[second])
        self.assertEqual(first['closing_note']['text'],'Проверена корзина')
        self.assertIsNone(bridge.closing_note(dict(self.issue,journals=[dict(self.issue['journals'][0],notes=None)])))
        self.assertIsNone(bridge.closing_note(dict(self.issue,journals=[*self.issue['journals'],
            dict(self.issue['journals'][0],private_notes=True)])))
        self.assertEqual(second['episode'],2)

    def test_existing_web_closures_remain_available_without_shared_telegram_delivery(self):
        reference = 'web-draft-fixture'
        bridge.create_task(dict(self.p, reference=reference))
        self.issue['status']['id'] = 4
        bridge.sync_tasks()
        bridge.sync_tasks()
        self.assertEqual(bridge.events(), [])
        closure, = bridge.closures(0)
        self.assertEqual((closure['reference'], closure['episode']), (reference, 1))

        # Before the web notifier was used, these were ordinary shared Telegram queue rows.
        with bridge.db() as c:
            marker, = c.execute('SELECT marker FROM tasks WHERE ref=?', (reference,)).fetchone()
            for episode, state, receipt in [(1, 'pending', None), (2, 'uncertain', None), (3, 'sent', 42)]:
                key = f'closed:{marker}:{episode}'
                bridge.event(c, key, 'issue_closed', 'Личная задача https://tracker.example/issues/11')
                c.execute('UPDATE events SET state=?,message_id=? WHERE id=?', (state, receipt, key))
        bridge.init()
        with patch.object(svc, 'request_json', return_value={'ok':True,'result':{'chat':{'id':44},'message_id':12}}) as remote:
            self.assertEqual(bridge.deliver()['sent'], 0)
            remote.assert_not_called()
        rows = {int(event['id'].rsplit(':', 1)[-1]): event for event in bridge.events()}
        self.assertEqual([rows[n]['state'] for n in (1, 2, 3)], ['suppressed', 'suppressed', 'sent'])
        self.assertEqual(rows[3]['message_id'], 42)
        self.assertTrue(all('https://tracker.example/' not in row['text'] for row in rows.values()))
        self.assertEqual(bridge.closures(0), [closure])

    def test_unsent_and_ambiguous_delivery(self):
        with bridge.db() as c: bridge.event(c,'one','test','test')
        del self.config['TELEGRAM_CHAT_ID']
        self.assertFalse(bridge.deliver()['configured'])
        self.assertEqual(bridge.events()[0]['state'],'pending')
        self.config['TELEGRAM_CHAT_ID']='44'
        with patch.object(svc,'send_message',side_effect=svc.ServiceError('429',429,30)):
            self.assertEqual(bridge.deliver()['state'],'pending')
            self.assertEqual(bridge.deliver()['sent'],0)
        with bridge.db() as c: c.execute('UPDATE events SET ready=0')
        with patch.object(svc,'send_message',side_effect=svc.ServiceError('Нет ответа')) as send:
            self.assertEqual(bridge.deliver()['state'],'uncertain')
            bridge.deliver()
            self.assertEqual(send.call_count,1)

    def test_report_rejects_partial_and_bad_totals(self):
        day=dt.date(2026,11,1)
        data=dict(data=[],sampled=False,total_rows=0,totals=[0]*6)
        self.assertEqual(metrika.summarize(data,day,day+dt.timedelta(days=13)),[[0]*6,[0]*6])
        for bad in (dict(sampled=True),dict(totals=[1]*6),dict(total_rows=3)):
            with self.assertRaises(ValueError): metrika.summarize(dict(data,**bad),day,day+dt.timedelta(days=13))


if __name__=='__main__':
    unittest.main(verbosity=2)
