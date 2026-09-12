"""SQLite locally, PostgreSQL in an isolated schema on Render."""
import re
import sqlite3

IDENTITIES = {'sources', 'destinations', 'posts', 'deliveries', 'ed_posts', 'ed_deletions'}
SCHEMA = 'repost_bot'


def pg_sql(sql):
    # The application's SQL uses qmark placeholders. Never rewrite quoted data.
    pieces = re.split(r"('(?:''|[^'])*')", sql)
    for i in range(0, len(pieces), 2):
        pieces[i] = pieces[i].replace('?', '%s').replace('REAL', 'DOUBLE PRECISION')
        pieces[i] = re.sub(r'\bINTEGER PRIMARY KEY\b', 'BIGSERIAL PRIMARY KEY', pieces[i])
        pieces[i] = re.sub(r'\bINTEGER\b', 'BIGINT', pieces[i])
        pieces[i] = pieces[i].replace('MAX(cursor,', 'GREATEST(cursor,')
    sql = ''.join(pieces)
    if re.match(r'\s*INSERT OR IGNORE ', sql, re.I):
        sql = re.sub('INSERT OR IGNORE', 'INSERT', sql, count=1, flags=re.I)
        sql += ' ON CONFLICT DO NOTHING'
    if re.match(r'\s*INSERT OR REPLACE INTO settings ', sql, re.I):
        sql = re.sub('INSERT OR REPLACE', 'INSERT', sql, count=1, flags=re.I)
        sql += ' ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    return sql


class Record(dict):
    def __getitem__(self, key):
        return tuple(self.values())[key] if isinstance(key, int) else super().__getitem__(key)


class Result:
    def __init__(self, cursor, generated=False):
        self.rowcount = cursor.rowcount
        self.lastrowid = None
        self.cursor = cursor
        if generated:
            row = cursor.fetchone()
            self.lastrowid = row[0] if row else None

    def fetchall(self):
        names = [column.name for column in self.cursor.description]
        return [Record(zip(names, row)) for row in self.cursor.fetchall()]

    def fetchone(self):
        row = self.cursor.fetchone()
        return Record(zip([c.name for c in self.cursor.description], row)) if row else None

    def __iter__(self):
        return iter(self.fetchall())


class Postgres:
    def __init__(self, url):
        import psycopg
        # Fixed namespace: existing MAX tables in public are never read or changed.
        self.conn = psycopg.connect(url, autocommit=True, connect_timeout=15)
        self.conn.execute('CREATE SCHEMA IF NOT EXISTS repost_bot')
        self.conn.execute('SET search_path TO repost_bot')
        self.conn.execute("SET statement_timeout = '15s'")
        self.transactions = []

    def execute(self, sql, args=()):
        sql = pg_sql(sql)
        match = re.match(r'\s*INSERT INTO (\w+)\b', sql, re.I)
        generated = bool(match and match[1] in IDENTITIES and not re.search(r'\bRETURNING\b', sql, re.I))
        if generated:
            sql += ' RETURNING id'
        return Result(self.conn.execute(sql, args), generated)

    def executescript(self, script):
        with self:
            # Schema DDL below has no procedural functions or semicolons in literals.
            for sql in script.split(';'):
                if sql.strip():
                    self.execute(sql)

    def __enter__(self):
        transaction = self.conn.transaction()
        self.transactions.append(transaction)
        transaction.__enter__()
        return self

    def __exit__(self, *args):
        return self.transactions.pop().__exit__(*args)

    def commit(self):
        if not self.transactions:
            self.conn.commit()

    def close(self):
        self.conn.close()

    def columns(self, table):
        return {row[0] for row in self.execute('SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=?', (SCHEMA, table))}

    def claim_worker(self):
        # Session lock is released by PostgreSQL if this connection dies.
        return self.conn.execute('SELECT pg_try_advisory_lock(178916,8101)').fetchone()[0]


class SQLite:
    def __init__(self, path):
        self.conn = sqlite3.connect(path, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute('PRAGMA foreign_keys=ON')
        self.conn.execute('PRAGMA journal_mode=WAL')
        self.depth = 0

    def execute(self, sql, args=()):
        return self.conn.execute(sql, args)

    def executescript(self, script):
        with self:
            for statement in script.split(';'):
                if statement.strip():
                    self.conn.execute(statement)

    def __enter__(self):
        self.conn.execute('BEGIN' if not self.depth else 'SAVEPOINT nested'+str(self.depth))
        self.depth += 1
        return self

    def __exit__(self, kind, value, traceback):
        self.depth -= 1
        if not self.depth:
            self.conn.execute('ROLLBACK' if kind else 'COMMIT')
        else:
            if kind:
                self.conn.execute('ROLLBACK TO SAVEPOINT nested'+str(self.depth))
            self.conn.execute('RELEASE SAVEPOINT nested'+str(self.depth))

    def commit(self):
        # Callers use explicit transaction scopes; an outer operation owns its commit.
        if not self.depth:
            self.conn.commit()

    def close(self):
        self.conn.close()


def connect(path):
    if str(path).startswith(('postgres://', 'postgresql://')):
        return Postgres(str(path))
    return SQLite(path)


def columns(db, table):
    if isinstance(db, Postgres):
        return db.columns(table)
    return {row[1] for row in db.execute('PRAGMA table_info(' + table + ')')}
