"""Telegram-authenticated version of the existing content review screen."""
import os
import secrets
from pathlib import Path
from aiohttp import web
from posting import validated_user


def install(server,app):
    async def page(request):
        nonce=secrets.token_urlsafe(24)
        html=(Path(__file__).parent/'content.html').read_text().replace('__CSP_NONCE__',nonce)
        return web.Response(text=html,content_type='text/html',headers={
          'Content-Security-Policy':f"default-src 'none'; script-src 'nonce-{nonce}' https://telegram.org; style-src 'nonce-{nonce}'; connect-src 'self'; frame-src https://www.tiktok.com; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors https://web.telegram.org https://webk.telegram.org https://webz.telegram.org;",
          'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'})
    async def api(request):
        try:
            body=await request.json()
            if not isinstance(body,dict): raise ValueError('Некорректный запрос.')
            actor=validated_user(body.get('initData'),os.environ['TG_BOT_TOKEN'])
            result=await app.editor.content.api(actor,request.match_info['action'],body)
            return web.json_response({'ok':True,**result},headers={'Cache-Control':'no-store'})
        except (ValueError,KeyError,TypeError) as exc:
            from app import safe_error
            return web.json_response({'ok':False,'message':safe_error(exc)},status=400)
        except Exception:
            return web.json_response({'ok':False,'message':'Ответ задерживается. Обнови подборку перед повтором.'},status=503)
    server.add_routes([web.get('/content',page),web.post('/content/api/{action}',api)])
