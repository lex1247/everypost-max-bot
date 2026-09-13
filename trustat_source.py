"""Read-only Trustat integration. Never joins channels or publishes messages."""
import json
import os
import re
import time
from urllib.parse import urlparse, quote

BASE='https://api-public.trustat.me/public/v1'

class TrustatError(Exception):
    def __init__(self,message,*,pause=False,retry_after=300):
        super().__init__(message);self.pause=pause;self.retry_after=retry_after


def source_ref(value):
    value=str(value or '').strip()
    if value.startswith('@'):value=value[1:]
    if re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{3,31}',value):return value.lower()
    if re.fullmatch(r'\+[A-Za-z0-9_-]{8,128}',value):return value
    if not value.startswith('https://'):raise ValueError('Пришлите ссылку на Telegram-канал или @имя.')
    u=urlparse(value)
    if u.hostname not in ('t.me','telegram.me') or u.username or u.password or u.port or u.query or u.fragment:
        raise ValueError('Нужна обычная ссылка Telegram без дополнительных параметров.')
    path=u.path.strip('/')
    if path.startswith('s/'):path=path[2:]
    if path.startswith('joinchat/'):path='+'+path[len('joinchat/'):]
    if '/' in path:raise ValueError('Нужна ссылка на канал, не на отдельный пост.')
    return source_ref(path)


def init(store):
    store.db.executescript('''CREATE TABLE IF NOT EXISTS ts_post_cache(
      post_id TEXT PRIMARY KEY,body TEXT NOT NULL,created_at REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS ts_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);''')


class Trustat:
    def __init__(self,app):self.app=app;init(app.s)

    async def get(self,path,params=None):
        key=os.getenv('TRUSTAT_API_KEY','').strip()
        if not key:raise TrustatError('Ключ Trustat ещё не настроен на сервере.',pause=True)
        state=self.app.s.rows("SELECT value FROM ts_state WHERE key='blocked'")
        if state:
            blocked=json.loads(state[0]['value'])
            if blocked['until']>time.time():raise TrustatError(blocked['message'],pause=True)
        try:r=await self.app.http.get(BASE+path,params=params or {},headers={'Authorization':'Bearer '+key},timeout=30,follow_redirects=False)
        except Exception:raise TrustatError('Trustat временно не отвечает. Повторим позже.') from None
        if r.status_code in (401,403,426):
            message={401:'Ключ Trustat отклонён. Проверьте ключ в настройках сервера.',403:'Trustat не разрешает чтение. Проверьте подключение API Search и API Stat.',426:'Лимит Trustat исчерпан. Связка приостановлена; архив и очередь сохранены.'}[r.status_code]
            # Brief shared cooldown prevents every route from repeating a failed request.
            self.app.s.run("INSERT INTO ts_state(key,value) VALUES('blocked',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(json.dumps({'until':time.time()+300,'message':message}),))
            raise TrustatError(message,pause=True)
        if r.status_code==404:raise TrustatError('Канал или пост не найден в Trustat. Проверьте ссылку и наличие канала в его базе.',pause=True)
        if r.status_code!=200:raise TrustatError('Trustat временно недоступен. Повторим позже.')
        try:
            d=r.json()
            if d['status']!='ok' or not isinstance(d['response'],dict):raise ValueError()
            return d['response']
        except (ValueError,KeyError,TypeError):raise TrustatError('Trustat вернул неполный ответ. Курсор сохранён.') from None

    async def resolve(self,value):
        ref=source_ref(value)
        channel=await self.get('/channels/'+quote(ref,safe=''),{'source':'telegram'})
        cid=channel.get('channel_id')
        if type(cid) is not int or not 0<cid<10**12 or channel.get('source')!='telegram':raise ValueError('Не удалось подтвердить Telegram-канал в Trustat.')
        page=await self.get('/channels/'+str(cid)+'/posts',{'source':'telegram','limit':1,'hide_deleted':'true'})
        posts=self.page(page,cid)
        return {'source':'trustat_'+str(cid),'peer':str(-10**12-cid),'title':str(channel.get('title') or 'Канал Telegram')[:200],
                'cursor':max((p['message_id'] for p in posts),default=0),'kind':'trustat'}

    def page(self,page,cid):
        if page.get('channel_id')!=cid or page.get('source')!='telegram' or not isinstance(page.get('posts'),list):raise TrustatError('Неверный канал в ответе Trustat.')
        posts=page['posts']
        if len(posts)>100:raise TrustatError('Слишком большая страница Trustat.')
        for p in posts:
            if not isinstance(p,dict) or p.get('channel_id')!=cid or p.get('source')!='telegram' or type(p.get('message_id')) is not int or p['message_id']<=0:raise TrustatError('Неполная карточка поста Trustat.')
        if any(a['message_id']<b['message_id'] for a,b in zip(posts,posts[1:])):
            raise TrustatError('Trustat вернул посты в неожиданном порядке. Курсор сохранён.')
        return posts

    async def detail(self,cid,mid):
        pid=f'{cid}_{mid}'
        cached=self.app.s.rows('SELECT body FROM ts_post_cache WHERE post_id=?',(pid,))
        if cached:return json.loads(cached[0]['body'])
        p=await self.get('/posts/'+pid,{'source':'telegram'})
        if p.get('channel_id')!=cid or p.get('message_id')!=mid or p.get('source')!='telegram':raise TrustatError('Неверный пост в ответе Trustat.')
        if p.get('text') is not None and not isinstance(p['text'],str):raise TrustatError('Trustat вернул некорректный текст. Курсор сохранён.')
        self.app.s.run('INSERT INTO ts_post_cache(post_id,body,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING',(pid,json.dumps(p,ensure_ascii=False),time.time()))
        return p

    async def fetch(self,source,peer,cursor):
        m=re.fullmatch(r'trustat_([1-9][0-9]{0,11})',str(source))
        if not m or str(-10**12-int(m[1]))!=str(peer) or type(cursor) is not int or cursor<0:raise ValueError('Некорректное состояние источника Trustat.')
        cid=int(m[1]);next_cursor=None;found={};seen=set();complete=False
        for _ in range(10):
            params={'source':'telegram','limit':100,'hide_deleted':'true'}
            if next_cursor:params['cursor']=next_cursor
            page=await self.get('/channels/'+str(cid)+'/posts',params)
            posts=self.page(page,cid)
            for p in posts:
                if p['message_id']>cursor:found[p['message_id']]=p
            if any(p['message_id']<=cursor for p in posts) or not page.get('next_cursor'):
                complete=True;break
            next_cursor=page['next_cursor']
            if not isinstance(next_cursor,str) or next_cursor in seen:raise TrustatError('Trustat повторил страницу. Курсор сохранён.')
            seen.add(next_cursor)
        if not complete:raise TrustatError('Слишком большой перерыв в чтении Trustat. Связка приостановлена, чтобы не пропустить посты.',pause=True)
        result=[];pause_error=None
        # Small batches preserve already prepared content if quota is exhausted mid-batch.
        for mid in sorted(found)[:20]:
            try:p=await self.detail(cid,mid)
            except TrustatError as e:
                if not result:raise
                pause_error=e;break
            media=post_media(p)
            result.append([mid,p.get('text') or '',f'https://t.me/c/{cid}/{mid}',media]);cursor=mid
        return {'posts':result,'cursor':cursor,'pause':bool(pause_error and pause_error.pause),
                'message':str(pause_error) if pause_error else None}


def post_media(post):
    result={'photos':[],'unsupported':[]}
    if post.get('is_deleted'):
        result['unsupported'].append('публикация удалена из источника');return result
    media=post.get('media')
    if not media:
        if not str(post.get('text') or '').strip():result['unsupported'].append('пустая карточка Trustat; нужна проверка')
        return result
    from media import photo_url,trustat_video_url
    entries=media if isinstance(media,list) else [media]
    gallery=[]
    for item in entries:
        try:
            if not isinstance(item,dict):raise ValueError()
            url=item.get('file_url')
            if item.get('media_type')=='mediaPhoto' and isinstance(url,str):
                gallery.append({'type':'photo','url':photo_url(url)})
            elif item.get('media_type')=='mediaDocument' and item.get('mime_type')=='video/mp4' and isinstance(url,str):
                gallery.append({'type':'video','url':trustat_video_url(url)})
            else:raise ValueError()
        except ValueError:result['unsupported'].append('Trustat не предоставил поддерживаемый файл вложения; нужна проверка')
    if len(gallery)==1 and gallery[0]['type']=='photo':result['photos']=[{'url':gallery[0]['url']}]
    elif gallery:result['gallery']=gallery
    return result
