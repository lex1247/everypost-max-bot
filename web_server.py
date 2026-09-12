"""Free Render web service, durable webhook and authenticated calendar."""
import asyncio
import hashlib
import hmac
import json
import os
import secrets
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import urlparse
from aiohttp import web
from posting import validated_user, packed, parse_time
from database import Postgres


def webhook_secret():
    return hmac.new(os.environ['TG_BOT_TOKEN'].encode(), b'EveryPost Telegram webhook v1', hashlib.sha256).hexdigest()


async def calendar_action(editor, action, body):
    actor = validated_user(body.get('initData'), os.environ['TG_BOT_TOKEN'])
    nonce = body.get('nonce')
    if not isinstance(nonce, str) or len(nonce)>100:
        raise ValueError('Открой календарь заново из бота.')
    rows = editor.s.rows('SELECT * FROM ed_calendar WHERE nonce=? AND actor=?', (nonce, actor))
    if not rows or rows[0]['expires'] < time.time():
        raise ValueError('Выбор времени истёк. Открой календарь заново.')
    session = dict(rows[0])
    if body.get('mode') != session['mode']:
        raise ValueError('Некорректный режим календаря.')
    # Recheck access even when returning a receipt after an uncertain HTTP response.
    post = await editor.post_access(actor, session['post'])
    # Another request may finish while channel rights were being checked.
    current = editor.s.rows('SELECT receipt FROM ed_calendar WHERE nonce=?', (nonce,))[0]['receipt']
    if current:
        return json.loads(current)
    post = editor.p.post(session['post'])
    if post['revision'] != session['revision']:
        raise ValueError('Пост уже изменён. Открой календарь заново.')
    channel=editor.p.channel(post['destination'])
    from zoneinfo import ZoneInfo
    zone=ZoneInfo(channel['timezone']); now=time.time()
    label=lambda at:datetime.fromtimestamp(at,zone).strftime('%d.%m.%Y %H:%M') if at else ''
    if action=='state':
        initial=post['delete_at'] if session['mode']=='delete' else post['publish_at']
        start=post['sent_at'] or post['publish_at'] or now
        default=max(now+600,start+3600) if session['mode']=='delete' else now+600
        dt=datetime.fromtimestamp(initial if initial and initial>now else default,zone)
        max_stamp=(start+47*3600-60) if session['mode']=='delete' and channel['platform']=='tg' else now+366*86400
        return {'ok':True,'state':'editing','nonce':nonce,'mode':session['mode'],'timezone':channel['timezone'],
                'today':datetime.fromtimestamp(now,zone).strftime('%Y%m%d'),
                'maxDay':datetime.fromtimestamp(max_stamp,zone).strftime('%Y%m%d'),
                'day':dt.strftime('%Y%m%d'),'hour':dt.hour,'minute':dt.minute,'serverNow':int(now*1000),
                'title':channel['title'],'postId':post['id'],'zoneLabel':channel['timezone'],
                'rescheduling':post['state']=='scheduled','canDisable':bool(post['delete_at']),
                'minAt':datetime.fromtimestamp(max(now+60,start+60),timezone.utc).isoformat() if session['mode']=='delete' else None,
                'maxPublishAt':datetime.fromtimestamp(post['delete_at']-60,timezone.utc).isoformat() if post['delete_at'] else None,
                'maxDeleteAt':datetime.fromtimestamp(max_stamp,timezone.utc).isoformat(),
                'publicationLabel':label(start),'currentDeletionLabel':('Автоудаление: '+label(post['delete_at'])) if post['delete_at'] else ''}
    result={'ok':True,'state':'saved','mode':session['mode'],'title':channel['title'],'zoneLabel':channel['timezone']}
    with editor.s.db:
        if action=='save':
            day=body.get('day','');hour=body.get('hour');minute=body.get('minute')
            if not isinstance(day,str) or len(day)!=8 or not day.isdigit() or type(hour) is not int or type(minute) is not int or not (0<=hour<=23 and 0<=minute<=59):
                raise ValueError('Проверь дату и время.')
            stamp=parse_time(day[6:8]+'.'+day[4:6]+'.'+day[:4]+f' {hour:02d}:{minute:02d}',channel['timezone'])
            editor.p.set_time(post,actor,session['mode'],stamp)
            result['label']=label(stamp)
        elif action=='disable' and session['mode']=='delete':
            if editor.s.rows("SELECT 1 FROM ed_deletions WHERE post=? AND state!='pending'",(post['id'],)):
                raise ValueError('Удаление уже началось. Проверь публикацию в боте.')
            editor.p.change(post,actor,delete_at=None)
            editor.s.db.execute('DELETE FROM ed_deletions WHERE post=?',(post['id'],))
            result.update(disabled=True,label='Автоудаление отключено')
        elif action=='cancel':
            result.update(state='cancelled',message='Расписание не изменено.')
        else:
            raise ValueError('Неизвестное действие календаря.')
        editor.s.db.execute('UPDATE ed_calendar SET receipt=? WHERE nonce=? AND receipt=?',(packed(result),nonce,''))
        editor.p.session(actor,{})
    return result


def create_web(app):
    server=web.Application(client_max_size=2*1024*1024)
    async def health(request):
        # A standby revision is healthy; the old revision can release the worker lock during cutover.
        app.s.rows('SELECT 1')
        return web.json_response({'ok':True,'service':'EveryPost Telegram','worker':bool(getattr(app,'worker_ready',False))})
    async def webhook(request):
        supplied=request.headers.get('X-Telegram-Bot-Api-Secret-Token','')
        if not hmac.compare_digest(supplied,webhook_secret()):
            return web.json_response({'ok':False},status=403)
        try:
            data=await request.json()
            app.accept_update(data)
        except (ValueError,TypeError,AttributeError):
            return web.json_response({'ok':False},status=400)
        return web.json_response({'ok':True})
    async def calendar(request):
        nonce=secrets.token_urlsafe(24)
        root=Path(__file__).parent
        template=root/'static'/'calendar.html'
        if not template.exists():
            template=root/'calendar.html'
        content=template.read_text().replace('__CSP_NONCE__',nonce)
        return web.Response(text=content,content_type='text/html',headers={
            'Content-Security-Policy':f"default-src 'none'; script-src 'nonce-{nonce}' https://telegram.org; style-src 'nonce-{nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors https://web.telegram.org https://webk.telegram.org https://webz.telegram.org;",
            'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'})
    async def calendar_api(request):
        try:
            result=await calendar_action(app.editor,request.match_info['action'],await request.json())
            return web.json_response(result,headers={'Cache-Control':'no-store'})
        except (ValueError,KeyError,TypeError) as exc:
            from app import safe_error
            return web.json_response({'ok':False,'message':safe_error(exc)},status=400)
        except Exception:
            return web.json_response({'ok':False,'message':'Не удалось подтвердить изменение. Повтори эту же операцию.'},status=503)
    async def import_seed(request):
        token=os.getenv('MIGRATION_TOKEN','')
        if len(token)<32 or not hmac.compare_digest(request.headers.get('Authorization',''),'Bearer '+token):
            return web.json_response({'ok':False},status=403)
        if app.s.get('migration_done') or app.s.get('activated')=='1':
            return web.json_response({'ok':False,'message':'Migration already completed'},status=409)
        try:
            from migration import import_data
            counts=import_data(app.s,await request.json())
            app.editor.p.sync_channels()
            return web.json_response({'ok':True,'counts':counts})
        except Exception:
            return web.json_response({'ok':False,'message':'Migration failed; no data imported'},status=400)
    async def activate(request):
        token=os.getenv('MIGRATION_TOKEN','')
        if len(token)<32 or not hmac.compare_digest(request.headers.get('Authorization',''),'Bearer '+token):
            return web.json_response({'ok':False},status=403)
        if not app.s.get('migration_done'):
            return web.json_response({'ok':False,'message':'Import state before activating'},status=409)
        # This endpoint authorizes this already configured TG bot only; it cannot change credentials or MAX webhook.
        app.s.set('activated','1')
        return web.json_response({'ok':True})
    server.add_routes([web.get('/',health),web.get('/health',health),web.post('/telegram/webhook',webhook),
                       web.get('/calendar',calendar),web.post('/calendar/api/{action}',calendar_api),
                       web.post('/migration/import',import_seed),web.post('/migration/activate',activate)])
    return server


async def serve(app):
    runner=web.AppRunner(create_web(app),access_log=None)
    await runner.setup()
    site=web.TCPSite(runner,'0.0.0.0',int(os.getenv('PORT','8080')))
    await site.start()
    print('HTTP ready. PostgreSQL state preserved.',flush=True)
    try:
        while True: await asyncio.sleep(30)
    finally:
        await runner.cleanup()


async def cloud_worker(app):
    from runtime import supervise
    if not isinstance(app.s.db,Postgres):
        raise RuntimeError('Render web mode requires PostgreSQL')
    while not app.s.db.claim_worker():
        await asyncio.sleep(2)
    app.s.recover()
    app.s.run("UPDATE tg_inbox SET status='unknown',error='Перезапуск во время обработки. Повтори действие после проверки.' WHERE status='processing'")
    app.s.run("UPDATE ed_deletions SET state='unknown',error='Перезапуск во время удаления' WHERE state='sending'")
    while os.getenv('REQUIRE_MIGRATION')=='1' and app.s.get('activated')!='1':
        await asyncio.sleep(1)
    base=os.getenv('PUBLIC_URL',os.getenv('RENDER_EXTERNAL_URL','')).rstrip('/')
    url=urlparse(base)
    if url.scheme!='https' or not url.hostname or url.path or url.query or url.fragment or url.username:
        raise RuntimeError('Configure PUBLIC_URL with the public HTTPS service origin')
    await app.tg('setWebhook',url=base+'/telegram/webhook',secret_token=webhook_secret(),
                 allowed_updates=['message','callback_query'],drop_pending_updates=False)
    app.worker_ready=True
    if app.s.get('posting_version')!='1':
        await app.notify('EveryPost работает на Render. Нажми «Постинг»: свои посты, черновики, предложка, календарь и оформление.\nБесплатный сервер может засыпать. Просроченные более чем на 5 минут публикации попадут в черновики для проверки.')
        app.s.set('posting_version','1')
    print('Telegram webhook ready. Posting worker active.',flush=True)
    # The outer supervisor handles process signals and closes this connection after cancelling all workers.
    jobs=[asyncio.create_task(c) for c in (app.inbox_loop(),app.editor.loop(),app.collect(),app.rewrite_queue(),app.publish())]
    try:
        done,_=await asyncio.wait(jobs,return_when=asyncio.FIRST_COMPLETED)
        for job in done: job.result()
        raise RuntimeError('Worker exited')
    finally:
        for job in jobs: job.cancel()
        await asyncio.gather(*jobs,return_exceptions=True)
