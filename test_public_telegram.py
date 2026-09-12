import base64
import json
import os
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from app import App
from core import Store
from public_telegram import parse_preview, PublicTelegram


def page(ids, channel=99, older=False, body=None, grouped=False):
    widgets = []
    for post_id in ids:
        meta = base64.urlsafe_b64encode(json.dumps({'c': -channel, 'p': f'{post_id}g' if grouped else post_id}).encode()).decode().rstrip('=')
        content = body if body is not None else f'Пост {post_id}'
        widgets.append(f'<div class="tgme_widget_message" data-post="news_channel/{post_id}" data-view="{meta}">'
                       f'<div class="tgme_widget_message_text">{content}</div></div>')
    navigation = '<a class="tme_messages_more" data-before="1"></a>' if older else ''
    return '<div class="tgme_channel_info_header_title">Новости</div>' + ''.join(widgets) + navigation


class PublicParsingTests(unittest.TestCase):
    def test_album_caption_is_one_post_and_must_match_group_id(self):
        html = page([12], body='Подпись к двум фотографиям', grouped=True)
        result = parse_preview(html, 'news_channel')
        self.assertEqual([post[:3] for post in result.posts], [(12, 'Подпись к двум фотографиям', 'https://t.me/news_channel/12')])
        with self.assertRaises(ValueError):
            parse_preview(html.replace('news_channel/12', 'news_channel/13'), 'news_channel')

    def test_preserves_newlines_emoji_and_hidden_link_targets(self):
        html = page([1], body='Открыли <b>2 школы</b><br/><br/>См. <a href="https://example.org/report/7">отчёт</a> '
                    '<img alt="🎉"><script>bad()</script>')
        result = parse_preview(html, 'news_channel')
        self.assertEqual(result.peer_id, -1000000000099)
        self.assertEqual(result.posts[0][1], 'Открыли 2 школы\n\nСм. отчёт (https://example.org/report/7) 🎉')

    def test_profile_or_login_page_is_not_an_empty_success(self):
        with self.assertRaises(ValueError):
            parse_preview('<div>Send message</div>', 'news_channel')

    def test_missing_identity_and_mixed_channels_fail_closed(self):
        for html in (page([1]).replace('data-view=', 'missing='),
                     page([1]) + page([2], channel=100),
                     page([1]).replace('news_channel/1', 'different_channel/1')):
            with self.subTest(html=html), self.assertRaises(ValueError):
                parse_preview(html, 'news_channel')


class PublicReadTests(unittest.IsolatedAsyncioTestCase):
    async def test_backfill_keeps_every_post_in_order(self):
        queries = []
        def handler(request):
            queries.append(request.url.params.get('before'))
            data = {None: page([4, 5], older=True), '4': page([2, 3], older=True), '2': page([1])}
            return httpx.Response(200, text=data[queries[-1]])
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with patch('public_telegram.asyncio.sleep', new_callable=AsyncMock):
                posts, cursor = await PublicTelegram(client).since('news_channel', '-1000000000099', 1)
        self.assertEqual([p[0] for p in posts], [2, 3, 4, 5])
        self.assertEqual(cursor, 5)
        self.assertEqual(queries, [None, '4', '2'])

    async def test_reassigned_username_stops_reading(self):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, text=page([2], channel=100)))) as client:
            with self.assertRaisesRegex(ValueError, 'другому каналу'):
                await PublicTelegram(client).since('news_channel', '-1000000000099', 1)

    async def test_redirect_to_nonpreview_is_not_followed(self):
        requests = []
        def handler(request):
            requests.append(request)
            return httpx.Response(302, headers={'location': 'https://example.org/login'})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=True) as client:
            with self.assertRaises(ValueError):
                await PublicTelegram(client).page('news_channel')
        self.assertEqual(len(requests), 1)

    async def test_backfill_limit_and_nonadvancing_pages_are_errors(self):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, text=page([4, 5], older=True)))) as client:
            reader = PublicTelegram(client)
            with patch('public_telegram.asyncio.sleep', new_callable=AsyncMock):
                with self.assertRaisesRegex(ValueError, 'один проход'):
                    await reader.since('news_channel', '-1000000000099', 1, max_pages=1)
                with self.assertRaisesRegex(ValueError, 'предыдущие посты'):
                    await reader.since('news_channel', '-1000000000099', 1)


class PublicSetupTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.env = patch.dict(os.environ, {'OWNER_ID': '123', 'FREE_TEST_MODE': '1'})
        self.env.start()
        self.store = Store(':memory:')
        self.http = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, text=page([1, 2]))))
        self.app = App(self.store, self.http)

    async def asyncTearDown(self):
        await self.http.aclose()
        self.store.db.close()
        self.env.stop()

    async def test_no_account_needed_and_single_destination_is_linked(self):
        did = self.store.add_destination('tg', '-1000000000200', 'Мой канал')
        reply = await self.app.add_source('https://t.me/news_channel')
        source = self.store.rows('SELECT * FROM sources')[0]
        self.assertEqual(source['remote'], '-1000000000099')
        self.assertEqual(source['cursor'], 2)
        self.assertEqual(self.store.get('tg_public:' + source['remote']), 'news_channel')
        self.assertEqual(self.store.rows('SELECT * FROM routes')[0]['destination'], did)
        self.assertFalse(self.store.rows('SELECT * FROM posts'))
        self.assertIn('публикации пока выключены', reply)
        await self.app.add_source('https://t.me/news_channel')
        self.assertEqual(len(self.store.rows('SELECT * FROM sources')), 1)

    async def test_destination_cannot_be_added_as_public_source(self):
        self.store.add_destination('tg', '-1000000000099', 'Мой канал')
        with self.assertRaisesRegex(ValueError, 'цикл'):
            await self.app.add_source('https://t.me/news_channel')
        self.assertFalse(self.store.rows('SELECT * FROM sources'))

    async def test_failed_backfill_does_not_advance_store(self):
        await self.app.add_source('https://t.me/news_channel')
        self.app.public_tg.since = AsyncMock(side_effect=ValueError('ошибка'))
        with self.assertRaises(ValueError):
            await self.app.fetch(self.store.rows('SELECT * FROM sources')[0])
        self.assertEqual(self.store.rows('SELECT cursor FROM sources')[0]['cursor'], 2)
        self.assertFalse(self.store.rows('SELECT * FROM posts'))

    async def test_native_route_selection_with_multiple_destinations(self):
        self.store.add_destination('tg', '-1000000000200', 'Первый')
        did = self.store.add_destination('max', '-10', 'Второй')
        await self.app.add_source('https://t.me/news_channel')
        self.assertFalse(self.store.rows('SELECT * FROM routes'))
        self.assertIn('Выбери', await self.app.command('Связать'))
        self.assertEqual(self.store.get('wizard'), '/choose_destination')
        reply = await self.app.command(f'Канал {did}: Второй')
        self.assertIn('Связь создана', reply)
        self.assertEqual(self.store.get('wizard'), '')
        self.assertEqual(self.store.rows('SELECT destination FROM routes')[0][0], did)
