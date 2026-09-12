"""One-time validated state transfer. Credentials are never included in an export."""
import json
import sqlite3
import time
from database import Postgres, IDENTITIES, columns

TABLES = ('settings','sources','destinations','routes','posts','deliveries','delivery_parts',
          'ed_channels','ed_users','ed_admins','ed_posts','ed_albums','ed_calendar','ed_deletions','ed_audit','tg_inbox')
RESERVED = {'activated','migration_done','posting_version'}


def export_data(path):
    connection=sqlite3.connect('file:'+str(path)+'?mode=ro',uri=True)
    connection.row_factory=sqlite3.Row
    try:
        connection.execute('BEGIN')
        present={r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        data={table:[dict(row) for row in connection.execute('SELECT * FROM '+table)] for table in TABLES if table in present}
        data['settings']=[r for r in data.get('settings',[]) if r['key'] not in RESERVED and not any(word in r['key'].lower() for word in ('token','secret','password','bind_'))]
        return {'version':1,'tables':data,'exported_at':time.time()}
    finally:
        connection.close()


def import_data(store, payload):
    if not isinstance(payload,dict) or payload.get('version')!=1 or not isinstance(payload.get('tables'),dict):
        raise ValueError('Invalid migration document')
    data=payload['tables']
    if not set(data)<=set(TABLES) or not {'settings','sources','destinations','routes','posts','deliveries','delivery_parts'}<=set(data):
        raise ValueError('Incomplete migration document')
    if store.get('migration_done') or any(store.rows('SELECT 1 FROM '+t+' LIMIT 1') for t in ('sources','destinations','posts','deliveries','ed_posts')):
        raise ValueError('Import requires an empty target database')
    counts={}
    with store.db:
        for table in TABLES:
            rows=data.get(table,[])
            if not isinstance(rows,list) or len(rows)>100000:
                raise ValueError('Invalid table data')
            permitted=columns(store.db,table)
            for row in rows:
                if not isinstance(row,dict) or not row or not set(row)<=permitted:
                    raise ValueError('Invalid column')
                if table=='settings' and row['key'] in RESERVED:
                    continue
                # No interpolated names can pass unless they are actual columns in the fixed tables above.
                names=list(row)
                sql='INSERT INTO '+table+'('+','.join(names)+') VALUES('+','.join('?' for _ in names)+')'
                if table=='settings': sql+=' ON CONFLICT(key) DO UPDATE SET value=excluded.value'
                store.db.execute(sql,tuple(row[n] for n in names))
            counts[table]=len(rows)
            if isinstance(store.db,Postgres) and table in IDENTITIES:
                store.db.execute("SELECT setval(pg_get_serial_sequence(?, 'id'), COALESCE((SELECT MAX(id) FROM "+table+"),1), EXISTS(SELECT 1 FROM "+table+"))",(table,))
        store.set('migration_done',json.dumps({'at':time.time(),'counts':counts}))
        # Never import an in-flight send as safe to retry.
        store.recover()
    return counts
