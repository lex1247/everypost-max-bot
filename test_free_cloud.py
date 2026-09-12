import json
import os
import time
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from app import App
from core import Store
from free_cloud import FreeCloud
from local_model import RewriteUnavailable, publishing_enabled


class FreeCloudTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.env = patch.dict(os.environ, {'OWNER_ID': '123', 'LLM_PROVIDER': 'llm7',
            'FREE_TEST_MODE': '1', 'LLM7_APPROVED': '0', 'OPENAI_API_KEY': 'private-openai-key',
            'TG_BOT_TOKEN': 'private-bot-token', 'LLM7_API_KEY': 'must-not-be-used'})
        self.env.start()
        self.store = Store(':memory:')
        self.app = App(self.store, AsyncMock())

    async def asyncTearDown(self):
        self.store.db.close()
        self.env.stop()

    async def test_unapproved_service_never_receives_text(self):
        with patch('free_cloud.httpx.AsyncClient') as client:
            with self.assertRaisesRegex(ValueError, 'не согласована'):
                await self.app.generate('Перепиши', 'Текст')
            client.assert_not_called()
        self.assertFalse(publishing_enabled())
        self.app.http.post.assert_not_awaited()

    async def test_approved_anonymous_request_does_not_use_any_account_keys(self):
        requests = []
        real_client = httpx.AsyncClient
        def handler(request):
            requests.append(request)
            return httpx.Response(200, json={'choices': [{'finish_reason': 'stop',
                'message': {'content': 'Пересказ'}}]})
        with patch.dict(os.environ, {'LLM7_APPROVED': '1'}), patch('free_cloud.httpx.AsyncClient',
                side_effect=lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw)) as factory:
            self.assertEqual(await self.app.generate('Перепиши', 'Текст'), 'Пересказ')
            self.assertTrue(publishing_enabled())
        request = requests[0]
        self.assertEqual(str(request.url), 'https://api.llm7.io/v1/chat/completions')
        self.assertEqual(request.headers['Authorization'], 'Bearer unused')
        body = json.loads(request.content)
        self.assertEqual(body['messages'][-1]['content'], 'Текст')
        self.assertEqual(body['model'], 'default')
        for secret in ('private-openai-key', 'private-bot-token', 'must-not-be-used'):
            self.assertNotIn(secret, str(request.headers) + request.content.decode())
        self.assertFalse(factory.call_args.kwargs['follow_redirects'])
        self.assertFalse(factory.call_args.kwargs['trust_env'])
        self.app.http.post.assert_not_awaited()

    async def test_limit_survives_recreating_provider(self):
        self.store.set('llm7_requests', json.dumps([time.time()] * 8))
        with patch.dict(os.environ, {'LLM7_APPROVED': '1'}), patch('free_cloud.httpx.AsyncClient') as client:
            with self.assertRaises(RewriteUnavailable):
                await FreeCloud(self.store).generate('Перепиши', 'Текст')
            client.assert_not_called()

    async def test_reasoning_verdict_has_room_to_finish(self):
        requests = []
        real_client = httpx.AsyncClient
        def handler(request):
            requests.append(request)
            return httpx.Response(200, json={'model': 'minimax-m2.7', 'choices': [
                {'finish_reason': 'stop', 'message': {'content': 'OK'}}]})
        with patch.dict(os.environ, {'LLM7_APPROVED': '1', 'LLM7_MODEL': 'minimax-m2.7'}), \
                patch('free_cloud.httpx.AsyncClient', side_effect=lambda **kw:
                      real_client(transport=httpx.MockTransport(handler), **kw)):
            self.assertEqual(await self.app.generate('Проверь факты', 'Текст', max_tokens=32), 'OK')
        body = json.loads(requests[0].content)
        self.assertEqual(body['model'], 'minimax-m2.7')
        self.assertGreaterEqual(body['max_tokens'], 2048)
        self.assertEqual(requests[0].headers['Authorization'], 'Bearer unused')

    async def test_post_wrapper_is_not_published(self):
        self.app.generate = AsyncMock(side_effect=['<post>\nНачали работу 2 школы.\n</post>', 'OK'])
        self.assertEqual(await self.app.rewrite('Открыли 2 школы'), 'Начали работу 2 школы.')

    async def test_changed_name_is_retried_before_semantic_approval(self):
        self.app.generate = AsyncMock(side_effect=[
            'Есть ссылка на чат сплетен в Адлере?',
            'У кого есть ссылка на чат сплетни Адлер?', 'OK'])
        self.assertEqual(await self.app.rewrite('Кто даст ссылку на чат сплетни Адлер'),
                         'У кого есть ссылка на чат сплетни Адлер?')
        self.assertIn('Адлер', self.app.generate.call_args_list[1].args[0])

    async def test_retry_after_stops_requests_without_falling_back(self):
        requests = []
        real_client = httpx.AsyncClient
        def handler(request):
            requests.append(request)
            return httpx.Response(429, headers={'Retry-After': '120'})
        with patch.dict(os.environ, {'LLM7_APPROVED': '1'}), patch('free_cloud.httpx.AsyncClient',
                side_effect=lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw)):
            for _ in range(2):
                with self.assertRaises(RewriteUnavailable):
                    await self.app.generate('Перепиши', 'Текст')
        self.assertEqual(len(requests), 1)
        self.assertGreater(float(self.store.get('llm7_pause_until')), time.time() + 100)
        self.app.http.post.assert_not_awaited()
