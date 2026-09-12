"""Posting state and validation. All user actions are revision checked."""
import hashlib
import hmac
import json
import secrets
import time
from datetime import datetime, timedelta
from urllib.parse import parse_qsl, urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from media import normal_media, utf16_len, publication_parts

EDITABLE = ('draft', 'proposed', 'held')
DEFAULT_STYLE = {'signature': '', 'buttons': [], 'proposal': False, 'discussion_url': ''}


def packed(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def valid_url(value):
    try:
        u = urlparse(value)
        if u.scheme not in ('https', 'http') or not u.hostname or u.username or u.password or len(value) > 2048:
            raise ValueError()
        _ = u.port
    except ValueError:
        raise ValueError('Нужна обычная ссылка http:// или https:// без логина и пароля.') from None
    return value


def parse_buttons(text):
    if text.strip() == '-':
        return []
    result = []
    for line in text.strip().splitlines():
        if '|' not in line:
            raise ValueError('Каждая кнопка с новой строки: Название | https://ссылка')
        label, url = [v.strip() for v in line.split('|', 1)]
        if not label or len(label) > 40:
            raise ValueError('Название кнопки: от 1 до 40 символов.')
        result.append({'text': label, 'url': valid_url(url)})
    if len(result) > 8:
        raise ValueError('Можно добавить до 8 кнопок.')
    return result


def validate_style(style):
    signature = style.get('signature', '').strip()
    if utf16_len(signature) > 700:
        raise ValueError('Подпись длиннее 700 символов.')
    buttons = parse_buttons('\n'.join(b['text']+' | '+b['url'] for b in style.get('buttons', [])) or '-')
    discussion = valid_url(style['discussion_url']) if style.get('discussion_url') else ''
    return {'signature': signature, 'buttons': buttons, 'proposal': bool(style.get('proposal')), 'discussion_url': discussion}


def styled(text, style, proposal_url):
    style = validate_style(style)
    signature = style['signature']
    if signature and text.rstrip() != signature and not text.rstrip().endswith('\n\n'+signature):
        text = (text.rstrip()+'\n\n'+signature).strip()
    buttons = list(style['buttons'])
    if style['proposal']:
        buttons.append({'text': 'Предложить новость', 'url': proposal_url})
    if style['discussion_url']:
        buttons.append({'text': 'Обсудить', 'url': style['discussion_url']})
    return text, buttons


def own_media(message):
    gallery = []
    if message.get('photo'):
        item = max(message['photo'], key=lambda p: p.get('width', 0)*p.get('height', 0))
        gallery.append({'type': 'photo', 'tg_file_id': item['file_id'], 'size': item.get('file_size', 0), 'spoiler': bool(message.get('has_media_spoiler'))})
    if message.get('video'):
        item = message['video']
        gallery.append({'type': 'video', 'tg_file_id': item['file_id'], 'size': item.get('file_size', 0), 'spoiler': bool(message.get('has_media_spoiler'))})
    if any(message.get(k) for k in ('animation', 'document', 'audio', 'voice', 'sticker', 'video_note', 'poll', 'contact', 'location', 'paid_media')):
        raise ValueError('Сейчас можно прислать текст, фото, видео или альбом фото и видео.')
    return {'gallery': gallery, 'photos': [], 'unsupported': []}


def message_text(message):
    text = message.get('text', message.get('caption', ''))
    # Keep hidden link targets without adding the forwarded source/byline.
    for entity in message.get('entities', message.get('caption_entities', [])):
        url = entity.get('url') if entity.get('type') == 'text_link' else None
        if url and url not in text:
            text += '\n'+valid_url(url)
    return text


def manual_plan(platform, text, media, buttons):
    media = normal_media(media)
    count = len(media.get('gallery', []))+len(media['photos'])
    if count > (10 if platform == 'tg' else 11 if buttons else 12):
        raise ValueError('В одном посте слишком много вложений. Telegram: до 10; MAX: до 12 (до 11 с кнопками).')
    limit = (1024 if count else 4096) if platform == 'tg' else 4000
    if utf16_len(text) > limit:
        raise ValueError(f'Текст вместе с подписью: {utf16_len(text)} символов из {limit}. Сократи текст или подпись; черновик сохранён.')
    if platform == 'max' and any(item.get('size', 0) > 20_000_000 for item in media.get('gallery', [])):
        raise ValueError('Для переноса из Telegram в MAX пришли файл не больше 20 МБ.')
    plan = publication_parts(platform, text, media)
    if buttons:
        if platform == 'tg' and plan[0]['kind'] in ('album', 'gallery') and count > 1:
            # Telegram cannot attach a keyboard to sendMediaGroup.
            # Send the caption with its buttons directly below the intact album.
            plan[0]['caption'] = ''
            plan.append({'kind': 'text', 'text': text or 'Открыть ссылки', 'buttons': buttons})
        else:
            plan[-1]['buttons'] = buttons
    return plan


def validated_user(init_data, token, now=None):
    now = time.time() if now is None else now
    if not isinstance(init_data, str) or len(init_data) > 16000:
        raise ValueError('Открой календарь кнопкой в Telegram.')
    pairs = parse_qsl(init_data, keep_blank_values=True, strict_parsing=True)
    values = dict(pairs)
    if len(values) != len(pairs):
        raise ValueError('Некорректная авторизация календаря.')
    signature = values.pop('hash', '')
    key = hmac.new(b'WebAppData', token.encode(), hashlib.sha256).digest()
    expected = hmac.new(key, '\n'.join(k+'='+v for k,v in sorted(values.items())).encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise ValueError('Открой календарь заново из Telegram.')
    try:
        age = now-int(values['auth_date'])
        user = json.loads(values['user'])['id']
        if not -30 <= age <= 3600 or type(user) is not int or user <= 0:
            raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise ValueError('Авторизация истекла. Открой календарь заново.') from None
    return user


def parse_time(text, zone):
    try:
        dt = datetime.strptime(text.strip(), '%d.%m.%Y %H:%M').replace(tzinfo=ZoneInfo(zone))
        # Reject nonexistent times during spring DST transitions.
        if datetime.fromtimestamp(dt.timestamp(), ZoneInfo(zone)).replace(tzinfo=None) != dt.replace(tzinfo=None):
            raise ValueError()
        return dt.timestamp()
    except (ValueError, ZoneInfoNotFoundError):
        raise ValueError('Пришли дату и время в формате 15.09.2026 18:30.') from None


class Posting:
    def __init__(self, store):
        self.s = store
        store.db.executescript('''
        CREATE TABLE IF NOT EXISTS ed_channels(
          destination INTEGER PRIMARY KEY REFERENCES destinations(id), code TEXT UNIQUE NOT NULL,
          style TEXT NOT NULL DEFAULT '{}', timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
          discussion TEXT NOT NULL DEFAULT '{}');
        CREATE TABLE IF NOT EXISTS ed_users(actor INTEGER PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ed_admins(destination INTEGER REFERENCES destinations(id), actor INTEGER,
          PRIMARY KEY(destination,actor));
        CREATE TABLE IF NOT EXISTS ed_posts(
          id INTEGER PRIMARY KEY, destination INTEGER REFERENCES destinations(id), creator INTEGER NOT NULL,
          author INTEGER NOT NULL, origin TEXT NOT NULL, text TEXT NOT NULL, media TEXT NOT NULL,
          style TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'draft', revision INTEGER NOT NULL DEFAULT 1,
          publish_at REAL, delete_at REAL, created_at REAL NOT NULL, sent_at REAL,
          delivery INTEGER UNIQUE REFERENCES deliveries(id), discussion_delivery INTEGER UNIQUE REFERENCES deliveries(id),
          error TEXT NOT NULL DEFAULT '', notified TEXT NOT NULL DEFAULT '',
          discussion_config TEXT NOT NULL DEFAULT '{}', discussion_done INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS ed_albums(actor INTEGER, album TEXT, message INTEGER, body TEXT NOT NULL,
          session TEXT NOT NULL, received REAL NOT NULL, PRIMARY KEY(actor,album,message));
        CREATE TABLE IF NOT EXISTS ed_calendar(nonce TEXT PRIMARY KEY, actor INTEGER NOT NULL,
          post INTEGER REFERENCES ed_posts(id), revision INTEGER NOT NULL, mode TEXT NOT NULL,
          expires REAL NOT NULL, receipt TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS ed_deletions(id INTEGER PRIMARY KEY, post INTEGER REFERENCES ed_posts(id),
          remote TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', tries INTEGER NOT NULL DEFAULT 0,
          next_try REAL NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', UNIQUE(post,remote));
        CREATE TABLE IF NOT EXISTS ed_audit(event TEXT PRIMARY KEY, actor INTEGER, destination INTEGER,
          action TEXT NOT NULL, post INTEGER, created_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS tg_inbox(id INTEGER PRIMARY KEY, body TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending', error TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL);
        ''')
        self.sync_channels()

    def sync_channels(self):
        for row in self.s.rows('SELECT id FROM destinations'):
            self.s.run('INSERT INTO ed_channels(destination,code,style) VALUES(?,?,?) ON CONFLICT(destination) DO NOTHING',
                       (row['id'], secrets.token_urlsafe(16), packed(DEFAULT_STYLE)))

    def channel(self, destination):
        self.sync_channels()
        rows = self.s.rows('SELECT d.*,c.code,c.style,c.timezone,c.discussion FROM destinations d JOIN ed_channels c ON c.destination=d.id WHERE d.id=?', (destination,))
        if not rows:
            raise ValueError('Канал больше не подключён.')
        return dict(rows[0])

    def post(self, id):
        rows = self.s.rows('SELECT * FROM ed_posts WHERE id=?', (id,))
        if not rows:
            raise ValueError('Пост не найден.')
        return dict(rows[0])

    def audit(self, actor, destination, action, post=None):
        self.s.run('INSERT INTO ed_audit VALUES(?,?,?,?,?,?)', (secrets.token_hex(16), actor, destination, action, post, time.time()))

    def session(self, actor, value=None):
        key = 'editor_session:'+str(actor)
        if value is not None:
            self.s.set(key, packed(value))
        return json.loads(self.s.get(key, '{}'))

    def new(self, destination, actor, text, media, origin='own', author=None):
        channel = self.channel(destination)
        media = normal_media(media)
        if not text.strip() and not media['photos'] and not media.get('gallery'):
            raise ValueError('Пришли текст, фотографию или видео.')
        if len(text) > 30000:
            raise ValueError('Текст слишком длинный: максимум 30 000 символов в черновике.')
        if origin == 'proposal' and self.s.rows("SELECT COUNT(*) FROM ed_posts WHERE author=? AND origin='proposal' AND created_at>?", (author or actor, time.time()-3600))[0][0] >= 20:
            raise ValueError('За час можно прислать до 20 предложений. Попробуй позже.')
        state = 'proposed' if origin == 'proposal' else 'draft'
        result = self.s.run('''INSERT INTO ed_posts(destination,creator,author,origin,text,media,style,state,created_at,discussion_config)
            VALUES(?,?,?,?,?,?,?,?,?,?)''', (destination, actor, author or actor, origin, text, packed(media), channel['style'], state, time.time(), channel['discussion']))
        self.audit(actor, destination, 'create', result.lastrowid)
        return self.post(result.lastrowid)

    def change(self, post, actor, **values):
        allowed = {'text', 'media', 'style', 'state', 'publish_at', 'delete_at', 'error', 'creator'}
        if not values or not values.keys() <= allowed:
            raise ValueError('Неверное изменение поста.')
        result = self.s.run('UPDATE ed_posts SET '+','.join(k+'=?' for k in values)+',revision=revision+1 WHERE id=? AND revision=? AND state=?',
                           (*values.values(), post['id'], post['revision'], post['state']))
        if not result.rowcount:
            raise ValueError('Пост уже изменён. Открой его заново.')
        self.audit(actor, post['destination'], 'change:'+','.join(values), post['id'])
        return self.post(post['id'])

    def validate(self, post):
        channel = self.channel(post['destination'])
        text, buttons = styled(post['text'], json.loads(post['style']), 'https://t.me/EveryPost_bot?start=propose_'+channel['code'])
        plan = manual_plan(channel['platform'], text, post['media'], buttons)
        return channel, text, plan

    def set_time(self, post, actor, mode, stamp, now=None):
        now = time.time() if now is None else now
        channel = self.channel(post['destination'])
        if stamp < now+60 or stamp > now+366*86400:
            raise ValueError('Выбери время от минуты до года вперёд.')
        if mode == 'schedule':
            if post['state'] not in (*EDITABLE, 'scheduled'):
                raise ValueError('Этот пост уже отправляется или опубликован.')
            self.validate(post)
            if post['delete_at'] and post['delete_at'] <= stamp+60:
                raise ValueError('Автоудаление должно быть позже публикации минимум на минуту.')
            return self.change(post, actor, state='scheduled', publish_at=stamp, creator=actor, error='')
        if mode != 'delete' or post['state'] not in (*EDITABLE, 'scheduled', 'sent'):
            raise ValueError('Сейчас нельзя менять автоудаление этого поста.')
        if self.s.rows("SELECT 1 FROM ed_deletions WHERE post=? AND state!='pending'", (post['id'],)):
            raise ValueError('Удаление уже началось. Проверь его результат в канале.')
        start = post['sent_at'] or post['publish_at'] or now
        if stamp <= start+60:
            raise ValueError('Автоудаление должно быть позже публикации минимум на минуту.')
        if channel['platform'] == 'tg' and stamp >= start+47*3600:
            raise ValueError('Telegram позволяет удалять посты только первые 48 часов. Выбери срок до 47 часов с запасом.')
        return self.change(post, actor, delete_at=stamp)

    def enqueue(self, post, actor):
        if post['state'] not in (*EDITABLE, 'scheduled'):
            raise ValueError('Этот пост уже поставлен в очередь или опубликован.')
        channel, text, plan = self.validate(post)
        if post['delete_at'] and post['delete_at'] < time.time()+60:
            raise ValueError('Время автоудаления уже прошло. Выбери новое или отключи его.')
        with self.s.db:
            # CAS before any external side effect; a repeated tap cannot queue twice.
            changed = self.s.db.execute("UPDATE ed_posts SET state='queued',creator=?,revision=revision+1,error='' WHERE id=? AND revision=? AND state=?",
                                        (actor, post['id'], post['revision'], post['state']))
            if not changed.rowcount:
                raise ValueError('Пост уже изменён. Открой его заново.')
            item = self.s.db.execute("INSERT INTO posts(source,original,url,rewritten,status,media) VALUES(NULL,?,'',?,'ready',?)", (text, text, post['media']))
            delivery = self.s.db.execute("INSERT INTO deliveries(post,destination,mode) VALUES(?,?,'original')", (item.lastrowid, post['destination']))
            for index, part in enumerate(plan):
                self.s.db.execute('INSERT INTO delivery_parts(delivery,part,payload) VALUES(?,?,?)', (delivery.lastrowid, index, packed(part)))
            self.s.db.execute('UPDATE ed_posts SET delivery=? WHERE id=?', (delivery.lastrowid, post['id']))
            self.audit(actor, post['destination'], 'enqueue', post['id'])
        return self.post(post['id'])
