"""Per-channel crossposting with explicit activation, rules and durable review items."""
import asyncio
import json
import re
import time
import unicodedata
from core import source_link
from posting import packed, message_text
from trustat_source import Trustat
from vk_source import VKSource


def schema(s):
    s.db.executescript('''
    CREATE TABLE IF NOT EXISTS ed_cross_routes(id INTEGER PRIMARY KEY,
      destination INTEGER NOT NULL REFERENCES destinations(id),actor INTEGER NOT NULL,kind TEXT NOT NULL,
      source TEXT NOT NULL,peer TEXT NOT NULL,title TEXT NOT NULL,cursor INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,rules TEXT NOT NULL DEFAULT '{}',
      checked_at REAL,next_at REAL NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',UNIQUE(destination,kind,peer));
    CREATE TABLE IF NOT EXISTS ed_cross_items(id INTEGER PRIMARY KEY,route INTEGER NOT NULL REFERENCES ed_cross_routes(id),
      remote INTEGER NOT NULL,text TEXT NOT NULL,url TEXT NOT NULL,media TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',post INTEGER UNIQUE REFERENCES ed_posts(id),error TEXT NOT NULL DEFAULT '',
      related INTEGER REFERENCES ed_posts(id),UNIQUE(route,remote));
    ''')


def parse_rules(text):
    if len(text)>6000: raise ValueError('До 6000 символов настроек.')
    if text.strip().lower()=='сброс': return {}
    result={'include':[],'exclude':[],'replace':[],'duplicates':False}
    for line in text.splitlines():
        if not line.strip(): continue
        key,sep,value=line.partition(':');key=key.strip().lower();value=value.strip()
        if not sep: raise ValueError('Используй строки Искать:, Исключить:, Заменить: или Дубли:.')
        if key in ('искать','исключить'):
            words=[x.strip() for x in value.split(';') if x.strip()]
            if len(words)>30 or any(len(x)>200 for x in words): raise ValueError('До 30 фраз по 200 символов.')
            result['include' if key=='искать' else 'exclude']+=words
        elif key=='заменить':
            a,sep,b=value.partition('=>')
            if not sep or not a.strip() or len(a)>300 or len(b)>500: raise ValueError('Заменить: старое => новое')
            result['replace'].append([a.strip(),b.strip()])
        elif key=='дубли' and value.lower() in ('да','нет'): result['duplicates']=value.lower()=='да'
        else: raise ValueError('Неизвестное правило. Дубли: да или нет.')
    if len(result['replace'])>30 or len(result['include'])>30 or len(result['exclude'])>30: raise ValueError('Слишком много правил.')
    return result


def apply_rules(text,rules):
    folded=text.casefold()
    if any(w.casefold() in folded for w in rules.get('exclude',[])): return text,'Исключён по стоп-фразе.'
    if rules.get('include') and not any(w.casefold() in folded for w in rules['include']): return text,'Нет обязательной фразы.'
    for a,b in rules.get('replace',[]): text=text.replace(a,b)
    if len(text)>30000: raise ValueError('После замен текст слишком длинный.')
    return text,''


def similarity(a,b):
    def norm(t): return re.sub(r'[^\w]+',' ',re.sub(r'https?://\S+',' ',unicodedata.normalize('NFKC',t).casefold())).strip()
    a,b=norm(a),norm(b)
    if min(len(a),len(b))<40:return 0
    if a==b:return 1
    a,b=set(a.split()),set(b.split())
    return len(a&b)/len(a|b) if min(len(a),len(b))>=10 else 0


def b(text,value):return {'text':text,'callback_data':'ed:cross:'+value}


class CrossControls:
    def __init__(self,e):self.e,self.s,self.p,self.app=e,e.s,e.p,e.app

    async def route(self,actor,id):
        rows=self.s.rows('SELECT * FROM ed_cross_routes WHERE id=?',(id,))
        if not rows: raise ValueError('Связка не найдена.')
        row=dict(rows[0]);await self.e.access(actor,row['destination'],owner=True);return row

    async def menu(self,actor):
        routes=[]
        for c in self.e.available(actor):
            if not self.e.is_owner(actor,c['id']):continue
            routes.extend([[b(r['title'][:28]+' → '+c['title'][:20],'route:'+str(r['id']))] for r in self.s.rows('SELECT * FROM ed_cross_routes WHERE destination=?',(c['id'],))])
        await self.e.say(actor,'Кросспостинг · Новые материалы источника с оформлением твоего канала.',routes+[[b('Добавить источник','add')],[{'text':'← Меню','callback_data':'ed:home'}]])

    async def card(self,actor,id):
        r=await self.route(actor,id)
        await self.e.say(actor,r['title']+' → '+self.p.channel(r['destination'])['title']+'\n'+('Включено' if r['enabled'] else 'На паузе')+'\n'+(r['error'] or 'Проверка раз в 5 минут. Архив до подключения пропускается.'),
          [[b('Пауза' if r['enabled'] else 'Включить',f"toggle:{id}:{r['revision']}:{0 if r['enabled'] else 1}")],
           [b('Правила переноса','rules:'+str(id)),b('Материалы и ошибки','items:'+str(id))],
           [b('Обновить','route:'+str(id)),b('← Связки','menu')]])

    async def callback(self,actor,parts):
        action=parts[0]
        if action=='menu':return await self.menu(actor)
        if action=='add':
            rows=[[b(c['title'][:40],'destination:'+str(c['id']))] for c in self.e.available(actor) if c['platform']=='tg' and self.e.is_owner(actor,c['id'])]
            return await self.e.say(actor,'Куда переносить новые посты?',rows)
        if action=='destination':
            d=int(parts[1]);await self.e.access(actor,d,owner=True)
            return await self.e.say(actor,'Откуда брать материалы?',[[b('Telegram через Trustat',f'new:{d}:trustat')],[b('Открытый Telegram',f'new:{d}:public')],[b('Сообщество ВК',f'new:{d}:vk')]])
        if action=='new':
            d=int(parts[1]);await self.e.access(actor,d,owner=True)
            if parts[2] not in ('trustat','public','vk'):raise ValueError('Неизвестный источник.')
            self.p.session(actor,{'action':'cross_add','destination':d,'kind':parts[2]})
            return await self.e.say(actor,'Пришли ссылку на источник. Затем проверь связку и нажми «Включить». /cancel — отмена.')
        if action in ('item','retry','edit','related'):
            rows=self.s.rows('SELECT * FROM ed_cross_items WHERE id=?',(int(parts[1]),))
            if not rows:raise ValueError('Материал не найден.')
            item=dict(rows[0]);r=await self.route(actor,item['route'])
            if action=='item':
                buttons=[[b('Повторить подготовку','retry:'+str(item['id'])),b('Править текст','edit:'+str(item['id']))]] if not item['post'] else [[{'text':'Открыть пост','callback_data':'ed:open:'+str(item['post'])}]]
                if item['related']:buttons.append([b('Добавить «Ранее сообщали»','related:'+str(item['id']))])
                return await self.e.say(actor,item['text'][:2500]+'\n'+item['url']+'\n'+item['state']+'\n'+item['error'],buttons)
            if item['post']:raise ValueError('Материал уже передан в посты.')
            if action=='retry':self.s.run("UPDATE ed_cross_items SET state='pending',error='' WHERE id=? AND post IS NULL AND state='failed'",(item['id'],))
            if action=='edit':
                self.p.session(actor,{'action':'cross_edit','id':item['id']});return await self.e.say(actor,'Пришли новый текст. Вложения сохранятся.')
            if action=='related':
                p=await self.e.post_access(actor,item['related']);c=self.p.channel(p['destination'])
                if p['state']!='sent' or c['platform']!='tg':raise ValueError('Нет доступной публикации для ссылки.')
                rows=self.s.rows("SELECT remote FROM delivery_parts WHERE delivery=? AND status='sent' ORDER BY part",(p['delivery'],))
                ids=[x for row in rows for x in json.loads(row['remote'] or '[]')]
                if not ids or not c['remote'].startswith('-100'):raise ValueError('Ссылка на публикацию недоступна.')
                suffix='\n\nРанее сообщали: https://t.me/c/'+c['remote'][4:]+'/'+str(ids[0])
                text=item['text'] if suffix in item['text'] else item['text']+suffix
                self.s.run("UPDATE ed_cross_items SET text=?,state='pending',error='',related=NULL WHERE id=? AND post IS NULL",(text,item['id']))
            return await self.callback(actor,['item',str(item['id'])])
        r=await self.route(actor,int(parts[1]));id=r['id']
        if action=='route':return await self.card(actor,id)
        if action=='toggle':
            enabled=int(parts[3])
            if enabled not in (0,1):raise ValueError('Некорректное действие.')
            if enabled:self.no_cycle(r['destination'],r['kind'],r['peer'])
            changed=self.s.run('UPDATE ed_cross_routes SET enabled=?,actor=?,revision=revision+1,next_at=0 WHERE id=? AND revision=?',(enabled,actor,id,int(parts[2])))
            if not changed.rowcount:raise ValueError('Связка изменилась. Обнови карточку.')
            return await self.card(actor,id)
        if action=='rules':
            self.p.session(actor,{'action':'cross_rules','id':id,'revision':r['revision']})
            return await self.e.say(actor,'Пришли правила, по одному на строку:\nИскать: причёска; косичка\nИсключить: реклама; макияж\nЗаменить: старое => новое\nДубли: да\n\n«сброс» убирает правила. Текущие:\n'+r['rules'])
        if action=='items':
            rows=[[b('#'+str(i['remote'])+' · '+i['state'],'item:'+str(i['id']))] for i in self.s.rows('SELECT * FROM ed_cross_items WHERE route=? ORDER BY id DESC LIMIT 30',(id,))]
            return await self.e.say(actor,'Последние материалы',rows+[[b('← Связка','route:'+str(id))]])
        raise ValueError('Открой связку заново.')

    def no_cycle(self,destination,kind,peer):
        platform='vk' if kind=='vk' else 'tg'
        if self.s.rows('SELECT 1 FROM destinations WHERE platform=? AND remote=?',(platform,peer)):raise ValueError('Этот канал уже назначение. Связка создала бы круговое копирование.')
        if self.s.rows('SELECT 1 FROM routes r JOIN sources s ON s.id=r.source WHERE r.destination=? AND s.platform=? AND s.remote=?',(destination,platform,peer)):raise ValueError('Такая связка уже включена в прежнем разделе источников.')

    async def input(self,actor,message,session):
        text=message_text(message)
        if session['action']=='cross_add':
            d=session['destination'];kind=session['kind'];await self.e.access(actor,d,owner=True)
            if kind=='public':
                platform,ref=source_link(text)
                if platform!='tg':raise ValueError('Нужен Telegram-канал.')
                page=await self.app.public_tg.page(ref)
                data={'source':ref,'peer':str(page.peer_id),'title':page.title,'cursor':max(p[0] for p in page.posts)}
            else:data=await (Trustat(self.app) if kind=='trustat' else VKSource(self.app)).resolve(text)
            await self.e.access(actor,d,owner=True);self.no_cycle(d,kind,data['peer'])
            with self.s.db:
                self.s.db.execute('''INSERT INTO ed_cross_routes(destination,actor,kind,source,peer,title,cursor)
                  VALUES(?,?,?,?,?,?,?) ON CONFLICT(destination,kind,peer) DO NOTHING''',(d,actor,kind,data['source'],data['peer'],data['title'],data['cursor']))
                id=self.s.rows('SELECT id FROM ed_cross_routes WHERE destination=? AND kind=? AND peer=?',(d,kind,data['peer']))[0]['id']
                self.p.session(actor,{})
            return await self.card(actor,id)
        if session['action']=='cross_rules':
            r=await self.route(actor,session['id']);rules=parse_rules(text)
            if not self.s.run('UPDATE ed_cross_routes SET rules=?,revision=revision+1 WHERE id=? AND revision=?',(packed(rules),r['id'],session['revision'])).rowcount:raise ValueError('Связка изменилась. Открой настройки заново.')
            self.p.session(actor,{});return await self.card(actor,r['id'])
        item=self.s.rows('SELECT * FROM ed_cross_items WHERE id=?',(session['id'],))[0];await self.route(actor,item['route'])
        if not text.strip() or len(text)>30000:raise ValueError('Текст от 1 до 30000 символов.')
        self.s.run("UPDATE ed_cross_items SET text=?,state='failed',error='Текст сохранён. Нажми «Повторить подготовку», когда проверишь материал.' WHERE id=? AND post IS NULL",(text,item['id']))
        self.p.session(actor,{});return await self.callback(actor,['item',str(item['id'])])

    async def tick(self):
        now=time.time()
        for raw in self.s.rows('SELECT * FROM ed_cross_routes WHERE enabled=1 AND next_at<=? ORDER BY next_at,id LIMIT 1',(now,)):
            r=dict(raw);self.s.run('UPDATE ed_cross_routes SET next_at=? WHERE id=?',(now+300,r['id']))
            try:
                await self.e.access(r['actor'],r['destination'],owner=True);self.no_cycle(r['destination'],r['kind'],r['peer'])
                if r['kind']=='public':
                    posts,cursor=await self.app.public_tg.since(r['source'],int(r['peer']),r['cursor'],max_pages=5);result={'posts':posts,'cursor':cursor}
                else:result=await (Trustat(self.app) if r['kind']=='trustat' else VKSource(self.app)).fetch(r['source'],r['peer'],r['cursor'])
                await self.e.access(r['actor'],r['destination'],owner=True)
                with self.s.db:
                    fresh=self.s.rows('SELECT revision,enabled FROM ed_cross_routes WHERE id=?',(r['id'],))[0]
                    if fresh['revision']!=r['revision'] or not fresh['enabled']:continue
                    for remote,text,url,media in result['posts']:
                        self.s.db.execute('INSERT INTO ed_cross_items(route,remote,text,url,media) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING',(r['id'],remote,text,url,packed(media)))
                    self.s.db.execute('UPDATE ed_cross_routes SET cursor=?,checked_at=?,error=?,enabled=? WHERE id=?',(result['cursor'],now,result.get('message') or '',0 if result.get('pause') else 1,r['id']))
            except Exception as exc:
                from app import safe_error
                self.s.run('UPDATE ed_cross_routes SET checked_at=?,error=?,enabled=? WHERE id=?',(now,safe_error(exc)[:500],0 if getattr(exc,'pause',False) else r['enabled'],r['id']))
        for raw in self.s.rows("SELECT i.* FROM ed_cross_items i JOIN ed_cross_routes r ON r.id=i.route WHERE i.state='pending' AND r.enabled=1 ORDER BY i.id LIMIT 3"):
            item=dict(raw);r=dict(self.s.rows('SELECT * FROM ed_cross_routes WHERE id=?',(item['route'],))[0])
            try:
                await self.e.access(r['actor'],r['destination'],owner=True,publish=True)
                text,skip=apply_rules(item['text'],json.loads(r['rules']))
                if skip:
                    self.s.run("UPDATE ed_cross_items SET state='skipped',error=? WHERE id=?",(skip,item['id']));continue
                related=None
                if json.loads(r['rules']).get('duplicates') and 'Ранее сообщали: https://t.me/' not in text:
                    for p in self.s.rows("SELECT id,text FROM ed_posts WHERE destination=? AND state='sent' ORDER BY id DESC LIMIT 100",(r['destination'],)):
                        if similarity(text,p['text'])>=.75:related=p['id'];break
                if related:
                    self.s.run("UPDATE ed_cross_items SET state='failed',related=?,error='Есть похожая публикация. Проверь материал.' WHERE id=?",(related,item['id']));continue
                with self.s.db:
                    fresh=self.s.rows('SELECT enabled,revision FROM ed_cross_routes WHERE id=?',(r['id'],))[0]
                    if not fresh['enabled'] or fresh['revision']!=r['revision']:continue
                    current=self.s.rows('SELECT post,state FROM ed_cross_items WHERE id=?',(item['id'],))[0]
                    if current['post'] or current['state']!='pending':continue
                    p=self.p.new(r['destination'],r['actor'],text,item['media'],origin='crosspost')
                    # Same durable queue and subscription checks as manually composed posts.
                    p=self.p.enqueue(p,r['actor'])
                    self.s.db.execute("UPDATE ed_cross_items SET post=?,state='queued',error='' WHERE id=?",(p['id'],item['id']))
            except Exception as exc:
                from app import safe_error
                self.s.run("UPDATE ed_cross_items SET state='failed',error=? WHERE id=?",(safe_error(exc)[:500],item['id']))

    async def loop(self):
        while True:
            self.app.runtime_heartbeats['crosspost']=time.monotonic()
            try:await self.tick()
            except Exception:print('Crossposting worker: state preserved; retrying.',flush=True)
            await asyncio.sleep(10)
