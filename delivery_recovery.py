"""Owner controls for legacy source deliveries; checking never publishes a message."""
import hashlib
import json
import os
import re
import time
from media import normal_media, publication_parts
from public_telegram import SourceMissing
from trustat_source import Trustat, TrustatError, post_media

ATTENTION = ('failed', 'unknown', 'review', 'unavailable', 'subscription_hold', 'repairing')
STATUS_NAMES = {'failed': 'Ошибка', 'unknown': 'Нужно проверить канал', 'review': 'Готово к повтору',
                'unavailable': 'Оригинал недоступен', 'subscription_hold': 'Истёк срок доступа',
                'repairing': 'Проверяется', 'cancelled': 'Пропущено', 'pending': 'В очереди', 'sent': 'Отправлено'}


class DeliveryRecovery:
    def __init__(self, app):
        self.app, self.s = app, app.s

    def row(self, id):
        rows = self.s.rows('''SELECT d.*,p.source,p.original,p.media,p.url,p.remote source_post,
            s.remote source_peer,s.platform source_platform,t.platform,t.title,t.remote target
            FROM deliveries d JOIN posts p ON p.id=d.post JOIN destinations t ON t.id=d.destination
            LEFT JOIN sources s ON s.id=p.source WHERE d.id=?''', (id,))
        if not rows or rows[0]['source'] is None:
            raise ValueError('Это не отправка старого источника. Открой пост в обычном редакторе.')
        return dict(rows[0])

    def fingerprint(self, row):
        parts = [dict(p) for p in self.s.rows('SELECT * FROM delivery_parts WHERE delivery=? ORDER BY part', (row['id'],))]
        return hashlib.sha256(json.dumps([row, parts], sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:12]

    def check_parts(self, id):
        if self.s.rows("SELECT 1 FROM delivery_parts WHERE delivery=? AND (status IN ('sent','sending','unknown') OR remote!='')", (id,)):
            raise ValueError('Часть поста уже отправлена или результат неизвестен. Проверь канал; полная замена заблокирована во избежание дублей.')

    async def enrich(self, peer, post, *, fresh=False):
        if not normal_media(post[3])['unsupported'] or not os.getenv('TRUSTAT_API_KEY', '').strip():
            return post
        cid = -int(peer) - 10**12
        if not 0 < cid < 10**12:
            raise ValueError('Не удалось подтвердить исходный канал Telegram.')
        original = await Trustat(self.app).detail(cid, post[0], fresh=fresh)
        media = post_media(original)
        if media['unsupported']:
            raise ValueError('Trustat не предоставил полный исходный файл. Нужен оригинал или пересылка поста в бота.')
        return (post[0], original.get('text') or '', post[2], media)

    async def enrich_batch(self, peer, posts):
        out = []
        for post in posts:
            if normal_media(post[3])['unsupported']:
                try:
                    post = await self.enrich(peer, post)
                except (TrustatError, ValueError):
                    # Keep the complete blocked item. Never publish only its caption.
                    pass
            out.append(post)
        return out

    async def refresh(self, id):
        row = self.row(id)
        if row['status'] not in ('failed', 'review', 'unavailable', 'cancelled'):
            raise ValueError('Отправку сейчас нельзя заменить. Обнови список ошибок.')
        if row['mode'] != 'original':
            raise ValueError('Для восстановления без ИИ сначала выбери режим «Как есть».')
        self.check_parts(id)
        username = self.s.get('tg_public:' + row['source_peer'])
        if row['source_platform'] != 'tg' or not username:
            raise ValueError('Эта проверка доступна для публичного Telegram-источника.')
        changed = self.s.run("UPDATE deliveries SET status='repairing' WHERE id=? AND status=?", (id, row['status'])).rowcount
        if not changed:
            raise ValueError('Состояние уже изменилось. Открой отправку заново.')
        try:
            post = await self.app.public_tg.single(username, row['source_peer'], row['source_post'])
            post = await self.enrich(row['source_peer'], post, fresh=True)
            media = normal_media(post[3])
            plan = publication_parts(row['platform'], post[1], media)
            for item in media['photos'] + media.get('gallery', []):
                if item.get('type') == 'video':
                    await self.app.trustat_video_file(item)
                else:
                    await self.app.photo_file(item)
            with self.s.db:
                self.check_parts(id)
                # An unroute/cancellation during the network call wins over the repair.
                n = self.s.db.execute("UPDATE deliveries SET status='review',error='Оригинал и файлы проверены. Можно повторить отправку.',media_attempts=0 WHERE id=? AND status='repairing'", (id,)).rowcount
                if not n:
                    raise ValueError('Отправка изменилась во время проверки; замена отменена.')
                self.s.db.execute('DELETE FROM delivery_parts WHERE delivery=?', (id,))
                for index, part in enumerate(plan):
                    self.s.db.execute('INSERT INTO delivery_parts(delivery,part,payload) VALUES(?,?,?)',
                                      (id, index, json.dumps(part, ensure_ascii=False)))
                self.s.set('delivery_repair:' + str(id), json.dumps({'at': time.time(), 'text': post[1], 'url': post[2]}, ensure_ascii=False))
                self.app.editor.p.audit(self.app.owner, row['destination'], 'legacy_repair', row['post'])
        except Exception as exc:
            from app import safe_error
            status = 'unavailable' if isinstance(exc, SourceMissing) else 'failed'
            self.s.run('UPDATE deliveries SET status=?,error=? WHERE id=? AND status=?',
                       (status, safe_error(exc), id, 'repairing'))
        return self.row(id)

    async def retry(self, id):
        row = self.row(id)
        if row['status'] != 'review':
            raise ValueError('Сначала проверь оригинал. Повторная отправка ещё не разрешена.')
        self.check_parts(id)
        await self.app.editor.access(self.app.owner, row['destination'], publish=True)
        if not self.s.rows('SELECT 1 FROM routes WHERE source=? AND destination=?', (row['source'], row['destination'])):
            raise ValueError('Связка отключена. Сначала подключи источник к этому каналу.')
        self.app.editor.p.subscriptions.require_delivery(row)
        with self.s.db:
            n = self.s.db.execute("UPDATE deliveries SET status='pending',error='',next_try=0,media_attempts=0 WHERE id=? AND status='review'", (id,)).rowcount
            if n:
                self.app.editor.p.audit(self.app.owner, row['destination'], 'legacy_retry', row['post'])
        return bool(n)

    def skip(self, id):
        row = self.row(id)
        self.check_parts(id)
        if row['status'] not in ('failed', 'review', 'unavailable'):
            raise ValueError('Эту отправку сейчас нельзя пропустить.')
        with self.s.db:
            n = self.s.db.execute("UPDATE deliveries SET status='cancelled' WHERE id=? AND status=?", (id, row['status'])).rowcount
            if n:
                self.app.editor.p.audit(self.app.owner, row['destination'], 'legacy_skip', row['post'])

    async def say(self, text, buttons=None):
        return await self.app.tg('sendMessage', chat_id=self.app.owner, text=text[:3900],
                                 link_preview_options={'is_disabled': True},
                                 reply_markup={'inline_keyboard': buttons or []})

    async def menu(self):
        rows = self.s.rows("""SELECT d.id,d.status,t.title FROM deliveries d JOIN posts p ON p.id=d.post
            JOIN destinations t ON t.id=d.destination WHERE p.source IS NOT NULL
            AND d.status IN ('failed','unknown','review','unavailable','subscription_hold','repairing') ORDER BY d.id DESC LIMIT 40""")
        counts = {state: sum(r['status'] == state for r in rows) for state in ATTENTION}
        titles = {'failed': 'ошибка', 'unknown': 'проверь канал', 'review': 'готово к повтору',
                  'unavailable': 'нет оригинала', 'subscription_hold': 'срок доступа', 'repairing': 'проверяется'}
        buttons = [[{'text': f"#{r['id']} · {titles[r['status']]} · {r['title'][:22]}", 'callback_data': 'repair:open:' + str(r['id'])}] for r in rows]
        if rows:
            buttons.insert(0, [{'text': 'Проверить доступные оригиналы', 'callback_data': 'repair:all'}])
        editor_errors = self.s.rows("""SELECT e.id,t.title FROM ed_posts e JOIN destinations t ON t.id=e.destination
            JOIN deliveries d ON d.id=e.delivery WHERE d.status IN ('failed','unknown','subscription_hold')
            AND e.creator=? ORDER BY e.id DESC LIMIT 20""", (self.app.owner,))
        buttons += [[{'text': f"Пост #{r['id']} · {r['title'][:28]}", 'callback_data': 'ed:open:' + str(r['id'])}] for r in editor_errors]
        text = 'Отправки источников: ' + ', '.join(f'{titles[k]} — {v}' for k, v in counts.items() if v) if rows else 'Ошибок отправки источников нет.'
        await self.say(text + '\nПроверка скачивает файлы без публикации. Пропущенные отправки сохраняются в истории.', buttons)

    async def card(self, id):
        row = self.row(id);fingerprint = self.fingerprint(row)
        buttons = []
        if row['status'] in ('failed', 'review', 'unavailable', 'cancelled'):
            buttons.append([{'text': 'Проверить оригинал', 'callback_data': f'repair:check:{id}:{fingerprint}'}])
        if row['status'] == 'review':
            buttons.append([{'text': 'Повторить отправку', 'callback_data': f'repair:retry:{id}:{fingerprint}'}])
        if row['status'] in ('failed', 'review', 'unavailable'):
            buttons.append([{'text': 'Пропустить', 'callback_data': f'repair:skip:{id}:{fingerprint}'}])
        buttons.append([{'text': '← Все ошибки', 'callback_data': 'repair:list'}])
        saved = json.loads(self.s.get('delivery_repair:' + str(id), '{}'))
        preview = saved.get('text', row['original']) if row['status'] == 'review' else ''
        await self.say(f"Отправка #{id} → {row['title']}\n{STATUS_NAMES.get(row['status'], row['status'])}\n{row['error']}\n{row['url']}" +
                       ('\n\nПодпись при повторе:\n' + (preview[:1800] or '(без подписи)') if row['status'] == 'review' else ''), buttons)

    async def batch(self):
        ids = [r['id'] for r in self.s.rows("""SELECT d.id FROM deliveries d JOIN posts p ON p.id=d.post
            JOIN sources s ON s.id=p.source WHERE s.platform='tg' AND d.mode='original'
            AND d.status='failed' ORDER BY d.id DESC LIMIT 20""")]
        await self.say(f'Проверяю оригиналы: {len(ids)}. В канал пока ничего не отправляется.')
        for id in ids:
            try:
                await self.refresh(id)
            except ValueError:
                pass
        await self.menu()

    async def handle(self, update):
        query = update.get('callback_query')
        message = update.get('message', {})
        is_callback = bool(query and str(query.get('data', '')).startswith('repair:'))
        command = message.get('text', '').strip()
        is_command = command in ('/errors', '/repair_all') or bool(re.fullmatch(r'/repair \d+', command))
        if not is_callback and not is_command:
            return False
        actor = (query or message).get('from', {}).get('id')
        chat = (query.get('message', {}) if query else message).get('chat', {})
        if actor != self.app.owner or chat.get('type') != 'private' or chat.get('id') != self.app.owner:
            if query:
                await self.app.tg('answerCallbackQuery', callback_query_id=query['id'], text='Недоступно.')
            return True
        if query:
            await self.app.tg('answerCallbackQuery', callback_query_id=query['id'])
            parts = query['data'].split(':')[1:]
        else:
            parts = ['list'] if command == '/errors' else ['all'] if command == '/repair_all' else ['check', command.split()[1]]
        action = parts[0]
        if action == 'list':
            await self.menu()
        elif action == 'all':
            await self.batch()
        elif action == 'open':
            await self.card(int(parts[1]))
        elif action in ('check', 'retry', 'skip', 'confirm_skip'):
            id = int(parts[1]);row = self.row(id)
            if query and (len(parts) != 3 or parts[2] != self.fingerprint(row)):
                raise ValueError('Кнопка устарела. Открой отправку заново через /errors.')
            if action == 'check':
                await self.refresh(id)
            elif action == 'retry':
                await self.retry(id)
            elif action == 'skip':
                await self.say(f'Пропустить отправку #{id}? Материал сохранится, опубликованным он отмечен не будет.',
                               [[{'text': 'Да, пропустить', 'callback_data': f'repair:confirm_skip:{id}:{parts[2]}'}]])
                return True
            else:
                self.skip(id)
            await self.card(id)
        return True
