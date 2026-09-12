import os
import unittest
from unittest.mock import AsyncMock, patch
import json
import httpx

from app import App, HELP, APIError, safe_error, CHANNEL_REQUEST_ID
from core import Store, destination_input, DESTINATION_PROMPT, PRIVATE_INVITE_PROMPT


class DestinationInputTests(unittest.TestCase):
    def test_plain_link_and_username(self):
        for value in ('https://t.me/my_channel', 't.me/my_channel', '@my_channel', '-100123456'):
            self.assertEqual(destination_input(value), ('tg', value))

    def test_platform_aliases(self):
        for name in ('tg', 'TG', 'ТГ', 'telegram', 'телеграм'):
            self.assertEqual(destination_input(name + ' @my_channel'), ('tg', '@my_channel'))
        self.assertEqual(destination_input('Макс -123'), ('max', '-123'))

    def test_bad_input_has_short_prompt(self):
        for value in ('готово', 'tg', 'Москва новости', 'https://vk.com/public123'):
            with self.assertRaises(ValueError) as caught:
                destination_input(value)
            self.assertEqual(str(caught.exception), DESTINATION_PROMPT)

    def test_invite_links_explain_how_to_select_private_channel(self):
        for value in ('https://t.me/+test_invite', 'tg https://t.me/+test_invite',
                      't.me/joinchat/test_invite', 'https://telegram.me/+test_invite'):
            with self.subTest(value=value), self.assertRaises(ValueError) as caught:
                destination_input(value)
            self.assertEqual(str(caught.exception), PRIVATE_INVITE_PROMPT)


class SetupFlowTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.env = patch.dict(os.environ, {'OWNER_ID': '123'})
        self.env.start()
        self.store = Store(':memory:')
        self.app = App(self.store, None)
        self.app.bot_id = 321

    async def asyncTearDown(self):
        self.store.db.close()
        self.env.stop()

    def forwarded(self, owner=123):
        return {'from': {'id': owner}, 'chat': {'type': 'private'},
                'forward_origin': {'type': 'channel', 'chat': {'id': -100999}}}

    async def test_wizard_accepts_raw_link_and_clears_on_success(self):
        self.app.add_destination = AsyncMock(return_value='Канал подключён.')
        await self.app.command('Добавить назначение')
        reply = await self.app.command(' https://t.me/my_channel ')
        self.app.add_destination.assert_awaited_once_with('tg', 'https://t.me/my_channel')
        self.assertEqual(reply, 'Канал подключён.')
        self.assertEqual(self.store.get('wizard'), '')

    async def test_invalid_destination_keeps_step_without_full_help(self):
        await self.app.command('Добавить назначение')
        with self.assertRaises(ValueError) as caught:
            await self.app.command('готово')
        self.assertLess(len(str(caught.exception)), 250)
        self.assertNotEqual(str(caught.exception), HELP)
        self.assertEqual(self.store.get('wizard'), '/destination')

    async def test_forward_connects_channel_and_checks_permissions(self):
        self.app.tg = AsyncMock(side_effect=[{'id': -100999, 'type': 'channel', 'title': 'Мой канал'},
                                            {'status': 'administrator', 'can_post_messages': True}])
        await self.app.command('Добавить назначение')
        result = await self.app.handle_message(self.forwarded())
        self.assertIn('Канал «Мой канал» подключён', result)
        self.assertLess(len(result), 200)
        self.assertEqual(len(self.store.rows('SELECT * FROM destinations')), 1)
        self.assertEqual(self.store.get('wizard'), '')
        self.app.tg.assert_any_await('getChatMember', chat_id=-100999, user_id=321)

    async def test_forward_without_publish_rights_is_not_saved(self):
        self.app.tg = AsyncMock(side_effect=[{'id': -100999, 'type': 'channel', 'title': 'Мой канал'},
                                            {'status': 'administrator', 'can_post_messages': False}])
        await self.app.command('Добавить назначение')
        with self.assertRaises(ValueError):
            await self.app.handle_message(self.forwarded())
        self.assertFalse(self.store.rows('SELECT * FROM destinations'))
        self.assertEqual(self.store.get('wizard'), '/destination')

    async def test_foreign_user_cannot_add_channel(self):
        self.app.add_destination = AsyncMock()
        self.assertIsNone(await self.app.handle_message(self.forwarded(owner=999)))
        self.app.add_destination.assert_not_awaited()

    async def test_forwarded_source_is_not_misclassified_as_destination(self):
        await self.app.command('Добавить источник')
        self.app.add_destination = AsyncMock()
        await self.app.handle_message(self.forwarded())
        self.app.add_destination.assert_not_awaited()
        self.assertEqual(self.store.get('wizard'), '/source')

    async def test_start_is_short_and_help_is_explicit(self):
        self.assertLess(len(await self.app.command('/start')), 200)
        self.assertEqual(await self.app.command('Помощь'), HELP)
        self.assertNotEqual(await self.app.command('непонятный текст'), HELP)

    async def test_403_keeps_channel_for_retry_and_explains_access(self):
        self.app.tg = AsyncMock(side_effect=APIError('Telegram', 403, method='getChat',
                               description='Forbidden: bot is not a member of the channel chat'))
        await self.app.command('Добавить назначение')
        with self.assertRaises(APIError) as caught:
            await self.app.command('@my_channel')
        self.assertIn('Администраторы', safe_error(caught.exception))
        self.assertFalse(self.store.rows('SELECT * FROM destinations'))
        self.assertEqual(json.loads(self.store.get('pending_destination'))['ref'], '@my_channel')
        self.app.tg = AsyncMock(side_effect=[{'id': -100999, 'type': 'channel', 'title': 'Мой канал'},
                                            {'status': 'administrator', 'can_post_messages': True}])
        self.assertIn('подключён', await self.app.command('Проверить канал'))
        self.assertEqual(self.store.get('pending_destination'), '')
        self.assertEqual(len(self.store.rows('SELECT * FROM destinations')), 1)

    async def test_api_error_diagnostics_exclude_token_and_urls(self):
        secret = '123456789:private-token-for-test'
        def handler(request):
            return httpx.Response(403, json={'ok': False, 'error_code': 403,
                                  'description': 'Forbidden ' + secret + ' https://example.com/private'})
        with patch.dict(os.environ, {'TG_BOT_TOKEN': secret}):
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
                self.app.http = http
                with self.assertRaises(APIError):
                    await self.app.tg('getChat', chat_id='@my_channel')
        diagnostic = self.store.get('last_tg_error')
        self.assertNotIn(secret, diagnostic)
        self.assertNotIn('https://', diagnostic)
        self.assertEqual(json.loads(diagnostic)['method'], 'getChat')

    async def test_chat_not_found_does_not_claim_definite_membership_issue(self):
        error = APIError('Telegram', 400, method='getChat', description='Bad Request: chat not found')
        self.assertIn('не найден или недоступен', safe_error(error))

    def shared_channel(self, owner=123, request_id=CHANNEL_REQUEST_ID):
        return {'from': {'id': owner}, 'chat': {'type': 'private'},
                'chat_shared': {'request_id': request_id, 'chat_id': -100999}}

    async def test_picker_connects_private_channel_with_permission_check(self):
        self.app.tg = AsyncMock(side_effect=[{'id': -100999, 'type': 'channel', 'title': 'Закрытый канал'},
                                            {'status': 'administrator', 'can_post_messages': True}])
        await self.app.command('Добавить назначение')
        reply = await self.app.handle_message(self.shared_channel())
        self.assertIn('Канал «Закрытый канал» подключён', reply)
        self.app.tg.assert_any_await('getChat', chat_id=-100999)
        self.app.tg.assert_any_await('getChatMember', chat_id=-100999, user_id=321)
        self.assertEqual(len(self.store.rows('SELECT * FROM destinations')), 1)
        self.assertEqual(self.store.get('wizard'), '')

    async def test_picker_without_publish_rights_is_not_saved(self):
        self.app.tg = AsyncMock(side_effect=[{'id': -100999, 'type': 'channel'},
                                            {'status': 'member'}])
        await self.app.command('Добавить назначение')
        with self.assertRaises(ValueError):
            await self.app.handle_message(self.shared_channel())
        self.assertFalse(self.store.rows('SELECT * FROM destinations'))
        self.assertEqual(self.store.get('wizard'), '/destination')
        self.assertEqual(json.loads(self.store.get('pending_destination'))['ref'], '-100999')

    async def test_picker_ignores_foreign_users_and_stale_selections(self):
        self.app.add_destination = AsyncMock()
        await self.app.command('Добавить назначение')
        self.assertIsNone(await self.app.handle_message(self.shared_channel(owner=999)))
        await self.app.handle_message(self.shared_channel(request_id=99))
        await self.app.command('Отмена')
        await self.app.handle_message(self.shared_channel())
        await self.app.command('Добавить источник')
        await self.app.handle_message(self.shared_channel())
        self.app.add_destination.assert_not_awaited()
        self.assertEqual(self.store.get('wizard'), '/source')

    async def test_invite_does_not_call_telegram_or_keep_old_retry_target(self):
        self.app.tg = AsyncMock()
        await self.app.command('Добавить назначение')
        self.store.set('pending_destination', json.dumps({'platform': 'tg', 'ref': '@old_channel'}))
        with self.assertRaises(ValueError) as caught:
            await self.app.command('https://t.me/+test_invite')
        self.assertEqual(str(caught.exception), PRIVATE_INVITE_PROMPT)
        self.assertEqual(self.store.get('wizard'), '/destination')
        self.assertEqual(self.store.get('pending_destination'), '')
        self.app.tg.assert_not_awaited()

    async def test_destination_prompt_contains_native_picker_without_new_bot_rights(self):
        self.app.tg = AsyncMock(return_value={'message_id': 1})
        prompt = await self.app.command('Добавить назначение')
        with patch('app.asyncio.sleep', new_callable=AsyncMock):
            await self.app.tell(prompt)
        keyboard = self.app.tg.call_args.kwargs['reply_markup']['keyboard']
        picker = keyboard[0][0]
        self.assertEqual(picker['text'], 'Выбрать мой канал')
        self.assertTrue(picker['request_chat']['chat_is_channel'])
        self.assertTrue(picker['request_chat']['bot_is_member'])
        self.assertNotIn('chat_has_username', picker['request_chat'])
        self.assertNotIn('bot_administrator_rights', picker['request_chat'])
