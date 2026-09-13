"""VK community feeds for MAX crossposting; no delivery side effects."""
import re
from core import source_link
from media import vk_media

class VKSource:
    def __init__(self,app):self.app=app
    async def resolve(self,value):
        platform,ref=source_link(str(value))
        if platform!='vk':raise ValueError('Пришлите ссылку на сообщество ВК.')
        ref=re.sub(r'^(club|public)(?=\d+$)','',ref)
        groups=await self.app.vk('groups.getById',group_ids=ref)
        groups=groups.get('groups') if isinstance(groups,dict) else groups
        if not isinstance(groups,list) or len(groups)!=1:raise ValueError('Сообщество ВК не найдено.')
        group=groups[0];gid=group.get('id')
        if type(gid) is not int or gid<=0 or group.get('is_closed'):raise ValueError('Нужно доступное открытое сообщество ВК.')
        owner=-gid;wall=await self.app.vk('wall.get',owner_id=owner,count=100,filter='owner')
        posts=self.page(wall,owner)
        return {'source':'vk_'+str(gid),'peer':str(owner),'kind':'vk','title':str(group.get('name') or ref)[:200],'cursor':max((p['id'] for p in posts),default=0)}
    def page(self,wall,owner):
        if not isinstance(wall,dict) or not isinstance(wall.get('items'),list) or len(wall['items'])>100:raise ValueError('Неполный ответ ВК.')
        for p in wall['items']:
            if not isinstance(p,dict) or p.get('owner_id')!=owner or type(p.get('id')) is not int or p['id']<=0:raise ValueError('Пост ВК не соответствует источнику.')
        return wall['items']
    async def fetch(self,source,peer,cursor):
        m=re.fullmatch(r'vk_([1-9][0-9]{0,11})',str(source))
        if not m or str(-int(m[1]))!=str(peer) or type(cursor) is not int or cursor<0:raise ValueError('Некорректная связка ВК.')
        owner=int(peer);found={};complete=False
        for offset in range(0,1000,100):
            wall=await self.app.vk('wall.get',owner_id=owner,count=100,offset=offset,filter='owner');posts=self.page(wall,owner)
            unpinned=[p for p in posts if not p.get('is_pinned')]
            if any(a['id']<b['id'] for a,b in zip(unpinned,unpinned[1:])):raise ValueError('ВК вернул посты в неожиданном порядке.')
            for p in posts:
                if p['id']>cursor:found[p['id']]=p
            if len(posts)<100 or any(p['id']<=cursor for p in unpinned):complete=True;break
        if not complete:raise ValueError('Слишком большой перерыв чтения ВК. Позиция сохранена; требуется проверка.')
        result=[]
        for mid in sorted(found)[:20]:
            p=found[mid];parts=[p.get('text','')]+[x.get('text','') for x in p.get('copy_history',[])]
            if not all(isinstance(x,str) for x in parts):raise ValueError('Неполный текст ВК.')
            result.append([mid,'\n'.join(x for x in parts if x),f'https://vk.com/wall{owner}_{mid}',vk_media(p)]);cursor=mid
        return {'posts':result,'cursor':cursor}
