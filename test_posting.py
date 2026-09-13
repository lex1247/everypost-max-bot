import asyncio
import hashlib
import hmac
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from urllib.parse import urlencode
from unittest.mock import AsyncMock,patch
from app import App, APIError
from core import Store
from database import pg_sql
from migration import export_data,import_data
from posting import Posting, packed, validated_user, manual_plan, parse_buttons, styled
from web_server import calendar_action, create_web, webhook_secret


def signed(actor=123, now=None, token='test'):
    data={'user':json.dumps({'id':actor}), 'auth_date':str(int(time.time() if now is None else now)), 'query_id':'example'}
    key=hmac.new(b'WebAppData',token.encode(),hashlib.sha256).digest()
    data['hash']=hmac.new(key,'\n'.join(k+'='+v for k,v in sorted(data.items())).encode(),hashlib.sha256).hexdigest()
    return urlencode(data)


class PostingTests(unittest.TestCase):
    def setUp(self):
        self.s=Store(':memory:'); self.d=self.s.add_destination('tg','-1002','Тест'); self.p=Posting(self.s)
    def tearDown(self): self.s.db.close()
    def post(self,media=None): return self.p.new(self.d,123,'Материал',media or {})
    def test_double_publish_queues_exactly_once(self):
        p=self.post();self.p.enqueue(p,123)
        with self.assertRaises(ValueError): self.p.enqueue(p,123)
        self.assertEqual(len(self.s.rows('SELECT * FROM deliveries')),1)
        self.assertEqual(self.p.post(p['id'])['state'],'queued')
    def test_nested_mutation_rollback(self):
        with self.assertRaises(RuntimeError):
            with self.s.db:
                self.post()
                raise RuntimeError()
        self.assertFalse(self.s.rows('SELECT * FROM ed_posts'))
        self.assertFalse(self.s.rows('SELECT * FROM ed_audit'))
    def test_queue_rollback_on_part_insert_failure(self):
        p=self.post()
        self.s.run("CREATE TRIGGER reject_parts BEFORE INSERT ON delivery_parts BEGIN SELECT RAISE(ABORT, 'test'); END")
        with self.assertRaises(Exception): self.p.enqueue(p,123)
        self.assertFalse(self.s.rows('SELECT * FROM deliveries'))
        self.assertEqual(self.p.post(p['id'])['state'],'draft')
    def test_style_is_a_snapshot_and_caption_edit_keeps_media(self):
        media={'gallery':[{'type':'photo','tg_file_id':'id'}]};p=self.post(media)
        self.s.run('UPDATE ed_channels SET style=?',(packed({'signature':'Новая подпись'}),))
        changed=self.p.change(p,123,text='Новый текст')
        self.assertEqual(json.loads(changed['media'])['gallery'][0]['tg_file_id'],'id')
        self.assertNotIn('Новая подпись',changed['style'])
    def test_buttons_and_signature_validate_before_publish(self):
        p=self.post({'gallery':[{'type':'photo','tg_file_id':'a'}]})
        p=self.p.change(p,123,text='Я'*1025)
        with self.assertRaises(ValueError): self.p.enqueue(p,123)
        self.assertEqual(self.p.post(p['id'])['state'],'draft')
        self.assertFalse(self.s.rows('SELECT * FROM deliveries'))
        for text in ('x | javascript:alert(1)','x | https://user:pass@example.com','x | https://example.com\n'*9):
            with self.assertRaises(ValueError): parse_buttons(text)
    def test_album_buttons_keep_order_and_text(self):
        media={'gallery':[{'type':'photo','tg_file_id':'p'},{'type':'video','tg_file_id':'v'}]}
        plan=manual_plan('tg','Подпись',media,[{'text':'Открыть','url':'https://example.com'}])
        self.assertEqual([i['type'] for i in plan[0]['items']],['photo','video'])
        self.assertEqual(plan[0]['caption'],'');self.assertEqual(plan[1]['text'],'Подпись')
        self.assertEqual(len(plan[1]['buttons']),1)
    def test_schedule_and_delete_limits(self):
        now=time.time();p=self.post()
        p=self.p.set_time(p,123,'schedule',now+600,now)
        with self.assertRaises(ValueError): self.p.set_time(p,123,'delete',now+500,now)
        with self.assertRaises(ValueError): self.p.set_time(p,123,'delete',now+50*3600,now)
        p=self.p.set_time(p,123,'delete',now+1200,now)
        with self.assertRaises(ValueError): self.p.set_time(p,123,'schedule',now+1800,now)
    def test_auth_cannot_be_forged_replayed_or_duplicated(self):
        self.assertEqual(validated_user(signed(),'test'),123)
        for data in (signed(now=time.time()-3700),signed().replace('auth_date=','auth_date=0'),signed()+'&user=%7B%22id%22%3A456%7D'):
            with self.assertRaises(ValueError): validated_user(data,'test')
    def test_pg_translator_preserves_literals(self):
        self.assertEqual(pg_sql("SELECT '?' label WHERE id=?"),"SELECT '?' label WHERE id=%s")
    def test_import_preserves_cursor_sent_history_and_cannot_repeat(self):
        with tempfile.TemporaryDirectory() as folder:
            source=Store(Path(folder)/'db');sid=source.add_source('tg','-1001','Источник',90)
            did=source.add_destination('tg','-1003','Канал');source.run('INSERT INTO routes VALUES(?,?)',(sid,did))
            source.ingest(sid,[(91,'Текст','url')],91);source.run("UPDATE deliveries SET status='sent',remote='22'")
            source.set('private_token','do not export');source.db.close()
            data=export_data(Path(folder)/'db')
            self.assertFalse(any(r['key']=='private_token' for r in data['tables']['settings']))
            target=Store(':memory:');Posting(target)
            import_data(target,data)
            self.assertEqual(target.rows('SELECT cursor FROM sources')[0][0],91)
            self.assertEqual(target.rows('SELECT status,remote FROM deliveries')[0]['remote'],'22')
            with self.assertRaises(ValueError): import_data(target,data)
            target.db.close()


class EditorFlowTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.env=patch.dict(os.environ,{'OWNER_ID':'123','TG_BOT_TOKEN':'test','MAX_BOT_TOKEN':'test','FREE_TEST_MODE':'1','LLM_PROVIDER':'openai'})
        self.env.start();self.s=Store(':memory:');self.d=self.s.add_destination('tg','-1002','Тест');self.app=App(self.s,None);self.app.bot_id=999
        self.app.tg=AsyncMock(side_effect=self.tg);self.app.notify=AsyncMock();self.app.editor.say=AsyncMock()
        self.remote=100
    async def asyncTearDown(self):self.s.db.close();self.env.stop()
    async def tg(self,method,**payload):
        if method=='getChatMember':return {'status':'administrator','can_post_messages':True}
        if method=='sendMediaGroup':return [{'message_id':i+100} for i in range(len(payload['media']))]
        if method=='deleteMessage':return True
        self.remote+=1;return {'message_id':self.remote}
    def post(self):return self.app.editor.p.new(self.d,123,'Тест',{})
    def command_update(self,text,actor=123,**extra):
        return {'message':{'message_id':150,'chat':{'type':'private','id':actor},
                           'from':{'id':actor,'first_name':'Редактор'},'text':text,**extra}}
    async def test_max_shortcuts_open_sections_without_creating_posts(self):
        for command,action in [('newpost','new'),('inbox','proposed'),('drafts','draft'),
                               ('scheduled','scheduled'),('published','sent'),('channels','settings')]:
            self.assertTrue(await self.app.editor.handle(self.command_update('/'+command)))
            rows=self.app.editor.say.call_args.args[2]
            self.assertEqual(rows[0][0]['callback_data'],f'ed:channel:{action}:{self.d}')
        await self.app.editor.handle(self.command_update('/menu'))
        self.assertIn('Создать пост',str(self.app.editor.say.call_args))
        await self.app.editor.handle(self.command_update('/help'))
        self.assertIn('/published — Опубликованные и автоудаление',self.app.editor.say.call_args.args[1])
        self.assertFalse(self.s.rows('SELECT * FROM ed_posts'))
        self.assertFalse(self.s.rows('SELECT * FROM deliveries'))
    async def test_shortcuts_keep_an_unfinished_edit_until_cancel(self):
        post=self.post();session={'action':'text','post':post['id'],'revision':post['revision']}
        self.app.editor.p.session(123,session)
        for command in ('/drafts','/menu','/help'):
            await self.app.editor.handle(self.command_update(command))
            self.assertEqual(self.app.editor.p.session(123),session)
            self.assertEqual(self.app.editor.p.post(post['id'])['text'],'Тест')
        await self.app.editor.handle(self.command_update('/cancel'))
        self.assertFalse(self.app.editor.p.session(123))
        self.assertEqual(self.app.editor.p.post(post['id'])['state'],'draft')
        await self.app.editor.handle(self.command_update('/drafts@EveryPost_bot'))
        self.assertEqual(self.app.editor.say.call_args.args[2][0][0]['callback_data'],f'ed:channel:draft:{self.d}')
    async def test_shortcut_does_not_expose_channels_to_subscribers(self):
        proposal={'action':'proposal','destination':self.d};self.app.editor.p.session(456,proposal)
        for command in ('/channels','/drafts','/inbox','/help'):
            await self.app.editor.handle(self.command_update(command,actor=456))
            self.assertEqual(self.app.editor.p.session(456),proposal)
            self.assertNotIn(f'ed:channel:',str(self.app.editor.say.call_args))
        self.assertFalse(self.s.rows('SELECT * FROM ed_posts'))
    async def test_command_for_another_bot_is_ignored(self):
        session={'action':'new','destination':self.d};self.app.editor.p.session(123,session)
        await self.app.editor.handle(self.command_update('/cancel@another_bot'))
        self.assertEqual(self.app.editor.p.session(123),session)
        self.app.editor.say.assert_not_called()
    async def test_forwarded_command_and_caption_remain_post_content(self):
        self.app.editor.p.session(123,{'action':'new','destination':self.d})
        await self.app.editor.handle(self.command_update('/drafts',forward_origin={'type':'user'}))
        self.assertEqual(self.s.rows('SELECT text FROM ed_posts')[0]['text'],'/drafts')
        self.app.editor.p.session(123,{'action':'new','destination':self.d})
        update=self.command_update('');update['message'].pop('text')
        update['message'].update(caption='/channels',photo=[{'file_id':'photo','width':80,'height':80}])
        await self.app.editor.handle(update)
        self.assertEqual(self.s.rows('SELECT text FROM ed_posts ORDER BY id DESC')[0]['text'],'/channels')
        self.assertFalse(self.s.rows('SELECT * FROM deliveries'))
    async def test_cancel_shortcut_invalidates_open_calendar_without_changing_schedule(self):
        post=self.post();post=self.app.editor.p.change(post,123,state='scheduled',publish_at=time.time()+3600)
        await self.app.editor.calendar(123,post,'schedule')
        row=self.s.rows('SELECT * FROM ed_calendar')[0]
        await self.app.editor.handle(self.command_update('/cancel'))
        result=await calendar_action(self.app.editor,'save',{'initData':signed(),'nonce':row['nonce'],'mode':'schedule'})
        self.assertEqual(result['state'],'cancelled')
        self.assertEqual(self.app.editor.p.post(post['id'])['publish_at'],post['publish_at'])
    async def test_unknown_user_and_stale_callbacks_cannot_publish(self):
        p=self.post()
        with self.assertRaises(ValueError): await self.app.editor.callback(456,f"ed:publish:{p['id']}:1")
        self.app.editor.p.change(p,123,text='Изменено')
        with self.assertRaises(ValueError): await self.app.editor.callback(123,f"ed:publish:{p['id']}:1")
        self.assertFalse(self.s.rows('SELECT * FROM deliveries'))
    async def test_admin_needs_app_role_and_channel_rights(self):
        self.s.run('INSERT INTO ed_admins VALUES(?,?)',(self.d,456))
        self.app.tg=AsyncMock(return_value={'status':'member'})
        with self.assertRaises(ValueError):await self.app.editor.access(456,self.d)
    async def test_manual_delivery_reaches_channel_once(self):
        p=self.app.editor.p.enqueue(self.post(),123)
        with patch('app.asyncio.sleep',new_callable=AsyncMock):
            await self.app.deliver({'id':p['delivery']});await self.app.deliver({'id':p['delivery']})
        sends=[c for c in self.app.tg.call_args_list if c.args[0]=='sendMessage']
        self.assertEqual(len(sends),1);self.assertEqual(sends[0].kwargs['chat_id'],'-1002')
        await self.app.editor.tick();self.assertEqual(self.app.editor.p.post(p['id'])['state'],'sent')
    async def test_revoked_access_blocks_queued_post(self):
        self.s.run('INSERT INTO ed_admins VALUES(?,?)',(self.d,456))
        p=self.app.editor.p.new(self.d,456,'Пост',{});p=self.app.editor.p.enqueue(p,456)
        self.s.run('DELETE FROM ed_admins WHERE actor=456')
        await self.app.deliver({'id':p['delivery']})
        self.assertFalse(any(c.args[0]=='sendMessage' for c in self.app.tg.call_args_list))
        self.assertEqual(self.s.rows('SELECT status FROM deliveries')[0][0],'failed')
    async def test_proposal_has_no_author_in_published_text(self):
        c=self.app.editor.p.channel(self.d)
        await self.app.editor.handle({'message':{'from':{'id':456,'first_name':'Автор'},'chat':{'type':'private','id':456},'text':'/start propose_'+c['code']}})
        await self.app.editor.handle({'message':{'from':{'id':456},'chat':{'type':'private','id':456},'text':'Новость'}})
        p=self.s.rows('SELECT * FROM ed_posts')[0]
        self.assertEqual(p['state'],'proposed');self.assertFalse(self.s.rows('SELECT * FROM deliveries'))
        await self.app.editor.callback(123,f"ed:publish:{p['id']}:1")
        self.assertEqual(self.s.rows('SELECT original FROM posts')[0][0],'Новость')
    async def test_album_collected_atomically_and_deduplicated(self):
        self.app.editor.p.session(123,{'action':'new','destination':self.d})
        for i in [1,1,2]:
            msg={'from':{'id':123},'chat':{'type':'private','id':123},'media_group_id':'album','message_id':i,'photo':[{'file_id':'p'+str(i),'width':10,'height':10}]}
            await self.app.editor.handle({'message':msg})
        self.s.run('UPDATE ed_albums SET received=?',(time.time()-3,))
        self.app.editor.card=AsyncMock()
        await self.app.editor.flush_albums();await self.app.editor.flush_albums()
        posts=self.s.rows('SELECT * FROM ed_posts');self.assertEqual(len(posts),1)
        self.assertEqual(len(json.loads(posts[0]['media'])['gallery']),2)
    async def test_late_free_server_wake_holds_schedule(self):
        p=self.post();self.app.editor.p.change(p,123,state='scheduled',publish_at=time.time()-400)
        await self.app.editor.tick()
        self.assertEqual(self.app.editor.p.post(p['id'])['state'],'held');self.assertFalse(self.s.rows('SELECT * FROM deliveries'))
    async def test_calendar_receipt_retry_and_wrong_actor(self):
        p=self.post();await self.app.editor.calendar(123,p,'schedule')
        row=self.s.rows('SELECT * FROM ed_calendar')[0]
        dt=__import__('datetime').datetime.now(__import__('zoneinfo').ZoneInfo('Europe/Moscow'))+__import__('datetime').timedelta(hours=1)
        body={'initData':signed(),'nonce':row['nonce'],'mode':'schedule','day':dt.strftime('%Y%m%d'),'hour':dt.hour,'minute':dt.minute}
        first=await calendar_action(self.app.editor,'save',body);again=await calendar_action(self.app.editor,'save',body)
        self.assertEqual(first,again);self.assertEqual(self.app.editor.p.post(p['id'])['state'],'scheduled')
        with self.assertRaises(ValueError):await calendar_action(self.app.editor,'save',{**body,'initData':signed(456)})
    async def test_auto_delete_checks_confirmed_result_and_never_deletes_discussion(self):
        p=self.app.editor.p.enqueue(self.post(),123)
        self.s.run("UPDATE deliveries SET status='sent'")
        self.s.run("UPDATE delivery_parts SET status='sent',remote='[\"12\",\"13\"]'")
        self.s.run("UPDATE ed_posts SET state='sent',sent_at=?,delete_at=?",(time.time()-100,time.time()-10))
        await self.app.editor.delete_due();await self.app.editor.delete_due()
        calls=[c for c in self.app.tg.call_args_list if c.args[0]=='deleteMessage']
        self.assertEqual(len(calls),2);self.assertTrue(all(c.kwargs['chat_id']==-1002 for c in calls))
        self.assertEqual(self.app.editor.p.post(p['id'])['state'],'deleted')
    async def test_uncertain_delete_does_not_claim_success_or_repeat(self):
        p=self.app.editor.p.enqueue(self.post(),123)
        self.s.run("UPDATE deliveries SET status='sent'");self.s.run("UPDATE delivery_parts SET status='sent',remote='[\"12\"]'")
        self.s.run("UPDATE ed_posts SET state='sent',delete_at=?",(time.time()-1,))
        async def fail(method,**payload):
            if method=='deleteMessage':raise TimeoutError()
            return {'status':'administrator','can_post_messages':True}
        self.app.tg=AsyncMock(side_effect=fail)
        await self.app.editor.delete_due();await self.app.editor.delete_due()
        self.assertEqual(len([c for c in self.app.tg.call_args_list if c.args[0]=='deleteMessage']),1)
        self.assertEqual(self.app.editor.p.post(p['id'])['state'],'sent')
        self.assertEqual(self.s.rows('SELECT state FROM ed_deletions')[0][0],'unknown')
    async def test_webhook_requires_secret_and_deduplicates(self):
        from aiohttp.test_utils import TestServer,TestClient
        async with TestClient(TestServer(create_web(self.app))) as client:
            payload={'update_id':42,'message':{'text':'/id'}}
            response=await client.post('/telegram/webhook',json=payload)
            self.assertEqual(response.status,403)
            for _ in range(2):
                response=await client.post('/telegram/webhook',json=payload,headers={'X-Telegram-Bot-Api-Secret-Token':webhook_secret()})
                self.assertEqual(response.status,200)
            self.assertEqual(len(self.s.rows('SELECT * FROM tg_inbox')),1)
            response=await client.get('/calendar');self.assertEqual(response.status,200)
            self.assertIn("default-src 'none'",response.headers['Content-Security-Policy'])
    async def test_inbox_duplicate_message_creates_one_draft(self):
        self.app.editor.p.session(123,{'action':'new','destination':self.d});self.app.editor.card=AsyncMock()
        update={'update_id':12,'message':{'from':{'id':123},'chat':{'type':'private','id':123},'text':'Материал'}}
        for _ in range(2):self.app.accept_update(update);await self.app.process_updates()
        self.assertEqual(len(self.s.rows('SELECT * FROM ed_posts')),1)

    async def test_global_pause_button_is_not_saved_as_post_text(self):
        self.app.editor.p.session(123,{'action':'new','destination':self.d})
        consumed=await self.app.editor.handle({'message':{'from':{'id':123},'chat':{'type':'private','id':123},'text':'Пауза'}})
        self.assertFalse(consumed)
        self.assertFalse(self.app.editor.p.session(123))
        self.assertFalse(self.s.rows('SELECT * FROM ed_posts'))
