"""Private Telegram screens for access terms and service-admin manual grants."""
import re
import time
import os
from datetime import datetime
from zoneinfo import ZoneInfo

from subscriptions import PLANS


def button(text, action):
    return {'text': text, 'callback_data': 'ed:sub:' + action}


def expiry_label(stamp):
    return datetime.fromtimestamp(stamp, ZoneInfo('Europe/Moscow')).strftime('%d.%m.%Y %H:%M') + ' (МСК)'


class SubscriptionControls:
    def __init__(self, editor):
        self.e = editor
        self.terms = editor.p.subscriptions

    async def plans(self, actor):
        await self.e.say(actor, 'Тарифы EveryPost на один канал\n\n' +
            '\n'.join(f'{label} — {price} ₽' for _, price, label in PLANS) +
            '\n\nРедакторы канала отдельно не оплачиваются. '
            'Приём оплаты пока не подключён. Срок доступа может назначить администратор сервиса. '
            'Автоматических списаний нет.', [[button('← Моя подписка', 'list:0')]])

    async def listing(self, actor, page=0):
        channels = [c for c in self.e.available(actor) if c['platform'] == 'tg']
        page = max(0, min(page, max(0, (len(channels) - 1) // 10)))
        rows = [[button(c['title'][:50], f'channel:{c["id"]}')] for c in channels[page*10:(page+1)*10]]
        pages = []
        if page: pages.append(button('← Назад', f'list:{page-1}'))
        if (page+1)*10 < len(channels): pages.append(button('Дальше →', f'list:{page+1}'))
        if pages: rows.append(pages)
        rows.append([button('Тарифы', 'plans')])
        rows.append([{'text': '← Меню', 'callback_data': 'ed:home'}])
        await self.e.say(actor, 'Моя подписка\n\nДоступ назначается каждому каналу отдельно.\n' +
            ('Выбери Telegram-канал.' if channels else 'Доступных Telegram-каналов пока нет. Подключи свой через /addchannel.'), rows)

    async def channel(self, actor, destination):
        channel = await self.e.access(actor, destination)
        if channel['platform'] != 'tg':
            raise ValueError('Подпиской MAX-канала управляй через MAX-бота.')
        row = self.terms.get(destination)
        info = 'Бесплатный доступ на этапе запуска. Срок не назначен.'
        if row:
            info = ('Срок действует' if row['expires_at'] > time.time() else 'Назначенный срок закончился') + '\nДо: ' + expiry_label(row['expires_at'])
            info += '\nРежим: ' + ('бесплатный запуск; окончание срока не блокирует публикации.' if row['mode'] == 'launch' else
                'публикации в пределах срока. После его окончания посты сохраняются, отправка приостанавливается.')
            info += '\nСрок назначен вручную; это не подтверждение оплаты.'
        held = self.e.s.rows("SELECT COUNT(*) FROM ed_posts WHERE destination=? AND state IN ('held','subscription_hold')", (destination,))[0][0]
        text = f'Подписка · {channel["title"]}\n\n{info}\n\nПосле продления проверь отложенные посты и черновики. Приостановленные посты не отправляются автоматически.'
        if actor == self.e.app.owner:
            text += f'\n\nID канала для назначения срока: {destination}\n/subscriptiongrant {destination} 1|3|6|12\n/subscriptionmode {destination} launch|term'
        rows = [[button('Тарифы и продление', 'plans')]]
        if held: rows.append([{'text': f'Посты для проверки: {held}', 'callback_data': f'ed:list:{destination}:draft:0'}])
        rows.append([button('← Моя подписка', 'list:0')])
        await self.e.say(actor, text, rows)

    async def callback(self, actor, parts):
        if parts == ['plans']: return await self.plans(actor)
        if len(parts) == 2 and parts[0] in ('list', 'channel') and re.fullmatch(r'\d{1,15}', parts[1]):
            if parts[0] == 'list': return await self.listing(actor, int(parts[1]))
            return await self.channel(actor, int(parts[1]))
        raise ValueError('Кнопка устарела. Открой /subscription заново.')

    async def command(self, actor, message):
        text = message.get('text', '').strip()
        match = re.match(r'^/(subscriptiongrant|subscriptionmode)(?:@([a-z0-9_]+))?(?:\s|$)', text, re.I)
        if not match: return False
        expected = (os.getenv('EXPECTED_TG_BOT_USERNAME') or 'EveryPost_bot').lstrip('@').lower()
        if match[2] and match[2].lower() != expected: return True
        if actor != self.e.app.owner:
            raise ValueError('Назначать срок и режим доступа может только администратор сервиса.')
        args = text[match.end():].split()
        kind = 'grant' if match[1].lower() == 'subscriptiongrant' else 'mode'
        usage = '/subscriptiongrant ID_канала 1|3|6|12' if kind == 'grant' else '/subscriptionmode ID_канала launch|term'
        if len(args) != 2 or not re.fullmatch(r'[1-9]\d{0,14}', args[0]):
            raise ValueError('Формат: ' + usage)
        value = args[1]
        if kind == 'grant':
            if value not in {'1','3','6','12'}: raise ValueError('Формат: ' + usage)
            value = int(value)
        message_id = message.get('message_id')
        if type(message_id) is not int or message_id <= 0:
            raise ValueError('Не удалось проверить команду. Отправь её новым сообщением.')
        receipt = self.terms.change(actor, self.e.app.owner, int(args[0]), kind, value, f'tg:{actor}:{message_id}')
        action = 'Срок назначен до ' + expiry_label(receipt['expires_at']) if kind == 'grant' else (
            'Включён бесплатный режим.' if receipt['mode'] == 'launch' else 'Включены публикации в пределах назначенного срока.')
        await self.e.say(actor, f'Канал #{args[0]}: {action}\nОплата не проводилась. Ранее приостановленные посты требуют проверки.',
                         [[button('Подписка канала', 'channel:' + args[0])]])
        return True
