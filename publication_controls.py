"""Edit confirmed Telegram publications with a durable operation record."""
import json
import secrets
import time
from posting import packed, message_text, styled, manual_plan


def schema(s):
    s.db.executescript('''CREATE TABLE IF NOT EXISTS ed_publication_edits(
      nonce TEXT PRIMARY KEY,post INTEGER NOT NULL REFERENCES ed_posts(id),actor INTEGER NOT NULL,
      text TEXT NOT NULL,state TEXT NOT NULL,created_at REAL NOT NULL,error TEXT NOT NULL DEFAULT '');
      CREATE UNIQUE INDEX IF NOT EXISTS ed_edit_active ON ed_publication_edits(post) WHERE state='sending';''')


class PublicationControls:
    def __init__(self,e):self.e,self.s,self.p=e,e.s,e.p

    async def recovery(self,actor,id,revision,decision=None):
        p=await self.e.post_access(actor,id,revision)
        if p['state'] not in ('failed','unknown') or not p['delivery']:raise ValueError('Отправка больше не требует проверки.')
        parts=self.s.rows('SELECT status,remote FROM delivery_parts WHERE delivery=?',(p['delivery'],))
        sent=sum(r['status']=='sent' for r in parts)
        if decision is None:
            suffix=f"{id}:{revision}"
            return await self.e.say(actor,f'Подтверждено частей: {sent} из {len(parts)}.\nСначала проверь канал. Если результат неизвестен, повтор может создать дубль. Уже подтверждённые части повторяться не будут.',
              [[{'text':'Проверено: недостающих частей в канале нет — повторить','callback_data':'ed:recoverretry:'+suffix}],
               [{'text':'Завершить без повторной отправки','callback_data':'ed:recovercancel:'+suffix}]])
        await self.e.access(actor,p['destination'],publish=True)
        if decision=='retry':self.p.subscriptions.require_publication(p['destination'])
        with self.s.db:
            row=self.s.rows('SELECT status FROM deliveries WHERE id=?',(p['delivery'],))[0]
            if row['status'] not in ('unknown','failed'):raise ValueError('Состояние уже изменилось. Обнови карточку.')
            self.p.change(p,actor,state='queued' if decision=='retry' else 'cancelled',error='')
            self.s.db.execute('UPDATE deliveries SET status=?,error=?,next_try=0 WHERE id=?',
                ('pending' if decision=='retry' else 'cancelled','' if decision=='retry' else 'Завершено пользователем без повтора',p['delivery']))
            if decision=='retry':self.s.db.execute("UPDATE delivery_parts SET status='pending' WHERE delivery=? AND status IN ('unknown','failed','pending')",(p['delivery'],))
            self.p.audit(actor,p['destination'],'delivery_'+decision,id)
        return await self.e.card(actor,id)

    async def start(self,actor,id,revision):
        p=await self.e.post_access(actor,id,revision)
        if p['state']!='sent' or self.p.channel(p['destination'])['platform']!='tg':raise ValueError('Выбери опубликованный Telegram-пост.')
        self.p.session(actor,{'action':'published_text','post':id,'revision':revision,'nonce':secrets.token_hex(16)})
        await self.e.say(actor,'Пришли новый текст или подпись. Видео и фотографии останутся. Перед изменением будет предпросмотр.')

    def plan(self,p,text):
        c=self.p.channel(p['destination']);text,buttons=styled(text,json.loads(p['style']),'https://t.me/EveryPost_bot?start=propose_'+c['code'])
        plan=manual_plan('tg',text,p['media'],buttons)
        parts=self.s.rows('SELECT * FROM delivery_parts WHERE delivery=? ORDER BY part',(p['delivery'],))
        if len(plan)!=len(parts) or any(r['status']!='sent' for r in parts):raise ValueError('Изменение числа сообщений невозможно. Сохрани прежнюю длину текста и кнопки.')
        operations=[]
        for desired,row in zip(plan,parts):
            old=json.loads(row['payload']);ids=json.loads(row['remote'] or '[]')
            if old['kind']!=desired['kind'] or not ids:raise ValueError('Формат отправленного поста изменился.')
            if desired['kind']=='text':
                operations.append(('editMessageText',{'chat_id':int(c['remote']),'message_id':int(ids[0]),'text':desired['text'],'link_preview_options':{'is_disabled':True}},row['part'],desired))
            else:
                operations.append(('editMessageCaption',{'chat_id':int(c['remote']),'message_id':int(ids[0]),'caption':desired.get('caption','')},row['part'],desired))
            if desired.get('buttons'):operations[-1][1]['reply_markup']={'inline_keyboard':[[b] for b in desired['buttons']]}
        return operations

    async def input(self,actor,message,session):
        p=await self.e.post_access(actor,session['post'],session['revision']);text=message_text(message)
        if len(text)>30000:raise ValueError('Текст слишком длинный.')
        self.plan(p,text)
        session={**session,'text':text};self.p.session(actor,session)
        await self.e.say(actor,'Новая версия:\n'+text[:3000],[[{'text':'Применить изменение','callback_data':'ed:pubapply:'+session['nonce']}],[{'text':'Отмена','callback_data':'ed:open:'+str(p['id'])}]])

    async def apply(self,actor,nonce):
        f=self.p.session(actor)
        existing=self.s.rows('SELECT * FROM ed_publication_edits WHERE nonce=? AND actor=?',(nonce,actor))
        if existing:return await self.e.say(actor,'Состояние изменения: '+existing[0]['state']+'. '+existing[0]['error'])
        if f.get('action')!='published_text' or f.get('nonce')!=nonce or 'text' not in f:raise ValueError('Правка устарела.')
        p=await self.e.post_access(actor,f['post'],f['revision']);await self.e.access(actor,p['destination'],publish=True)
        if p['state']!='sent':raise ValueError('Пост больше не опубликован.')
        operations=self.plan(p,f['text'])
        with self.s.db:
            self.p.change(p,actor,state='sent')  # Reserve revision before contacting Telegram.
            self.s.db.execute('INSERT INTO ed_publication_edits VALUES(?,?,?,?,?,?,?)',(nonce,p['id'],actor,f['text'],'sending',time.time(),''))
        try:
            for method,payload,part,desired in operations:
                try:await self.e.app.tg(method,**payload)
                except Exception as exc:
                    if 'message is not modified' not in str(exc).lower():raise
                self.s.run('UPDATE delivery_parts SET payload=? WHERE delivery=? AND part=?',(packed(desired),p['delivery'],part))
            with self.s.db:
                self.s.db.execute('UPDATE ed_posts SET text=? WHERE id=?',(f['text'],p['id']))
                full,_=styled(f['text'],json.loads(p['style']),'https://t.me/EveryPost_bot?start=propose_'+self.p.channel(p['destination'])['code'])
                self.s.db.execute('UPDATE posts SET original=?,rewritten=? WHERE id=(SELECT post FROM deliveries WHERE id=?)',(full,full,p['delivery']))
                self.s.db.execute("UPDATE ed_publication_edits SET state='done' WHERE nonce=?",(nonce,))
                self.p.session(actor,{})
            return await self.e.card(actor,p['id'])
        except Exception:
            self.s.run("UPDATE ed_publication_edits SET state='unknown',error='Проверь текст в канале: ответ Telegram не подтверждён. Автоматический повтор отключён.' WHERE nonce=?",(nonce,))
            raise ValueError('Изменение не подтверждено. Проверь текст в канале перед новой правкой.')
