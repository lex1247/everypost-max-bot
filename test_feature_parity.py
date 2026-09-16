"""User paths across content, folders, crossposting and publication edits. No live sends."""
import json
import os
import tempfile
import time
import unittest
from datetime import datetime,timezone
from pathlib import Path
from unittest.mock import AsyncMock,patch
from types import SimpleNamespace
from aiohttp.test_utils import TestClient,TestServer
import test_client_onboarding as fixture
from content_library import hair_relevance,same_video,SEEDS
from cross_controls import parse_rules,apply_rules,similarity
from core import Store
from posting import Posting,packed
from migration import export_data,import_data
from web_server import create_web
from test_posting import signed


class FeatureParityTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp=fixture.CustomerFlowTests.asyncSetUp
    asyncTearDown=fixture.CustomerFlowTests.asyncTearDown
    telegram=fixture.CustomerFlowTests.telegram
    message=fixture.CustomerFlowTests.message
    connect=fixture.CustomerFlowTests.connect
    draft=fixture.CustomerFlowTests.draft

    def candidate(self,d,remote='7630155394786069782',title='Прическа косички',digest='a'):
        meta={'provider':'tiktok','remote_id':remote,'canonical_url':'https://www.tiktok.com/@hair/video/'+remote,
          'original_url':'https://www.tiktok.com/@hair','author':'hair','title':title,'duration':20,'published_at':None,'metrics':{'views':123}}
        row=self.e.content.upsert(d,meta)
        fp={'version':1,'duration':20,'frames':[f'{i*1234567:032x}' for i in range(8)],'colors':[[120,110,100]]*8}
        result={'item':meta,'content_hash':digest*64,'fingerprint':fp}
        self.e.content.inspection(row,result)
        return self.e.content.item(d,row['id']),result

    async def choose(self,d,id,due=None):
        return await self.e.content.api(456,'decide',{'channelId':d,'id':id,'decision':'queue','dueAt':due})

    async def test_content_tenant_isolation(self):
        d=await self.connect();await self.connect(789,'@other_channel')
        row,_=self.candidate(d)
        for action in ('state','decide','toggle','recover','seed'):
            with self.assertRaises(ValueError):await self.e.content.api(789,action,{'channelId':d,'id':row['id'],'decision':'queue'})
        self.assertFalse(self.s.rows('SELECT * FROM ed_posts'))

    async def test_multiple_sources_idempotent_and_unsafe_urls_rejected(self):
        d=await self.connect()
        for _ in range(2):await self.e.content.add_sources(456,d,['@hair','https://www.tiktok.com/@hair/video/7630155394786069782'])
        self.assertEqual(len(self.s.rows('SELECT * FROM ed_content_sources')),2)
        with self.assertRaises(ValueError):await self.e.content.add_sources(456,d,['https://127.0.0.1/private'])

    async def test_seeds_include_nine_original_examples(self):
        d=await self.connect();await self.e.content.api(456,'seed',{'channelId':d})
        rows=self.s.rows('SELECT * FROM ed_content_sources')
        self.assertEqual(len(rows),18);self.assertEqual(len(SEEDS),9)

    async def test_hair_only_excludes_makeup_and_apartments(self):
        d=await self.connect()
        for i,title in enumerate(('Дизайн квартиры','makeup hairstyle','Красивый день')):
            row,_=self.candidate(d,str(7630155394786069782+i),title,chr(97+i))
            with self.assertRaises(ValueError):await self.choose(d,row['id'])
        self.assertEqual(hair_relevance('Braids hairstyle tutorial'),'match')

    async def test_identical_and_visual_reuploads_blocked(self):
        d=await self.connect();one,info=self.candidate(d)
        two,_=self.candidate(d,'7630155394786069783',digest='b')
        self.assertEqual(two['duplicate_of'],one['id'])
        with self.assertRaises(ValueError):await self.choose(d,two['id'])
        await self.e.content.api(456,'decide',{'channelId':d,'id':two['id'],'decision':'distinct'})
        await self.choose(d,two['id'])
        three,_=self.candidate(d,'7630155394786069784',digest='a')
        with self.assertRaises(ValueError):await self.e.content.api(456,'decide',{'channelId':d,'id':three['id'],'decision':'distinct'})

    async def test_queue_double_tap_preserves_slot(self):
        d=await self.connect();row,_=self.candidate(d)
        one=await self.choose(d,row['id']);two=await self.choose(d,row['id'])
        self.assertEqual(one,two);self.assertFalse(self.s.rows('SELECT * FROM deliveries'))

    async def test_content_prepared_as_video_caption_schedule_once(self):
        d=await self.connect();self.s.run('UPDATE ed_channels SET style=? WHERE destination=?',(packed({'signature':'Сохрани идею'}),d))
        row,result=self.candidate(d);await self.choose(d,row['id'])
        original=self.app.tg.side_effect
        async def tg(method,**payload):
            if method=='sendVideo':return {'message_id':777,'video':{'file_id':'clean-video'}}
            return await original(method,**payload)
        self.app.tg.side_effect=tg
        with patch('content_source.inspect',AsyncMock(return_value=(b'video',result))):await self.e.content.tick()
        item=self.e.content.item(d,row['id']);p=self.p.post(item['post_id'])
        self.assertEqual(p['state'],'scheduled');self.assertEqual(p['text'],'')
        self.assertEqual(self.p.validate(p)[1],'Сохрани идею')
        self.assertEqual(json.loads(p['media'])['gallery'][0]['tg_file_id'],'clean-video')
        self.assertFalse(self.s.rows('SELECT * FROM deliveries'))
        await self.choose(d,row['id']);self.assertEqual(len(self.s.rows('SELECT * FROM ed_posts')),1)
        videos=[c.kwargs for c in self.app.tg.call_args_list if c.args[0]=='sendVideo']
        self.assertEqual(videos[0]['chat_id'],456)

    async def test_revoked_actor_during_download_never_queues(self):
        d=await self.connect();row,result=self.candidate(d);await self.choose(d,row['id'])
        async def inspect(url):
            self.roles[-1001,456]={'status':'member'};return b'video',result
        with patch('content_source.inspect',inspect):await self.e.content.tick()
        self.assertEqual(self.e.content.item(d,row['id'])['state'],'failed')
        self.assertFalse(self.s.rows('SELECT * FROM ed_posts'))

    async def test_two_hour_source_poll_and_saved_metrics(self):
        d=await self.connect();await self.e.content.add_sources(456,d,['@hair'])
        _,result=self.candidate(d,title='Дизайн квартиры')
        fetch=AsyncMock(return_value={'items':[result['item']]})
        with patch('content_source.fetch',fetch):await self.e.content.tick();await self.e.content.tick()
        self.assertEqual(fetch.await_count,1)
        source=self.s.rows('SELECT * FROM ed_content_sources')[0]
        self.assertGreater(source['next_at'],time.time()+7100)
        self.assertEqual(json.loads(self.s.rows('SELECT metadata FROM ed_content_items')[0][0])['metrics']['views'],123)

    async def test_source_failure_backoff_visible(self):
        d=await self.connect();await self.e.content.add_sources(456,d,['@hair'])
        with patch('content_source.fetch',AsyncMock(side_effect=ValueError('TikTok недоступен'))):await self.e.content.tick()
        row=self.s.rows('SELECT * FROM ed_content_sources')[0]
        self.assertIn('недоступен',row['last_error']);self.assertGreater(row['next_at'],time.time()+290)

    async def test_content_web_requires_telegram_signature(self):
        d=await self.connect()
        async with TestClient(TestServer(create_web(self.app))) as client:
            response=await client.post('/content/api/state',json={'channelId':d,'initData':'fake'})
            self.assertEqual(response.status,400)
            response=await client.post('/content/api/state',json={'channelId':d,'initData':signed(456)})
            self.assertEqual(response.status,200);self.assertTrue((await response.json())['hairOnly'])
            response=await client.get('/content');self.assertEqual(response.status,200)
            html=await response.text();self.assertIn('Telegram',html);self.assertNotIn('max-web-app',html)
            self.assertIn('frame-src https://www.tiktok.com',response.headers['Content-Security-Policy'])

    async def test_direct_tiktok_link_asks_channel_and_persists_source(self):
        d=await self.connect();url='https://www.tiktok.com/@hair/video/7630155394786069782'
        await self.e.handle(self.message(456,url));session=self.p.session(456)
        self.assertEqual(session['action'],'content_link')
        with patch.dict(os.environ,{'PUBLIC_URL':'https://example.com'}):
            await self.e.callback(456,f"ed:contentadd:{d}:{session['nonce']}")
        self.assertEqual(self.s.rows('SELECT url FROM ed_content_sources')[0][0],url)
        self.assertFalse(self.s.rows('SELECT * FROM deliveries'))

    async def test_content_reschedule_uses_post_revision(self):
        d=await self.connect();row,_=self.candidate(d);p=await self.draft(456,d,True)
        p=self.p.set_time(p,456,'schedule',time.time()+7200)
        self.s.run("UPDATE ed_content_items SET state='queued',post_id=? WHERE id=?",(p['id'],row['id']))
        args={'channelId':d,'id':row['id'],'revision':p['revision'],'dueAt':datetime.fromtimestamp(time.time()+10800,timezone.utc).isoformat()}
        await self.e.content.api(456,'move',args)
        with self.assertRaises(ValueError):await self.e.content.api(456,'move',args)

    async def test_replacement_never_overwrites_a_later_manual_edit(self):
        d=await self.connect();row,result=self.candidate(d);p=await self.draft(456,d,True)
        p=self.p.set_time(p,456,'schedule',time.time()+7200)
        self.s.run("UPDATE ed_content_items SET state='queued',post_id=? WHERE id=?",(p['id'],row['id']))
        await self.e.content.api(456,'replace',{'channelId':d,'id':row['id'],'revision':p['revision']})
        p=self.p.post(p['id']);self.p.change(p,456,text='Ручная правка')
        self.s.run("UPDATE ed_content_items SET file_id='cached' WHERE id=?",(row['id'],))
        with patch('content_source.inspect',AsyncMock(return_value=(b'video',result))):await self.e.content.tick()
        self.assertEqual(self.e.content.item(d,row['id'])['state'],'failed')
        self.assertEqual(self.p.post(p['id'])['text'],'Ручная правка')
        self.assertEqual(json.loads(self.p.post(p['id'])['media'])['gallery'][0]['tg_file_id'],'video-1')

    async def test_expired_preparation_lease_requires_review(self):
        d=await self.connect();row,_=self.candidate(d)
        self.s.run("UPDATE ed_content_items SET state='preparing',lease_until=?,selected_by=456 WHERE id=?",(time.time()-1,row['id']))
        await self.e.content.tick()
        self.assertEqual(self.e.content.item(d,row['id'])['state'],'failed')
        self.assertFalse(self.s.rows('SELECT * FROM deliveries'))

    async def test_multi_album_kept_intact_in_each_draft(self):
        d=await self.connect();self.channels[-1003]=(456,'Второй');d2=self.p.connect_channel(456,-1003,'Второй',123)
        session={'action':'multi_material','ids':[d,d2],'nonce':'album-test'};self.p.session(456,session)
        await self.e.handle(self.message(456,media_group_id='album',message_id=1,caption='Альбом',photo=[{'file_id':'photo'}]))
        await self.e.handle(self.message(456,media_group_id='album',message_id=2,video={'file_id':'video'}))
        self.s.run('UPDATE ed_albums SET received=?',(time.time()-3,));await self.e.flush_albums()
        posts=self.s.rows('SELECT * FROM ed_posts');self.assertEqual(len(posts),2)
        for p in posts:self.assertEqual(len(json.loads(p['media'])['gallery']),2)

    async def test_cross_trustat_video_upload_to_telegram(self):
        self.app.trustat_video_file=AsyncMock(return_value=b'0000ftypvideo')
        part={'kind':'gallery','caption':'Подпись','items':[{'type':'video','url':'https://static1.trustat.ru/a.mp4'}]}
        method,payload,files=await self.app.prepare_part('tg',-1001,part)
        self.assertEqual(method,'sendVideo');self.assertEqual(payload['video'],'attach://video0');self.assertIn('video0',files)

    async def batch(self):
        d=await self.connect();self.channels[-1003]=(456,'Второй канал');d2=self.p.connect_channel(456,-1003,'Второй канал',123)
        await self.e.multi.start(456)
        session=self.p.session(456);session['ids']=[d,d2];self.p.session(456,session)
        await self.e.multi.callback(456,['done',session['nonce']]);session=self.p.session(456)
        await self.e.multi.material(456,{'text':'Один материал'},session)
        return self.s.rows('SELECT id FROM ed_batches')[0][0],[d,d2]

    async def test_multi_channel_queue_atomic_and_double_tap(self):
        id,ds=await self.batch()
        self.assertEqual(len(self.s.rows('SELECT * FROM ed_posts')),2)
        await self.e.multi.callback(456,['publish',str(id)]);await self.e.multi.callback(456,['publish',str(id)])
        self.assertEqual(len(self.s.rows('SELECT * FROM deliveries')),2)
        with self.assertRaises(ValueError):await self.e.multi.card(789,id)

    async def test_multi_revoked_channel_blocks_whole_batch(self):
        id,ds=await self.batch();self.roles[-1003,456]={'status':'member'}
        with self.assertRaises(ValueError):await self.e.multi.callback(456,['publish',str(id)])
        self.assertFalse(self.s.rows('SELECT * FROM deliveries'))

    async def test_multi_invalid_one_schedule_rolls_back_all(self):
        id,ds=await self.batch()
        self.s.run("UPDATE ed_posts SET state='sent' WHERE destination=?",(ds[1],))
        with self.assertRaises(ValueError):await self.e.multi.input(456,{'text':datetime.fromtimestamp(time.time()+7200).strftime('%d.%m.%Y %H:%M')},{'action':'multi_time','batch':id})
        self.assertEqual(self.s.rows('SELECT state FROM ed_posts WHERE destination=?',(ds[0],))[0][0],'draft')

    async def test_personal_folder_rechecks_removed_access(self):
        d=await self.connect();self.s.run('INSERT INTO ed_folders(actor,name,channels) VALUES(?,?,?)',(456,'Причёски',packed([d])))
        id=self.s.rows('SELECT id FROM ed_folders')[0][0]
        with self.assertRaises(ValueError):await self.e.multi.callback(789,['usefolder',str(id)])
        self.roles[-1001,456]={'status':'member'}
        with self.assertRaises(ValueError):await self.e.multi.callback(456,['usefolder',str(id)])

    async def route(self,d,rules=None):
        self.s.run('INSERT INTO ed_cross_routes(destination,actor,kind,source,peer,title,cursor,enabled,rules,next_at) VALUES(?,?,?,?,?,?,?,1,?,?)',
            (d,456,'public','source','-10099','Источник',10,packed(rules or {}),time.time()+3600))
        return self.s.rows('SELECT id FROM ed_cross_routes')[0][0]

    async def test_crosspost_uses_channel_style_and_shared_queue(self):
        d=await self.connect();r=await self.route(d)
        self.s.run('UPDATE ed_channels SET style=? WHERE destination=?',(packed({'signature':'Подпись'}),d))
        self.s.run('INSERT INTO ed_cross_items(route,remote,text,url,media) VALUES(?,?,?,?,?)',(r,11,'Новость','https://t.me/source/11','{}'))
        await self.e.cross.tick();await self.e.cross.tick()
        self.assertEqual(len(self.s.rows('SELECT * FROM deliveries')),1)
        self.assertIn('Подпись',self.s.rows('SELECT original FROM posts')[0][0])

    async def test_cross_rules_skip_without_publishing(self):
        d=await self.connect();r=await self.route(d,parse_rules('Исключить: реклама\nЗаменить: коса => косичка\nДубли: да'))
        self.s.run('INSERT INTO ed_cross_items(route,remote,text,url,media) VALUES(?,?,?,?,?)',(r,11,'реклама коса','','{}'))
        await self.e.cross.tick();self.assertFalse(self.s.rows('SELECT * FROM deliveries'))
        self.assertEqual(self.s.rows('SELECT state FROM ed_cross_items')[0][0],'skipped')

    async def test_cross_private_destination_and_cycle_guard(self):
        d=await self.connect();r=await self.route(d)
        with self.assertRaises(ValueError):await self.e.cross.route(789,r)
        with self.assertRaises(ValueError):self.e.cross.no_cycle(d,'public','-1001')

    async def test_cross_fetch_cursor_and_item_committed_together(self):
        d=await self.connect();r=await self.route(d);self.s.run('UPDATE ed_cross_routes SET next_at=0 WHERE id=?',(r,))
        self.app.public_tg.since=AsyncMock(return_value=([(11,'Запись','https://t.me/source/11',{})],11))
        await self.e.cross.tick();await self.e.cross.tick()
        self.assertEqual(self.s.rows('SELECT cursor FROM ed_cross_routes')[0][0],11)
        self.assertEqual(len(self.s.rows('SELECT * FROM ed_cross_items')),1)

    async def sent_post(self,video=False):
        d=await self.connect();p=await self.draft(456,d,video=video);p=self.p.enqueue(p,456)
        self.s.run("UPDATE delivery_parts SET status='sent',remote='[777]' WHERE delivery=?",(p['delivery'],))
        self.s.run("UPDATE deliveries SET status='sent' WHERE id=?",(p['delivery'],))
        self.s.run("UPDATE ed_posts SET state='sent',sent_at=? WHERE id=?",(time.time(),p['id']))
        return self.p.post(p['id'])

    async def test_published_video_caption_edit_and_repeat_receipt(self):
        p=await self.sent_post(True);await self.e.publications.start(456,p['id'],p['revision'])
        f=self.p.session(456);await self.e.publications.input(456,{'text':'Новая подпись'},f)
        self.app.tg.reset_mock()
        await self.e.publications.apply(456,f['nonce']);await self.e.publications.apply(456,f['nonce'])
        edits=[c for c in self.app.tg.call_args_list if c.args[0]=='editMessageCaption']
        self.assertEqual(len(edits),1);self.assertEqual(edits[0].kwargs['message_id'],777)
        self.assertEqual(self.p.post(p['id'])['text'],'Новая подпись')

    async def test_publication_uncertain_edit_not_automatically_repeated(self):
        p=await self.sent_post();await self.e.publications.start(456,p['id'],p['revision'])
        f=self.p.session(456);await self.e.publications.input(456,{'text':'Новый текст'},f)
        original=self.app.tg.side_effect
        async def tg(method,**payload):
            if method=='editMessageText':raise TimeoutError()
            return await original(method,**payload)
        self.app.tg.side_effect=tg
        with self.assertRaises(ValueError):await self.e.publications.apply(456,f['nonce'])
        await self.e.publications.apply(456,f['nonce'])
        self.assertEqual(self.s.rows('SELECT state FROM ed_publication_edits')[0][0],'unknown')

    async def test_customer_recovery_preserves_confirmed_parts(self):
        p=await self.sent_post()
        self.s.run("INSERT INTO delivery_parts(delivery,part,payload,status) VALUES(?,1,?,'unknown')",(p['delivery'],packed({'kind':'text','text':'Вторая часть'})))
        self.s.run("UPDATE deliveries SET status='unknown' WHERE id=?",(p['delivery'],))
        self.s.run("UPDATE ed_posts SET state='unknown' WHERE id=?",(p['id'],));p=self.p.post(p['id'])
        with self.assertRaises(ValueError):await self.e.publications.recovery(789,p['id'],p['revision'],'retry')
        await self.e.publications.recovery(456,p['id'],p['revision'])
        self.assertEqual(self.s.rows('SELECT status FROM deliveries WHERE id=?',(p['delivery'],))[0][0],'unknown')
        await self.e.publications.recovery(456,p['id'],p['revision'],'retry')
        parts=self.s.rows('SELECT status,remote FROM delivery_parts WHERE delivery=? ORDER BY part',(p['delivery'],))
        self.assertEqual(parts[0]['status'],'sent');self.assertEqual(parts[0]['remote'],'[777]');self.assertEqual(parts[1]['status'],'pending')
        with self.assertRaises(ValueError):await self.e.publications.recovery(456,p['id'],p['revision'],'retry')

    async def test_restoration_preserves_content_sources_folders_and_rules(self):
        with tempfile.TemporaryDirectory() as folder:
            s=Store(Path(folder)/'state.sqlite3');p=Posting(s);d=p.connect_channel(456,-1001,'Канал',123)
            s.run('INSERT INTO ed_content_sources(destination,actor,url) VALUES(?,?,?)',(d,456,'https://www.tiktok.com/@hair'))
            s.run('INSERT INTO ed_folders(actor,name,channels) VALUES(?,?,?)',(456,'Папка',packed([d])))
            s.db.close();target=Store(':memory:');Posting(target)
            import_data(target,export_data(Path(folder)/'state.sqlite3'))
            self.assertEqual(target.rows('SELECT actor FROM ed_content_sources')[0][0],456)
            self.assertEqual(target.rows('SELECT name FROM ed_folders')[0][0],'Папка');target.db.close()
