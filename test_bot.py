import json
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from core import Store, source_link, check_rewrite
from app import App, APIError


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.s = Store(':memory:')
        self.sid = self.s.add_source('vk', '-1', 'Источник', 10)
        self.did = self.s.add_destination('tg', '-1002', 'Канал')
        self.s.run('INSERT INTO routes VALUES(?,?)', (self.sid, self.did))

    def tearDown(self):
        self.s.db.close()

    def test_repeated_poll_is_deduplicated(self):
        for _ in range(2):
            self.s.ingest(self.sid, [(11, 'Открыли 2 школы', 'https://vk.com/wall-1_11')], 11)
        self.assertEqual(len(self.s.rows('SELECT * FROM posts')), 1)
        self.assertEqual(len(self.s.rows('SELECT * FROM deliveries')), 1)

    def test_new_destination_does_not_replay_old_posts(self):
        self.s.ingest(self.sid, [(11, 'Пост', 'url')], 11)
        second = self.s.add_destination('max', '-3', 'MAX')
        self.s.run('INSERT INTO routes VALUES(?,?)', (self.sid, second))
        self.s.ingest(self.sid, [(11, 'Пост', 'url'), (12, 'Новый', 'url2')], 12)
        self.assertEqual(len(self.s.rows('SELECT * FROM deliveries')), 3)

    def test_cursor_not_rewound_and_empty_media_skipped(self):
        self.s.ingest(self.sid, [(11, '', 'url')], 11)
        self.s.ingest(self.sid, [], 3)
        self.assertEqual(self.s.rows('SELECT cursor FROM sources')[0][0], 11)
        self.assertFalse(self.s.rows('SELECT * FROM posts'))

    def test_atomic_ingestion_rolls_back_on_failure(self):
        with self.assertRaises(Exception):
            self.s.ingest(self.sid, [(11, 'Первый', 'url'), (12, 'Второй', None)], 12)
        self.assertFalse(self.s.rows('SELECT * FROM posts'))
        self.assertEqual(self.s.rows('SELECT cursor FROM sources')[0][0], 10)

    def test_restart_does_not_blindly_resend(self):
        with tempfile.TemporaryDirectory() as folder:
            path = folder + '/db'
            s = Store(path)
            sid = s.add_source('vk', '-1', 'VK', 0)
            did = s.add_destination('max', '-2', 'MAX')
            s.run('INSERT INTO routes VALUES(?,?)', (sid, did))
            s.ingest(sid, [(1, 'Пост', 'url')], 1)
            s.run("UPDATE deliveries SET status='sending'")
            s.db.close()
            reopened = Store(path)
            self.assertEqual(reopened.rows('SELECT status FROM deliveries')[0][0], 'unknown')
            reopened.db.close()

    def test_source_and_destination_cannot_be_same_channel(self):
        self.s.add_source('tg', '-1003', 'TG', 0)
        with self.assertRaises(ValueError):
            self.s.add_destination('tg', '-1003', 'TG')


class ParsingTests(unittest.TestCase):
    def test_supported_links(self):
        self.assertEqual(source_link('https://t.me/s/News_channel'), ('tg', 'news_channel'))
        self.assertEqual(source_link('https://vk.ru/public123'), ('vk', 'public123'))
        self.assertEqual(source_link('@channel'), ('tg', 'channel'))

    def test_reject_wrong_host_and_post_links(self):
        for link in ('https://t.me.attacker.org/name', 'https://vk.com/wall-1_2/foo', 'https://t.me/name/123', 'https://t.me/+invite'):
            with self.subTest(link=link), self.assertRaises(ValueError):
                source_link(link)

    def test_numeric_changes_and_empty_output_blocked(self):
        for text in ('Открыли 3 школы', ''):
            with self.assertRaises(ValueError):
                check_rewrite('Открыли 2 школы', text)
        check_rewrite('Открыли 2 школы', 'Начали работу 2 школы')

    def test_contact_and_link_changes_blocked(self):
        original = 'Ответьте @person: https://example.org/form'
        check_rewrite(original, 'Связь: @person, анкета https://example.org/form.')
        for result in ('Ответьте @another: https://example.org/form',
                       'Ответьте @person', 'Ответьте @person: https://example.org/other'):
            with self.subTest(result=result), self.assertRaises(ValueError):
                check_rewrite(original, result)


class FlowTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.env = patch.dict(os.environ, {'OWNER_ID': '123', 'TG_BOT_TOKEN': 'test', 'MAX_BOT_TOKEN': 'test'})
        self.env.start()
        self.s = Store(':memory:')
        self.sid = self.s.add_source('vk', '-1', 'VK', 0)
        for platform, remote in [('tg', '-1002'), ('max', '-3')]:
            did = self.s.add_destination(platform, remote, platform)
            self.s.run('INSERT INTO routes VALUES(?,?)', (self.sid, did))
        self.s.ingest(self.sid, [(1, 'Пост', 'https://vk.com/wall-1_1')], 1)
        self.s.run("UPDATE posts SET rewritten='Новый текст',status='ready'")
        self.app = App(self.s, None)
        self.app.notify = AsyncMock()

    async def asyncTearDown(self):
        self.s.db.close()
        self.env.stop()

    def deliveries(self):
        return self.s.rows('''SELECT d.id,p.rewritten,p.url,t.platform,t.remote target FROM deliveries d
          JOIN posts p ON p.id=d.post JOIN destinations t ON t.id=d.destination ORDER BY d.id''')

    async def test_partial_success_retries_only_failed_destination(self):
        self.app.tg = AsyncMock(return_value={'message_id': 44})
        self.app.max_api = AsyncMock(side_effect=APIError('MAX', 429, 30))
        for d in self.deliveries():
            await self.app.deliver(d)
        self.assertEqual([r[0] for r in self.s.rows('SELECT status FROM deliveries ORDER BY id')], ['sent', 'pending'])
        self.app.max_api = AsyncMock(return_value={'message': {'body': {'mid': 'x'}}})
        for d in self.deliveries():
            await self.app.deliver(d)
        self.app.tg.assert_awaited_once()
        self.assertEqual([r[0] for r in self.s.rows('SELECT status FROM deliveries')], ['sent', 'sent'])

    async def test_timeout_requires_manual_resolution(self):
        self.app.tg = AsyncMock(side_effect=httpx.ReadTimeout('private detail'))
        await self.app.deliver(self.deliveries()[0])
        self.assertEqual(self.s.rows('SELECT status FROM deliveries WHERE id=1')[0][0], 'unknown')
        await self.app.deliver(self.deliveries()[0])
        self.app.tg.assert_awaited_once()

    async def test_bad_success_response_is_ambiguous(self):
        self.app.tg = AsyncMock(side_effect=json.JSONDecodeError('bad json', '', 0))
        await self.app.deliver(self.deliveries()[0])
        self.assertEqual(self.s.rows('SELECT status FROM deliveries WHERE id=1')[0][0], 'unknown')

    async def test_pause_prevents_send(self):
        self.s.set('paused', 1)
        self.app.tg = AsyncMock()
        await self.app.deliver(self.deliveries()[0])
        self.app.tg.assert_not_awaited()

    async def test_free_mode_never_calls_paid_generation(self):
        self.app.http = AsyncMock()
        with patch.dict(os.environ, {'FREE_TEST_MODE': '1'}):
            with self.assertRaisesRegex(ValueError, 'бесплатном тесте'):
                await self.app.generate('Перепиши', 'Пост')
        self.app.http.post.assert_not_awaited()

    async def test_resume_cannot_override_free_mode(self):
        self.app.tg = AsyncMock()
        with patch.dict(os.environ, {'FREE_TEST_MODE': '1'}):
            self.assertIn('блокировать', await self.app.command('/resume'))
            await self.app.deliver(self.deliveries()[0])
        self.app.tg.assert_not_awaited()
        self.assertEqual(self.s.rows('SELECT status FROM deliveries WHERE id=1')[0][0], 'pending')

    async def test_unroute_cancels_only_selected_destination(self):
        await self.app.command('/unroute 1 2')
        self.assertEqual([r[0] for r in self.s.rows('SELECT status FROM deliveries ORDER BY id')], ['pending', 'cancelled'])

    async def test_explicit_free_test_sends_only_approved_delivery_once(self):
        self.app.tg = AsyncMock(return_value={'message_id': 55})
        self.app.max_api = AsyncMock()
        first, second = self.deliveries()
        with patch.dict(os.environ, {'FREE_TEST_MODE': '1'}):
            await self.app.deliver(first, approved_test_id=True)
            self.app.tg.assert_not_awaited()
            await self.app.deliver(first, approved_test_id=first['id'])
            await self.app.deliver(first, approved_test_id=first['id'])
            await self.app.deliver(second, approved_test_id=first['id'])
            await self.app.deliver(second)
        self.app.tg.assert_awaited_once()
        self.app.max_api.assert_not_awaited()
        self.assertEqual([r[0] for r in self.s.rows('SELECT status FROM deliveries ORDER BY id')], ['sent', 'pending'])

    async def test_rewrite_verification_failure_blocks(self):
        self.app.generate = AsyncMock(side_effect=['Открылись 2 школы', 'FAIL'])
        with self.assertRaises(ValueError):
            await self.app.rewrite('Открыли 2 школы')

    async def test_vk_pinned_old_post_does_not_stop_pagination(self):
        first = [{'id': 1, 'is_pinned': 1, 'text': 'Старый'}] + [{'id': i, 'text': f'Пост {i}'} for i in range(201, 102, -1)]
        second = [{'id': i, 'text': f'Пост {i}'} for i in range(102, 99, -1)]
        self.s.run('UPDATE sources SET cursor=100')
        self.app.vk = AsyncMock(side_effect=[{'items': first}, {'items': second}])
        await self.app.fetch(self.s.rows('SELECT * FROM sources')[0])
        self.assertEqual(self.app.vk.await_count, 2)
        self.assertEqual(self.s.rows('SELECT max(remote) FROM posts')[0][0], 201)
        self.assertTrue(self.s.rows('SELECT 1 FROM posts WHERE remote=101'))

    async def test_real_http_payloads_on_mock_transport(self):
        requests = []
        def handler(request):
            requests.append(request)
            if request.url.host == 'api.telegram.org':
                return httpx.Response(200, json={'ok': True, 'result': {'message_id': 17}})
            return httpx.Response(200, json={'message': {'body': {'mid': 'max17'}}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            self.app.http = client
            for d in self.deliveries():
                await self.app.deliver(d)
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[1].headers['Authorization'], 'test')
        self.assertEqual(requests[1].url.params['chat_id'], '-3')
        self.assertEqual(json.loads(requests[0].content)['text'], 'Новый текст')
        self.assertEqual(json.loads(requests[1].content)['text'], 'Новый текст')


if __name__ == '__main__':
    unittest.main()
