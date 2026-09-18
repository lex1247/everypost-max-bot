"""Build gate using a disposable local PostgreSQL, never DATABASE_URL."""
import os
import asyncio
import json
import time
from unittest.mock import AsyncMock,patch
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import quote
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from core import Store
from posting import Posting
from migration import export_data,import_data
from subscriptions import add_months


async def parity_check(s,destination):
    from app import App
    from content_library import ContentLibrary
    with patch.dict(os.environ,{'OWNER_ID':'123','TG_BOT_TOKEN':'test','FREE_TEST_MODE':'1'}):
        app=App(s,None);app.bot_id=999;e=app.editor
        async def tg(method,**data):
            if method=='getChatMember':return {'status':'administrator','can_post_messages':True} if data['user_id']==999 else {'status':'creator'}
            if method=='sendVideo':return {'message_id':1,'video':{'file_id':'pg-clean-video'}}
            return {'message_id':1}
        app.tg=AsyncMock(side_effect=tg);e.say=AsyncMock()
        metadata={'provider':'tiktok','remote_id':'7630155394786069782','author':'hair','title':'Прическа коса',
          'original_url':'https://www.tiktok.com/@hair','canonical_url':'https://www.tiktok.com/@hair/video/7630155394786069782','duration':20,'metrics':{}}
        row=e.content.upsert(destination,metadata)
        result={'item':metadata,'content_hash':'a'*64,'fingerprint':{'version':1,'duration':20,'frames':[f'{i*1234567:032x}' for i in range(8)],'colors':[[100,100,100]]*8}}
        e.content.inspection(row,result)
        body={'channelId':destination,'id':row['id'],'decision':'queue'}
        receipts=await asyncio.gather(e.content.api(456,'decide',body),e.content.api(456,'decide',body))
        assert receipts[0]==receipts[1]
        with patch('content_source.inspect',AsyncMock(return_value=(b'video',result))):await e.content.tick()
        candidate=e.content.item(destination,row['id']);post=e.p.post(candidate['post_id'])
        assert post['state']=='scheduled' and post['text']==''
        assert json.loads(post['media'])['gallery'][0]['tg_file_id']=='pg-clean-video'
        await e.content.api(456,'decide',body)
        assert len(s.rows("SELECT * FROM ed_posts WHERE origin='tiktok'"))==1
        folder=s.run('INSERT INTO ed_folders(actor,name,channels) VALUES(?,?,?)',(456,'Причёски',json.dumps([destination])))
        assert folder.lastrowid is not None
        batch=s.run('INSERT INTO ed_batches(actor,nonce,created_at) VALUES(?,?,?)',(456,'pg-batch',time.time()))
        s.run('INSERT INTO ed_batch_posts VALUES(?,?,?)',(batch.lastrowid,destination,post['id']))
        route=s.run('INSERT INTO ed_cross_routes(destination,actor,kind,source,peer,title,cursor,enabled,next_at) VALUES(?,?,?,?,?,?,?,1,?)',
                    (destination,456,'public','source','-10099','Источник',10,time.time()+3600))
        s.run('INSERT INTO ed_cross_items(route,remote,text,url,media) VALUES(?,?,?,?,?)',(route.lastrowid,11,'Тестовая запись','','{}'))
        await e.cross.tick();await e.cross.tick()
        assert len(s.rows("SELECT * FROM ed_posts WHERE origin='crosspost'"))==1


async def recovery_check(s):
    from app import App
    from media_download import MediaTemporary
    with patch.dict(os.environ, {'OWNER_ID': '123', 'TG_BOT_TOKEN': 'test', 'FREE_TEST_MODE': '1'}):
        app = App(s, None)
        sid = s.add_source('tg', '-1000000000077', 'Проверка восстановления', 0)
        did = s.add_destination('tg', '-1000000000078', 'Проверка назначения')
        s.run('INSERT INTO routes VALUES(?,?)', (sid, did));s.set_route_mode(sid, did, 'original')
        s.set('tg_public:-1000000000077', 'news_channel')
        s.ingest(sid, [(1, 'Подпись', 'https://t.me/news_channel/1', {'unsupported': ['скрыто']})], 1)
        id = s.rows('SELECT d.id FROM deliveries d JOIN posts p ON p.id=d.post WHERE p.source=?', (sid,))[0]['id']
        s.run("UPDATE deliveries SET status='failed' WHERE id=?", (id,))
        app.public_tg.single = AsyncMock(return_value=(1, 'Подпись', 'https://t.me/news_channel/1', {'photos': [{'url': 'https://cdn4.telesco.pe/a.jpg'}]}))
        app.photo_file = AsyncMock(return_value=('a.jpg', b'\xff\xd8\xffphoto', 'image/jpeg'))
        app.editor.access = AsyncMock();app.tg = AsyncMock(return_value={'message_id': 9});app.notify = AsyncMock()
        assert (await app.recovery.refresh(id))['status'] == 'review'
        assert len(s.rows('SELECT * FROM delivery_parts WHERE delivery=?', (id,))) == 1
        assert await app.recovery.retry(id)
        app.photo_file.side_effect = MediaTemporary('Временно недоступно')
        await app.deliver({'id': id})
        row = app.recovery.row(id)
        assert row['media_attempts'] == 1 and row['status'] == 'pending'
        app.tg.assert_not_awaited()
        app.photo_file.side_effect = None
        with patch('app.asyncio.sleep', AsyncMock()):
            await app.deliver({'id': id});await app.deliver({'id': id})
        app.tg.assert_awaited_once()
        assert app.recovery.row(id)['status'] == 'sent'


async def owner_controls_check(s,destination):
    from app import App
    with patch.dict(os.environ,{'OWNER_ID':'123','TG_BOT_TOKEN':'test','FREE_TEST_MODE':'1'}):
        app=App(s,None);app.bot_id=999;e=app.editor
        app.tg=AsyncMock(return_value={'status':'administrator','can_post_messages':True})
        async def tg(method,**data):
            return {'status':'administrator','can_post_messages':True} if data.get('user_id') in (999,321) else {'status':'creator'}
        app.tg.side_effect=tg;e.say=AsyncMock()
        s.run('INSERT INTO ed_users(actor,name) VALUES(321,?) ON CONFLICT DO NOTHING',('Редактор проверки',))
        await e.input(456,{'text':'321'},{'action':'grant','destination':destination})
        assert not e.can_create(321,destination)
        await e.channels.callback(456,['rights',str(destination),'321','1','1'])
        p=e.p.new(destination,321,'Проверка прав',{})
        e.p.set_time(p,321,'schedule',time.time()+600)
        await e.channels.callback(456,['rights',str(destination),'321','0','2'])
        assert e.p.post(p['id'])['state']=='held'
        await e.callback(456,f'ed:revoke:{destination}:321')
        await e.input(456,{'text':'321'},{'action':'grant','destination':destination})
        assert e.channels.rights(destination,321)['revision']==5 and not e.can_create(321,destination)
        await e.channels.callback(456,['notify',str(destination),'0'])
        e.say.reset_mock();await e.channels.notify(456,destination,'Успех')
        e.say.assert_not_awaited()
        await e.channels.notify(456,destination,'Ошибка',critical=True);e.say.assert_awaited_once()
        await e.channels.history(456,destination)
        assert 'Редактор' in str(e.say.call_args) or 'редактор' in str(e.say.call_args)
        folder=s.run('INSERT INTO ed_folders(actor,name,channels) VALUES(?,?,?)',(456,'Редактирование папки',json.dumps([destination])))
        await e.multi.callback(456,['editfolder',str(folder.lastrowid)])
        f=e.p.session(456)
        await e.multi.callback(456,['toggle',f['nonce'],str(destination)])
        await e.multi.callback(456,['done',f['nonce']])
        assert s.rows('SELECT channels FROM ed_folders WHERE id=?',(folder.lastrowid,))[0][0]=='[]'
        print('PostgreSQL owner controls passed: editor rights, revocation/regrant, held schedules, notifications, history, folder editing.',flush=True)


def main():
    if os.getenv('POSTGRES_TEST_BIN'):
        binary=Path(os.environ['POSTGRES_TEST_BIN'])
    else:
        from pgserver._commands import POSTGRES_BIN_PATH
        binary=POSTGRES_BIN_PATH
    with tempfile.TemporaryDirectory(prefix='ep-pg-') as root:
        root=Path(root);folder=root/'data';sockets=root/'socket';sockets.mkdir(mode=0o700)
        subprocess.run([str(binary/'initdb'),'-D',str(folder),'-U','postgres','-A','trust','--no-locale','-E','UTF8'],check=True,stdout=subprocess.DEVNULL)
        subprocess.run([str(binary/'pg_ctl'),'-D',str(folder),'-l',str(root/'postgres.log'),'-o',f"-c listen_addresses='' -k {sockets}",'-w','start'],check=True,stdout=subprocess.DEVNULL)
        uri='postgresql://postgres@/postgres?host='+quote(str(sockets))
        try:
            source=Store(root/'source.sqlite3');sid=source.add_source('tg','-1001','Источник',10)
            did=source.add_destination('tg','-1002','Канал');source.run('INSERT INTO routes VALUES(?,?)',(sid,did))
            source.set_route_mode(sid,did,'original');source.ingest(sid,[(11,'Первый пост','https://example.com')],11)
            source.run("UPDATE deliveries SET status='sent',remote='22'")
            source_posting=Posting(source)
            customer=source_posting.connect_channel(456,-1003,'Клиент',123)
            grant=source_posting.subscriptions.change(123,123,customer,'grant',1,'tg:123:100')
            source_posting.subscriptions.change(123,123,customer,'mode','term','tg:123:101')
            source.db.close()
            s=Store(uri);p=Posting(s);import_data(s,export_data(root/'source.sqlite3'));p.sync_channels()
            assert s.rows('SELECT cursor FROM sources')[0][0]==11
            assert s.rows('SELECT remote FROM deliveries')[0][0]=='22'
            assert p.channel_owner(customer,123)==456
            assert p.subscriptions.get(customer)['mode']=='term'
            assert p.subscriptions.get(customer)['expires_at']==grant['expires_at']
            assert p.subscriptions.change(123,123,customer,'grant',1,'tg:123:100')==grant
            s.ingest(sid,[(12,'Новый пост','https://example.com')],12)
            post=p.new(did,123,'Свой пост',{});p.enqueue(post,123)
            assert len(s.rows('SELECT * FROM deliveries'))==3
            try:
                with s.db:
                    p.new(did,123,'Откат',{})
                    raise ValueError()
            except ValueError:pass
            assert len(s.rows('SELECT * FROM ed_posts'))==1
            assert s.db.claim_worker()
            other=Store(uri,recover=False);assert not other.db.claim_worker();other.db.close()
            competitors=[Store(uri,recover=False),Store(uri,recover=False)]
            claimants=[Posting(db) for db in competitors]
            barrier=Barrier(2)
            def claim(index):
                barrier.wait(timeout=10)
                try:
                    return claimants[index].connect_channel(700+index,-1009,'Одновременное подключение',123)
                except ValueError:
                    return None
            try:
                with ThreadPoolExecutor(max_workers=2) as pool:
                    outcomes=list(pool.map(claim,range(2)))
                assert sum(item is not None for item in outcomes)==1
                winner=outcomes.index(next(item for item in outcomes if item is not None))
                destination=outcomes[winner]
                assert p.channel_owner(destination,123)==700+winner
                assert p.connect_channel(700+winner,-1009,'Повтор',123)==destination
                assert len(s.rows("SELECT * FROM destinations WHERE remote='-1009'"))==1
                assert len(s.rows('SELECT * FROM ed_channel_owners WHERE destination=?',(destination,)))==1
                barrier=Barrier(2)
                def renew(index):
                    barrier.wait(timeout=10)
                    return claimants[index].subscriptions.change(123,123,customer,'grant',1,'tg:123:102')
                with ThreadPoolExecutor(max_workers=2) as pool:
                    receipts=list(pool.map(renew,range(2)))
                assert receipts[0]==receipts[1]
                assert receipts[0]['expires_at']==add_months(grant['expires_at'],1)
                assert len(s.rows("SELECT * FROM ed_subscription_events WHERE event='tg:123:102'"))==1
                barrier=Barrier(2)
                def independent_renewal(index):
                    barrier.wait(timeout=10)
                    return claimants[index].subscriptions.change(123,123,customer,'grant',1,f'tg:123:{103+index}')
                with ThreadPoolExecutor(max_workers=2) as pool:
                    list(pool.map(independent_renewal,range(2)))
                assert p.subscriptions.get(customer)['expires_at']==add_months(add_months(receipts[0]['expires_at'],1),1)
            finally:
                for db in competitors: db.db.close()
            asyncio.run(parity_check(s,customer))
            asyncio.run(recovery_check(s))
            asyncio.run(owner_controls_check(s,customer))
            # The test intentionally fails before deployment if migration or lock semantics are wrong.
            s.db.close()
            print('PostgreSQL check passed: migration, ownership, subscription receipts, concurrent claims/renewals, content review and queue idempotency, folders, batches, crossposting, source repair and bounded download retries.',flush=True)
        finally:
            subprocess.run([str(binary/'pg_ctl'),'-D',str(folder),'-m','fast','-w','stop'],check=True,stdout=subprocess.DEVNULL)


if __name__=='__main__':main()
