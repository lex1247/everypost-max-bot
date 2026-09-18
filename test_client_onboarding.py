"""Customer flows against a disposable database and fake Telegram, with no live sends."""
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app import App, APIError
from core import Store
from editor import Editor
from migration import export_data, import_data
from posting import Posting
from test_posting import signed
from web_server import calendar_action


class CustomerFlowTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.env = patch.dict(os.environ, {'OWNER_ID': '123', 'TG_BOT_TOKEN': 'test',
            'MAX_BOT_TOKEN': 'test', 'FREE_TEST_MODE': '1', 'LLM_PROVIDER': 'openai'})
        self.env.start()
        self.s = Store(':memory:')
        self.app = App(self.s, None)
        self.app.bot_id = 999
        self.e = self.app.editor
        self.p = self.e.p
        self.channels = {-1001: (456, 'Причёски'), -1002: (789, 'Другой клиент')}
        self.roles = {}
        self.app.tg = AsyncMock(side_effect=self.telegram)
        self.app.notify = AsyncMock()
        self.e.say = AsyncMock()

    async def asyncTearDown(self):
        self.s.db.close()
        self.env.stop()

    async def telegram(self, method, **payload):
        if method == 'getChat':
            ref = payload['chat_id']
            remote = {'@hair_channel': -1001, '@other_channel': -1002}.get(ref, ref)
            if remote not in self.channels:
                raise APIError('Telegram', 400, method='getChat', description='chat not found')
            return {'id': remote, 'type': 'channel', 'title': self.channels[remote][1]}
        if method == 'getChatMember':
            remote, actor = payload['chat_id'], payload['user_id']
            if (remote, actor) in self.roles:
                return self.roles[remote, actor]
            if actor == 999:
                return {'status': 'administrator', 'can_post_messages': True}
            return {'status': 'creator' if self.channels[remote][0] == actor else 'member'}
        return {'message_id': 100}

    def message(self, actor, text='', **fields):
        return {'message': {'from': {'id': actor}, 'chat': {'id': actor, 'type': 'private'}, **({'text': text} if text else {}), **fields}}

    async def connect(self, actor=456, ref='@hair_channel'):
        await self.e.handle(self.message(actor, '/addchannel'))
        await self.e.handle(self.message(actor, ref))
        return self.e.available(actor)[0]['id']

    async def draft(self, actor, destination, video=False):
        await self.e.callback(actor, f'ed:channel:new:{destination}')
        if video:
            await self.e.handle(self.message(actor, caption='Коса за минуту', video={'file_id': 'video-1', 'file_size': 1234}))
        else:
            await self.e.handle(self.message(actor, 'Текст'))
        return self.p.post(self.s.rows('SELECT MAX(id) FROM ed_posts')[0][0])

    async def test_new_customer_menu_and_private_picker(self):
        await self.e.handle(self.message(456, '/start'))
        self.assertIn('ed:connect', str(self.e.say.call_args))
        await self.e.callback(456, 'ed:connect')
        markup = self.app.tg.call_args.kwargs['reply_markup']
        request = markup['keyboard'][0][0]['request_chat']
        self.assertTrue(request['chat_is_created'])
        self.assertTrue(request['bot_is_member'])
        await self.e.handle(self.message(456, chat_shared={'request_id': request['request_id'], 'chat_id': -1001}))
        d = self.e.available(456)[0]['id']
        self.assertEqual(self.p.channel_owner(d, 123), 456)
        self.assertIn(f'ed:channel:new:{d}', str(self.e.say.call_args))
        self.assertFalse(self.s.rows('SELECT * FROM routes'))
        self.assertFalse(self.s.rows('SELECT * FROM deliveries'))

    async def test_video_caption_reschedule_cancel_restart_and_send_once(self):
        d = await self.connect()
        await self.e.callback(456, f'ed:config:signature:{d}')
        await self.e.handle(self.message(456, 'Сохрани идею'))
        post = await self.draft(456, d, video=True)
        self.assertEqual(json.loads(post['style'])['signature'], 'Сохрани идею')
        for hours in (2, 3):
            await self.e.callback(456, f"ed:schedule:{post['id']}:{post['revision']}")
            date = datetime.now(ZoneInfo('Europe/Moscow')) + timedelta(hours=hours)
            await self.e.handle(self.message(456, date.strftime('%d.%m.%Y %H:%M')))
            post = self.p.post(post['id'])
            self.assertEqual(post['state'], 'scheduled')
            self.assertAlmostEqual(post['publish_at'], date.replace(second=0, microsecond=0).timestamp())
        await self.e.callback(456, f"ed:unschedule:{post['id']}:{post['revision']}")
        post = self.p.post(post['id'])
        self.assertEqual(post['state'], 'draft')
        self.assertIsNone(post['publish_at'])
        await self.e.callback(456, f"ed:publish:{post['id']}:{post['revision']}")
        with self.assertRaisesRegex(ValueError, 'устарела'):
            await self.e.callback(456, f"ed:publish:{post['id']}:{post['revision']}")
        self.app.editor = Editor(self.app)
        self.app.editor.say = AsyncMock()
        self.assertEqual(self.app.editor.available(456)[0]['id'], d)
        post = self.p.post(post['id'])
        self.app.tg.reset_mock()
        with patch('app.asyncio.sleep', new_callable=AsyncMock):
            await self.app.deliver({'id': post['delivery']})
            await self.app.deliver({'id': post['delivery']})
        sends = [c for c in self.app.tg.call_args_list if c.args[0] == 'sendVideo']
        self.assertEqual(len(sends), 1)
        self.assertEqual(sends[0].kwargs['chat_id'], '-1001')
        self.assertEqual(sends[0].kwargs['video'], 'video-1')
        self.assertEqual(sends[0].kwargs['caption'], 'Коса за минуту\n\nСохрани идею')
        await self.app.editor.tick()
        self.assertEqual(self.p.post(post['id'])['state'], 'sent')

    async def test_channels_styles_posts_and_stale_foreign_buttons_are_isolated(self):
        first = await self.connect()
        other = await self.connect(789, '@other_channel')
        await self.e.callback(456, f'ed:config:signature:{first}')
        await self.e.handle(self.message(456, 'Подпись первого'))
        post = await self.draft(456, first)
        self.assertEqual([d['id'] for d in self.e.available(789)], [other])
        self.assertEqual(json.loads(self.p.channel(other)['style'])['signature'], '')
        for command in (f'ed:open:{post["id"]}', f'ed:publish:{post["id"]}:1',
                        f'ed:list:{first}:draft:0', f'ed:config:signature:{first}',
                        f'ed:grant:{first}', f'ed:revoke:{first}:456'):
            with self.subTest(command=command), self.assertRaises(ValueError):
                await self.e.callback(789, command)
        self.assertEqual(self.p.post(post['id'])['state'], 'draft')
        self.assertFalse(self.s.rows('SELECT * FROM deliveries'))

    async def test_customer_calendar_rejects_other_customer(self):
        d = await self.connect()
        post = await self.draft(456, d)
        await self.e.calendar(456, post, 'schedule')
        nonce = self.s.rows('SELECT nonce FROM ed_calendar')[0][0]
        date = datetime.now(ZoneInfo('Europe/Moscow')) + timedelta(hours=2)
        body = {'initData': signed(789), 'nonce': nonce, 'mode': 'schedule',
            'day': date.strftime('%Y%m%d'), 'hour': date.hour, 'minute': date.minute}
        with self.assertRaises(ValueError):
            await calendar_action(self.e, 'save', body)
        self.assertEqual(self.p.post(post['id'])['state'], 'draft')
        result = await calendar_action(self.e, 'save', {**body, 'initData': signed(456)})
        self.assertTrue(result['ok'])
        self.assertEqual(self.p.post(post['id'])['state'], 'scheduled')

    async def test_reconnect_aliases_are_idempotent_and_cannot_steal_existing_owner(self):
        d = await self.connect()
        await self.e.callback(456, f'ed:config:signature:{d}')
        await self.e.handle(self.message(456, 'Подпись'))
        self.assertEqual(await self.connect(456, 'https://t.me/hair_channel'), d)
        self.assertEqual(len(self.s.rows('SELECT * FROM destinations')), 1)
        self.assertEqual(json.loads(self.p.channel(d)['style'])['signature'], 'Подпись')
        self.channels[-1001] = (789, 'Переданный канал')
        with self.assertRaisesRegex(ValueError, 'другому аккаунту'):
            await self.connect(789)
        self.assertEqual(self.p.channel_owner(d, 123), 456)

    async def test_legacy_destination_cannot_be_claimed(self):
        d = self.s.add_destination('tg', '-1001', 'Рабочий канал')
        with self.assertRaisesRegex(ValueError, 'другому аккаунту'):
            await self.connect()
        self.assertEqual(self.p.channel_owner(d, 123), 123)
        self.assertFalse(self.s.rows('SELECT * FROM ed_channel_owners'))

    async def test_admin_and_subscriber_cannot_claim_channel(self):
        for role in ({'status': 'member'}, {'status': 'administrator', 'can_post_messages': True}):
            self.roles[-1001, 789] = role
            with self.subTest(role=role), self.assertRaisesRegex(ValueError, 'его владелец'):
                await self.connect(789)
        self.assertFalse(self.s.rows('SELECT * FROM destinations'))

    async def test_bot_without_publication_rights_does_not_connect(self):
        for role in ({'status': 'member'}, {'status': 'administrator', 'can_post_messages': False}):
            self.roles[-1001, 999] = role
            with self.assertRaisesRegex(ValueError, 'Публикация сообщений'):
                await self.connect()
        self.assertFalse(self.s.rows('SELECT * FROM destinations'))

    async def test_bad_channel_and_invite_give_recoverable_errors(self):
        for ref, error in (('@unknown', 'не получил доступ'), ('https://t.me/+invite', 'Пригласительная')):
            with self.subTest(ref=ref), self.assertRaisesRegex(ValueError, error):
                await self.connect(ref=ref)
            self.assertEqual(self.p.session(456)['action'], 'connect')
        self.assertFalse(self.s.rows('SELECT * FROM destinations'))

    async def test_old_or_expired_picker_and_private_identity_are_rejected(self):
        await self.e.handle(self.message(456, '/addchannel'))
        session = self.p.session(456)
        for actor, request in ((789, session['request_id']), (456, session['request_id'] + 1)):
            with self.assertRaisesRegex(ValueError, 'устарел'):
                await self.e.handle(self.message(actor, chat_shared={'request_id': request, 'chat_id': -1001}))
        self.p.session(456, {**session, 'expires': time.time() - 1})
        with self.assertRaisesRegex(ValueError, 'устарело'):
            await self.e.handle(self.message(456, '@hair_channel'))
        wrong_chat = self.message(456, '/addchannel')
        wrong_chat['message']['chat']['id'] = 789
        self.assertFalse(await self.e.handle(wrong_chat))
        self.assertFalse(self.s.rows('SELECT * FROM destinations'))

    async def test_cancel_removes_picker_and_late_selection_cannot_connect(self):
        await self.e.handle(self.message(456, '/addchannel'))
        request = self.p.session(456)['request_id']
        await self.e.handle(self.message(456, '/cancel'))
        self.assertTrue(self.app.tg.call_args.kwargs['reply_markup']['remove_keyboard'])
        with self.assertRaisesRegex(ValueError, 'устарела'):
            await self.e.handle(self.message(456, chat_shared={'request_id': request, 'chat_id': -1001}))
        self.assertFalse(self.s.rows('SELECT * FROM destinations'))

    async def test_connect_does_not_discard_unfinished_post(self):
        d = await self.connect()
        await self.e.callback(456, f'ed:channel:new:{d}')
        session = self.p.session(456)
        await self.e.callback(456, 'ed:connect')
        self.assertEqual(self.p.session(456), session)
        await self.e.handle(self.message(456, '/addchannel'))
        self.assertEqual(self.p.session(456), session)

    async def test_forwarded_channel_and_source_cycle(self):
        await self.e.handle(self.message(456, '/addchannel'))
        await self.e.handle(self.message(456, 'Пересланный пост', forward_origin={
            'type': 'channel', 'chat': {'type': 'channel', 'id': -1001}}))
        self.assertEqual(len(self.e.available(456)), 1)
        self.s.add_source('tg', '-1002', 'Источник', 1)
        with self.assertRaisesRegex(ValueError, 'цикл'):
            await self.connect(789, '@other_channel')
        self.assertEqual(len(self.s.rows('SELECT * FROM destinations')), 1)

    async def test_customer_proposals_notify_customer_and_preserve_author_privacy(self):
        d = await self.connect()
        code = self.p.channel(d)['code']
        await self.e.handle(self.message(321, '/start propose_' + code))
        self.e.say.reset_mock()
        await self.e.handle(self.message(321, 'Коса с лентой'))
        self.assertEqual([c.args[0] for c in self.e.say.call_args_list], [321, 456])
        post = self.s.rows('SELECT * FROM ed_posts')[0]
        await self.e.callback(456, f'ed:publish:{post["id"]}:1')
        self.assertEqual(self.s.rows('SELECT original FROM posts')[0][0], 'Коса с лентой')
        self.assertFalse(self.e.available(321))

    async def test_customer_album_proposals_notify_customer(self):
        d = await self.connect()
        self.p.session(321, {'action': 'proposal', 'destination': d})
        for i in (1, 2):
            await self.e.handle(self.message(321, media_group_id='album', message_id=i,
                photo=[{'file_id': f'photo-{i}', 'width': 20, 'height': 20}]))
        self.s.run('UPDATE ed_albums SET received=?', (time.time() - 3,))
        self.e.say.reset_mock()
        await self.e.flush_albums()
        self.assertEqual([c.args[0] for c in self.e.say.call_args_list], [321, 456])

    async def test_owner_grants_editor_and_can_review_then_revoke_own_channel_only(self):
        d = await self.connect()
        await self.e.handle(self.message(321, '/id'))
        self.roles[-1001, 321] = {'status': 'administrator', 'can_post_messages': True}
        await self.e.callback(456, f'ed:grant:{d}')
        await self.e.handle(self.message(456, '321'))
        await self.e.channels.callback(456,['rights',str(d),'321','1','1'])
        post = await self.draft(321, d)
        await self.e.post_access(456, post['id'])
        self.p.set_time(post, 321, 'schedule', time.time() + 3600)
        with self.assertRaises(ValueError):
            await self.e.callback(321, f'ed:config:signature:{d}')
        with self.assertRaises(ValueError):
            await self.e.callback(456, f'ed:revoke:{d}:456')
        await self.e.callback(456, f'ed:revoke:{d}:321')
        self.assertFalse(self.e.available(321))
        self.assertEqual(self.p.post(post['id'])['state'], 'held')
        await self.e.post_access(456, post['id'])

    async def test_revocation_during_media_preparation_blocks_send(self):
        d = await self.connect()
        self.roles[-1001, 321] = {'status': 'administrator', 'can_post_messages': True}
        self.s.run('INSERT INTO ed_admins VALUES(?,?)', (d, 321))
        post = self.p.enqueue(self.p.new(d, 321, 'Текст', {}), 321)
        prepare = self.app.prepare_part
        async def revoke(*args):
            result = await prepare(*args)
            self.s.run('DELETE FROM ed_admins WHERE actor=321')
            return result
        self.app.prepare_part = revoke
        self.app.tg.reset_mock()
        await self.app.deliver({'id': post['delivery']})
        self.assertFalse(any(c.args[0].startswith('send') for c in self.app.tg.call_args_list))
        self.assertEqual(self.s.rows('SELECT status FROM deliveries')[0][0], 'failed')

    async def test_revocation_during_telegram_permission_check_blocks_access(self):
        d = await self.connect()
        self.s.run('INSERT INTO ed_admins VALUES(?,?)', (d, 321))
        async def revoke(method, **payload):
            self.s.run('DELETE FROM ed_admins WHERE actor=321')
            return {'status': 'administrator', 'can_post_messages': True}
        self.app.tg = AsyncMock(side_effect=revoke)
        with self.assertRaisesRegex(ValueError, 'отозван'):
            await self.e.access(321, d)

    async def test_owner_telegram_rights_revoked_before_scheduled_publication(self):
        d = await self.connect()
        post = await self.draft(456, d)
        self.p.change(post, 456, state='scheduled', publish_at=time.time()-1)
        self.roles[-1001, 456] = {'status': 'member'}
        await self.e.tick()
        self.assertEqual(self.p.post(post['id'])['state'], 'held')
        self.assertFalse(self.s.rows('SELECT * FROM deliveries'))

    async def test_previous_owner_cannot_change_settings_after_transfer(self):
        d = await self.connect()
        self.roles[-1001, 456] = {'status': 'administrator', 'can_post_messages': True}
        with self.assertRaisesRegex(ValueError, 'владельцем'):
            await self.e.callback(456, f'ed:config:signature:{d}')

    async def test_copy_to_group_requires_customer_group_rights(self):
        d = await self.connect()
        original = self.telegram
        async def group(method, **payload):
            if payload.get('chat_id') == -500:
                if method == 'getChat': return {'id': -500, 'type': 'supergroup'}
                return {'status': 'administrator' if payload['user_id'] == 999 else 'member'}
            return await original(method, **payload)
        self.app.tg = AsyncMock(side_effect=group)
        await self.e.callback(456, f'ed:config:discussion:{d}')
        with self.assertRaisesRegex(ValueError, 'ты администратор'):
            await self.e.handle(self.message(456, '-500'))
        self.assertEqual(json.loads(self.p.channel(d)['discussion']), {})

    async def test_legacy_source_does_not_automatically_route_to_customer(self):
        await self.connect()
        self.app.public_tg.page = AsyncMock(return_value=SimpleNamespace(peer_id=-2000, title='Источник', posts=[(10,)]))
        await self.app.add_source('https://t.me/source_channel')
        self.assertFalse(self.s.rows('SELECT * FROM routes'))
        legacy = self.s.add_destination('tg', '-2001', 'Канал владельца сервиса')
        await self.app.add_source('https://t.me/source_channel')
        self.assertEqual(self.s.rows('SELECT destination FROM routes')[0][0], legacy)


class OwnershipPersistenceTests(unittest.TestCase):
    def test_migration_and_disk_restart_preserve_ownership_and_settings(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'test.sqlite3'
            source = Store(path)
            p = Posting(source)
            d = p.connect_channel(456, -1001, 'Канал', 123)
            source.run('UPDATE ed_channels SET timezone=? WHERE destination=?', ('Asia/Yekaterinburg', d))
            p.new(d, 456, 'Черновик', {})
            source.db.close()
            restarted = Store(path)
            self.assertEqual(Posting(restarted).channel_owner(d, 123), 456)
            restarted.db.close()
            target = Store(':memory:')
            p = Posting(target)
            try:
                import_data(target, export_data(path))
                self.assertEqual(p.channel_owner(d, 123), 456)
                self.assertEqual(p.channel(d)['timezone'], 'Asia/Yekaterinburg')
                self.assertEqual(target.rows('SELECT creator FROM ed_posts')[0][0], 456)
            finally:
                target.db.close()

    def test_failed_connection_rolls_back_destination_and_owner(self):
        s = Store(':memory:')
        p = Posting(s)
        try:
            with patch.object(p, 'audit', side_effect=RuntimeError('disk error')):
                with self.assertRaises(RuntimeError):
                    p.connect_channel(456, -1001, 'Канал', 123)
            for table in ('destinations', 'ed_channel_owners', 'ed_channels'):
                self.assertFalse(s.rows('SELECT * FROM ' + table))
        finally:
            s.db.close()


if __name__ == '__main__':
    unittest.main()
