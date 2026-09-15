"""Authenticated preparation API for the MAX UI. Never publishes messages."""
import hashlib
import hmac
import json
import os
import re
import time
from aiohttp import web
from core import source_link
from trustat_source import Trustat, TrustatError
from vk_source import VKSource
from media import normal_media
from local_model import publishing_enabled, RewriteUnavailable


def bridge_key():
    return hmac.new(os.environ['MAX_BOT_TOKEN'].strip().encode(),
                    b'EveryPost MAX crosspost bridge v1', hashlib.sha256).digest()


def authenticate(raw, stamp, signature):
    if not re.fullmatch(r'\d{10}', stamp or '') or abs(time.time()-int(stamp)) > 300:
        return False
    if not re.fullmatch(r'[a-f0-9]{64}', signature or ''):
        return False
    expected = hmac.new(bridge_key(), stamp.encode()+b'.'+raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature or '')


async def action(app, data):
    operation = data.get('action')
    if operation in ('content_fetch', 'content_prepare'):
        from content_source import action as content_action
        return await content_action(app, data)
    if operation in ('vk_resolve','vk_fetch'):
        provider=VKSource(app)
        if operation=='vk_resolve':return await provider.resolve(data.get('source'))
        return await provider.fetch(data.get('source'),data.get('peer'),data.get('cursor'))
    if operation in ('trustat_resolve','trustat_fetch'):
        provider=Trustat(app)
        if operation=='trustat_resolve':return await provider.resolve(data.get('source'))
        return await provider.fetch(data.get('source'),data.get('peer'),data.get('cursor'))
    if operation in ('resolve', 'fetch'):
        platform, username = source_link(data.get('source', ''))
        if platform != 'tg':
            raise ValueError('Пока доступны открытые источники Telegram.')
        if operation == 'resolve':
            page = await app.public_tg.page(username)
            return {'source': username, 'peer': str(page.peer_id), 'title': page.title,
                    'cursor': max(p[0] for p in page.posts)}
        if not re.fullmatch(r'-\d+', str(data.get('peer', ''))) or type(data.get('cursor')) is not int or data['cursor'] < 0:
            raise ValueError('Некорректное состояние источника.')
        posts, cursor = await app.public_tg.since(username, int(data['peer']), data['cursor'], max_pages=5)
        if len(posts) > 100:
            posts = posts[:100]
            cursor = posts[-1][0]
        return {'posts': posts, 'cursor': cursor}
    if operation == 'prepare':
        text, mode = data.get('text'), data.get('mode')
        if not isinstance(text, str) or len(text) > 30000 or mode not in ('original', 'ai'):
            raise ValueError('Некорректный текст или режим обработки.')
        media = normal_media(data.get('media'))
        if media['unsupported']:
            raise ValueError('В источнике есть неподдерживаемое вложение. Материал сохранён для проверки.')
        if len(media['photos'])+len(media.get('gallery',[])) > 12:
            raise ValueError('В материале больше 12 фотографий. Нужна ручная правка.')
        if mode == 'ai' and text.strip():
            if not publishing_enabled():
                raise RewriteUnavailable('ИИ не включён в текущих настройках сервиса.')
            text = await app.rewrite(text)
        if len(text.encode('utf-16-le'))//2 > 4000:
            raise ValueError('Текст длиннее 4000 символов. Материал сохранён целиком.')
        _, body, _ = await app.prepare_part('max', None,
            {'kind': 'max', 'text': text, 'photos': media['photos'], 'items':media.get('gallery',[])})
        return {'body': body}
    raise ValueError('Неизвестное действие кросспостинга.')


def install(server, app):
    async def endpoint(request):
        raw = await request.read()
        if not os.getenv('MAX_BOT_TOKEN') or not authenticate(raw,
                request.headers.get('X-EveryPost-Time'), request.headers.get('X-EveryPost-Signature')):
            return web.json_response({'ok': False}, status=403)
        try:
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise ValueError('Некорректный запрос.')
            result = await action(app, data)
            return web.json_response({'ok': True, **result})
        except TrustatError as exc:
            return web.json_response({'ok':False,'message':str(exc),'pause':exc.pause,'retry_after':exc.retry_after},status=422 if exc.pause else 503)
        except ValueError as exc:
            return web.json_response({'ok': False, 'message': str(exc)[:500]}, status=422)
        except Exception:
            # No credentials, upstream request URLs, or source content in errors.
            return web.json_response({'ok': False, 'message': 'Сервис обработки временно недоступен. Повторите позже.'}, status=503)
    server.router.add_post('/max-crosspost', endpoint)
