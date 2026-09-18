"""Owner controls and revocation races, using disposable state and fake Telegram."""
import json
import tempfile
import time
import unittest
from pathlib import Path
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, patch

import test_client_onboarding as fixture
from core import Store
from editor import Editor
from migration import export_data, import_data
from posting import Posting, packed
import test_feature_parity as content_fixture
from test_posting import signed
from web_server import calendar_action


class ChannelControlTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.CustomerFlowTests.asyncSetUp
    asyncTearDown = fixture.CustomerFlowTests.asyncTearDown
    telegram = fixture.CustomerFlowTests.telegram
    message = fixture.CustomerFlowTests.message
    connect = fixture.CustomerFlowTests.connect
    draft = fixture.CustomerFlowTests.draft
    candidate = content_fixture.FeatureParityTests.candidate

    async def editor(self, destination, allow=False):
        await self.e.handle(self.message(321,'/id'))
        remote=int(self.p.channel(destination)['remote'])
        self.roles[remote,321]={'status':'administrator','can_post_messages':True}
        await self.e.callback(456,f'ed:grant:{destination}')
        await self.e.handle(self.message(456,'321'))
        if allow: await self.rights(destination,True)

    async def rights(self,destination,enabled):
        r=self.e.channels.rights(destination,321)
        await self.e.channels.callback(456,['rights',str(destination),'321',str(int(enabled)),str(r['revision'])])

    async def test_new_editor_moderates_proposals_but_cannot_create(self):
        d=await self.connect();await self.editor(d)
        with self.assertRaisesRegex(ValueError,'Свои посты'):
            await self.e.callback(321,f'ed:channel:new:{d}')
        with self.assertRaises(ValueError): self.p.new(d,321,'Не разрешено',{})
        await self.e.home(321)
        self.assertNotIn('ed:choose:new',str(self.e.say.call_args))
        proposal=self.p.new(d,987,'Предложение',{},origin='proposal')
        await self.e.callback(321,f"ed:publish:{proposal['id']}:{proposal['revision']}")
        queued=self.p.post(proposal['id'])
        await self.e.authorize_delivery({'id':queued['delivery'],'status':'pending'})
        self.assertEqual(queued['state'],'queued')

    async def test_existing_editor_keeps_access_and_owner_cannot_be_restricted(self):
        d=await self.connect();self.s.run('INSERT INTO ed_admins VALUES(?,?)',(d,321))
        self.assertTrue(self.e.can_create(321,d))
        with self.assertRaises(ValueError): await self.e.channels.callback(456,['rights',str(d),'456','0','0'])
        self.assertTrue(self.e.can_create(456,d))

    async def test_permissions_survive_restart_and_old_buttons_cannot_regrant(self):
        d=await self.connect();await self.editor(d,True)
        stale=self.e.channels.rights(d,321)['revision']
        await self.rights(d,False)
        with self.assertRaises(ValueError): await self.e.channels.callback(456,['rights',str(d),'321','1',str(stale)])
        old=self.e.channels.rights(d,321)['revision']
        await self.e.callback(456,f'ed:revoke:{d}:321');await self.editor(d)
        with self.assertRaises(ValueError): await self.e.channels.callback(456,['rights',str(d),'321','1',str(old)])
        self.assertFalse(Editor(self.app).can_create(321,d))

    async def test_revoked_permission_blocks_old_input_and_buffers(self):
        d=await self.connect();await self.editor(d,True)
        await self.e.callback(321,f'ed:channel:new:{d}')
        session=self.p.session(321)
        await self.e.handle(self.message(321,media_group_id='album',message_id=17,photo=[{'file_id':'photo'}]))
        self.s.run('UPDATE ed_albums SET received=?',(time.time()-10,))
        await self.rights(d,False)
        with self.assertRaises(ValueError): await self.e.input(321,{'text':'Поздно'},session)
        await self.e.flush_albums()
        self.assertFalse(self.s.rows('SELECT * FROM ed_posts'))
        self.assertFalse(self.s.rows('SELECT * FROM ed_albums'))

    async def test_revocation_holds_scheduled_own_posts_but_not_proposals(self):
        d=await self.connect();await self.editor(d,True)
        own=self.p.new(d,321,'Свое',{});proposal=self.p.new(d,987,'Предложение',{},origin='proposal')
        for p in (own,proposal):self.p.set_time(p,321,'schedule',time.time()+600)
        await self.rights(d,False)
        self.assertEqual(self.p.post(own['id'])['state'],'held')
        self.assertEqual(self.p.post(proposal['id'])['state'],'scheduled')

    async def test_old_calendar_and_publish_button_cannot_bypass_permission(self):
        d=await self.connect();await self.editor(d,True);p=await self.draft(321,d)
        await self.e.calendar(321,p,'schedule')
        nonce=self.s.rows('SELECT nonce FROM ed_calendar')[0][0]
        await self.rights(d,False)
        for method in ('publish','subscription_resume'):
            with self.assertRaises(ValueError):await self.e.callback(321,f"ed:{method}:{p['id']}:{p['revision']}")
        with self.assertRaisesRegex(ValueError,'Свои посты'):
            await calendar_action(self.e,'save',{'initData':signed(321),'nonce':nonce,'mode':'schedule','day':(datetime.now()+timedelta(days=1)).strftime('%Y%m%d'),'hour':12,'minute':0})
        self.assertEqual(self.p.post(p['id'])['state'],'draft')
        self.assertFalse(self.s.rows('SELECT * FROM deliveries'))

    async def test_revocation_during_upload_prevents_actual_send(self):
        d=await self.connect();await self.editor(d,True);p=await self.draft(321,d,True)
        p=self.p.enqueue(p,321)
        async def prepare(*args):
            await self.rights(d,False)
            return 'sendVideo',{'chat_id':-1001,'video':'video'},None
        self.app.prepare_part=prepare;self.app.tg.reset_mock()
        with patch('app.asyncio.sleep',AsyncMock()):await self.app.deliver({'id':p['delivery']})
        sends=[c for c in self.app.tg.call_args_list if c.args[0]=='sendVideo']
        self.assertFalse(sends)
        self.assertNotEqual(self.s.rows('SELECT status FROM deliveries')[0][0],'sent')

    async def test_tiktok_queue_and_download_recheck_permission(self):
        d=await self.connect();await self.editor(d);row,result=self.candidate(d)
        body={'channelId':d,'id':row['id'],'decision':'queue'}
        with self.assertRaises(ValueError):await self.e.content.api(321,'decide',body)
        await self.rights(d,True);await self.e.content.api(321,'decide',body)
        async def inspect(url):
            await self.rights(d,False)
            return b'video',result
        with patch('content_source.inspect',inspect):await self.e.content.tick()
        self.assertFalse(self.s.rows('SELECT * FROM ed_posts'))
        self.assertEqual(self.e.content.item(d,row['id'])['state'],'failed')

    async def test_owner_can_recover_after_editor_loses_creation_right(self):
        d=await self.connect();await self.editor(d,True)
        p=self.p.enqueue(self.p.new(d,321,'Проверено владельцем',{}),321)
        self.s.run("UPDATE ed_posts SET state='failed' WHERE id=?",(p['id'],))
        self.s.run("UPDATE deliveries SET status='failed' WHERE id=?",(p['delivery'],))
        await self.rights(d,False)
        with self.assertRaises(ValueError):await self.e.publications.recovery(321,p['id'],p['revision'],'retry')
        await self.e.publications.recovery(456,p['id'],p['revision'],'retry')
        self.assertEqual(self.p.post(p['id'])['creator'],456)
        await self.e.authorize_delivery({'id':p['delivery'],'status':'pending'})

    async def test_multi_revocation_during_later_channel_check_rolls_back_all_posts(self):
        d=await self.connect();await self.editor(d,True)
        self.channels[-1003]=(456,'Второй канал')
        d2=self.p.connect_channel(456,-1003,'Второй канал',123);await self.editor(d2,True)
        session={'action':'multi_material','kind':'multi','ids':[d,d2],'nonce':'race'};self.p.session(321,session)
        async def tg(method,**payload):
            if method=='getChatMember' and payload['chat_id']==-1003 and payload['user_id']==321:
                self.s.run('UPDATE ed_editor_rights SET can_create=0 WHERE destination=? AND actor=321',(d,))
            return await self.telegram(method,**payload)
        self.app.tg.side_effect=tg
        with self.assertRaises(ValueError):await self.e.multi.material(321,{'text':'Везде'},session)
        self.assertFalse(self.s.rows('SELECT * FROM ed_posts'))
        self.assertFalse(self.s.rows('SELECT * FROM ed_batches'))

    async def test_history_is_owner_only_scoped_and_paginated(self):
        d=await self.connect();other=await self.connect(789,'@other_channel');await self.editor(d)
        self.p.audit(789,other,'setting:signature')
        for _ in range(12):self.p.audit(456,d,'setting:buttons')
        for actor in (321,789):
            with self.assertRaises(ValueError):await self.e.channels.history(actor,d)
        await self.e.channels.history(456,d)
        text=self.e.say.call_args.args[1];rows=self.e.say.call_args.args[2]
        self.assertEqual(text.count('Настройка: кнопки'),10)
        self.assertNotIn('подпись',text);self.assertIn('Дальше',str(rows))
        await self.e.channels.history(456,d,1)
        self.assertEqual(self.e.say.call_args.args[1].count('Настройка: кнопки'),2)

    async def test_muted_success_keeps_errors_and_direct_responses(self):
        d=await self.connect()
        await self.e.channels.callback(456,['notify',str(d),'0'])
        for state in ('sent','failed','unknown'):
            p=self.p.enqueue(self.p.new(d,456,state,{}),456)
            self.s.run('UPDATE deliveries SET status=? WHERE id=?',(state,p['delivery']))
            self.e.say.reset_mock();await self.e.tick()
            if state=='sent':self.e.say.assert_not_awaited()
            else:self.assertIn('#'+str(p['id']),self.e.say.call_args.args[1])
        await self.e.settings(456,d);self.assertIn('Уведомления',str(self.e.say.call_args))
        with self.assertRaises(ValueError):await self.e.channels.callback(789,['notify',str(d),'0'])

    async def test_muted_proposal_still_acknowledges_sender(self):
        d=await self.connect();await self.e.channels.callback(456,['notify',str(d),'0'])
        self.e.say.reset_mock()
        await self.e.input(987,{'text':'Коса'}, {'action':'proposal','destination':d})
        self.assertEqual([c.args[0] for c in self.e.say.call_args_list],[987])
        self.assertEqual(len(self.s.rows("SELECT * FROM ed_posts WHERE state='proposed'")),1)

    async def test_muted_autodeletion_success_still_records_history(self):
        d=await self.connect();await self.e.channels.callback(456,['notify',str(d),'0'])
        p=self.p.enqueue(self.p.new(d,456,'Удалить',{}),456)
        self.s.run("UPDATE ed_posts SET state='sent',delete_at=? WHERE id=?",(time.time()-1,p['id']))
        self.s.run("UPDATE delivery_parts SET status='sent',remote='[\"77\"]' WHERE delivery=?",(p['delivery'],))
        original=self.app.tg.side_effect
        async def tg(method,**payload):
            return True if method=='deleteMessage' else await original(method,**payload)
        self.app.tg.side_effect=tg;self.e.say.reset_mock();await self.e.delete_due()
        self.e.say.assert_not_awaited()
        self.assertEqual(self.p.post(p['id'])['state'],'deleted')
        self.assertEqual(len(self.s.rows("SELECT * FROM ed_audit WHERE action='deleted'")),1)

    async def folder(self,d):
        id=self.s.run('INSERT INTO ed_folders(actor,name,channels) VALUES(?,?,?)',(456,'Причёски',packed([d]))).lastrowid
        await self.e.multi.callback(456,['editfolder',str(id)])
        return id,self.p.session(456)

    async def test_folder_edit_adds_removes_and_preserves_identity(self):
        d=await self.connect();self.channels[-1003]=(456,'Второй канал')
        d2=self.p.connect_channel(456,-1003,'Второй канал',123)
        id,f=await self.folder(d)
        for channel in (d,d2):await self.e.multi.callback(456,['toggle',f['nonce'],str(channel)])
        await self.e.multi.callback(456,['done',f['nonce']])
        folder=dict(self.s.rows('SELECT * FROM ed_folders WHERE id=?',(id,))[0])
        self.assertEqual(json.loads(folder['channels']),[d2]);self.assertEqual(folder['name'],'Причёски')
        with self.assertRaises(ValueError):await self.e.multi.callback(456,['done',f['nonce']])
        with self.assertRaises(ValueError):await self.e.multi.callback(789,['editfolder',str(id)])
        self.assertFalse(self.s.rows('SELECT * FROM ed_posts'))

    async def test_folder_can_remove_channel_after_platform_access_lost(self):
        d=await self.connect();id,f=await self.folder(d)
        self.roles[-1001,456]={'status':'member'}
        await self.e.multi.callback(456,['toggle',f['nonce'],str(d)])
        await self.e.multi.callback(456,['done',f['nonce']])
        self.assertEqual(self.s.rows('SELECT channels FROM ed_folders WHERE id=?',(id,))[0][0],'[]')
        with self.assertRaises(ValueError):await self.e.multi.callback(456,['usefolder',str(id)])

    async def test_folder_stale_edit_cannot_overwrite_recreated_folder(self):
        d=await self.connect();id,f=await self.folder(d)
        self.s.run('DELETE FROM ed_folders WHERE id=?',(id,))
        self.s.run('INSERT INTO ed_folders(id,actor,name,channels) VALUES(?,?,?,?)',(id,456,'Другая','[]'))
        with self.assertRaises(ValueError):await self.e.multi.callback(456,['done',f['nonce']])
        self.assertEqual(self.s.rows('SELECT channels FROM ed_folders')[0][0],'[]')

    async def test_new_folder_with_existing_name_does_not_replace_it(self):
        d=await self.connect();id,_=await self.folder(d)
        await self.e.multi.start(456,'folder','Причёски');f=self.p.session(456)
        await self.e.multi.callback(456,['toggle',f['nonce'],str(d)])
        with self.assertRaises(ValueError):await self.e.multi.callback(456,['done',f['nonce']])
        self.assertEqual(len(self.s.rows('SELECT * FROM ed_folders')),1)

    async def test_owner_controls_survive_export_and_import(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'source.db';source=Store(path);p=Posting(source)
            d=p.connect_channel(456,-1001,'Канал',123)
            source.run('INSERT INTO ed_admins VALUES(?,?)',(d,321))
            source.run('INSERT INTO ed_editor_rights VALUES(?,?,?,?)',(d,321,0,5))
            source.set(f'channel_notifications:{d}:456','0')
            source.run('INSERT INTO ed_folders(actor,name,channels,version) VALUES(?,?,?,?)',(456,'Папка',packed([d]),'version'))
            source.db.close();target=Store(':memory:');Posting(target)
            try:
                import_data(target,export_data(path))
                self.assertEqual(target.rows('SELECT can_create,revision FROM ed_editor_rights')[0]['revision'],5)
                self.assertEqual(target.get(f'channel_notifications:{d}:456'),'0')
                self.assertEqual(target.rows('SELECT version FROM ed_folders')[0][0],'version')
            finally:target.db.close()


if __name__=='__main__':unittest.main()
