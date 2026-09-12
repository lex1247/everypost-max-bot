"""Telegram controls for the posting features of EveryPost MAX."""
import asyncio
import json
import os
import secrets
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from posting import (Posting, EDITABLE, packed, own_media, message_text, styled, parse_buttons,
                     validate_style, parse_time, valid_url)

LABELS = {'draft': 'Черновик', 'proposed': 'Предложено', 'held': 'Нужна проверка', 'scheduled': 'Отложен',
          'queued': 'В очереди', 'sent': 'Опубликован', 'deleted': 'Удалён', 'cancelled': 'Отменён',
          'failed': 'Ошибка', 'unknown': 'Проверь канал'}


def button(text, data):
    return {'text': text, 'callback_data': 'ed:'+data}


class Editor:
    def __init__(self, app):
        self.app, self.s = app, app.s
        self.p = Posting(self.s)

    async def say(self, actor, text, rows=None):
        kwargs = {'chat_id': actor, 'text': text[:4000], 'link_preview_options': {'is_disabled': True}}
        if rows is not None:
            kwargs['reply_markup'] = {'inline_keyboard': rows}
        return await self.app.tg('sendMessage', **kwargs)

    def available(self, actor):
        if actor == self.app.owner:
            return self.s.rows('SELECT * FROM destinations ORDER BY id')
        return self.s.rows('SELECT d.* FROM destinations d JOIN ed_admins a ON a.destination=d.id WHERE a.actor=? ORDER BY d.id', (actor,))

    async def access(self, actor, destination, *, publish=False, owner=False):
        if owner and actor != self.app.owner:
            raise ValueError('Эта настройка доступна владельцу бота.')
        if actor != self.app.owner and not self.s.rows('SELECT 1 FROM ed_admins WHERE destination=? AND actor=?', (destination, actor)):
            raise ValueError('Доступ к этому каналу не выдан или отозван.')
        channel = self.p.channel(destination)
        if channel['platform'] == 'tg':
            member = await self.app.tg('getChatMember', chat_id=int(channel['remote']), user_id=actor)
            if member.get('status') != 'creator' and not (member.get('status') == 'administrator' and member.get('can_post_messages')):
                raise ValueError('Для работы с каналом нужны права администратора Telegram на публикацию.')
        if publish:
            if channel['platform'] == 'tg':
                member = await self.app.tg('getChatMember', chat_id=int(channel['remote']), user_id=self.app.bot_id)
                if member.get('status') != 'administrator' or not member.get('can_post_messages'):
                    raise ValueError('У бота нет права публиковать в этом канале Telegram.')
            else:
                member = await self.app.max_api('GET', f"/chats/{channel['remote']}/members/me")
                if not member.get('is_admin') or not {'write', 'post_edit_delete_message'}.intersection(member.get('permissions') or []):
                    raise ValueError('У бота нет права публиковать в этом канале MAX.')
        return channel

    async def post_access(self, actor, id, revision=None):
        post = self.p.post(id)
        await self.access(actor, post['destination'])
        if actor != self.app.owner and post['creator'] != actor and post['state'] != 'proposed':
            raise ValueError('Этот пост доступен его редактору и владельцу бота.')
        if revision is not None and post['revision'] != revision:
            raise ValueError('Эта кнопка устарела. Открой пост заново в списке.')
        return post

    async def home(self, actor):
        self.p.session(actor, {})
        if actor == self.app.owner:
            self.s.set('wizard', '')
        if not self.available(actor):
            return await self.say(actor, 'Для предложки открой ссылку из канала. Для управления каналом владелец должен добавить тебя администратором бота.')
        return await self.say(actor, 'Постинг\nВыбери действие.', [
            [button('✍️ Создать пост', 'choose:new')],
            [button('📝 Черновики', 'choose:draft'), button('📨 Предложка', 'choose:proposed')],
            [button('🗓 Отложенные', 'choose:scheduled'), button('✅ Опубликованные', 'choose:sent')],
            [button('⚙️ Каналы и оформление', 'choose:settings')]])

    async def choose(self, actor, action):
        rows = [[button(f"{c['title'][:40]} · {c['platform'].upper()}", f"channel:{action}:{c['id']}")] for c in self.available(actor)]
        if not rows:
            return await self.home(actor)
        rows.append([button('← Меню', 'home')])
        await self.say(actor, 'Выбери канал.', rows)

    async def listing(self, actor, destination, state, page=0):
        await self.access(actor, destination)
        states = ('draft','held','failed','unknown') if state == 'draft' else ('sent','deleted') if state == 'sent' else (state,)
        query = 'SELECT * FROM ed_posts WHERE destination=? AND state IN ('+','.join('?' for _ in states)+')'
        args = [destination, *states]
        if actor != self.app.owner and state != 'proposed':
            query += ' AND creator=?'
            args.append(actor)
        posts = self.s.rows(query+' ORDER BY id DESC LIMIT 11 OFFSET ?', (*args, max(0,page)*10))
        rows = [[button(f"#{p['id']} · {LABELS.get(p['state'],p['state'])} · {(p['text'] or 'Медиа')[:25]}", f"open:{p['id']}")] for p in posts[:10]]
        pages=[]
        if page: pages.append(button('← Назад', f'list:{destination}:{state}:{page-1}'))
        if len(posts)>10: pages.append(button('Дальше →', f'list:{destination}:{state}:{page+1}'))
        if pages: rows.append(pages)
        rows.append([button('← Меню', 'home')])
        await self.say(actor, self.p.channel(destination)['title']+'\n'+('Выбери пост.' if posts else 'Здесь пока пусто.'), rows)

    async def card(self, actor, id, preview=False):
        p = await self.post_access(actor, id)
        c = self.p.channel(p['destination'])
        if preview:
            try:
                _, _, plan = self.p.validate(p)
                for part in plan:
                    method, payload, files = await self.app.prepare_part('tg', actor, part) if c['platform']=='tg' else (None,None,None)
                    if method:
                        await self.app.tg(method, **payload, **({'_files': files} if files else {}))
                if c['platform'] == 'max':
                    # Show the same text/media in Telegram; the destination is stated on the control card.
                    from media import publication_parts
                    text, _ = styled(p['text'], json.loads(p['style']), 'https://t.me/EveryPost_bot?start=propose_'+c['code'])
                    for part in publication_parts('tg', text, p['media']):
                        method,payload,files=await self.app.prepare_part('tg',actor,part)
                        await self.app.tg(method, **payload, **({'_files':files} if files else {}))
            except ValueError as exc:
                await self.say(actor, 'Предпросмотр: '+str(exc))
        prefix=f"#{p['id']} · {LABELS.get(p['state'],p['state'])}\nКанал: {c['title']} · {c['platform'].upper()}"
        zone=ZoneInfo(c['timezone'])
        for field,label in [('publish_at','Публикация'),('delete_at','Автоудаление')]:
            if p[field]: prefix+=f"\n{label}: "+datetime.fromtimestamp(p[field],zone).strftime('%d.%m.%Y %H:%M')+f" ({c['timezone']})"
        if p['error']: prefix+='\n'+p['error']
        suffix=f"{p['id']}:{p['revision']}"
        rows=[]
        if p['state'] in EDITABLE:
            rows=[[button('👁 Предпросмотр', 'preview:'+suffix), button('🚀 Опубликовать', 'publish:'+suffix)],
                  [button('✏️ Изменить текст', 'text:'+suffix), button('🖼 Заменить материал', 'replace:'+suffix)],
                  [button('📝 Сохранить черновик', 'save:'+suffix), button('🗓 Отложить', 'schedule:'+suffix)],
                  [button('✨ Оформление', 'style:'+suffix), button('⏱ Автоудаление', 'delete:'+suffix)],
                  [button('🗑 Удалить черновик', 'discard:'+suffix)]]
        elif p['state']=='scheduled':
            rows=[[button('Перенести', 'schedule:'+suffix),button('В черновики', 'unschedule:'+suffix)],
                  [button('Автоудаление', 'delete:'+suffix),button('Предпросмотр','preview:'+suffix)]]
        elif p['state']=='sent':
            rows=[[button('⏱ Автоудаление','delete:'+suffix)]]
        if p['delete_at'] and p['state'] in (*EDITABLE,'scheduled','sent'):
            rows.append([button('Отключить автоудаление','undelete:'+suffix)])
        if p['state'] in ('failed','unknown'):
            rows.append([button('Проверить отправку','delivery:'+suffix)])
        rows.append([button('← Меню','home')])
        await self.say(actor,prefix+'\n\n'+(p['text'][:600] or 'Пост с медиа'),rows)

    async def settings(self, actor, destination):
        c=await self.access(actor,destination)
        style=validate_style(json.loads(c['style']))
        info=(f"{c['title']} · {c['platform'].upper()}\nЧасовой пояс: {c['timezone']}\n"
              f"Подпись: {style['signature'] or 'нет'}\nКнопок: {len(style['buttons'])}\n"
              'Ссылка предложки:\nhttps://t.me/EveryPost_bot?start=propose_'+c['code'])
        if actor!=self.app.owner:
            return await self.say(actor,info+'\n\nОбщие настройки меняет владелец бота.',[[button('← Меню','home')]])
        rows=[[button('Подпись',f'config:signature:{destination}'),button('Кнопки',f'config:buttons:{destination}')],
              [button('Предложка '+('✓' if style['proposal'] else '—'),f'config:proposal:{destination}')],
              [button('Часовой пояс',f'config:timezone:{destination}'),button('Обсуждение',f'config:discussion_url:{destination}')]]
        if actor==self.app.owner:
            discussion=json.loads(c['discussion'])
            rows += [[button('Копия в группу '+('✓' if discussion.get('enabled') else '—'),f'config:discussion:{destination}')],
                     [button('Администраторы',f'admins:{destination}')]]
        rows.append([button('← Меню','home')])
        await self.say(actor,info,rows)

    async def style_menu(self,actor,p):
        style=validate_style(json.loads(p['style']))
        suffix=f"{p['id']}:{p['revision']}"
        await self.say(actor,f"Оформление поста #{p['id']}\nПодпись: {style['signature'] or 'нет'}\nКнопок: {len(style['buttons'])}",
            [[button('Подпись','pstyle:signature:'+suffix),button('Кнопки','pstyle:buttons:'+suffix)],
             [button('Предложка '+('✓' if style['proposal'] else '—'),'pstyle:proposal:'+suffix)],
             [button('Обсуждение','pstyle:discussion_url:'+suffix)], [button('← К посту','open:'+str(p['id']))]])

    async def calendar(self,actor,p,mode):
        if p['state'] not in (*EDITABLE,'scheduled','sent') or (mode=='schedule' and p['state']=='sent'):
            raise ValueError('Этот пост уже отправляется. Дождись результата.')
        nonce=secrets.token_urlsafe(24)
        self.s.run('INSERT INTO ed_calendar(nonce,actor,post,revision,mode,expires) VALUES(?,?,?,?,?,?)',
                   (nonce,actor,p['id'],p['revision'],mode,time.time()+3600))
        self.p.session(actor,{'action':'time','post':p['id'],'revision':p['revision'],'mode':mode})
        base=os.getenv('PUBLIC_URL',os.getenv('RENDER_EXTERNAL_URL','')).rstrip('/')
        rows=[]
        if base.startswith('https://'):
            rows.append([{'text':'🗓 Открыть календарь','web_app':{'url':base+'/calendar?nonce='+nonce+'&mode='+mode}}])
        rows.append([button('← К посту','open:'+str(p['id']))])
        await self.say(actor,('Выбери время публикации' if mode=='schedule' else 'Выбери время удаления')+
            f". Часовой пояс: {self.p.channel(p['destination'])['timezone']}.\nМожно прислать дату сообщением, например 15.09.2026 18:30.",rows)

    async def callback(self,actor,data):
        parts=data.split(':')[1:]; action=parts[0]
        if action=='home': return await self.home(actor)
        if action=='choose': return await self.choose(actor,parts[1])
        if action=='list': return await self.listing(actor,int(parts[1]),parts[2],int(parts[3]))
        if action=='channel':
            what,destination=parts[1],int(parts[2]); await self.access(actor,destination)
            if what=='new':
                self.p.session(actor,{'action':'new','destination':destination})
                return await self.say(actor,'Пришли текст, фото, видео или один альбом. Пост сначала появится в черновиках.',[[button('Отмена','home')]])
            if what=='settings': return await self.settings(actor,destination)
            return await self.listing(actor,destination,what)
        if action=='config':
            field,destination=parts[1],int(parts[2]); c=await self.access(actor,destination,owner=True)
            if field=='proposal':
                style=validate_style(json.loads(c['style']));style['proposal']=not style['proposal']
                self.s.run('UPDATE ed_channels SET style=? WHERE destination=?',(packed(style),destination))
                return await self.settings(actor,destination)
            self.p.session(actor,{'action':'config','field':field,'destination':destination})
            prompts={'signature':'Пришли подпись (до 700 символов) или - для отключения.',
                     'buttons':'Пришли до 8 кнопок, каждая с новой строки:\nНазвание | https://ссылка\nИли - для отключения.',
                     'timezone':'Пришли часовой пояс, например Europe/Moscow или Asia/Yekaterinburg.',
                     'discussion_url':'Пришли ссылку на группу обсуждения или - для отключения кнопки.',
                     'discussion':'Пришли числовой ID группы для копий новых постов этого канала. Бот должен состоять в ней. Для отключения пришли -. Копия в группе останется при автоудалении поста из канала.'}
            return await self.say(actor,prompts[field],[[button('Отмена','home')]])
        if action=='admins':
            destination=int(parts[1]);await self.access(actor,destination,owner=True)
            admins=self.s.rows('SELECT a.actor,u.name FROM ed_admins a LEFT JOIN ed_users u ON u.actor=a.actor WHERE destination=?',(destination,))
            rows=[[button('Убрать '+(a['name'] or str(a['actor']))[:30],f"revoke:{destination}:{a['actor']}")] for a in admins]
            rows.extend([[button('Добавить',f'grant:{destination}')],[button('← Настройки',f'channel:settings:{destination}')]])
            return await self.say(actor,'Администраторы бота для этого канала. В Telegram также нужны права на публикацию в самом канале.',rows)
        if action in ('grant','revoke'):
            destination=int(parts[1]); await self.access(actor,destination,owner=True)
            if action=='grant':
                self.p.session(actor,{'action':'grant','destination':destination})
                return await self.say(actor,'Попроси администратора открыть этого бота и нажать /id. Пришли его числовой ID сюда.')
            target=int(parts[2])
            with self.s.db:
                self.s.db.execute('DELETE FROM ed_admins WHERE destination=? AND actor=?',(destination,target))
                self.s.db.execute("UPDATE ed_posts SET state='held',error='Доступ редактора отозван',revision=revision+1 WHERE destination=? AND creator=? AND state='scheduled'",(destination,target))
            self.p.audit(actor,destination,'revoke:'+str(target))
            return await self.callback(actor,f'ed:admins:{destination}')
        if action=='open':
            self.p.session(actor,{})
            return await self.card(actor,int(parts[1]))
        if action=='pstyle':
            field,id,revision=parts[1],int(parts[2]),int(parts[3]);p=await self.post_access(actor,id,revision)
            if p['state'] not in EDITABLE: raise ValueError('Сначала верни пост в черновики.')
            if field=='proposal':
                style=json.loads(p['style']);style['proposal']=not style.get('proposal')
                p=self.p.change(p,actor,style=packed(validate_style(style)))
                return await self.style_menu(actor,p)
            self.p.session(actor,{'action':'pstyle','field':field,'post':id,'revision':revision})
            return await self.say(actor,{'signature':'Пришли подпись до 700 символов или - для отключения.',
                'buttons':'Каждая кнопка с новой строки: Название | https://ссылка\nИли - для отключения.',
                'discussion_url':'Пришли ссылку обсуждения или - для отключения.'}[field])
        id,revision=int(parts[1]),int(parts[2]);p=await self.post_access(actor,id,revision)
        if action=='preview': return await self.card(actor,id,True)
        if action=='delivery':
            if actor!=self.app.owner: return await self.say(actor,'Владелец проверит доставку и сможет её восстановить.')
            return await self.say(actor,f"Отправка {p['delivery']}. Проверь канал перед повтором.\n/errors — сведения; /resolve {p['delivery']} sent — пост уже вышел; /resolve {p['delivery']} retry — повтор, если точно не вышел.")
        if action=='undelete':
            if p['state'] not in (*EDITABLE,'scheduled','sent'): raise ValueError('Сейчас нельзя изменить автоудаление.')
            # In-progress removal cannot be revoked as if nothing happened.
            if self.s.rows("SELECT 1 FROM ed_deletions WHERE post=? AND state!='pending'",(id,)):
                raise ValueError('Удаление уже началось. Проверь результат в списке публикаций.')
            with self.s.db:
                self.p.change(p,actor,delete_at=None)
                self.s.db.execute('DELETE FROM ed_deletions WHERE post=?',(id,))
            return await self.card(actor,id)
        if action in ('schedule','delete'): return await self.calendar(actor,p,action)
        if action=='unschedule' and p['state']=='scheduled':
            self.p.change(p,actor,state='draft',publish_at=None)
            return await self.card(actor,id)
        if p['state'] not in EDITABLE: raise ValueError('Этот пост уже отправляется или опубликован.')
        if action=='publish':
            await self.access(actor,p['destination'],publish=True)
            p=self.p.enqueue(p,actor);self.p.session(actor,{})
            return await self.card(actor,p['id'])
        if action=='style': return await self.style_menu(actor,p)
        if action in ('text','replace'):
            self.p.session(actor,{'action':action,'post':id,'revision':revision})
            return await self.say(actor,'Пришли новый текст. Фото и видео останутся.' if action=='text' else 'Пришли новый материал целиком: текст, фото, видео или альбом. Он заменит прежний материал.',[[button('Отмена','open:'+str(id))]])
        if action=='save':
            self.p.change(p,actor,state='draft',creator=actor);self.p.session(actor,{})
            return await self.card(actor,id)
        if action=='discard':
            self.p.change(p,actor,state='cancelled');self.p.session(actor,{})
            return await self.say(actor,'Черновик удалён.',[[button('Меню','home')]])
        raise ValueError('Открой меню заново.')

    async def input(self,actor,message,session):
        action=session.get('action');text=message_text(message)
        if action in ('new','proposal','replace'):
            media=own_media(message)
            if action=='replace':
                p=await self.post_access(actor,session['post'],session['revision'])
                if p['state'] not in EDITABLE: raise ValueError('Сначала верни пост в черновики.')
                if not text.strip() and not media.get('gallery'): raise ValueError('Пришли материал для поста.')
                p=self.p.change(p,actor,text=text,media=packed(normalized(media)))
            else:
                destination=session['destination']
                if action=='new': await self.access(actor,destination)
                p=self.p.new(destination,actor,text,media,origin='proposal' if action=='proposal' else 'own')
            if action=='proposal':
                # Keep proposal mode for the next item, but do not disclose the author's identity in the channel.
                await self.say(actor,'Предложение отправлено на рассмотрение. Спасибо!')
                await self.say(self.app.owner,f"Новая предложка #{p['id']} в «{self.p.channel(p['destination'])['title']}».",[[button('Открыть',f"open:{p['id']}")]])
            else:
                self.p.session(actor,{})
                await self.card(actor,p['id'],True)
            return
        if action=='text':
            p=await self.post_access(actor,session['post'],session['revision'])
            if p['state'] not in EDITABLE: raise ValueError('Сначала верни пост в черновики.')
            if not message.get('text'): raise ValueError('Пришли новый текст обычным сообщением; - убирает подпись под фото.')
            text='' if text.strip()=='-' else text
            self.p.change(p,actor,text=text);self.p.session(actor,{})
            return await self.card(actor,p['id'],True)
        if action=='time':
            p=await self.post_access(actor,session['post'],session['revision'])
            stamp=parse_time(text,self.p.channel(p['destination'])['timezone'])
            self.p.set_time(p,actor,session['mode'],stamp);self.p.session(actor,{})
            return await self.card(actor,p['id'])
        if action in ('config','pstyle'):
            field=session['field']
            if action=='config':
                destination=session['destination'];c=await self.access(actor,destination,owner=True);style=json.loads(c['style'])
            else:
                p=await self.post_access(actor,session['post'],session['revision'])
                if p['state'] not in EDITABLE: raise ValueError('Сначала верни пост в черновики.')
                destination=p['destination'];style=json.loads(p['style'])
            if field in ('signature','buttons','discussion_url'):
                style[field]=parse_buttons(text) if field=='buttons' else '' if text.strip()=='-' else text.strip()
                style=validate_style(style)
                if action=='config': self.s.run('UPDATE ed_channels SET style=? WHERE destination=?',(packed(style),destination))
                else: self.p.change(p,actor,style=packed(style))
            elif field=='timezone':
                try: ZoneInfo(text.strip())
                except (ValueError,ZoneInfoNotFoundError): raise ValueError('Неизвестный часовой пояс. Например Europe/Moscow.') from None
                self.s.run('UPDATE ed_channels SET timezone=? WHERE destination=?',(text.strip(),destination))
            elif field=='discussion':
                info={}
                if text.strip()!='-':
                    try: target=int(text.strip())
                    except ValueError: raise ValueError('Нужен числовой ID группы, либо - для отключения.') from None
                    if self.s.rows('SELECT 1 FROM destinations WHERE platform=? AND remote=?',(c['platform'],str(target))):
                        raise ValueError('Выбери группу обсуждения, а не канал назначения.')
                    if c['platform']=='tg':
                        group=await self.app.tg('getChat',chat_id=target)
                        if group.get('type') not in ('group','supergroup'): raise ValueError('Нужна группа Telegram.')
                        bot=await self.app.tg('getChatMember',chat_id=target,user_id=self.app.bot_id)
                        if bot.get('status') not in ('administrator','member'): raise ValueError('Добавь бота в группу с правом отправки сообщений.')
                        if group.get('linked_chat_id')==int(c['remote']): raise ValueError('Telegram сам переносит посты в эту связанную группу. Дополнительная копия создала бы дубли. Можно добавить только кнопку обсуждения.')
                    else:
                        group=await self.app.max_api('GET',f'/chats/{target}')
                        if group.get('type')!='chat': raise ValueError('Нужен групповой чат MAX.')
                        await self.app.max_api('GET',f'/chats/{target}/members/me')
                    info={'enabled':True,'target':str(target),'title':group.get('title',str(target))}
                self.s.run('UPDATE ed_channels SET discussion=? WHERE destination=?',(packed(info),destination))
            self.p.audit(actor,destination,'setting:'+field);self.p.session(actor,{})
            return await self.settings(actor,destination) if action=='config' else await self.card(actor,p['id'])
        if action=='grant':
            destination=session['destination'];await self.access(actor,destination,owner=True)
            try: target=int(text.strip())
            except ValueError: raise ValueError('Пришли числовой ID администратора.') from None
            if not self.s.rows('SELECT 1 FROM ed_users WHERE actor=?',(target,)): raise ValueError('Сначала этот пользователь должен открыть бота и нажать /id.')
            if target==self.app.owner: raise ValueError('У владельца уже есть доступ.')
            c=self.p.channel(destination)
            if c['platform']=='tg':
                member=await self.app.tg('getChatMember',chat_id=int(c['remote']),user_id=target)
                if member.get('status')!='creator' and not (member.get('status')=='administrator' and member.get('can_post_messages')):
                    raise ValueError('Сначала дай этому пользователю право публикации в самом Telegram-канале.')
            self.s.run('INSERT INTO ed_admins VALUES(?,?) ON CONFLICT DO NOTHING',(destination,target));self.p.session(actor,{})
            self.p.audit(actor,destination,'grant:'+str(target))
            return await self.callback(actor,f'ed:admins:{destination}')

    async def handle(self,update):
        callback=update.get('callback_query')
        message=callback.get('message',{}) if callback else update.get('message',{})
        user=callback.get('from',{}) if callback else message.get('from',{})
        actor=user.get('id')
        if not actor or message.get('chat',{}).get('type')!='private': return False
        self.s.run('INSERT INTO ed_users(actor,name) VALUES(?,?) ON CONFLICT(actor) DO UPDATE SET name=excluded.name',
                   (actor,(user.get('first_name','')+' '+user.get('last_name','')).strip()[:150]))
        if callback:
            if not callback.get('data','').startswith('ed:'): return False
            try: await self.app.tg('answerCallbackQuery',callback_query_id=callback['id'])
            except Exception: pass
            await self.callback(actor,callback['data']);return True
        text=message.get('text','').strip()
        if text=='/id': await self.say(actor,f'Твой ID: {actor}');return True
        if text.startswith('/start propose_'):
            code=text.split('propose_',1)[1]
            found=self.s.rows('SELECT destination FROM ed_channels WHERE code=?',(code,))
            if not found: raise ValueError('Ссылка предложки устарела.')
            destination=found[0]['destination'];self.p.session(actor,{'action':'proposal','destination':destination})
            await self.say(actor,'Предложка канала «'+self.p.channel(destination)['title']+'».\nПришли текст, фото, видео или один альбом. Редактор проверит материал перед публикацией.');return True
        if text in ('Постинг','/menu','/posting') or (text.startswith('/start') and actor!=self.app.owner):
            await self.home(actor);return True
        if text in ('/cancel','Отмена') and self.p.session(actor):
            await self.home(actor);return True
        if actor==self.app.owner and (text.startswith('/') or text in {'Добавить источник','Добавить назначение','Связать','Мои настройки','Режим публикации','Пауза','Продолжить','Помощь','Проверить канал'}):
            self.p.session(actor,{})
            return False
        session=self.p.session(actor)
        if session and not text.startswith('/'):
            if message.get('media_group_id') and session.get('action') in ('new','proposal','replace'):
                self.s.run('INSERT INTO ed_albums VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',
                    (actor,str(message['media_group_id']),message['message_id'],packed(message),packed(session),time.time()))
            else: await self.input(actor,message,session)
            return True
        if actor!=self.app.owner:
            await self.home(actor);return True
        return False

    async def flush_albums(self):
        for group in self.s.rows('SELECT actor,album,MAX(received) last FROM ed_albums GROUP BY actor,album HAVING MAX(received)<?',(time.time()-2,)):
            rows=self.s.rows('SELECT * FROM ed_albums WHERE actor=? AND album=? ORDER BY message',(group['actor'],group['album']))
            session=json.loads(rows[0]['session']);actor=group['actor']
            # A cancelled or replaced compose session cannot unexpectedly create a post.
            if self.p.session(actor)!=session:
                self.s.run('DELETE FROM ed_albums WHERE actor=? AND album=?',(actor,group['album']));continue
            try:
                messages=[json.loads(r['body']) for r in rows]
                text='\n'.join(message_text(m) for m in messages if message_text(m))
                media={'photos':[],'unsupported':[],'gallery':[item for m in messages for item in own_media(m)['gallery']]}
                if session['action']=='replace':
                    p=await self.post_access(actor,session['post'],session['revision'])
                    if p['state'] not in EDITABLE: raise ValueError('Пост уже изменён.')
                    with self.s.db:
                        p=self.p.change(p,actor,text=text,media=packed(normalized(media)))
                        self.s.db.execute('DELETE FROM ed_albums WHERE actor=? AND album=?',(actor,group['album']))
                else:
                    if session['action']=='new': await self.access(actor,session['destination'])
                    with self.s.db:
                        p=self.p.new(session['destination'],actor,text,media,origin='proposal' if session['action']=='proposal' else 'own')
                        self.s.db.execute('DELETE FROM ed_albums WHERE actor=? AND album=?',(actor,group['album']))
                if session['action']=='proposal':
                    await self.say(actor,'Альбом отправлен на рассмотрение.')
                    await self.say(self.app.owner,f"Новая предложка #{p['id']} — альбом.",[[button('Открыть',f"open:{p['id']}")]])
                else:
                    self.p.session(actor,{})
                    await self.card(actor,p['id'],True)
            except Exception as exc:
                from app import safe_error
                self.s.run('DELETE FROM ed_albums WHERE actor=? AND album=?',(actor,group['album']))
                await self.say(actor,safe_error(exc)+'\nПришли альбом заново после исправления.')

    async def authorize_delivery(self,delivery):
        rows=self.s.rows('SELECT * FROM ed_posts WHERE delivery=? OR discussion_delivery=?',(delivery['id'],delivery['id']))
        if not rows: raise ValueError('У ручной отправки отсутствует подтверждённый пост.')
        p=dict(rows[0]);await self.access(p['creator'],p['destination'],publish=True)
        if p['delivery']==delivery['id'] and p['state'] in ('failed','unknown') and delivery['status']=='pending':
            self.s.run("UPDATE ed_posts SET state='queued',error='' WHERE id=?",(p['id'],))
            p['state']='queued'
        if p['delivery']==delivery['id'] and p['state']!='queued': raise ValueError('Пост больше не ожидает публикации.')
        return p

    async def tick(self):
        await self.flush_albums()
        if self.s.get('paused')=='1': return
        now=time.time()
        for row in self.s.rows("SELECT * FROM ed_posts WHERE state='scheduled' AND publish_at<=? ORDER BY publish_at LIMIT 10",(now,)):
            p=dict(row)
            try:
                if now-p['publish_at']>300:
                    raise ValueError('Сервер проснулся после времени публикации. Проверь пост и назначь новое время.')
                await self.access(p['creator'],p['destination'],publish=True)
                self.p.enqueue(p,p['creator'])
            except Exception as exc:
                from app import safe_error
                self.p.change(p,p['creator'],state='held',error=safe_error(exc))
                await self.say(p['creator'],f"Пост #{p['id']} сохранён для проверки: "+safe_error(exc),[[button('Открыть',f"open:{p['id']}")]])
        for row in self.s.rows("SELECT e.*,d.status delivery_state,d.error delivery_error FROM ed_posts e JOIN deliveries d ON d.id=e.delivery WHERE e.state IN ('queued','unknown','failed')"):
            p=dict(row);state=p['delivery_state']
            if state in ('sent','failed','unknown','cancelled'):
                stamp=time.time() if state=='sent' else p['sent_at']
                self.s.run('UPDATE ed_posts SET state=?,sent_at=?,error=? WHERE id=?',(state,stamp,p['delivery_error'],p['id']))
                if p['notified']!=state:
                    self.s.run('UPDATE ed_posts SET notified=? WHERE id=?',(state,p['id']))
                    await self.say(p['creator'],f"Пост #{p['id']}: {LABELS.get(state,state)}.",[[button('Открыть',f"open:{p['id']}")]])
            elif state=='pending' and p['state'] in ('unknown','failed'):
                self.s.run("UPDATE ed_posts SET state='queued',error='' WHERE id=?",(p['id'],))
        await self.discussion_copies()
        await self.delete_due()
        self.s.run('DELETE FROM ed_calendar WHERE expires<?',(now-86400,))
        self.s.run("DELETE FROM tg_inbox WHERE status='done' AND created_at<?",(now-7*86400,))

    async def discussion_copies(self):
        for row in self.s.rows("SELECT * FROM ed_posts WHERE state='sent' AND discussion_done=0"):
            p=dict(row);c=self.p.channel(p['destination']);config=json.loads(p['discussion_config'])
            # Discussion settings were snapshotted when the draft was created.
            if not config.get('enabled'):
                self.s.run('UPDATE ed_posts SET discussion_done=1 WHERE id=?',(p['id'],))
                continue
            try:
                await self.access(p['creator'],p['destination'],publish=True)
            except Exception:
                self.s.run("UPDATE ed_posts SET discussion_done=1,error='Копия в группу отменена: проверь права редактора.' WHERE id=?",(p['id'],))
                continue
            # Destination rows remain channels only: a copy uses an explicit target override on its parts.
            with self.s.db:
                original=self.s.rows('SELECT p.* FROM posts p JOIN deliveries d ON d.post=p.id WHERE d.id=?',(p['delivery'],))[0]
                record=self.s.db.execute("INSERT INTO posts(source,original,url,rewritten,status,media) VALUES(NULL,?,'',?,'ready',?)",(original['original'],original['rewritten'],original['media']))
                delivery=self.s.db.execute("INSERT INTO deliveries(post,destination,mode) VALUES(?,?,'original')",(record.lastrowid,p['destination']))
                from media import publication_parts
                for index,part in enumerate(publication_parts(c['platform'],original['original'],original['media'])):
                    part['discussion_target']=config['target']
                    self.s.db.execute('INSERT INTO delivery_parts(delivery,part,payload) VALUES(?,?,?)',(delivery.lastrowid,index,packed(part)))
                self.s.db.execute('UPDATE ed_posts SET discussion_delivery=?,discussion_done=1 WHERE id=?',(delivery.lastrowid,p['id']))

    async def delete_due(self):
        for row in self.s.rows("SELECT * FROM ed_posts WHERE state='sent' AND delete_at IS NOT NULL AND delete_at<=?",(time.time(),)):
            p=dict(row);c=self.p.channel(p['destination'])
            try:
                await self.access(p['creator'],p['destination'],publish=True)
                sent_parts=self.s.rows("SELECT remote FROM delivery_parts WHERE delivery=? AND status='sent'",(p['delivery'],))
                for part in sent_parts:
                    for remote in json.loads(part['remote']):
                        self.s.run('INSERT INTO ed_deletions(post,remote) VALUES(?,?) ON CONFLICT DO NOTHING',(p['id'],remote))
                jobs=self.s.rows('SELECT * FROM ed_deletions WHERE post=? ORDER BY id',(p['id'],))
                for job in jobs:
                    if job['state'] not in ('pending','retry') or job['next_try']>time.time(): continue
                    self.s.run("UPDATE ed_deletions SET state='sending',tries=tries+1 WHERE id=?",(job['id'],))
                    try:
                        if c['platform']=='tg':
                            result=await self.app.tg('deleteMessage',chat_id=int(c['remote']),message_id=int(job['remote']))
                            if result is not True: raise RuntimeError('Deletion not confirmed')
                        else:
                            result=await self.app.max_api('DELETE','/messages',params={'message_id':job['remote']})
                            if result.get('success') is not True: raise RuntimeError('Deletion not confirmed')
                        self.s.run("UPDATE ed_deletions SET state='done',error='' WHERE id=?",(job['id'],))
                    except Exception as exc:
                        from app import APIError,safe_error
                        # A network break may follow a successful deletion. Never call it success or retry blindly.
                        retry=isinstance(exc,APIError) and exc.code==429 and job['tries']<8
                        self.s.run('UPDATE ed_deletions SET state=?,error=?,next_try=? WHERE id=?',
                            ('retry' if retry else 'unknown',safe_error(exc),time.time()+max(30,getattr(exc,'retry_after',60)),job['id']))
                pending=self.s.rows("SELECT state FROM ed_deletions WHERE post=? AND state!='done'",(p['id'],))
                if jobs and not pending:
                    self.s.run("UPDATE ed_posts SET state='deleted',error='',revision=revision+1 WHERE id=?",(p['id'],))
                    await self.say(p['creator'],f"Пост #{p['id']} удалён из канала «{c['title']}».")
                elif any(j['state'] in ('unknown','sending') for j in pending) and p['notified']!='delete_unknown':
                    self.s.run("UPDATE ed_posts SET error='Не удалось подтвердить удаление. Проверь канал.',notified='delete_unknown' WHERE id=?",(p['id'],))
                    await self.say(p['creator'],f"Проверь удаление поста #{p['id']}: ответ площадки не подтверждён.")
            except Exception as exc:
                from app import safe_error
                if p['notified']!='delete_error':
                    self.s.run("UPDATE ed_posts SET error=?,notified='delete_error' WHERE id=?",(safe_error(exc),p['id']))
                    await self.say(p['creator'],f"Автоудаление #{p['id']} приостановлено: "+safe_error(exc))

    async def loop(self):
        while True:
            try: await self.tick()
            except Exception: print('Сбой редактора: очередь сохранена, повтор через 2 секунды.',flush=True)
            await asyncio.sleep(2)


def normalized(media):
    from media import normal_media
    return normal_media(media)
