import hashlib
import hmac
import json
import os
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from max_bridge import authenticate, bridge_key, action, install


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.env=patch.dict(os.environ, {'MAX_BOT_TOKEN':'test-only'})
        self.env.start()
        self.app=SimpleNamespace(public_tg=SimpleNamespace(page=AsyncMock(),since=AsyncMock()),
            rewrite=AsyncMock(return_value='Новая формулировка'),
            prepare_part=AsyncMock(return_value=('/messages',{'text':'Новость'},{})))
    def tearDown(self): self.env.stop()
    async def test_signature_bound_to_body_and_fresh_time(self):
        body=b'{"action":"resolve"}';stamp=str(int(time.time()))
        sig=hmac.new(bridge_key(),stamp.encode()+b'.'+body,hashlib.sha256).hexdigest()
        self.assertTrue(authenticate(body,stamp,sig))
        self.assertFalse(authenticate(body+b' ',stamp,sig))
        self.assertFalse(authenticate(body,str(int(stamp)-301),sig))
        self.assertFalse(authenticate(body,stamp,'wrong'))
    async def test_resolve_skips_archive_and_canonicalizes_name(self):
        self.app.public_tg.page.return_value=SimpleNamespace(peer_id=-100123,title='Источник',posts=[(9,'x','u',{}),(11,'y','u',{})])
        result=await action(self.app,{'action':'resolve','source':'@SourceName'})
        self.assertEqual(result['cursor'],11)
        self.assertEqual(result['source'],'sourcename')
        self.assertEqual(result['peer'],'-100123')
    async def test_fetch_limited_without_skipping_remaining_posts(self):
        posts=[(n,'текст','url',{}) for n in range(1,121)]
        self.app.public_tg.since.return_value=(posts,120)
        r=await action(self.app,{'action':'fetch','source':'@source','peer':'-100123','cursor':0})
        self.assertEqual(r['cursor'],100);self.assertEqual(len(r['posts']),100)
    async def test_plain_mode_never_calls_ai(self):
        await action(self.app,{'action':'prepare','text':'Новость','media':{},'mode':'original'})
        self.app.rewrite.assert_not_awaited()
        self.app.prepare_part.assert_awaited_once()
    async def test_ai_prepares_but_does_not_publish(self):
        await action(self.app,{'action':'prepare','text':'Новость','media':{},'mode':'ai'})
        self.app.rewrite.assert_awaited_once_with('Новость')
        self.assertEqual(self.app.prepare_part.call_args.args[2]['text'],'Новая формулировка')
    async def test_unsupported_media_is_never_silently_dropped(self):
        with self.assertRaises(ValueError):
            await action(self.app,{'action':'prepare','text':'Новость','media':{'unsupported':['видео']},'mode':'original'})
        self.app.prepare_part.assert_not_awaited()
    async def test_length_and_unsafe_photo_rejected_before_upload(self):
        for text,media in [('😀'*2001,{}),('x',{'photos':[{'url':'http://127.0.0.1/file'}]})]:
            with self.assertRaises(ValueError):
                await action(self.app,{'action':'prepare','text':text,'media':media,'mode':'original'})
        self.app.prepare_part.assert_not_awaited()
    async def test_endpoint_rejects_unsigned_requests(self):
        server=web.Application();install(server,self.app)
        async with TestClient(TestServer(server)) as c:
            r=await c.post('/max-crosspost',json={'action':'resolve','source':'@source'})
            self.assertEqual(r.status,403)
            self.app.public_tg.page.assert_not_awaited()
    async def test_endpoint_redacts_upstream_failures(self):
        self.app.rewrite.side_effect=RuntimeError('sensitive upstream URL')
        body=json.dumps({'action':'prepare','text':'text','mode':'ai','media':{}}).encode();stamp=str(int(time.time()))
        sig=hmac.new(bridge_key(),stamp.encode()+b'.'+body,hashlib.sha256).hexdigest()
        server=web.Application();install(server,self.app)
        async with TestClient(TestServer(server)) as c:
            r=await c.post('/max-crosspost',data=body,headers={'X-EveryPost-Time':stamp,'X-EveryPost-Signature':sig})
            self.assertEqual(r.status,503)
            self.assertNotIn('sensitive',await r.text())
