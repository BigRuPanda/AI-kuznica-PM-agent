import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import bridge
import metrika
import providers as svc


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
                     'TELEGRAM_BOT_TOKEN':'123:test','TELEGRAM_CHAT_ID':'44'}
        get=lambda k,default='':self.config.get(k,default)
        for mod in (bridge,svc):
            self.enterContext(patch.object(mod,'setting',side_effect=get))
        self.data=dict(counter='10',goals=['1','2','3','4','5'],start='2026-11-01',end='2026-11-14',
                       periods=[[100,90,80,70,60,20],[100,80,70,60,50,18]],web='https://example.org/report')
        self.enterContext(patch.object(metrika,'fetch',return_value=self.data))
        self.enterContext(patch.object(svc,'project',return_value=2))
        self.issue={'id':11,'project':{'id':2},'subject':'Проверка','status':{'id':1,'name':'Open'},'updated_on':'2026-11-26'}
        self.posts=[]
        def redmine(path,data=None,method=None):
            if path=='issues.json' and data:
                self.posts.append(data)
                self.issue['description']=data['issue']['description']
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
