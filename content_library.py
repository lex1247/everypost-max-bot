"""Reviewed content goes through the existing editor queue, never directly to a channel."""
import asyncio
import json
import os
import re
import time
import unicodedata
from datetime import datetime, timezone

import content_source
from database import Postgres

SEEDS = [('ailq309','7630155394786069782'),('assel_nogai','7517331297430162706'),
 ('preobrazhenskaya_style','6918097245090974978'),('senita_stylist','6945895321968839938'),
 ('potapova.style.hair','7477844578209565954'),('miaoloo','7221888273554181419'),
 ('maxprxgove7','7644846844866088200'),('albina_hair','7618120483661237525'),('emerson3089','7630757847998958861')]
PROVIDERS = {'tiktok': content_source}


def schema(s):
    s.db.executescript('''
    CREATE TABLE IF NOT EXISTS ed_content_sources(id INTEGER PRIMARY KEY,
      destination INTEGER NOT NULL REFERENCES destinations(id), actor INTEGER NOT NULL,
      provider TEXT NOT NULL DEFAULT 'tiktok', url TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      checked_at REAL, next_at REAL NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '', UNIQUE(destination,provider,url));
    CREATE TABLE IF NOT EXISTS ed_content_items(id INTEGER PRIMARY KEY,
      destination INTEGER NOT NULL REFERENCES destinations(id), provider TEXT NOT NULL,
      remote_id TEXT NOT NULL, metadata TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'new',
      scan_state TEXT NOT NULL DEFAULT 'pending', scan_hash TEXT NOT NULL DEFAULT '',
      fingerprint TEXT NOT NULL DEFAULT '{}', duplicate_of INTEGER, distinct_video INTEGER NOT NULL DEFAULT 0,
      scan_error TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '',
      selected_by INTEGER, due_at REAL, lease_until REAL NOT NULL DEFAULT 0,
      post_id INTEGER UNIQUE REFERENCES ed_posts(id), file_id TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1, UNIQUE(destination,provider,remote_id));
    ''')


def hair_relevance(title):
    t=unicodedata.normalize('NFKC',title).lower()
    if re.search(r'интерьер|квартир|мебел|ремонт|пространство для работы|дизайн|рецепт|готовим|кулинар|макияж|мейк|make[ _-]?up|cosmetic|lipstick|eyeliner|interior|apartment|furniture|recipe|cooking|ميكب|مكياج|روج|косметик|маникюр|nailart|outfit|fashion|типаж|романтизм',t): return 'excluded'
    return 'match' if re.search(r'прич[её]ск|косич|плетени|заплести|заплет|укладк|локон|пуч[ое]к|пучки|хвост[аи]?\b|причесать|hairstyl|hairtutorial|hairidea|hairdo|hairhack|braid|updo|ponytail|messybun|sleekbun|curlyhair|heatlesscurl|تسريح|ضفائر|编发|編髮|盘发|盤髮',t) else 'unknown'


def valid_fingerprint(f):
    return (isinstance(f,dict) and f.get('version')==1 and content_source.number(f.get('duration')) is not None
      and 3<=f['duration']<=300 and isinstance(f.get('frames'),list) and len(f['frames'])==8
      and all(isinstance(h,str) and re.fullmatch('[a-f0-9]{32}',h) for h in f['frames'])
      and isinstance(f.get('colors'),list) and len(f['colors'])==8
      and all(isinstance(c,list) and len(c)==3 and all(type(v) is int and 0<=v<=255 for v in c) for c in f['colors']))


def same_video(a,b):
    if not valid_fingerprint(a) or not valid_fingerprint(b) or abs(a['duration']-b['duration'])>max(.7,a['duration']*.025): return False
    if len(set(a['frames']))<4 or len(set(b['frames']))<4: return False
    bits=[(int(x,16)^int(y,16)).bit_count() for x,y in zip(a['frames'],b['frames'])]
    colors=[sum(abs(x-y) for x,y in zip(c,d))/3 for c,d in zip(a['colors'],b['colors'])]
    return max(bits)<=10 and sum(bits)<=40 and max(colors)<=24


def stamp(value):
    if not isinstance(value,str): raise ValueError('Выбери дату публикации.')
    try:
        dt=datetime.fromisoformat(value.replace('Z','+00:00'))
        if not dt.tzinfo: raise ValueError()
        result=dt.timestamp()
    except (ValueError,OverflowError): raise ValueError('Проверь дату публикации.')
    if not time.time()+300<=result<=time.time()+365*86400: raise ValueError('Выбери время от 5 минут до года вперёд.')
    return result


def iso(value): return datetime.fromtimestamp(value,timezone.utc).isoformat() if value else None


class ContentLibrary:
    def __init__(self,editor):
        self.e,self.s,self.p,self.app=editor,editor.s,editor.p,editor.app

    def lock(self,destination):
        self.s.rows('SELECT id FROM destinations WHERE id=?'+(' FOR UPDATE' if isinstance(self.s.db,Postgres) else ''),(destination,))

    def item(self,destination,id):
        rows=self.s.rows('SELECT * FROM ed_content_items WHERE destination=? AND id=?',(destination,id))
        if not rows: raise ValueError('Ролик не найден в этом канале.')
        return dict(rows[0])

    def hair_only(self,destination): return self.s.get('content_hair:'+str(destination),'1')=='1'

    def relevant(self,row): return not self.hair_only(row['destination']) or hair_relevance(json.loads(row['metadata']).get('title',''))=='match'

    def upsert(self,destination,metadata):
        provider=metadata.get('provider')
        if provider not in PROVIDERS: raise ValueError('Источник ещё не подключён.')
        remote=str(metadata.get('remote_id','')); url=PROVIDERS[provider].source_url(metadata.get('canonical_url'))
        if not re.fullmatch(r'\d{10,25}',remote) or not url.endswith('/video/'+remote): raise ValueError('ID ролика не совпадает со ссылкой.')
        metadata=dict(metadata,canonical_url=url,title=str(metadata.get('title',''))[:4000])
        self.s.run('''INSERT INTO ed_content_items(destination,provider,remote_id,metadata) VALUES(?,?,?,?)
          ON CONFLICT(destination,provider,remote_id) DO UPDATE SET metadata=excluded.metadata''',
          (destination,provider,remote,json.dumps(metadata,ensure_ascii=False)))
        return dict(self.s.rows('SELECT * FROM ed_content_items WHERE destination=? AND provider=? AND remote_id=?',(destination,provider,remote))[0])

    async def add_sources(self,actor,destination,urls):
        await self.e.access(actor,destination,owner=True)
        if not isinstance(urls,list) or not 1<=len(urls)<=50: raise ValueError('Пришли от 1 до 50 ссылок.')
        urls=list(dict.fromkeys(content_source.source_url(x) for x in urls))
        with self.s.db:
            self.lock(destination)
            count=self.s.rows('SELECT COUNT(*) FROM ed_content_sources WHERE destination=?',(destination,))[0][0]
            existing={r['url'] for r in self.s.rows('SELECT url FROM ed_content_sources WHERE destination=?',(destination,))}
            if count+len(set(urls)-existing)>100: raise ValueError('До 100 источников на канал.')
            for url in urls:
                self.s.db.execute('INSERT INTO ed_content_sources(destination,actor,url) VALUES(?,?,?) ON CONFLICT DO NOTHING',(destination,actor,url))
        return {'added':len(urls)}

    async def open(self,actor):
        base=os.getenv('PUBLIC_URL',os.getenv('RENDER_EXTERNAL_URL','')).rstrip('/')
        if not base.startswith('https://'): raise ValueError('Адрес панели ещё не настроен.')
        return await self.e.say(actor,'Контент · TikTok\nДобавь источники, просмотри ролики и выбери «В очередь». Видео появится в отложенных постах с оформлением канала. При подготовке бот пришлёт тебе видео для проверки.',
            [[{'text':'🎬 Открыть контент','web_app':{'url':base+'/content'}}]])

    async def link(self,actor,url):
        import secrets
        url=content_source.source_url(url);nonce=secrets.token_hex(8)
        self.p.session(actor,{'action':'content_link','url':url,'nonce':nonce})
        rows=[[{'text':c['title'][:40],'callback_data':f"ed:contentadd:{c['id']}:{nonce}"}] for c in self.e.available(actor) if c['platform']=='tg' and self.e.is_owner(actor,c['id'])]
        if not rows: raise ValueError('Сначала подключи свой Telegram-канал.')
        await self.e.say(actor,'В подборку какого канала добавить TikTok-ссылку?',rows)

    async def accept_link(self,actor,destination,nonce):
        session=self.p.session(actor)
        if session.get('action')!='content_link' or session.get('nonce')!=nonce:raise ValueError('Выбор устарел. Пришли ссылку заново.')
        await self.add_sources(actor,destination,[session['url']])
        self.p.session(actor,{})
        await self.e.say(actor,'Ссылка добавлена. Ролик появится после проверки темы и повторов. Выбери его в подборке, чтобы добавить в очередь.')
        return await self.open(actor)

    async def api(self,actor,action,body):
        if action=='channels':
            result=[]
            for c in self.e.available(actor):
                if c['platform']!='tg': continue
                try: await self.e.access(actor,c['id'])
                except ValueError: continue
                result.append({'id':c['id'],'title':c['title']})
            return {'channels':result}
        try: destination=int(body.get('channelId'))
        except (TypeError,ValueError): raise ValueError('Выбери канал.')
        channel=await self.e.access(actor,destination,owner=action in ('sources','seed','toggle','hair-policy','recover'))
        if channel['platform']!='tg': raise ValueError('Выбери Telegram-канал.')
        if action=='sources': return await self.add_sources(actor,destination,body.get('urls'))
        if action=='seed':
            urls=[u for a,r in SEEDS for u in ('https://www.tiktok.com/@'+a,'https://www.tiktok.com/@'+a+'/video/'+r)]
            return await self.add_sources(actor,destination,urls)
        if action=='toggle':
            if type(body.get('enabled')) is not bool: raise ValueError('Некорректное действие.')
            self.s.run('UPDATE ed_content_sources SET enabled=?,next_at=0 WHERE id=? AND destination=?',(int(body['enabled']),int(body['id']),destination));return {}
        if action=='hair-policy':
            if type(body.get('enabled')) is not bool: raise ValueError('Некорректный фильтр.')
            self.s.set('content_hair:'+str(destination),'1' if body['enabled'] else '0'); return {}
        if action=='recover':
            for candidate in self.s.rows("SELECT * FROM ed_content_items WHERE destination=? AND state='failed' AND post_id IS NOT NULL",(destination,)):
                self.s.run("UPDATE ed_posts SET error='Готовится замена видео' WHERE id=? AND state='held' AND revision=? AND error LIKE 'Замена видео не завершена%'",(candidate['post_id'],candidate['revision']))
            result=self.s.run("UPDATE ed_content_items SET scan_state=CASE WHEN scan_state='failed' THEN 'pending' ELSE scan_state END,scan_error='',state=CASE WHEN state='failed' AND selected_by IS NOT NULL THEN 'selected' ELSE state END,last_error='' WHERE destination=? AND post_id IS NULL AND (lease_until=0 OR lease_until<?)",(destination,time.time()))
            return {'recovered':result.rowcount}
        if action=='state': return self.state(actor,destination,channel,body)
        row=self.item(destination,int(body.get('id',0)))
        if row['post_id']:
            post=await self.e.post_access(actor,row['post_id'])
            if action=='move':
                if post['revision']!=body.get('revision'): raise ValueError('Пост изменился. Обнови подборку.')
                self.p.set_time(post,actor,'schedule',stamp(body.get('dueAt'))); return {}
            if action=='replace':
                self.e.require_create(actor,destination)
                if post['revision']!=body.get('revision') or post['state']!='scheduled': raise ValueError('Сначала обнови подборку или верни пост в расписание.')
                with self.s.db:
                    self.p.change(post,actor,state='held',error='Готовится замена видео')
                    self.s.db.execute("UPDATE ed_content_items SET state='selected',selected_by=?,file_id='',lease_until=0,revision=? WHERE id=?",(actor,post['revision']+1,row['id']))
                return {}
            if action=='decide' and body.get('decision')=='queue': return {'item':{'due_at':iso(post['publish_at'])}}
            raise ValueError('Этот ролик уже в постах. Управляй им через очередь.')
        if action!='decide': raise ValueError('Неизвестное действие.')
        decision=body.get('decision')
        if decision=='queue':
            await self.e.access(actor,destination,publish=True,create=True)
            with self.s.db:
                self.lock(destination); row=self.item(destination,row['id'])
                if row['state'] in ('selected','preparing','queued'): return {'item':{'due_at':iso(row['due_at'])}}
                if not self.relevant(row): raise ValueError('Ролик отсеян по теме канала.')
                if row['scan_state']!='ready': raise ValueError('Сначала дождись проверки повторов.')
                due=stamp(body['dueAt']) if body.get('dueAt') else max(time.time()+600,
                    (self.s.rows("SELECT MAX(due_at) FROM ed_content_items WHERE destination=? AND state IN ('selected','preparing','queued')",(destination,))[0][0] or 0)+5400,
                    (self.s.rows("SELECT MAX(publish_at) FROM ed_posts WHERE destination=? AND state='scheduled'",(destination,))[0][0] or 0)+5400)
                self.p.subscriptions.require_publication(destination,due)
                self.s.db.execute("UPDATE ed_content_items SET state='selected',selected_by=?,due_at=?,last_error='' WHERE id=?",(actor,due,row['id']))
            return {'item':{'due_at':iso(due)}}
        with self.s.db:
            self.lock(destination); row=self.item(destination,row['id'])
            if row['state'] in ('selected','preparing','queued'): raise ValueError('Ролик уже готовится. Обнови список.')
            if decision=='distinct':
                duplicate=row['duplicate_of']
                if duplicate and self.item(destination,duplicate)['scan_hash']==row['scan_hash']: raise ValueError('Это тот же самый файл видео.')
                self.s.db.execute("UPDATE ed_content_items SET distinct_video=1,scan_state='ready',duplicate_of=NULL,state='new',last_error='' WHERE id=?",(row['id'],))
            elif decision in ('skip','restore'):
                self.s.db.execute('UPDATE ed_content_items SET state=? WHERE id=?',('skipped' if decision=='skip' else 'new',row['id']))
            else: raise ValueError('Неизвестный выбор.')
        return {}

    def state(self,actor,destination,channel,body):
        page=max(0,min(10000,int(body.get('page',0)))); mode=body.get('filter','new')
        all_rows=self.s.rows('SELECT * FROM ed_content_items WHERE destination=? ORDER BY id DESC LIMIT 5000',(destination,))
        rows=[]
        for raw in all_rows:
            row=dict(raw); relevant=self.relevant(row)
            match=(mode=='excluded' and not relevant and not row['post_id']) or (mode=='duplicates' and row['scan_state']=='duplicate') or (mode=='checking' and relevant and row['state']=='new' and row['scan_state'] in ('pending','checking','failed')) or (mode=='new' and relevant and row['state']=='new' and row['scan_state']=='ready') or (mode=='selected' and row['state'] in ('selected','preparing')) or (mode in ('queued','failed','skipped') and row['state']==mode)
            if not match: continue
            item={**json.loads(row['metadata']),**row,'channel_id':destination,'due_at':iso(row['due_at']),'metadata_status':'verified'}
            item['metrics']=json.loads(row['metadata']).get('metrics',{})
            if row['post_id']:
                p=self.p.post(row['post_id'])
                if not self.e.is_owner(actor,destination) and p['creator']!=actor: continue
                item.update(queue_status={'sent':'published','held':'paused'}.get(p['state'],p['state']),queue_revision=p['revision'],queue_due_at=iso(p['publish_at']),last_error=p['error'] or row['last_error'])
                if row['state'] in ('selected','preparing','failed'): item['refresh_state']={'selected':'pending','preparing':'preparing','failed':'failed'}[row['state']]
            rows.append(item)
        sources=[{**dict(s),'enabled':bool(s['enabled']),'checked_at':iso(s['checked_at'])} for s in self.s.rows('SELECT * FROM ed_content_sources WHERE destination=? ORDER BY id',(destination,))]
        return {'title':channel['title'],'timezone':channel['timezone'],'owner':self.e.is_owner(actor,destination),'canCreate':self.e.can_create(actor,destination),'hairOnly':self.hair_only(destination),'items':rows[page*12:page*12+12],'hasMore':len(rows)>(page+1)*12,'sources':sources}

    def inspection(self,row,data):
        if not re.fullmatch('[a-f0-9]{64}',str(data.get('content_hash',''))) or not valid_fingerprint(data.get('fingerprint')): raise ValueError('Не удалось проверить кадры.')
        with self.s.db:
            self.lock(row['destination']);row=self.item(row['destination'],row['id'])
            duplicate=None
            for other in self.s.rows("SELECT * FROM ed_content_items WHERE destination=? AND id<>? AND scan_hash<>'' AND duplicate_of IS NULL ORDER BY id",(row['destination'],row['id'])):
                if other['scan_hash']==data['content_hash'] or (not row['distinct_video'] and not other['distinct_video'] and same_video(json.loads(other['fingerprint']),data['fingerprint'])):
                    duplicate=other['id'];break
            self.s.db.execute('UPDATE ed_content_items SET scan_hash=?,fingerprint=?,scan_state=?,duplicate_of=?,scan_error=?,metadata=? WHERE id=?',
                (data['content_hash'],json.dumps(data['fingerprint']),'duplicate' if duplicate else 'ready',duplicate,'',json.dumps(data['item'],ensure_ascii=False),row['id']))
        return duplicate

    async def prepare(self,row):
        actor=row['selected_by'];d=row['destination']
        await self.e.access(actor,d,publish=True,create=True)
        if not self.relevant(row): raise ValueError('Ролик отсеян по теме канала.')
        data,result=await PROVIDERS[row['provider']].inspect(json.loads(row['metadata'])['canonical_url'])
        if self.inspection(row,result): raise ValueError('Найден повтор ролика. Проверь вкладку «Повторы».')
        await self.e.access(actor,d,publish=True,create=True)
        if not self.relevant(self.item(d,row['id'])): raise ValueError('Ролик отсеян по теме канала.')
        file_id=row['file_id']
        if not file_id:
            # Explicit review selection authorizes a private preview, never a channel send.
            sent=await self.app.tg('sendVideo',chat_id=actor,video='attach://video',caption='Видео подготовлено для очереди. Подпись канала добавится при публикации.',supports_streaming=True,
                _files={'video':('video.mp4',data,'video/mp4')})
            file_id=sent.get('video',{}).get('file_id')
            if not file_id: raise ValueError('Telegram не подтвердил сохранение видео.')
            self.s.run('UPDATE ed_content_items SET file_id=? WHERE id=?',(file_id,row['id']))
        await self.e.access(actor,d,publish=True,create=True)
        with self.s.db:
            self.lock(d);fresh=self.item(d,row['id'])
            if fresh['state']!='preparing': return
            media={'gallery':[{'type':'video','tg_file_id':file_id}]}
            if fresh['post_id']:
                post=self.p.post(fresh['post_id'])
                if post['state']!='held' or post['error']!='Готовится замена видео' or post['revision']!=fresh['revision']: raise ValueError('Пост изменён во время подготовки. Проверь его.')
                post=self.p.change(post,actor,media=json.dumps(media),error='')
                due=post['publish_at']
            else:
                post=self.p.new(d,actor,'',media,origin='tiktok');due=fresh['due_at']
            if due and due>=time.time()+60:
                post=self.p.set_time(post,actor,'schedule',due)
            else:
                post=self.p.change(post,actor,state='held',error='Время прошло во время подготовки. Выбери новую дату.')
            self.s.db.execute("UPDATE ed_content_items SET state='queued',post_id=?,lease_until=0,last_error='' WHERE id=?",(post['id'],row['id']))

    async def tick(self):
        now=time.time()
        self.s.run("UPDATE ed_content_items SET state='failed',last_error='Подготовка прервалась. Проверь очередь и повтори подготовку.',lease_until=0 WHERE state='preparing' AND lease_until<?",(now,))
        self.s.run("UPDATE ed_content_items SET scan_state='pending',lease_until=0 WHERE scan_state='checking' AND lease_until<?",(now,))
        rows=self.s.rows("SELECT * FROM ed_content_items WHERE state='selected' ORDER BY id LIMIT 1")
        if rows:
            row=dict(rows[0])
            if self.s.run("UPDATE ed_content_items SET state='preparing',lease_until=? WHERE id=? AND state='selected'",(now+600,row['id'])).rowcount:
                try: await self.prepare(row)
                except Exception as exc:
                    from app import safe_error
                    self.s.run("UPDATE ed_content_items SET state='failed',lease_until=0,last_error=? WHERE id=?",(safe_error(exc)[:500],row['id']))
                    if row['post_id']:
                        self.s.run("UPDATE ed_posts SET error=? WHERE id=? AND revision=? AND state='held' AND error='Готовится замена видео'",('Замена видео не завершена: '+safe_error(exc)[:300],row['post_id'],row['revision']))
            return
        sources=self.s.rows('SELECT * FROM ed_content_sources WHERE enabled=1 AND next_at<=? ORDER BY next_at,id LIMIT 1',(now,))
        if sources:
            s=dict(sources[0]);self.s.run('UPDATE ed_content_sources SET next_at=? WHERE id=?',(now+7200,s['id']))
            try:
                await self.e.access(s['actor'],s['destination'],owner=True)
                result=await PROVIDERS[s['provider']].fetch(s['url'])
                await self.e.access(s['actor'],s['destination'],owner=True)
                for item in result['items']: self.upsert(s['destination'],item)
                self.s.run("UPDATE ed_content_sources SET checked_at=?,last_error='',failures=0 WHERE id=?",(now,s['id']))
            except Exception as exc:
                from app import safe_error
                self.s.run('UPDATE ed_content_sources SET checked_at=?,last_error=?,failures=failures+1,next_at=? WHERE id=?',(now,safe_error(exc)[:500],now+min(7200,300*2**min(s['failures'],6)),s['id']))
        candidates=self.s.rows("SELECT * FROM ed_content_items WHERE scan_state='pending' AND state='new' ORDER BY id")
        for raw in candidates:
            row=dict(raw)
            if not self.relevant(row): continue
            if not self.s.run("UPDATE ed_content_items SET scan_state='checking',lease_until=? WHERE id=? AND scan_state='pending'",(time.time()+600,row['id'])).rowcount: continue
            try:
                _,result=await PROVIDERS[row['provider']].inspect(json.loads(row['metadata'])['canonical_url'])
                self.inspection(row,result)
            except Exception as exc:
                from app import safe_error
                self.s.run("UPDATE ed_content_items SET scan_state='failed',scan_error=?,lease_until=0 WHERE id=?",(safe_error(exc)[:500],row['id']))
            break

    async def loop(self):
        while True:
            self.app.runtime_heartbeats['content']=time.monotonic()
            try: await self.tick()
            except Exception: print('Content worker: state preserved; retrying.',flush=True)
            await asyncio.sleep(10)
