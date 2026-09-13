import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock,patch
import httpx
from core import Store
from trustat_source import Trustat,TrustatError,source_ref,post_media

CID=2159108162
PEER=str(-10**12-CID)
SOURCE='trustat_'+str(CID)
def post(mid,**kw):return dict(channel_id=CID,message_id=mid,source='telegram',text='Post '+str(mid),**kw)
def page(ids,cursor=None):return dict(channel_id=CID,source='telegram',posts=[post(i) for i in ids],next_cursor=cursor)
def response(data,status=200):return httpx.Response(status,json={'status':'ok','response':data})

class TrustatTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.env=patch.dict(os.environ,{'TRUSTAT_API_KEY':'test-secret'});self.env.start()
        self.s=Store(':memory:');self.http=SimpleNamespace(get=AsyncMock())
        self.t=Trustat(SimpleNamespace(s=self.s,http=self.http))
    def tearDown(self):self.s.db.close();self.env.stop()
    def test_public_and_private_links(self):
        for v in ['@News_channel','https://t.me/s/News_channel/','https://telegram.me/News_channel']:
            self.assertEqual(source_ref(v),'news_channel')
        for v in ['+aBcDef0123','https://t.me/+aBcDef0123','https://t.me/joinchat/aBcDef0123']:
            self.assertEqual(source_ref(v),'+aBcDef0123')
    def test_invalid_links(self):
        for v in ['https://evil.test/news','https://t.me/news/123','http://t.me/news','https://x@t.me/news','https://t.me/news?x=1']:
            with self.subTest(v=v),self.assertRaises(ValueError):source_ref(v)
    async def test_resolve_skips_archive(self):
        self.http.get.side_effect=[response(dict(channel_id=CID,source='telegram',title='Source')),response(page([40]))]
        r=await self.t.resolve('https://t.me/+aBcDef0123')
        self.assertEqual((r['source'],r['peer'],r['cursor']),(SOURCE,PEER,40))
        self.assertIn('%2B',self.http.get.call_args_list[0].args[0])
    async def test_missing_key(self):
        with patch.dict(os.environ,{'TRUSTAT_API_KEY':''}),self.assertRaises(TrustatError) as cm:await self.t.resolve('@news')
        self.assertTrue(cm.exception.pause);self.http.get.assert_not_awaited()
    async def test_quota_persists_cooldown_and_redacts_secret(self):
        self.http.get.return_value=response({},426)
        for _ in range(2):
            with self.assertRaises(TrustatError) as cm:await self.t.get('/usage/info')
            self.assertTrue(cm.exception.pause);self.assertNotIn('test-secret',str(cm.exception))
        self.assertEqual(self.http.get.await_count,1)
        self.assertEqual(len(self.s.rows('SELECT * FROM ts_state')),1)
    async def test_auth_scope_failures_pause(self):
        for status in [401,403]:
            self.s.run('DELETE FROM ts_state');self.http.get.return_value=response({},status)
            with self.assertRaises(TrustatError) as cm:await self.t.get('/x')
            self.assertTrue(cm.exception.pause)
    async def test_transient_does_not_pause(self):
        self.http.get.side_effect=RuntimeError('test-secret')
        with self.assertRaises(TrustatError) as cm:await self.t.get('/x')
        self.assertFalse(cm.exception.pause);self.assertNotIn('test-secret',str(cm.exception))
    async def test_pagination_returns_oldest_first(self):
        self.http.get.side_effect=[response(page([14,13],'next')),response(page([12,11,10])),response(post(11)),response(post(12)),response(post(13)),response(post(14))]
        r=await self.t.fetch(SOURCE,PEER,10)
        self.assertEqual([p[0] for p in r['posts']],[11,12,13,14]);self.assertEqual(r['cursor'],14)
    async def test_small_batch_does_not_skip_remaining(self):
        self.http.get.side_effect=[response(page(list(range(40,9,-1))))]+[response(post(i)) for i in range(11,31)]
        r=await self.t.fetch(SOURCE,PEER,10)
        self.assertEqual(len(r['posts']),20);self.assertEqual(r['cursor'],30)
    async def test_partial_quota_returns_only_cached_complete_posts(self):
        self.http.get.side_effect=[response(page([12,11,10])),response(post(11)),response({},426)]
        r=await self.t.fetch(SOURCE,PEER,10)
        self.assertEqual(r['cursor'],11);self.assertTrue(r['pause']);self.assertEqual(len(r['posts']),1)
    async def test_repeated_detail_uses_cache(self):
        self.http.get.return_value=response(post(11))
        self.assertEqual(await self.t.detail(CID,11),await self.t.detail(CID,11))
        self.assertEqual(self.http.get.await_count,1)
    async def test_wrong_channel_and_order_fail_without_advancing(self):
        for data in [dict(page([11]),channel_id=7),page([10,11])]:
            self.http.get.return_value=response(data)
            with self.assertRaises(TrustatError):await self.t.fetch(SOURCE,PEER,10)
    async def test_repeated_pagination_fails(self):
        self.http.get.return_value=response(page([12,11],'same'))
        with self.assertRaises(TrustatError):await self.t.fetch(SOURCE,PEER,10)
    async def test_mismatched_peer_prevents_request(self):
        with self.assertRaises(ValueError):await self.t.fetch(SOURCE,'-1007',10)
        self.http.get.assert_not_awaited()
    async def test_wrong_detail_identity_never_cached(self):
        self.http.get.return_value=response(post(99))
        with self.assertRaises(TrustatError):await self.t.detail(CID,11)
        self.assertFalse(self.s.rows('SELECT * FROM ts_post_cache'))
    def test_real_photo_and_video_shapes(self):
        photo=post_media(post(1,media={'media_type':'mediaPhoto','file_url':'https://static1.trustat.ru/posts/_0/d8/photo.jpg'}))
        self.assertEqual(len(photo['photos']),1);self.assertFalse(photo['unsupported'])
        video=post_media(post(1,media={'media_type':'mediaDocument','mime_type':'video/mp4','file_thumbnail_url':'https://static1.trustat.ru/posts/thumb.jpg'}))
        self.assertFalse(video['photos']);self.assertTrue(video['unsupported'])
    def test_unknown_media_unsafe_urls_and_deleted_preserved_for_review(self):
        for kwargs in [dict(media={'media_type':'mediaPhoto','file_url':'https://evil.test/x.jpg'}),dict(media=[{}]),dict(is_deleted=True)]:
            self.assertTrue(post_media(post(1,**kwargs))['unsupported'])
    def test_empty_post_requires_review(self):
        self.assertTrue(post_media({'text':''})['unsupported'])

if __name__=='__main__':unittest.main()

class TrustatBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_bridge_dispatches_provider_actions(self):
        from max_bridge import action
        app=SimpleNamespace()
        with patch('max_bridge.Trustat') as factory:
            factory.return_value.resolve=AsyncMock(return_value={'source':SOURCE})
            factory.return_value.fetch=AsyncMock(return_value={'posts':[],'cursor':10})
            self.assertEqual(await action(app,{'action':'trustat_resolve','source':'@news'}),{'source':SOURCE})
            await action(app,{'action':'trustat_fetch','source':SOURCE,'peer':PEER,'cursor':10})
            factory.return_value.fetch.assert_awaited_once_with(SOURCE,PEER,10)
    async def test_signed_endpoint_returns_quota_pause_without_secret(self):
        import json,time,hmac,hashlib
        from aiohttp import web
        from aiohttp.test_utils import TestClient,TestServer
        from max_bridge import install,bridge_key
        with patch.dict(os.environ,{'MAX_BOT_TOKEN':'test-only'}),patch('max_bridge.action',new=AsyncMock(side_effect=TrustatError('Лимит Trustat исчерпан.',pause=True))):
            server=web.Application();install(server,SimpleNamespace())
            body=json.dumps({'action':'trustat_fetch'}).encode();stamp=str(int(time.time()))
            sig=hmac.new(bridge_key(),stamp.encode()+b'.'+body,hashlib.sha256).hexdigest()
            async with TestClient(TestServer(server)) as c:
                r=await c.post('/max-crosspost',data=body,headers={'X-EveryPost-Time':stamp,'X-EveryPost-Signature':sig})
                data=await r.json();self.assertEqual(r.status,422);self.assertTrue(data['pause']);self.assertFalse(data['ok'])
