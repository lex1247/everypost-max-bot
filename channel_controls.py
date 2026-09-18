"""Channel owners' editor rights, notification preferences and audit history."""
from datetime import datetime
from zoneinfo import ZoneInfo


def schema(s):
    s.db.executescript('''CREATE TABLE IF NOT EXISTS ed_editor_rights(
      destination INTEGER NOT NULL REFERENCES destinations(id), actor INTEGER NOT NULL,
      can_create INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(destination,actor));
      CREATE INDEX IF NOT EXISTS ed_audit_channel_time ON ed_audit(destination,created_at,event);''')


def b(text, value):
    return {'text': text, 'callback_data': 'ed:channelctl:'+value}


def action_label(action):
    kind, _, detail = action.partition(':')
    labels = {'connect':'Подключён канал', 'create':'Создан пост', 'enqueue':'Передан в очередь',
        'sent':'Опубликован', 'failed':'Ошибка отправки', 'unknown':'Отправка не подтверждена',
        'cancelled':'Отправка отменена', 'deleted':'Удалён из канала',
        'grant':'Добавлен редактор', 'revoke':'Отозван доступ редактора',
        'allow_posts':'Разрешены свои посты редактору', 'deny_posts':'Запрещены свои посты редактору',
        'delivery_retry':'Повтор неотправленных частей', 'delivery_cancel':'Завершение без повтора',
        'subscription_resume':'Возобновление после продления', 'subscription_draft':'Возврат в черновики',
        'publication_edit':'Изменён опубликованный текст', 'publication_edit_unknown':'Правка не подтверждена'}
    if kind in ('grant','revoke','allow_posts','deny_posts'):
        return labels[kind]+' · ID '+detail
    if kind == 'notifications':
        return 'Обычные уведомления '+('включены' if detail == '1' else 'выключены')
    if kind == 'setting':
        return 'Настройка: '+{'signature':'подпись','buttons':'кнопки','proposal':'предложка',
            'timezone':'часовой пояс','discussion_url':'ссылка обсуждения','discussion':'копии в группу'}.get(detail,'оформление')
    if kind == 'change':
        fields = {'text':'текст','media':'медиа','style':'оформление','state':'статус',
            'publish_at':'дата публикации','delete_at':'автоудаление','creator':'редактор','error':'результат проверки'}
        return 'Изменено: '+', '.join(fields[x] for x in detail.split(',') if x in fields)
    return labels.get(kind, 'Изменение поста или настроек')


class ChannelControls:
    def __init__(self, editor):
        self.e, self.s, self.p = editor, editor.s, editor.p

    def rights(self, destination, actor):
        rows = self.s.rows('SELECT * FROM ed_editor_rights WHERE destination=? AND actor=?', (destination,actor))
        # Existing grants keep their access. New grants explicitly start as moderators.
        return dict(rows[0]) if rows else {'can_create':1, 'revision':0}

    def notify_enabled(self, actor, destination):
        return self.s.get(f'channel_notifications:{destination}:{actor}', '1') != '0'

    async def notify(self, actor, destination, text, rows=None, *, critical=False):
        # Only owners have this preference. Never suppress a direct UI response or an error.
        if critical or not self.e.is_owner(actor,destination) or self.notify_enabled(actor,destination):
            return await self.e.say(actor,text,rows)

    async def editors(self, actor, destination):
        await self.e.access(actor,destination,owner=True)
        admins = self.s.rows('SELECT a.actor,u.name FROM ed_admins a LEFT JOIN ed_users u ON u.actor=a.actor WHERE destination=? ORDER BY a.actor', (destination,))
        rows = [[b((a['name'] or str(a['actor']))[:30]+' · '+('свои посты ✓' if self.rights(destination,a['actor'])['can_create'] else 'предложки'),
            f"editor:{destination}:{a['actor']}")] for a in admins if not self.e.is_owner(a['actor'],destination)]
        rows += [[{'text':'Добавить редактора','callback_data':f'ed:grant:{destination}'}],
                 [{'text':'← Настройки','callback_data':f'ed:channel:settings:{destination}'}]]
        return await self.e.say(actor,'Редакторы канала. Новый редактор работает с предложками; свои посты разрешает владелец. В Telegram также нужны права на публикацию.',rows)

    async def editor(self, actor, destination, target):
        await self.e.access(actor,destination,owner=True)
        if self.e.is_owner(target,destination) or not self.s.rows('SELECT 1 FROM ed_admins WHERE destination=? AND actor=?',(destination,target)):
            raise ValueError('Редактор больше не имеет доступа. Открой список заново.')
        r = self.rights(destination,target)
        return await self.e.say(actor,f"Редактор · ID {target}\nПредложки: доступны\nСвои посты: "+('разрешены' if r['can_create'] else 'запрещены'),
            [[b('Запретить свои посты' if r['can_create'] else 'Разрешить свои посты',f"rights:{destination}:{target}:{1-int(r['can_create'])}:{r['revision']}")],
             [{'text':'Отозвать доступ','callback_data':f'ed:revoke:{destination}:{target}'}],
             [{'text':'← Редакторы','callback_data':f'ed:admins:{destination}'}]])

    async def history(self, actor, destination, page=0):
        c = await self.e.access(actor,destination,owner=True)
        page = max(0,min(10000,page))
        events = self.s.rows('''SELECT a.*,u.name FROM ed_audit a LEFT JOIN ed_users u ON u.actor=a.actor
            WHERE a.destination=? ORDER BY a.created_at DESC,a.event DESC LIMIT 11 OFFSET ?''',(destination,page*10))
        lines = [c['title']+' · История действий', 'Время: '+c['timezone']]
        for event in events[:10]:
            stamp = datetime.fromtimestamp(event['created_at'],ZoneInfo(c['timezone'])).strftime('%d.%m %H:%M')
            who = (event['name'] or str(event['actor']))[:50].replace('\n',' ')
            post = f" · пост #{event['post']}" if event['post'] else ''
            lines.append(f"{stamp} · {who}\n{action_label(event['action'])}{post}")
        if not events: lines.append('Пока нет записей.')
        pages = ([b('← Назад',f'history:{destination}:{page-1}')] if page else [])
        if len(events)>10: pages.append(b('Дальше →',f'history:{destination}:{page+1}'))
        rows = [pages] if pages else []
        rows.append([{'text':'← Настройки','callback_data':f'ed:channel:settings:{destination}'}])
        return await self.e.say(actor,'\n\n'.join(lines),rows)

    async def notifications(self, actor, destination):
        await self.e.access(actor,destination,owner=True)
        enabled = self.notify_enabled(actor,destination)
        return await self.e.say(actor,'Уведомления тебе по этому каналу\n\nПредложки, успешная публикация и автоудаление: '+('включены' if enabled else 'выключены')+
            '.\nОшибки, задержки и неподтверждённые отправки приходят всегда. Сообщения в ответ на твои действия остаются.',
            [[b('Выключить обычные уведомления' if enabled else 'Включить обычные уведомления',f'notify:{destination}:{0 if enabled else 1}')],
             [{'text':'← Настройки','callback_data':f'ed:channel:settings:{destination}'}]])

    async def callback(self, actor, parts):
        action, destination = parts[0], int(parts[1])
        if action == 'history': return await self.history(actor,destination,int(parts[2]))
        if action == 'notifications': return await self.notifications(actor,destination)
        if action == 'editor': return await self.editor(actor,destination,int(parts[2]))
        await self.e.access(actor,destination,owner=True)
        if action == 'notify':
            value = parts[2]
            if value not in ('0','1'): raise ValueError('Некорректная настройка.')
            with self.s.db:
                if self.notify_enabled(actor,destination) != (value == '1'):
                    self.s.set(f'channel_notifications:{destination}:{actor}',value)
                    self.p.audit(actor,destination,'notifications:'+value)
            return await self.notifications(actor,destination)
        if action == 'rights':
            target, enabled, revision = map(int,parts[2:5])
            if enabled not in (0,1) or self.e.is_owner(target,destination): raise ValueError('Некорректные права редактора.')
            with self.s.db:
                if not self.s.rows('SELECT 1 FROM ed_admins WHERE destination=? AND actor=?',(destination,target)):
                    raise ValueError('Доступ редактора уже отозван.')
                if self.rights(destination,target)['revision'] != revision:
                    raise ValueError('Права уже изменились. Открой редактора заново.')
                if revision == 0:
                    changed = self.s.db.execute('INSERT INTO ed_editor_rights(destination,actor,can_create) VALUES(?,?,?) ON CONFLICT DO NOTHING',(destination,target,enabled))
                else:
                    changed = self.s.db.execute('UPDATE ed_editor_rights SET can_create=?,revision=revision+1 WHERE destination=? AND actor=? AND revision=?',(enabled,destination,target,revision))
                if not changed.rowcount: raise ValueError('Права уже изменились. Открой редактора заново.')
                if not enabled:
                    for raw in self.s.rows("SELECT * FROM ed_posts WHERE destination=? AND creator=? AND origin!='proposal' AND state='scheduled'",(destination,target)):
                        self.p.change(dict(raw),actor,state='held',error='Владелец запретил редактору свои посты. Проверь пост и назначь время.')
                self.p.audit(actor,destination,('allow_posts:' if enabled else 'deny_posts:')+str(target))
            return await self.editor(actor,destination,target)
        raise ValueError('Открой настройки заново.')
