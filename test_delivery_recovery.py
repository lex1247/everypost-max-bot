import asyncio
import json
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, patch
import httpx
from app import App
from core import Store
from media import normal_media
from media_download import download, MediaTemporary
from public_telegram import PublicTelegram, SourceMissing, parse_preview
from test_public_telegram import page


PHOTO = {'photos': [{'url': 'https://cdn4.telesco.pe/file/new.jpg'}]}
JPEG = b'\xff\xd8\xffphoto'


class DownloadTests(unittest.IsolatedAsyncioTestCase):
    async def test_temporary_http_and_broken_connection_retry_before_publish(self):
        for failure in (httpx.Response(503), httpx.ReadError('private URL')):
            calls = []
            def handler(request):
                calls.append(request)
                if len(calls) == 1:
                    if isinstance(failure, Exception): raise failure
                    return failure
                return httpx.Response(200, content=JPEG)
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as h:
                with patch('media_download.asyncio.sleep', AsyncMock()):
                    self.assertEqual(await download(h, 'https://cdn4.telesco.pe/a', 100, 'Фото'), JPEG)
                self.assertEqual(len(calls), 2)

    async def test_bounded_outage_and_rate_limit(self):
        for status, expected in ((503, 3), (429, 1)):
            requests = []
            def handler(request):
                requests.append(request)
                return httpx.Response(status, headers={'retry-after': '120'})
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as h:
                with patch('media_download.asyncio.sleep', AsyncMock()), self.assertRaises(MediaTemporary) as cm:
                    await download(h, 'https://cdn4.telesco.pe/a', 100, 'Фото')
                self.assertEqual(len(requests), expected)
                self.assertEqual(cm.exception.retry_after, 120)

    async def test_redirect_permanent_error_and_oversize_are_not_retried(self):
        for reply in (httpx.Response(302, headers={'location': 'https://evil.test/a'}),
                      httpx.Response(403), httpx.Response(404),
                      httpx.Response(200, content=b'abc', headers={'content-length': '1000'}),
                      httpx.Response(200, content=b'x' * 101)):
            calls = []
            def handler(request): calls.append(request); return reply
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as h:
                with self.assertRaises(ValueError): await download(h, 'https://cdn4.telesco.pe/a', 100, 'Фото')
            self.assertEqual(len(calls), 1)


class PublicMediaTests(unittest.IsolatedAsyncioTestCase):
    def test_mixed_album_keeps_order_and_ignores_only_video_fallback(self):
        media = '''<a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn4.telesco.pe/a.jpg')"></a>
            <div class="tgme_widget_message_video_player"><video class="blured" src="https://cdn4.telesco.pe/blur.mp4"></video>
            <video src="https://cdn4.telesco.pe/real.mp4"></video><div class="message_media_not_supported">fallback</div></div>'''
        html = page([1]).replace('</div></div>', '</div>' + media + '</div>')
        result = parse_preview(html, 'news_channel').posts[0][3]
        self.assertEqual([i['type'] for i in result['gallery']], ['photo', 'video'])
        self.assertTrue(result['gallery'][1]['url'].endswith('real.mp4'))
        self.assertFalse(result['unsupported'])
        split = html.rfind('</div>')
        result = parse_preview(html[:split] + '<div class="message_media_not_supported">hidden</div>' + html[split:], 'news_channel').posts[0][3]
        self.assertTrue(result['unsupported'])

    def test_video_urls_are_restricted(self):
        for url in ('http://cdn4.telesco.pe/a', 'https://telesco.pe.evil.test/a',
                    'https://user:pass@cdn4.telesco.pe/a', 'https://cdn4.telesco.pe:444/a',
                    'https://sun1.userapi.com/a', 'https://127.0.0.1/a'):
            with self.assertRaises(ValueError): normal_media({'gallery': [{'type': 'video', 'url': url}]})

    async def test_single_checks_identity_missing_and_temporary_page(self):
        for content, status, expected in ((page([1]), 200, None),
                   ('<div class="tgme_widget_message_error">Post not found</div>', 200, SourceMissing),
                   (page([2]), 200, ValueError), (page([1], channel=77), 200, ValueError), ('bad', 503, MediaTemporary)):
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(status, text=content))) as h:
                if expected:
                    with self.assertRaises(expected): await PublicTelegram(h).single('news_channel', -1000000000099, 1)
                else: self.assertEqual((await PublicTelegram(h).single('news_channel', -1000000000099, 1))[0], 1)


class RecoveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {'OWNER_ID': '123', 'TG_BOT_TOKEN': 'test', 'FREE_TEST_MODE': '1', 'TRUSTAT_API_KEY': ''})
        self.env.start();self.s = Store(':memory:');self.app = App(self.s, None)
        self.app.tg = AsyncMock(return_value={'message_id': 77});self.app.notify = AsyncMock()
        self.app.editor.access = AsyncMock();self.app.photo_file = AsyncMock(return_value=('a.jpg', JPEG, 'image/jpeg'))
        self.sid = self.s.add_source('tg', '-1000000000099', 'Source', 0)
        self.did = self.s.add_destination('tg', '-1002', 'Test');self.s.run('INSERT INTO routes VALUES(?,?)', (self.sid, self.did))
        self.s.set_route_mode(self.sid, self.did, 'original');self.s.set('tg_public:-1000000000099', 'news_channel')
        self.s.ingest(self.sid, [(1, 'Старый текст', 'https://t.me/news_channel/1', {'unsupported': ['другое медиа']})], 1)
        self.s.run("UPDATE deliveries SET status='failed'")
        self.app.public_tg.single = AsyncMock(return_value=(1, 'Новая подпись', 'https://t.me/news_channel/1', PHOTO))

    def tearDown(self): self.s.db.close();self.env.stop()

    async def test_refresh_only_prepares_then_retry_publishes_once(self):
        row = await self.app.recovery.refresh(1)
        self.assertEqual(row['status'], 'review');self.app.tg.assert_not_awaited()
        self.assertEqual(self.s.rows('SELECT original FROM posts')[0][0], 'Старый текст')
        self.assertTrue(await self.app.recovery.retry(1))
        with self.assertRaises(ValueError): await self.app.recovery.retry(1)
        with patch('app.asyncio.sleep', AsyncMock()):
            await self.app.deliver({'id': 1});await self.app.deliver({'id': 1})
        self.app.tg.assert_awaited_once();self.assertEqual(self.app.tg.call_args.kwargs['caption'], 'Новая подпись')
        self.assertEqual(self.app.recovery.row(1)['status'], 'sent')

    async def test_deleted_original_is_preserved_unavailable_and_not_retried(self):
        self.app.public_tg.single.side_effect = SourceMissing('Нет оригинала')
        row = await self.app.recovery.refresh(1)
        self.assertEqual(row['status'], 'unavailable')
        with self.assertRaises(ValueError): await self.app.recovery.retry(1)
        self.app.recovery.skip(1);self.assertEqual(self.app.recovery.row(1)['status'], 'cancelled')
        self.assertEqual(len(self.s.rows('SELECT * FROM posts')), 1)
        self.app.tg.assert_not_awaited()

    async def test_partial_and_unknown_are_never_replaced(self):
        for status in ('sent', 'unknown', 'sending'):
            self.s.run('DELETE FROM delivery_parts')
            self.s.run('INSERT INTO delivery_parts(delivery,part,payload,status) VALUES(1,0,?,?)', ('{}', status))
            with self.assertRaises(ValueError): await self.app.recovery.refresh(1)
        self.app.public_tg.single.assert_not_awaited()

    async def test_duplicate_refresh_is_claimed_once(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def single(*args):
            entered.set();await release.wait()
            return (1, 'Подпись', 'https://t.me/news_channel/1', PHOTO)
        self.app.public_tg.single.side_effect = single
        first = asyncio.create_task(self.app.recovery.refresh(1))
        await entered.wait()
        with self.assertRaises(ValueError): await self.app.recovery.refresh(1)
        release.set();await first
        self.app.public_tg.single.assert_awaited_once()
        self.assertEqual(self.app.recovery.row(1)['status'], 'review')
        self.assertEqual(len(self.s.rows('SELECT * FROM delivery_parts')), 1)
        self.app.tg.assert_not_awaited()

    async def test_unroute_while_downloading_wins(self):
        async def photo(_):
            await self.app.command('/unroute 1 1');return ('a.jpg', JPEG, 'image/jpeg')
        self.app.photo_file.side_effect = photo
        self.assertEqual((await self.app.recovery.refresh(1))['status'], 'cancelled')
        self.assertFalse(self.s.rows('SELECT * FROM delivery_parts'))

    async def test_stale_buttons_and_foreign_actors_cannot_retry(self):
        token = self.app.recovery.fingerprint(self.app.recovery.row(1))
        await self.app.recovery.refresh(1)
        def update(actor): return {'callback_query': {'id': 'q', 'from': {'id': actor}, 'message': {'chat': {'id': actor, 'type': 'private'}}, 'data': f'repair:retry:1:{token}'}}
        with self.assertRaises(ValueError): await self.app.recovery.handle(update(123))
        await self.app.recovery.handle(update(999))
        self.assertEqual(self.app.recovery.row(1)['status'], 'review')

    async def test_trustat_fallback_only_for_hidden_files_and_fresh_check(self):
        with patch.dict(os.environ, {'TRUSTAT_API_KEY': 'test'}):
            value = {'channel_id': 99, 'message_id': 1, 'source': 'telegram', 'text': 'Подпись',
                     'media': {'media_type': 'mediaPhoto', 'file_url': 'https://static1.trustat.ru/a.jpg'}}
            self.app.public_tg.single.return_value = (1, '', 'https://t.me/news_channel/1', {'unsupported': ['скрыто']})
            with patch('trustat_source.Trustat.detail', AsyncMock(return_value=value)) as detail:
                self.assertEqual((await self.app.recovery.refresh(1))['status'], 'review')
                detail.assert_awaited_once_with(99, 1, fresh=True)

    async def test_temporary_download_exhaustion_is_durable_and_bounded(self):
        await self.app.recovery.refresh(1);await self.app.recovery.retry(1)
        self.app.photo_file.side_effect = MediaTemporary('Временно недоступно')
        for attempt in range(5):
            await self.app.deliver({'id': 1})
            row = self.app.recovery.row(1)
            self.assertEqual(row['media_attempts'], attempt + 1)
            self.assertEqual(row['status'], 'failed' if attempt == 4 else 'pending')
        self.app.tg.assert_not_awaited()

    async def test_expired_photo_is_refreshed_but_shared_post_unchanged(self):
        self.app.photo_file.side_effect = ValueError('HTTP 403')
        self.assertEqual((await self.app.recovery.refresh(1))['status'], 'failed')
        self.app.photo_file.side_effect = None
        self.assertEqual((await self.app.recovery.refresh(1))['status'], 'review')
        self.assertIn('new.jpg', self.s.rows('SELECT payload FROM delivery_parts')[0][0])

    def test_interrupted_check_is_recoverable(self):
        self.s.run("UPDATE deliveries SET status='repairing'");self.s.recover()
        self.assertEqual(self.app.recovery.row(1)['status'], 'failed')

    def test_video_without_caption_is_not_dropped(self):
        self.s.ingest(self.sid, [(2, '', 'url', {'gallery': [{'type': 'video', 'url': 'https://cdn4.telesco.pe/v.mp4'}]})], 2)
        self.assertEqual(len(self.s.rows('SELECT * FROM deliveries')), 2)
