"""Durable routing and delivery state, independent of network adapters."""
import re
import json
from database import connect, columns
from urllib.parse import urlparse
from media import normal_media


DESTINATION_PROMPT = ('Нажми «Выбрать мой канал» и выбери свой Telegram-канал в списке. '
                      'Можно также прислать @имя или переслать пост из канала. '
                      'Для MAX: max и числовой ID канала.')
PRIVATE_INVITE_PROMPT = ('Это ссылка-приглашение. Чтобы подключить канал, нажми «Выбрать мой канал» '
                         'или перешли сюда пост из него.')


def is_tg_invite(value):
    value = value.strip()
    try:
        url = urlparse(value if '://' in value else 'https://' + value)
        return (url.scheme == 'https' and url.hostname in ('t.me', 'telegram.me')
                and not url.port and not url.username and not url.password
                and url.path.startswith(('/+', '/joinchat/')))
    except ValueError:
        return False


def destination_input(text):
    parts = text.strip().split()
    aliases = {'tg': 'tg', 'тг': 'tg', 'telegram': 'tg', 'телеграм': 'tg',
               'max': 'max', 'макс': 'max', 'мах': 'max'}
    if len(parts) == 2 and parts[0].lower() in aliases:
        if aliases[parts[0].lower()] == 'tg' and is_tg_invite(parts[1]):
            raise ValueError(PRIVATE_INVITE_PROMPT)
        return aliases[parts[0].lower()], parts[1]
    if len(parts) == 1:
        value = parts[0]
        if is_tg_invite(value):
            raise ValueError(PRIVATE_INVITE_PROMPT)
        if value.startswith('@') or re.fullmatch(r'-\d+', value):
            return 'tg', value
        try:
            platform, _ = source_link(value)
            if platform == 'tg':
                return 'tg', value
        except ValueError:
            pass
    raise ValueError(DESTINATION_PROMPT)


def source_link(value):
    value = value.strip()
    if value.startswith('@'):
        value = 'https://t.me/' + value[1:]
    if '://' not in value:
        value = 'https://' + value
    u = urlparse(value)
    path = u.path.strip('/')
    if u.scheme != 'https' or u.port or u.username or u.password:
        raise ValueError('Нужна обычная HTTPS-ссылка на канал или паблик.')
    if u.hostname in ('t.me', 'telegram.me'):
        if path.startswith('s/'):
            path = path[2:]
        if re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{3,31}', path):
            return 'tg', path.lower()
    if u.hostname in ('vk.com', 'www.vk.com', 'm.vk.com', 'vk.ru', 'www.vk.ru'):
        if re.fullmatch(r'[A-Za-z0-9_.]+', path):
            return 'vk', path.lower()
    raise ValueError('Пришли ссылку на открытый канал ТГ или паблик ВК, не на отдельный пост.')


def protected_words(text):
    """Conservative lexical guard for visible names and age/gender terms."""
    result = set()
    for match in re.finditer(r'\b[А-ЯЁA-Z][а-яёa-zА-ЯЁA-Z-]+\b', text):
        prefix = text[:match.start()].rstrip()
        if prefix and prefix[-1] not in '.!?':
            result.add(match.group())
    result.update(re.findall(
        r'\b(?:мальчик\w*|девочк\w*|реб[её]н\w*|подрост\w*|'
        r'(?:не)?совершеннолетн\w*|пацан\w*|парень|парн(?:я|ю|ем|е|и|ей|ям|ями|ях)|'
        r'девушк\w*|мужчин\w*|женщин\w*)\b', text, flags=re.I))
    # An informal title can start in lowercase: "чат сплетни Адлер".
    # Keep the full title fragment instead of only its final capitalized word.
    result.update(re.findall(
        r'\b(?:чат(?:а|е|у|ом)?|канал(?:а|е|у|ом)?)\s+'
        r'((?:[а-яёa-z-]+\s+){0,4}[А-ЯЁA-Z][\w-]*(?:\s+[А-ЯЁA-Z][\w-]*)*)', text))
    result.update(re.findall(r'«([^»\n]{1,100})»', text))
    return sorted(result, key=str.casefold)


def check_rewrite(original, rewritten):
    if not rewritten.strip():
        raise ValueError('Нейросеть вернула пустой текст.')
    if len(rewritten.encode('utf-16-le')) // 2 > 3500:
        raise ValueError('Переписанный текст слишком длинный.')
    # Conservative check; changed numeric notation also requires attention.
    numbers = lambda s: set(re.findall(r'\d+(?:[.,:/-]\d+)*', s))
    if numbers(original) != numbers(rewritten):
        raise ValueError('После переписывания изменился набор чисел.')
    references = lambda s: {v.rstrip('.,;:!?') for v in
        re.findall(r'https?://[^\s<>()]+|(?<!\w)@[A-Za-z0-9_]+', s)}
    if references(original) != references(rewritten):
        raise ValueError('После переписывания изменились ссылки или имена пользователей.')
    missing = [word for word in protected_words(original)
               if not re.search(r'(?<!\w)' + re.escape(word) + r'(?!\w)', rewritten, flags=re.I)]
    if missing:
        raise ValueError('Нужно сохранить без замены: ' + ', '.join(missing)[:180])


class Store:
    def __init__(self, path, recover=True):
        self.db = connect(path)
        self.db.executescript('''
        CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sources(
          id INTEGER PRIMARY KEY, platform TEXT NOT NULL, remote TEXT NOT NULL,
          title TEXT NOT NULL, cursor INTEGER NOT NULL, error TEXT DEFAULT '',
          UNIQUE(platform,remote));
        CREATE TABLE IF NOT EXISTS destinations(
          id INTEGER PRIMARY KEY, platform TEXT NOT NULL, remote TEXT NOT NULL,
          title TEXT NOT NULL, UNIQUE(platform,remote));
        CREATE TABLE IF NOT EXISTS routes(
          source INTEGER REFERENCES sources(id), destination INTEGER REFERENCES destinations(id),
          PRIMARY KEY(source,destination));
        CREATE TABLE IF NOT EXISTS posts(
          id INTEGER PRIMARY KEY, source INTEGER REFERENCES sources(id), remote INTEGER,
          original TEXT NOT NULL, url TEXT NOT NULL, rewritten TEXT,
          status TEXT DEFAULT 'new', error TEXT DEFAULT '', UNIQUE(source,remote));
        CREATE TABLE IF NOT EXISTS deliveries(
          id INTEGER PRIMARY KEY, post INTEGER REFERENCES posts(id),
          destination INTEGER REFERENCES destinations(id), status TEXT DEFAULT 'pending',
          remote TEXT, error TEXT DEFAULT '', next_try REAL DEFAULT 0,
          UNIQUE(post,destination));
        CREATE TABLE IF NOT EXISTS delivery_parts(
          delivery INTEGER REFERENCES deliveries(id), part INTEGER, payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending', remote TEXT DEFAULT '',
          PRIMARY KEY(delivery,part));
        ''')
        for table, column, definition in (
                ('posts', 'media', "TEXT NOT NULL DEFAULT '{}'"),
                ('deliveries', 'mode', "TEXT NOT NULL DEFAULT 'ai'")):
            if column not in columns(self.db, table):
                self.db.execute(f'ALTER TABLE {table} ADD COLUMN {column} {definition}')
        self.db.commit()
        if recover:
            self.recover()

    def recover(self):
        # A crash during a send may happen after the platform accepted it.
        self.db.execute("UPDATE deliveries SET status='unknown',error='Перезапуск во время отправки' WHERE status='sending'")
        self.db.execute("UPDATE delivery_parts SET status='unknown' WHERE status='sending'")
        self.db.commit()

    def rows(self, sql, args=()):
        return self.db.execute(sql, args).fetchall()

    def run(self, sql, args=()):
        with self.db:
            return self.db.execute(sql, args)

    def get(self, key, default=''):
        row = self.rows('SELECT value FROM settings WHERE key=?', (key,))
        return row[0][0] if row else default

    def set(self, key, value):
        self.run('INSERT OR REPLACE INTO settings VALUES(?,?)', (key, str(value)))

    def add_source(self, platform, remote, title, cursor):
        self.run('INSERT OR IGNORE INTO sources(platform,remote,title,cursor) VALUES(?,?,?,?)',
                 (platform, str(remote), title, cursor))
        return self.rows('SELECT id FROM sources WHERE platform=? AND remote=?', (platform, str(remote)))[0][0]

    def add_destination(self, platform, remote, title):
        if platform == 'tg' and self.rows("SELECT 1 FROM sources WHERE platform='tg' AND remote=?", (str(remote),)):
            raise ValueError('Этот канал уже является источником: публикация создаст цикл.')
        self.run('INSERT OR IGNORE INTO destinations(platform,remote,title) VALUES(?,?,?)', (platform, str(remote), title))
        return self.rows('SELECT id FROM destinations WHERE platform=? AND remote=?', (platform, str(remote)))[0][0]

    def ingest(self, source, posts, cursor):
        with self.db:
            for post in posts:
                remote, original, url = post[:3]
                media = normal_media(post[3] if len(post) > 3 else {})
                if not original.strip() and not media['photos'] and not media['unsupported']:
                    continue
                result = self.db.execute('INSERT INTO posts(source,remote,original,url,media) VALUES(?,?,?,?,?) ON CONFLICT(source,remote) DO NOTHING',
                                         (source, remote, original, url, json.dumps(media, ensure_ascii=False)))
                if result.rowcount:
                    for route in self.rows('SELECT destination FROM routes WHERE source=?', (source,)):
                        self.db.execute('INSERT INTO deliveries(post,destination,mode) VALUES(?,?,?)',
                            (result.lastrowid, route['destination'], self.route_mode(source, route['destination'])))
            self.db.execute("UPDATE sources SET cursor=MAX(cursor,?),error='' WHERE id=?", (cursor, source))

    def route_mode(self, source, destination):
        return self.get(f'route_mode:{source}:{destination}', 'ai')

    def set_route_mode(self, source, destination, mode):
        if mode not in ('ai', 'original'):
            raise ValueError('Выбери «Как есть» или «Переписать с ИИ».')
        if not self.rows('SELECT 1 FROM routes WHERE source=? AND destination=?', (source, destination)):
            raise ValueError('Связка не найдена. Сначала нажми «Связать».')
        with self.db:
            self.db.execute('INSERT OR REPLACE INTO settings VALUES(?,?)',
                            (f'route_mode:{source}:{destination}', mode))
            eligible = self.rows("""SELECT d.id FROM deliveries d JOIN posts p ON p.id=d.post
                WHERE p.source=? AND d.destination=? AND d.status='pending'
                AND NOT EXISTS(SELECT 1 FROM delivery_parts x WHERE x.delivery=d.id AND x.status!='pending')""",
                (source, destination))
            for row in eligible:
                self.db.execute('DELETE FROM delivery_parts WHERE delivery=?', (row['id'],))
                self.db.execute('UPDATE deliveries SET mode=? WHERE id=?', (mode, row['id']))

    def configuration(self):
        out = ['Источники:']
        for r in self.rows('SELECT * FROM sources'):
            out.append(f"{r['id']}. {r['platform']} · {r['title']}" + (f" · ошибка: {r['error']}" if r['error'] else ''))
        out.append('\nКуда публикуем:')
        for r in self.rows('SELECT * FROM destinations'):
            out.append(f"{r['id']}. {r['platform']} · {r['title']} · {r['remote']}")
        out.append('\nСвязи (источник → назначение):')
        out.extend(f"{r['source']} → {r['destination']} · " +
                   ('Как есть' if self.route_mode(r['source'], r['destination']) == 'original' else 'Переписать с ИИ')
                   for r in self.rows('SELECT * FROM routes'))
        out.append('\nФотографии переносятся. Ссылка на источник не добавляется.')
        out.append('\nПубликация: ' + ('пауза' if self.get('paused') == '1' else 'включена'))
        out.extend(f"{r['status']}: {r['n']}" for r in self.rows('SELECT status,count(*) n FROM deliveries GROUP BY status'))
        return '\n'.join(out)
