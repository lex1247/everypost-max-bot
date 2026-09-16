"""Per-channel access terms. Manual grants are never payment confirmations."""
import calendar
import json
import time
from datetime import datetime
from zoneinfo import ZoneInfo

from database import Postgres

PLANS = ((1, 299, '1 месяц'), (3, 849, '3 месяца'), (6, 1599, '6 месяцев'), (12, 2999, '12 месяцев'))
TERM_ENDED = 'Срок доступа канала закончился. Пост сохранён. Открой /subscription для продления и затем проверь расписание.'


class SubscriptionExpired(ValueError):
    pass


def add_months(stamp, months):
    if type(months) is not int or months not in {p[0] for p in PLANS}:
        raise ValueError('Выбери срок: 1, 3, 6 или 12 месяцев.')
    date = datetime.fromtimestamp(stamp, ZoneInfo('Europe/Moscow'))
    year, month = divmod(date.year * 12 + date.month - 1 + months, 12)
    month += 1
    return date.replace(year=year, month=month, day=min(date.day, calendar.monthrange(year, month)[1])).timestamp()


class Subscriptions:
    def __init__(self, store):
        self.s = store
        store.db.executescript('''
        CREATE TABLE IF NOT EXISTS ed_subscriptions(
          destination INTEGER PRIMARY KEY REFERENCES destinations(id),
          mode TEXT NOT NULL DEFAULT 'launch' CHECK(mode IN ('launch','term')),
          months INTEGER NOT NULL CHECK(months IN (1,3,6,12)), expires_at REAL NOT NULL,
          assigned_by INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS ed_subscription_events(
          event TEXT PRIMARY KEY, destination INTEGER NOT NULL REFERENCES destinations(id),
          actor INTEGER NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,
          receipt TEXT NOT NULL, created_at REAL NOT NULL);
        ''')

    def get(self, destination):
        rows = self.s.rows('SELECT * FROM ed_subscriptions WHERE destination=?', (destination,))
        return dict(rows[0]) if rows else None

    def require_publication(self, destination, stamp=None):
        row = self.get(destination)
        now = time.time()
        if row and row['mode'] == 'term':
            if row['expires_at'] <= now:
                raise SubscriptionExpired(TERM_ENDED)
            if stamp is not None and stamp >= row['expires_at']:
                raise SubscriptionExpired('Дата публикации выходит за назначенный срок доступа. Выбери дату раньше окончания срока либо продли доступ в /subscription.')

    def _channel_lock(self, destination):
        suffix = ' FOR UPDATE' if isinstance(self.s.db, Postgres) else ''
        rows = self.s.rows('SELECT platform FROM destinations WHERE id=?' + suffix, (destination,))
        if not rows:
            raise ValueError('Канал не найден. Открой /subscription и выбери канал.')
        if rows[0]['platform'] != 'tg':
            raise ValueError('Подпиской MAX-канала управляй через MAX-бота.')

    def _receipt(self, event, actor, destination, kind, value):
        rows = self.s.rows('SELECT * FROM ed_subscription_events WHERE event=?', (event,))
        if not rows:
            return None
        old = rows[0]
        if (old['actor'], old['destination'], old['kind'], old['value']) != (actor, destination, kind, value):
            raise ValueError('Эта команда уже обработана с другими параметрами. Отправь новое сообщение.')
        return json.loads(old['receipt'])

    def change(self, actor, service_owner, destination, kind, value, event, *, now=None):
        if actor != service_owner:
            raise ValueError('Назначать срок и режим доступа может только администратор сервиса.')
        if not isinstance(event, str) or not event.startswith('tg:') or len(event) > 120:
            raise ValueError('Не удалось проверить команду. Отправь её новым сообщением.')
        if kind not in ('grant', 'mode'):
            raise ValueError('Неизвестное изменение подписки.')
        if kind == 'grant' and (type(value) is not int or value not in {p[0] for p in PLANS}):
            raise ValueError('Выбери срок: 1, 3, 6 или 12 месяцев.')
        if kind == 'mode' and value not in ('launch', 'term'):
            raise ValueError('Режим: launch — бесплатный запуск; term — публикации в пределах назначенного срока.')
        now = time.time() if now is None else now
        with self.s.db:
            self._channel_lock(destination)
            receipt = self._receipt(event, actor, destination, kind, str(value))
            if receipt is not None:
                return receipt
            old = self.get(destination)
            if old and old['mode'] == 'term' and old['expires_at'] <= now:
                # Renewal may arrive before a sleeping worker has observed expiry.
                # Preserve that backlog for review before making the term active again.
                self._hold_backlog(destination, now)
            if kind == 'grant':
                expires = add_months(max(now, old['expires_at'] if old else now), value)
                self.s.db.execute('''INSERT INTO ed_subscriptions(destination,months,expires_at,assigned_by,updated_at)
                    VALUES(?,?,?,?,?) ON CONFLICT(destination) DO UPDATE SET months=excluded.months,
                    expires_at=excluded.expires_at,assigned_by=excluded.assigned_by,
                    updated_at=excluded.updated_at,revision=ed_subscriptions.revision+1''',
                    (destination, value, expires, actor, now))
            else:
                if not old:
                    raise ValueError('Сначала назначь срок командой /subscriptiongrant. Текущий бесплатный доступ сохранён.')
                if value == 'term' and old['expires_at'] <= now:
                    raise ValueError('Сначала продли срок. Нельзя включить ограничение с уже истёкшим сроком.')
                self.s.db.execute('UPDATE ed_subscriptions SET mode=?,assigned_by=?,updated_at=?,revision=revision+1 WHERE destination=?',
                                  (value, actor, now, destination))
            receipt = self.get(destination)
            self.s.db.execute('INSERT INTO ed_subscription_events(event,destination,actor,kind,value,receipt,created_at) VALUES(?,?,?,?,?,?,?)',
                              (event, destination, actor, kind, str(value), json.dumps(receipt), now))
        return receipt

    def _hold_backlog(self, destination, now):
        self.s.db.execute("""UPDATE deliveries SET status='subscription_hold',error=?
            WHERE destination=? AND status='pending'
              AND NOT EXISTS(SELECT 1 FROM ed_posts e WHERE e.discussion_delivery=deliveries.id AND e.state IN ('sent','deleted'))""",
            (TERM_ENDED, destination))
        self.s.db.execute("""UPDATE ed_posts SET state='subscription_hold',error=?,revision=revision+1
            WHERE destination=? AND state IN ('queued','failed','unknown')
              AND delivery IN (SELECT id FROM deliveries WHERE status='subscription_hold')""", (TERM_ENDED, destination))
        self.s.db.execute("""UPDATE ed_posts SET state='held',error=?,revision=revision+1
            WHERE destination=? AND state='scheduled' AND publish_at<=?""", (TERM_ENDED, destination, now))

    def require_delivery(self, delivery):
        # Finish the configured copy of an already sent post, and keep deletion independent of billing.
        if self.s.rows("SELECT 1 FROM ed_posts WHERE discussion_delivery=? AND state IN ('sent','deleted')", (delivery['id'],)):
            return
        self.require_publication(delivery['destination'])

    def hold_delivery(self, delivery_id):
        with self.s.db:
            changed = self.s.db.execute("UPDATE deliveries SET status='subscription_hold',error=? WHERE id=? AND status='pending'",
                                        (TERM_ENDED, delivery_id))
            if changed.rowcount:
                self.s.db.execute("UPDATE ed_posts SET state='subscription_hold',error=?,revision=revision+1 WHERE delivery=? AND state='queued'",
                                  (TERM_ENDED, delivery_id))
        return bool(changed.rowcount)

    def resume(self, post, actor, *, draft=False):
        """Explicit user review after renewal; keep confirmed parts and original delivery IDs."""
        with self.s.db:
            if post['state'] != 'subscription_hold' or not post['delivery']:
                raise ValueError('Отправка уже изменена. Открой пост заново.')
            if not draft:
                self.require_publication(post['destination'])
                if post['delete_at'] and post['delete_at'] <= time.time() + 60:
                    raise ValueError('Срок автоудаления уже прошёл. Отключи или измени автоудаление перед продолжением.')
            parts = self.s.rows('SELECT status,remote FROM delivery_parts WHERE delivery=?', (post['delivery'],))
            if any(p['status'] not in ('pending', 'sent') for p in parts):
                raise ValueError('Есть неподтверждённая отправка. Сначала проверь результат в канале с поддержкой.')
            if draft and any(p['status'] == 'sent' or p['remote'] for p in parts):
                raise ValueError('Часть поста уже вышла. Можно продолжить только неотправленные части.')
            if not draft and (not parts or not any(p['status'] == 'pending' for p in parts)):
                raise ValueError('Нет неотправленных частей. Проверь результат в канале с поддержкой.')
            delivery = self.s.db.execute("UPDATE deliveries SET status=?,error='',next_try=0 WHERE id=? AND status='subscription_hold'",
                                         ('cancelled' if draft else 'pending', post['delivery']))
            changed = self.s.db.execute("UPDATE ed_posts SET state=?,creator=?,publish_at=NULL,error='',notified='',revision=revision+1 WHERE id=? AND revision=? AND state='subscription_hold'",
                                        ('draft' if draft else 'queued', actor, post['id'], post['revision']))
            if not delivery.rowcount or not changed.rowcount:
                raise ValueError('Пост уже изменён. Открой его заново.')
