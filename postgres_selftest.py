"""Build gate using a disposable local PostgreSQL, never DATABASE_URL."""
import os
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import quote
from core import Store
from posting import Posting
from migration import export_data,import_data


def main():
    from pgserver._commands import POSTGRES_BIN_PATH
    binary=POSTGRES_BIN_PATH
    with tempfile.TemporaryDirectory(prefix='ep-pg-') as root:
        root=Path(root);folder=root/'data';sockets=root/'socket';sockets.mkdir(mode=0o700)
        subprocess.run([str(binary/'initdb'),'-D',str(folder),'-U','postgres','-A','trust','--no-locale','-E','UTF8'],check=True,stdout=subprocess.DEVNULL)
        subprocess.run([str(binary/'pg_ctl'),'-D',str(folder),'-l',str(root/'postgres.log'),'-o',f"-c listen_addresses='' -k {sockets}",'-w','start'],check=True,stdout=subprocess.DEVNULL)
        uri='postgresql://postgres@/postgres?host='+quote(str(sockets))
        try:
            source=Store(root/'source.sqlite3');sid=source.add_source('tg','-1001','Источник',10)
            did=source.add_destination('tg','-1002','Канал');source.run('INSERT INTO routes VALUES(?,?)',(sid,did))
            source.set_route_mode(sid,did,'original');source.ingest(sid,[(11,'Первый пост','https://example.com')],11)
            source.run("UPDATE deliveries SET status='sent',remote='22'");source.db.close()
            s=Store(uri);p=Posting(s);import_data(s,export_data(root/'source.sqlite3'));p.sync_channels()
            assert s.rows('SELECT cursor FROM sources')[0][0]==11
            assert s.rows('SELECT remote FROM deliveries')[0][0]=='22'
            s.ingest(sid,[(12,'Новый пост','https://example.com')],12)
            post=p.new(did,123,'Свой пост',{});p.enqueue(post,123)
            assert len(s.rows('SELECT * FROM deliveries'))==3
            try:
                with s.db:
                    p.new(did,123,'Откат',{})
                    raise ValueError()
            except ValueError:pass
            assert len(s.rows('SELECT * FROM ed_posts'))==1
            assert s.db.claim_worker()
            other=Store(uri,recover=False);assert not other.db.claim_worker();other.db.close()
            # The test intentionally fails before deployment if migration or lock semantics are wrong.
            s.db.close()
            print('PostgreSQL check passed: migration, Unicode, sequences, routing, transactions and worker lock.',flush=True)
        finally:
            subprocess.run([str(binary/'pg_ctl'),'-D',str(folder),'-m','fast','-w','stop'],check=True,stdout=subprocess.DEVNULL)


if __name__=='__main__':main()
