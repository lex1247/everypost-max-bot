import asyncio
import json
import os
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from app import App
from core import Store
from local_model import LocalModel, RewriteUnavailable, local_base_url, publishing_enabled


class LocalModelTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.env = patch.dict(os.environ, {'LLM_PROVIDER': 'local', 'FREE_TEST_MODE': '1',
            'LOCAL_LLM_URL': 'http://127.0.0.1:18081', 'OWNER_ID': '123',
            'OPENAI_API_KEY': 'must-never-be-used'})
        self.env.start()
        self.store = Store(':memory:')
        self.app = App(self.store, AsyncMock())
        self.app.notify = AsyncMock()

    async def asyncTearDown(self):
        self.store.db.close()
        self.env.stop()

    async def test_free_local_generation_uses_only_loopback_without_credentials(self):
        requests = []
        def handler(request):
            requests.append(request)
            return httpx.Response(200, json={'choices': [{'finish_reason': 'stop',
                'message': {'content': 'Сохранили 2 места.'}}]})
        real_client = httpx.AsyncClient
        with patch('local_model.httpx.AsyncClient', side_effect=lambda **kw:
                   real_client(transport=httpx.MockTransport(handler), **kw)) as factory:
            result = await self.app.generate('Перепиши', 'Оставили 2 места.')
        self.assertEqual(result, 'Сохранили 2 места.')
        self.app.http.post.assert_not_awaited()
        self.assertEqual(len(requests), 1)
        self.assertEqual(str(requests[0].url), 'http://127.0.0.1:18081/v1/chat/completions')
        self.assertNotIn('authorization', requests[0].headers)
        self.assertNotIn('must-never-be-used', requests[0].content.decode())
        self.assertFalse(factory.call_args.kwargs['trust_env'])
        self.assertFalse(factory.call_args.kwargs['follow_redirects'])
        self.assertFalse(json.loads(requests[0].content)['chat_template_kwargs']['enable_thinking'])
        self.assertEqual(json.loads(requests[0].content)['reasoning_effort'], 'none')

    async def test_cannot_redirect_free_mode_to_a_cloud_endpoint(self):
        for url in ('https://api.openai.com', 'http://example.com:80',
                    'http://127.0.0.1:80@other.test', 'http://127.0.0.1:80/redirect',
                    'http://127.0.0.1:80?url=x', 'http://127.0.0.1:80#x'):
            with self.subTest(url=url), patch.dict(os.environ, {'LOCAL_LLM_URL': url}):
                with self.assertRaises(ValueError):
                    local_base_url()

    async def test_incomplete_answers_and_redirects_do_not_become_posts(self):
        responses = [httpx.Response(302, headers={'Location': 'https://paid.example'}),
                     httpx.Response(200, json={'choices': [{'finish_reason': 'length',
                                      'message': {'content': 'Обрезанный текст'}}]}),
                     httpx.Response(200, json={'choices': []}),
                     httpx.Response(200, json={'choices': [{'finish_reason': 'stop',
                                      'message': {'content': '<think>Размышления'}}]})]
        real_client = httpx.AsyncClient
        for response in responses:
            with patch('local_model.httpx.AsyncClient', side_effect=lambda **kw:
                       real_client(transport=httpx.MockTransport(lambda _: response), **kw)):
                with self.assertRaises(ValueError):
                    await LocalModel().generate('Перепиши', 'Текст')

    async def test_unavailable_model_has_no_paid_fallback(self):
        real_client = httpx.AsyncClient
        def handler(request):
            raise httpx.ConnectError('offline', request=request)
        with patch('local_model.httpx.AsyncClient', side_effect=lambda **kw:
                   real_client(transport=httpx.MockTransport(handler), **kw)):
            with self.assertRaises(RewriteUnavailable):
                await self.app.generate('Перепиши', 'Текст')
        self.app.http.post.assert_not_awaited()

    async def test_local_mode_sends_once_and_respects_pause(self):
        sid = self.store.add_source('tg', '-1001', 'Источник', 0)
        did = self.store.add_destination('tg', '-1002', 'Канал')
        self.store.run('INSERT INTO routes VALUES(?,?)', (sid, did))
        self.store.ingest(sid, [(1, 'Текст', 'https://t.me/example/1')], 1)
        self.store.run("UPDATE posts SET rewritten='Пересказ',status='ready'")
        d = self.store.rows('''SELECT d.id,p.rewritten,p.url,t.platform,t.remote target
            FROM deliveries d JOIN posts p ON p.id=d.post JOIN destinations t ON t.id=d.destination''')[0]
        self.app.tg = AsyncMock(return_value={'message_id': 77})
        self.assertTrue(publishing_enabled())
        self.store.set('paused', '1')
        await self.app.deliver(d)
        self.app.tg.assert_not_awaited()
        self.store.set('paused', '0')
        await self.app.deliver(d)
        await self.app.deliver(d)
        self.app.tg.assert_awaited_once()

    async def test_temporary_outage_keeps_original_queued(self):
        sid = self.store.add_source('tg', '-1001', 'Источник', 0)
        did = self.store.add_destination('tg', '-1002', 'Канал')
        self.store.run('INSERT INTO routes VALUES(?,?)', (sid, did))
        self.store.ingest(sid, [(1, 'Текст', 'https://t.me/example/1')], 1)
        self.app.rewrite = AsyncMock(side_effect=RewriteUnavailable('Модель занята'))
        self.app.deliver = AsyncMock()
        with patch('app.asyncio.sleep', side_effect=asyncio.CancelledError):
            with self.assertRaises(asyncio.CancelledError):
                await self.app.rewrite_queue()
        self.assertEqual(self.store.rows('SELECT status FROM posts')[0][0], 'new')
        self.assertEqual(self.store.rows('SELECT status FROM deliveries')[0][0], 'pending')
        self.app.deliver.assert_not_awaited()
        self.app.notify.assert_awaited_once()

    async def test_unchanged_draft_is_rewritten_before_verification(self):
        self.app.generate = AsyncMock(side_effect=['Открыли 2 школы', 'Начали работу 2 школы', 'OK'])
        self.assertEqual(await self.app.rewrite('Открыли 2 школы'), 'Начали работу 2 школы')
        self.assertEqual(self.app.generate.await_count, 3)

    async def test_repeated_original_is_never_accepted_as_rewritten(self):
        self.app.generate = AsyncMock(return_value='Открыли 2 школы')
        with self.assertRaisesRegex(ValueError, 'без переписывания'):
            await self.app.rewrite('Открыли 2 школы')
        self.assertEqual(self.app.generate.await_count, 2)

    async def test_json_wrapper_and_punctuation_are_not_a_rewrite(self):
        self.app.generate = AsyncMock(side_effect=[json.dumps({'post': 'Открыли 2 школы.'}, ensure_ascii=False),
            json.dumps({'post': 'Начали работу 2 школы.'}, ensure_ascii=False), 'OK'])
        self.assertEqual(await self.app.rewrite('Открыли 2 школы'), 'Начали работу 2 школы.')

    async def test_structured_verdict_is_checked_and_not_published(self):
        for verdict in ('OK', 'FAIL'):
            self.app.generate = AsyncMock(side_effect=[json.dumps({'post': 'Начали работу 2 школы'}),
                                                       json.dumps({'verdict': verdict})])
            if verdict == 'OK':
                self.assertEqual(await self.app.rewrite('Открыли 2 школы'), 'Начали работу 2 школы')
            else:
                with self.assertRaisesRegex(ValueError, 'Проверка смысла'):
                    await self.app.rewrite('Открыли 2 школы')

    async def test_unexpected_json_fields_are_not_sent_as_text(self):
        self.app.generate = AsyncMock(return_value='{"post":"Начали работу 2 школы", "extra":"junk"}')
        with self.assertRaisesRegex(ValueError, 'формат поста'):
            await self.app.rewrite('Открыли 2 школы')

    async def test_structured_request_rejects_a_plain_response(self):
        real_client = httpx.AsyncClient
        requests = []
        def handler(request):
            requests.append(request)
            return httpx.Response(200, json={'choices': [{'finish_reason': 'stop', 'message': {'content': 'OK'}}]})
        schema = {'type': 'object', 'properties': {'verdict': {'type': 'string', 'enum': ['OK','FAIL']}},
                  'required': ['verdict'], 'additionalProperties': False}
        with patch('local_model.httpx.AsyncClient', side_effect=lambda **kw:
                   real_client(transport=httpx.MockTransport(handler), **kw)):
            with self.assertRaisesRegex(ValueError, 'формат ответа'):
                await LocalModel().generate('Проверь', 'Текст', json_schema=schema)
        self.assertEqual(json.loads(requests[0].content)['response_format']['json_schema']['schema'], schema)


if __name__ == '__main__':
    unittest.main()
