import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from app import App, APIError
from core import Store
from media import normal_media, publication_parts, text_chunks, utf16_len, vk_media
from public_telegram import PublicTelegram, parse_preview
from test_public_telegram import page


def photos(count=1):
    return {'photos': [{'url': f'https://cdn4.telesco.pe/file/photo{i}.jpg'} for i in range(count)]}


class MediaTests(unittest.TestCase):
    def test_photos_and_long_unicode_text_are_complete(self):
        text = ('😀 Длинный текст\n' * 900).strip()
        for platform, size, limit in [('tg', 10, 4096), ('max', 12, 4000)]:
            parts = publication_parts(platform, text, photos(23))
            groups = [p.get('photos', [p['photo']] if 'photo' in p else []) for p in parts]
            self.assertEqual(sum(map(len, groups)), 23)
            self.assertTrue(all(len(group) <= size for group in groups))
            texts = [p.get('text', p.get('caption', '')) for p in parts]
            self.assertEqual(''.join(texts), text)
            self.assertTrue(all(utf16_len(t) <= limit for t in texts))

    def test_short_caption_and_photo_only(self):
        for platform in ('tg', 'max'):
            part = publication_parts(platform, 'Подпись', photos())[0]
            self.assertEqual(part.get('caption', part.get('text')), 'Подпись')
            self.assertEqual(len(publication_parts(platform, '', photos())), 1)

    def test_invalid_media_never_becomes_a_text_only_publication(self):
        for media in ({'unsupported': ['видео']}, {'photos': [None]}, {'photos': 'bad'},
                      {'photos': ['http://cdn4.telesco.pe/a']},
                      {'photos': ['https://telesco.pe.evil.example/a']}):
            with self.subTest(media=media), self.assertRaises(ValueError):
                publication_parts('tg', 'Текст', media)

    def test_vk_selects_largest_photo_and_includes_repost_photos(self):
        photo = {'type': 'photo', 'photo': {'sizes': [
            {'width': 50, 'height': 50, 'url': 'https://sun1.userapi.com/small.jpg'},
            {'width': 1000, 'height': 700, 'url': 'https://sun1.userapi.com/large.jpg'}]}}
        result = vk_media({'attachments': [photo], 'copy_history': [{'attachments': [photo]}]})
        self.assertEqual(len(result['photos']), 1)
        self.assertTrue(result['photos'][0]['url'].endswith('/large.jpg'))
        self.assertEqual(vk_media({'attachments': [{'type': 'video'}]})['unsupported'], ['video'])

    def test_preview_album_keeps_photos_but_not_video_thumbnail(self):
        markup = ''.join(f'<a class="tgme_widget_message_photo_wrap" style="background-image:url(\'https://cdn4.telesco.pe/file/{i}.jpg\')"></a>' for i in range(2))
        html = page([12], body='Подпись', grouped=True).replace('</div></div>', '</div>' + markup + '</div>')
        result = parse_preview(html, 'news_channel').posts[0]
        self.assertEqual(len(result[3]['photos']), 2)
        video = '<div class="tgme_widget_message_video_player" style="background-image:url(\'https://cdn4.telesco.pe/file/thumb.jpg\')"><video></video></div>'
        result = parse_preview(page([13]).replace('</div></div>', '</div>' + video + '</div>'), 'news_channel').posts[0]
        self.assertEqual(result[3]['photos'], [])
        self.assertEqual(result[3]['unsupported'], ['видео'])

    def test_route_mode_persists_and_changes_only_unstarted_deliveries(self):
        with tempfile.TemporaryDirectory() as folder:
            s = Store(folder + '/db')
            sid = s.add_source('tg', '-1001', 'Source', 0)
            did = s.add_destination('tg', '-1002', 'Target')
            s.run('INSERT INTO routes VALUES(?,?)', (sid, did))
            s.ingest(sid, [(i, 'Текст', 'url', photos()) for i in range(1, 4)], 3)
            s.run("UPDATE deliveries SET status='sent' WHERE id=1")
            s.run("INSERT INTO delivery_parts(delivery,part,payload,status) VALUES(2,0,'{}','sent')")
            s.set_route_mode(sid, did, 'original')
            self.assertEqual([r['mode'] for r in s.rows('SELECT mode FROM deliveries ORDER BY id')], ['ai', 'ai', 'original'])
            s.db.close()
            s = Store(folder + '/db')
            s.ingest(sid, [(4, '', 'url', photos())], 4)
            self.assertEqual(s.route_mode(sid, did), 'original')
            self.assertEqual(s.rows('SELECT mode FROM deliveries WHERE post=4')[0]['mode'], 'original')
            s.db.close()


class MediaFlowTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.env = patch.dict(os.environ, {'OWNER_ID': '123', 'TG_BOT_TOKEN': 'test', 'MAX_BOT_TOKEN': 'test', 'FREE_TEST_MODE': '1', 'LLM_PROVIDER': 'openai'})
        self.env.start()
        self.sleep = patch('app.asyncio.sleep', new_callable=AsyncMock)
        self.sleep.start()
        self.s = Store(':memory:')
        self.sid = self.s.add_source('tg', '-1001', 'Источник', 0)
        self.did = self.s.add_destination('tg', '-1002', 'Канал')
        self.s.run('INSERT INTO routes VALUES(?,?)', (self.sid, self.did))
        self.app = App(self.s, None)
        self.app.notify = AsyncMock()
        self.app.rewrite = AsyncMock(side_effect=AssertionError('Original mode must not use AI'))
        self.app.photo_file = AsyncMock(return_value=('photo.jpg', b'\xff\xd8\xfftest', 'image/jpeg'))

    async def asyncTearDown(self):
        self.s.db.close()
        self.sleep.stop()
        self.env.stop()

    def ingest(self, text='Оригинал @person https://example.org', media=None):
        self.s.set_route_mode(self.sid, self.did, 'original')
        self.s.ingest(self.sid, [(1, text, 'https://t.me/source/1', media or photos())], 1)
        return self.s.rows('SELECT * FROM deliveries')[0]

    async def test_original_mode_sends_photo_with_exact_original_and_no_ai(self):
        d = self.ingest()
        self.app.tg = AsyncMock(return_value={'message_id': 10, 'photo': [{}]})
        await self.app.deliver(d)
        self.assertEqual(self.app.tg.call_args.args, ('sendPhoto',))
        self.assertEqual(self.app.tg.call_args.kwargs['caption'], 'Оригинал @person https://example.org')
        self.assertNotIn('Источник:', self.app.tg.call_args.kwargs['caption'])
        self.app.rewrite.assert_not_awaited()
        self.assertEqual(self.s.rows('SELECT status FROM deliveries')[0][0], 'sent')

    async def test_long_album_retries_only_remaining_text(self):
        d = self.ingest('Б' * 5000, photos(2))
        self.app.tg = AsyncMock(side_effect=[[{'message_id': 10}, {'message_id': 11}], APIError('Telegram', 429, 10)])
        await self.app.deliver(d)
        self.assertEqual([r[0] for r in self.s.rows('SELECT status FROM delivery_parts ORDER BY part')], ['sent', 'pending', 'pending'])
        self.app.tg = AsyncMock(side_effect=[{'message_id': 12}, {'message_id': 13}])
        await self.app.deliver(d)
        self.assertEqual([c.args[0] for c in self.app.tg.call_args_list], ['sendMessage', 'sendMessage'])
        self.assertEqual(json.loads(self.s.rows('SELECT remote FROM deliveries')[0][0]), ['10', '11', '12', '13'])

    async def test_uncertain_album_response_is_not_retried_automatically(self):
        d = self.ingest(media=photos(2))
        self.app.tg = AsyncMock(return_value=[])
        await self.app.deliver(d)
        await self.app.deliver(d)
        self.app.tg.assert_awaited_once()
        self.assertEqual(self.s.rows('SELECT status FROM deliveries')[0][0], 'unknown')

    async def test_unroute_during_first_part_cancels_remaining_parts(self):
        d = self.ingest('Б' * 5000)
        async def send(*args, **kwargs):
            await self.app.command('/unroute 1 1')
            return {'message_id': 10}
        self.app.tg = AsyncMock(side_effect=send)
        await self.app.deliver(d)
        self.app.tg.assert_awaited_once()
        self.assertEqual(self.s.rows('SELECT status FROM deliveries')[0][0], 'cancelled')

    async def test_unsupported_video_blocks_entire_post(self):
        d = self.ingest(media={'photos': photos()['photos'], 'unsupported': ['видео']})
        self.app.tg = AsyncMock()
        await self.app.deliver(d)
        self.app.tg.assert_not_awaited()
        self.assertEqual(self.s.rows('SELECT status FROM deliveries')[0][0], 'failed')

    async def test_max_image_request_and_telegram_album_request(self):
        d = self.ingest(media=photos(2))
        self.s.run("UPDATE destinations SET platform='max',remote='-3'")
        requests = []
        def handler(request):
            requests.append(request)
            if request.url.path == '/uploads':
                return httpx.Response(200, json={'url': 'https://iu.oneme.ru/upload.do?token=test-media'})
            if request.url.host == 'iu.oneme.ru':
                self.assertNotIn('Authorization', request.headers)
                return httpx.Response(200, json={'token': 'uploaded-image'})
            return httpx.Response(200, json={'message': {'body': {'mid': 'max-photo'}}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            self.app.http = client
            await self.app.deliver(d)
        payload = json.loads(requests[-1].content)
        self.assertEqual([a['type'] for a in payload['attachments']], ['image', 'image'])
        self.assertEqual(payload['attachments'][0]['payload'], {'token': 'uploaded-image'})
        self.assertNotIn('Источник:', payload['text'])
        method, payload, files = await self.app.prepare_part('tg', '-1002', publication_parts('tg', 'Подпись', photos(2))[0])
        self.assertEqual(method, 'sendMediaGroup')
        self.assertEqual([p['caption'] for p in payload['media']], ['Подпись', ''])
        self.assertEqual(set(files), {'photo0', 'photo1'})
        self.assertEqual(payload['media'][0]['media'], 'attach://photo0')

    async def test_download_checks_file_bytes_and_does_not_follow_redirects(self):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, content=b'\xff\xd8\xffphoto'))) as client:
            self.app.http = client
            result = await App.photo_file(self.app, photos()['photos'][0])
            self.assertEqual(result, ('photo.jpg', b'\xff\xd8\xffphoto', 'image/jpeg'))
        for response in (httpx.Response(200, content=b'<html>error</html>'), httpx.Response(302, headers={'location': 'https://example.org'})):
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: response)) as client:
                self.app.http = client
                with self.assertRaises(ValueError):
                    await App.photo_file(self.app, photos()['photos'][0])

    async def test_max_not_ready_reuses_uploaded_image_on_retry(self):
        d = self.ingest()
        self.s.run("UPDATE destinations SET platform='max',remote='-3'")
        calls = []
        def handler(request):
            calls.append(request.url.path)
            if request.url.path == '/uploads':
                return httpx.Response(200, json={'url': 'https://iu.oneme.ru/upload.do?token=example'})
            if request.url.path == '/upload.do':
                return httpx.Response(200, json={'token': 'image'})
            if calls.count('/messages') == 1:
                return httpx.Response(400, json={'code': 'attachment.not.ready'})
            return httpx.Response(200, json={'message': {'body': {'mid': 'done'}}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            self.app.http = client
            await self.app.deliver(d)
            self.assertEqual(self.s.rows('SELECT status FROM deliveries')[0][0], 'pending')
            await self.app.deliver(d)
        self.assertEqual(calls.count('/uploads'), 1)
        self.assertEqual(calls.count('/upload.do'), 1)
        self.assertEqual(calls.count('/messages'), 2)
        self.assertEqual(self.s.rows('SELECT status FROM deliveries')[0][0], 'sent')

    async def test_mode_buttons_choose_each_route(self):
        second = self.s.add_destination('max', '-3', 'MAX')
        self.s.run('INSERT INTO routes VALUES(?,?)', (self.sid, second))
        self.assertIn('связку', (await self.app.command('Режим публикации')).lower())
        await self.app.command('Связка 1 → 2: Источник → MAX')
        self.assertIn('сохранён', await self.app.command('Как есть'))
        self.assertEqual(self.s.route_mode(1, 1), 'ai')
        self.assertEqual(self.s.route_mode(1, 2), 'original')

    async def test_recent_album_member_defers_whole_reader_album(self):
        old = datetime.fromtimestamp(1, timezone.utc)
        now = datetime.now(timezone.utc)
        messages = [SimpleNamespace(id=i, date=stamp, grouped_id=9, photo=True, media=SimpleNamespace(spoiler=False), message='Подпись' if i == 1 else '') for i, stamp in [(1, old), (2, now)]]
        async def iterate(*args, **kwargs):
            for message in messages:
                yield message
        self.app.reader = SimpleNamespace(get_entity=AsyncMock(return_value=SimpleNamespace(id=1, username='source')), iter_messages=iterate)
        await self.app.fetch(self.s.rows('SELECT * FROM sources')[0])
        self.assertFalse(self.s.rows('SELECT * FROM posts'))
        self.assertEqual(self.s.rows('SELECT cursor FROM sources')[0][0], 0)

    async def test_recent_public_post_cannot_be_skipped_by_later_id(self):
        posts = [(1, 'Первый', 'url', {'published_at': 1}), (2, 'Альбом', 'url', {'published_at': datetime.now(timezone.utc).timestamp()}), (3, 'Третий', 'url', {'published_at': 1})]
        reader = PublicTelegram(None)
        reader.page = AsyncMock(return_value=SimpleNamespace(peer_id=-1001, posts=posts, has_older=False))
        found, cursor = await reader.since('source', '-1001', 0)
        self.assertEqual([p[0] for p in found], [1])
        self.assertEqual(cursor, 1)


if __name__ == '__main__':
    unittest.main()
