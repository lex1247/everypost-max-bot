import asyncio
import os
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, patch
from aiohttp.test_utils import TestClient, TestServer
from app import App, main
from core import Store
from runtime import run_mode
from web_server import create_web, cloud_worker


class ServerRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.env=patch.dict(os.environ,{'OWNER_ID':'7','TG_BOT_TOKEN':'test',
            'EP_RUN_MODE':'standby','EP_STRICT_HEALTH':'1','WEB_MODE':'1','DATABASE_URL':'unused',
            'LLM_PROVIDER':'llm7','LLM7_APPROVED':'1','FREE_TEST_MODE':'1'})
        self.env.start()
        self.store=Store(':memory:')
        self.app=App(self.store,AsyncMock())

    async def asyncTearDown(self):
        self.store.db.close()
        self.env.stop()

    async def test_standby_http_blocks_all_mutations(self):
        async with TestClient(TestServer(create_web(self.app))) as client:
            self.assertEqual((await client.get('/health')).status,200)
            for path in ['/telegram/webhook','/max-crosspost','/calendar/api/save','/migration/activate']:
                self.assertEqual((await client.post(path,json={})).status,503)
        self.app.http.post.assert_not_awaited()

    async def test_health_requires_database_and_live_workers(self):
        with patch.dict(os.environ,{'EP_RUN_MODE':'active'}):
            async with TestClient(TestServer(create_web(self.app))) as client:
                self.assertEqual((await client.get('/health')).status,503)
                self.app.worker_ready=True
                self.app.runtime_heartbeats={key:time.monotonic() for key in ['publish','inbox_loop','editor','content','crosspost']}
                self.assertEqual((await client.get('/health')).status,200)
                self.app.runtime_heartbeats['publish']-=1801
                self.assertEqual((await client.get('/health')).status,503)
                with patch.object(self.store,'rows',side_effect=RuntimeError('secret')):
                    result=await client.get('/health')
                    self.assertEqual(result.status,503)
                    self.assertNotIn('secret',await result.text())

    async def test_standby_worker_does_not_claim_or_recover_database(self):
        task=asyncio.create_task(cloud_worker(self.app))
        await asyncio.sleep(0)
        self.assertFalse(task.done())
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.app.http.post.assert_not_awaited()

    async def test_standby_main_never_contacts_telegram(self):
        async def supervise_only_server(*jobs):
            self.assertEqual(len(jobs),1)
            self.assertEqual(jobs[0].cr_code.co_name,'serve')
            for job in jobs: job.close()
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ,{'DATA_DIR':folder}), \
             patch('app.Store',return_value=self.store), patch('app.supervise',side_effect=supervise_only_server), \
             patch.object(App,'tg',new_callable=AsyncMock) as telegram:
            await main()
            telegram.assert_not_awaited()

    def test_invalid_mode_fails_closed(self):
        with patch.dict(os.environ,{'EP_RUN_MODE':'stnadby'}):
            self.assertRaises(ValueError,run_mode)
