"""Personal folders and one reviewed material for multiple existing channel queues."""
import json
import secrets
import time
from posting import packed, own_media, message_text, EDITABLE, parse_time


def schema(s):
    s.db.executescript('''
    CREATE TABLE IF NOT EXISTS ed_folders(id INTEGER PRIMARY KEY,actor INTEGER NOT NULL,name TEXT NOT NULL,
      channels TEXT NOT NULL DEFAULT '[]',UNIQUE(actor,name));
    CREATE TABLE IF NOT EXISTS ed_batches(id INTEGER PRIMARY KEY,actor INTEGER NOT NULL,
      nonce TEXT NOT NULL UNIQUE,created_at REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS ed_batch_posts(batch INTEGER REFERENCES ed_batches(id),
      destination INTEGER REFERENCES destinations(id),post INTEGER UNIQUE REFERENCES ed_posts(id),PRIMARY KEY(batch,destination));
    ''')


def b(text,value): return {'text':text,'callback_data':'ed:multi:'+value}


class MultiControls:
    def __init__(self,e): self.e,self.s,self.p=e,e.s,e.p

    async def start(self,actor,kind='multi',name=''):
        self.p.session(actor,{'action':'multi_select','kind':kind,'name':name,'ids':[],'nonce':secrets.token_hex(8)})
        return await self.select(actor)

    async def select(self,actor):
        f=self.p.session(actor)
        if f.get('action')!='multi_select': raise ValueError('Выбор устарел. Начни заново.')
        rows=[[b(('✓ ' if c['id'] in f['ids'] else '')+c['title'][:35],f"toggle:{f['nonce']}:{c['id']}")] for c in self.e.available(actor)]
        rows += [[b('Папки','pickfolder')],[b('Готово',f"done:{f['nonce']}")],[{'text':'Отмена','callback_data':'ed:home'}]]
        await self.e.say(actor,'Выбери каналы (до 30). Для каждого сохранятся его подпись и кнопки.',rows)

    async def folders(self,actor,pick=False):
        rows=[[b(f['name'][:40],('usefolder:' if pick else 'folder:')+str(f['id']))] for f in self.s.rows('SELECT * FROM ed_folders WHERE actor=? ORDER BY name',(actor,))]
        rows += [[b('Создать папку','newfolder')],[{'text':'← Меню','callback_data':'ed:home'}]]
        await self.e.say(actor,'Папки каналов',rows)

    async def card(self,actor,id):
        rows=self.s.rows('SELECT * FROM ed_batches WHERE id=? AND actor=?',(id,actor))
        if not rows: raise ValueError('Рассылка недоступна.')
        posts=self.s.rows('SELECT post FROM ed_batch_posts WHERE batch=? ORDER BY destination',(id,))
        buttons=[];lines=[]
        for r in posts:
            p=await self.e.post_access(actor,r['post']);c=self.p.channel(p['destination'])
            lines.append(f"{c['title']} — {p['state']} · #{p['id']}")
            buttons.append([{'text':c['title'][:35]+' · Предпросмотр / правка','callback_data':f"ed:preview:{p['id']}:{p['revision']}"}])
        buttons += [[b('Опубликовать во всех',f'publish:{id}'),b('Отложить во всех',f'schedule:{id}')],
                    [b('Вернуть в черновики',f'draft:{id}')],[{'text':'← Меню','callback_data':'ed:home'}]]
        await self.e.say(actor,'Рассылка #'+str(id)+'\n'+'\n'.join(lines),buttons)

    async def posts(self,actor,id):
        if not self.s.rows('SELECT 1 FROM ed_batches WHERE id=? AND actor=?',(id,actor)): raise ValueError('Рассылка недоступна.')
        posts=[]
        for row in self.s.rows('SELECT post FROM ed_batch_posts WHERE batch=? ORDER BY destination',(id,)):
            p=await self.e.post_access(actor,row['post']);await self.e.access(actor,p['destination'],publish=True);posts.append(p)
        # Network checks above may have yielded; fresh revisions are checked in the transaction.
        return posts

    async def callback(self,actor,parts):
        action=parts[0]
        if action=='start': return await self.start(actor)
        if action in ('folders','pickfolder'): return await self.folders(actor,action=='pickfolder')
        if action=='reports':
            rows=[[b('Рассылка #'+str(r['id']),'report:'+str(r['id']))] for r in self.s.rows('SELECT id FROM ed_batches WHERE actor=? ORDER BY id DESC LIMIT 30',(actor,))]
            return await self.e.say(actor,'Последние рассылки',rows)
        if action=='report': return await self.card(actor,int(parts[1]))
        if action=='newfolder':
            self.p.session(actor,{'action':'folder_name'});return await self.e.say(actor,'Пришли название папки до 60 символов.')
        if action in ('folder','usefolder','deletefolder'):
            rows=self.s.rows('SELECT * FROM ed_folders WHERE actor=? AND id=?',(actor,int(parts[1])))
            if not rows: raise ValueError('Папка недоступна.')
            f=dict(rows[0])
            if action=='deletefolder':
                self.s.run('DELETE FROM ed_folders WHERE actor=? AND id=?',(actor,f['id']));return await self.folders(actor)
            if action=='folder':
                return await self.e.say(actor,f['name'],[[b('Создать пост для папки','usefolder:'+str(f['id']))],[b('Удалить папку','deletefolder:'+str(f['id']))]])
            ids=json.loads(f['channels'])
            for d in ids: await self.e.access(actor,d)
            current=self.p.session(actor)
            if current.get('action')!='multi_select': current={'action':'multi_select','kind':'multi','name':'','nonce':secrets.token_hex(8),'ids':[]}
            current['ids']=list(dict.fromkeys(current['ids']+ids))
            if len(current['ids'])>30: raise ValueError('До 30 каналов в одной рассылке.')
            self.p.session(actor,current);return await self.select(actor)
        if action in ('toggle','done'):
            f=self.p.session(actor)
            if f.get('action')!='multi_select' or f.get('nonce')!=parts[1]: raise ValueError('Выбор устарел.')
            if action=='toggle':
                d=int(parts[2]);await self.e.access(actor,d)
                f['ids']=([x for x in f['ids'] if x!=d] if d in f['ids'] else f['ids']+[d])
                if len(f['ids'])>30: raise ValueError('До 30 каналов.')
                self.p.session(actor,f);return await self.select(actor)
            if not f['ids']: raise ValueError('Выбери хотя бы один канал.')
            for d in f['ids']: await self.e.access(actor,d)
            if f['kind']=='folder':
                self.s.run('INSERT INTO ed_folders(actor,name,channels) VALUES(?,?,?) ON CONFLICT(actor,name) DO UPDATE SET channels=excluded.channels',(actor,f['name'],packed(f['ids'])))
                self.p.session(actor,{});return await self.folders(actor)
            f['action']='multi_material';self.p.session(actor,f)
            return await self.e.say(actor,'Пришли текст, фото, видео или альбом. Сначала будут созданы черновики для проверки в каждом канале.')
        if action=='schedule':
            await self.posts(actor,int(parts[1]));self.p.session(actor,{'action':'multi_time','batch':int(parts[1])})
            return await self.e.say(actor,'Пришли дату и время, например 18.09.2026 12:00. Каждый канал использует свой часовой пояс.')
        if action in ('publish','draft'):
            posts=await self.posts(actor,int(parts[1]))
            with self.s.db:
                for p in posts:
                    if action=='publish':
                        if p['state'] in ('queued','sent'): continue
                        self.p.enqueue(p,actor)
                    elif p['state']=='scheduled': self.p.change(p,actor,state='draft',publish_at=None)
            return await self.card(actor,int(parts[1]))
        raise ValueError('Открой раздел заново.')

    async def material(self,actor,message,session,media=None):
        for d in session['ids']: await self.e.access(actor,d)
        with self.s.db:
            existing=self.s.rows('SELECT id FROM ed_batches WHERE nonce=?',(session['nonce'],))
            if existing: id=existing[0]['id']
            else:
                if self.p.session(actor)!=session: raise ValueError('Создание рассылки отменено или изменено. Открой его заново.')
                result=self.s.db.execute('INSERT INTO ed_batches(actor,nonce,created_at) VALUES(?,?,?)',(actor,session['nonce'],time.time()));id=result.lastrowid
                for d in session['ids']:
                    p=self.p.new(d,actor,message_text(message),media if media is not None else own_media(message))
                    self.p.validate(p)
                    self.s.db.execute('INSERT INTO ed_batch_posts VALUES(?,?,?)',(id,d,p['id']))
            self.p.session(actor,{})
        return await self.card(actor,id)

    async def input(self,actor,message,session):
        if session['action']=='folder_name':
            name=message_text(message).strip()
            if not 1<=len(name)<=60: raise ValueError('Название от 1 до 60 символов.')
            return await self.start(actor,'folder',name)
        if session['action']=='multi_material': return await self.material(actor,message,session)
        posts=await self.posts(actor,session['batch'])
        with self.s.db:
            for p in posts:
                self.p.set_time(p,actor,'schedule',parse_time(message_text(message),self.p.channel(p['destination'])['timezone']))
            self.p.session(actor,{})
        return await self.card(actor,session['batch'])
