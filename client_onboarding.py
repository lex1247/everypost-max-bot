"""Private, owner-verified Telegram channel connection for each customer."""
import re
import secrets
import time


class ChannelConnection:
    def __init__(self, editor):
        self.e = editor

    async def start(self, actor):
        session = self.e.p.session(actor)
        if session and session.get('action') not in ('connect', 'proposal'):
            return await self.e.say(actor, 'Сначала заверши текущий ввод или отправь /cancel. Текущая правка не потеряна.')
        request_id = secrets.randbelow(2**31 - 1) + 1
        self.e.p.session(actor, {'action': 'connect', 'request_id': request_id, 'expires': time.time() + 1800})
        if actor == self.e.app.owner:
            self.e.s.set('wizard', '')
        return await self.e.app.tg('sendMessage', chat_id=actor, text=(
            'Подключение своего Telegram-канала\n\n'
            '1. Добавь этого бота администратором канала с правом публикации.\n'
            '2. Нажми «Выбрать мой канал». Подключать канал может его владелец.\n\n'
            'Также можно прислать @имя канала, ссылку https://t.me/имя или переслать сюда его пост. '
            'Для закрытого канала используй кнопку выбора.\n/cancel — отмена.'),
            reply_markup={'keyboard': [[{'text': 'Выбрать мой канал', 'request_chat': {
                'request_id': request_id, 'chat_is_channel': True, 'chat_is_created': True,
                'bot_is_member': True}}], [{'text': '/cancel'}]],
                'resize_keyboard': True, 'one_time_keyboard': True})

    def reference(self, message, session):
        shared = message.get('chat_shared')
        if shared:
            if shared.get('request_id') != session.get('request_id'):
                raise ValueError('Кнопка выбора устарела. Используй последнюю кнопку или начни заново: /addchannel.')
            return shared.get('chat_id')
        origin = message.get('forward_origin') or {}
        channel = origin.get('chat') if origin.get('type') == 'channel' else message.get('forward_from_chat')
        if channel and channel.get('type') == 'channel':
            return channel.get('id')
        text = message.get('text', '').strip()
        if re.fullmatch(r'-[1-9]\d{0,18}', text):
            return int(text)
        match = re.fullmatch(r'(?:@|https?://(?:www\.)?t\.me/)([a-zA-Z][a-zA-Z0-9_]{3,31})/?', text)
        if match:
            return '@' + match[1]
        raise ValueError('Нажми «Выбрать мой канал», пришли @имя канала или перешли его пост. Пригласительная ссылка не подойдёт.')

    async def accept(self, actor, message, session):
        if session.get('action') != 'connect' or session.get('expires', 0) < time.time():
            raise ValueError('Подключение устарело. Начни заново: /addchannel.')
        ref = self.reference(message, session)
        if not ref or not self.e.app.bot_id:
            raise ValueError('Не удалось проверить канал. Попробуй /addchannel ещё раз.')
        from app import APIError
        try:
            channel = await self.e.app.tg('getChat', chat_id=ref)
            if channel.get('type') != 'channel':
                raise ValueError('Нужен Telegram-канал. Группа или личный чат не подойдут.')
            remote = int(channel['id'])
            bot = await self.e.app.tg('getChatMember', chat_id=remote, user_id=self.e.app.bot_id)
            if bot.get('status') != 'administrator' or not bot.get('can_post_messages'):
                raise ValueError('Дай боту права администратора канала и включи «Публикация сообщений». Затем выбери канал снова.')
            member = await self.e.app.tg('getChatMember', chat_id=remote, user_id=actor)
            if member.get('status') != 'creator':
                raise ValueError('Подключить канал может его владелец. Если ты редактор, попроси владельца добавить тебя через настройки канала в боте.')
        except APIError as exc:
            if exc.code in (400, 403):
                raise ValueError('Бот не получил доступ к каналу. Проверь адрес, добавь бота администратором и выбери канал снова.') from None
            raise
        destination = self.e.p.connect_channel(actor, remote, channel.get('title') or str(remote), self.e.app.owner)
        self.e.p.session(actor, {})
        await self.e.app.tg('sendMessage', chat_id=actor,
            text='Канал подключён: ' + (channel.get('title') or str(remote)), reply_markup={'remove_keyboard': True})
        return await self.e.settings(actor, destination)
