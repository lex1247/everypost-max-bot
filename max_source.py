"""MAX channel feeds for the authenticated Telegram owner; never polls /updates."""
import json,re
from urllib.parse import urlparse
from media import photo_url
from database import Postgres

def init(store):
    store.db.executescript('''CREATE TABLE IF NOT EXISTS max_source_messages(
      id INTEGER PRIMARY KEY,source INTEGER NOT NULL,mid TEXT NOT NULL,ignored INTEGER NOT NULL DEFAULT 0,
      UNIQUE(source,mid));''')

class MaxSource:
    def __init__(self,app):self.app=app;init(app.s)
    async def access(self,remote):
        chat=await self.app.max_api('GET','/chats/'+str(remote))
        member=await self.app.max_api('GET','/chats/'+str(remote)+'/members/me')
        if chat.get('type')!='channel' or not member.get('is_admin'):raise ValueError('EveryPost должен быть администратором MAX-канала-источника.')
        return chat
    def page(self,data,remote):
        rows=data.get('messages') if isinstance(data,dict) else None
        if not isinstance(rows,list) or len(rows)>100:raise ValueError('MAX вернул неполный список постов.')
        for p in rows:
            if (p.get('recipient',{}).get('chat_id')!=remote or type(p.get('timestamp')) is not int
              or not isinstance(p.get('body',{}).get('mid'),str)):raise ValueError('Пост не соответствует MAX-источнику.')
        if any(a['timestamp']<b['timestamp'] for a,b in zip(rows,rows[1:])):raise ValueError('Неожиданный порядок постов MAX.')
        return rows
    async def add(self,remote):
        if not re.fullmatch(r'-[1-9][0-9]{0,18}',str(remote)):raise ValueError('Некорректный MAX-канал.')
        remote=int(remote);chat=await self.access(remote)
        if self.app.s.rows("SELECT 1 FROM routes r JOIN destinations d ON d.id=r.destination WHERE d.platform='max' AND d.remote=?",(str(remote),)):
            raise ValueError('Этот MAX-канал получает кросспостинг. Сначала отключите входящие связки, чтобы не создавать круговое копирование.')
        # The MAX UI stores incoming routes in the same PostgreSQL database.
        if isinstance(self.app.s.db,Postgres):
            exists=self.app.s.rows("SELECT to_regclass('public.ep_cross_routes') AS t")[0]['t']
            if exists and self.app.s.rows('SELECT 1 FROM public.ep_cross_routes r JOIN public.channels c ON c.id=r.channel_id WHERE c.max_chat_id=? AND r.enabled',(remote,)):
                raise ValueError('В этот MAX-канал уже включён перенос. Поставьте входящие связки на паузу перед обратным направлением.')
        rows=self.page(await self.app.max_api('GET','/messages',params={'chat_id':remote,'count':100}),remote)
        old=self.app.s.rows("SELECT id FROM sources WHERE platform='max' AND remote=?",(str(remote),))
        if old:return old[0]['id'],chat.get('title',str(remote))
        with self.app.s.db:
            sid=self.app.s.add_source('max',str(remote),chat.get('title',str(remote)),max((p['timestamp'] for p in rows),default=0))
            for p in rows:self.app.s.db.execute('INSERT INTO max_source_messages(source,mid,ignored) VALUES(?,?,1) ON CONFLICT DO NOTHING',(sid,p['body']['mid']))
        return sid,chat.get('title',str(remote))
    async def fetch(self,source):
        remote=int(source['remote']);await self.access(remote)
        before=None;found={};complete=False
        for _ in range(10):
            params={'chat_id':remote,'count':100}
            if before is not None:params['from']=before
            rows=self.page(await self.app.max_api('GET','/messages',params=params),remote)
            for p in rows:
                if p['timestamp']>=source['cursor']:found[p['body']['mid']]=p
            if len(rows)<100 or any(p['timestamp']<source['cursor'] for p in rows):complete=True;break
            earliest=rows[-1]['timestamp']
            if rows[0]['timestamp']==earliest:raise ValueError('Больше 100 постов MAX с одним временем. Автоматическое чтение остановлено для проверки.')
            # Keep the timestamp boundary in the next page; deduplication uses message IDs.
            if before is not None and earliest>=before:raise ValueError('MAX повторил страницу. Позиция чтения сохранена.')
            before=earliest
        if not complete:raise ValueError('Слишком большой перерыв чтения MAX. Позиция сохранена.')
        posts=[];cursor=source['cursor']
        for p in sorted(found.values(),key=lambda p:(p['timestamp'],p['body']['mid'])):
            body=p['body'];mid=body['mid'];cursor=max(cursor,p['timestamp'])
            self.app.s.run('INSERT INTO max_source_messages(source,mid) VALUES(?,?) ON CONFLICT DO NOTHING',(source['id'],mid))
            mapping=self.app.s.rows('SELECT id,ignored FROM max_source_messages WHERE source=? AND mid=?',(source['id'],mid))[0]
            if mapping['ignored']:continue
            media={'photos':[],'unsupported':[]}
            if p.get('link'):media['unsupported'].append('пересланный пост MAX требует проверки источника')
            for a in body.get('attachments',[]):
                if a.get('type')=='image':
                    try:media['photos'].append({'url':photo_url(a.get('payload',{}).get('url'))})
                    except ValueError:media['unsupported'].append('недоступная фотография MAX')
                elif a.get('type')=='inline_keyboard':
                    media['unsupported'].append('кнопки MAX требуют ручной проверки перед переносом в Telegram')
                else:media['unsupported'].append('неподдерживаемое вложение MAX: '+str(a.get('type'))[:40])
            text=body.get('text') or ''
            if not isinstance(text,str):raise ValueError('Неполный текст MAX.')
            link=p.get('url') or '';parsed=urlparse(link)
            if parsed.scheme!='https' or parsed.hostname not in ('max.ru','web.max.ru') or parsed.username or parsed.password or parsed.port not in (None,443):link=''
            posts.append((mapping['id'],text,link,media))
        self.app.s.ingest(source['id'],posts,cursor)

async def choose(app):
    data=await app.max_api('GET','/chats',params={'count':100})
    chats=[c for c in data.get('chats',[]) if c.get('type')=='channel']
    app.s.set('max_source_choices',json.dumps([{'id':c['chat_id'],'title':c.get('title','MAX-канал')} for c in chats]))
    app.s.set('wizard','/max_source_choice')
    return 'Выберите MAX-канал-источник. Бот должен быть его администратором. После выбора укажите свой Telegram-канал назначения. Старый архив пропускается. Видео и кнопки, которые нельзя перенести целиком, остаются для проверки.' if chats else 'Бот пока не видит MAX-каналы. Добавьте EveryPost администратором источника, затем откройте этот раздел снова.'
