"""TikTok adapter for the existing authenticated MAX bridge; never publishes.

Collectors return provider-neutral metadata. Only this adapter knows yt-dlp.
External media is downloaded only after an explicit review decision.
"""
import asyncio
import hashlib
import json
import math
import re
import sys
import tempfile
import time
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urlparse

MAX_BYTES = 50_000_000
# TikTok's download/download_addr formats may carry its moving username watermark.
# Require a playable MP4 with audio; never fall back to a download variant.
CLEAN_FORMAT = ('b[ext=mp4][vcodec~="^(avc|h264)"][acodec!=none]'
                '[format_id!^=download][format_note!*=?watermarked]')
_gate = asyncio.Semaphore(1)
_prepare_gate = asyncio.Semaphore(1)


def source_url(value):
    if not isinstance(value, str) or len(value) > 2048:
        raise ValueError('Нужна ссылка TikTok или @имя.')
    value = value.strip()
    if re.fullmatch(r'@[A-Za-z0-9_.]{1,32}', value):
        value = 'https://www.tiktok.com/' + value
    u = urlparse(value)
    if (u.scheme != 'https' or u.username or u.password or u.port not in (None, 443)
            or u.hostname not in ('www.tiktok.com', 'tiktok.com', 'vt.tiktok.com', 'vm.tiktok.com')):
        raise ValueError('Поддерживается только HTTPS-ссылка TikTok.')
    if u.hostname in ('vt.tiktok.com', 'vm.tiktok.com'):
        if not re.fullmatch(r'/[A-Za-z0-9]+/?', u.path):
            raise ValueError('Некорректная короткая ссылка TikTok.')
        return 'https://' + u.hostname + u.path
    if not re.fullmatch(r'/@[A-Za-z0-9_.]{1,32}(?:/video/[0-9]{10,25})?/?', u.path):
        raise ValueError('Нужна ссылка на аккаунт или ролик TikTok.')
    return 'https://www.tiktok.com' + u.path.rstrip('/')


def number(value):
    return value if type(value) in (int, float) and math.isfinite(value) and value >= 0 else None


def normalize(info, original):
    remote = str(info.get('id', ''))
    profile = re.search(r'/@([A-Za-z0-9_.]{1,32})(?:/|$)', str(info.get('uploader_url', '')))
    author = profile[1] if profile else (info.get('uploader') or info.get('creator') or info.get('uploader_id') or '_')
    author = str(author).lstrip('@')
    if not re.fullmatch(r'[0-9]{10,25}', remote):
        raise ValueError('TikTok не вернул ID видео.')
    if not re.fullmatch(r'[A-Za-z0-9_.]{1,32}', author):
        author = '_'
    stamp = number(info.get('timestamp'))
    published = None
    if stamp is not None:
        try:
            published = datetime.fromtimestamp(stamp, timezone.utc).isoformat()
        except (ValueError, OverflowError, OSError):
            pass
    return {'provider': 'tiktok', 'remote_id': remote, 'original_url': original,
            'canonical_url': f'https://www.tiktok.com/@{author}/video/{remote}',
            'author': author, 'title': str(info.get('description') or info.get('title') or '')[:4000],
            'published_at': published, 'duration': number(info.get('duration')),
            'metrics': {name: number(info.get(key)) for name, key in
                        [('views', 'view_count'), ('likes', 'like_count'),
                         ('comments', 'comment_count'), ('shares', 'repost_count')]}}


async def extract(url):
    """Killable, bounded subprocess; ignore local yt-dlp configuration."""
    url = source_url(url)
    async with _gate:
        proc = await asyncio.create_subprocess_exec(
            sys.executable, '-m', 'yt_dlp', '--ignore-config', '--no-warnings',
            '--quiet', '--skip-download', '--dump-single-json', '--playlist-end', '30',
            '--socket-timeout', '12', '--retries', '1', '--extractor-retries', '1',
            '--', url, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            limit=4_000_000)
        async def read():
            chunks = bytearray()
            while chunk := await proc.stdout.read(65536):
                chunks.extend(chunk)
                if len(chunks) > 4_000_000:
                    raise ValueError('Ответ TikTok слишком большой.')
            await proc.wait()
            return chunks
        try:
            raw = await asyncio.wait_for(read(), 45)
            if proc.returncode:
                raise ValueError('TikTok недоступен с сервера или требует вход. Источник сохранён; повторите позже.')
            return json.loads(raw)
        finally:
            if proc.returncode is None:
                proc.kill()
                await proc.wait()



async def fetch(source):
    url = source_url(source)
    info = await extract(url)
    entries = info.get('entries') if info.get('_type') == 'playlist' else [info]
    if not isinstance(entries, list):
        raise ValueError('TikTok не вернул список роликов.')
    items = [normalize(entry, url) for entry in entries[:30] if isinstance(entry, dict)]
    if not items:
        raise ValueError('TikTok не вернул доступных роликов. Повторите позже.')
    return {'items': items}


async def fingerprint(data, duration):
    """Bounded local decoding; no URLs or credentials reach ffmpeg."""
    from PIL import Image
    import imageio_ffmpeg
    duration = number(duration)
    if not duration or duration < 3 or duration > 300:
        raise ValueError('Для проверки повторов нужна длительность видео от 3 до 300 секунд.')
    with tempfile.TemporaryDirectory(prefix='everypost-frames-') as folder:
        path = Path(folder) / 'input.mp4'
        path.write_bytes(data)
        proc = await asyncio.create_subprocess_exec(
            imageio_ffmpeg.get_ffmpeg_exe(), '-v', 'error', '-nostdin', '-threads', '1',
            '-ss', str(duration / 20), '-i', str(path), '-an', '-sn',
            '-vf', f'fps={8/duration},scale=32:32', '-frames:v', '8',
            '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        try:
            raw, _ = await asyncio.wait_for(proc.communicate(), 25)
        finally:
            if proc.returncode is None:
                proc.kill()
                await proc.wait()
        if proc.returncode or len(raw) != 8 * 32 * 32 * 3:
            raise ValueError('Не удалось прочитать все кадры видео для проверки повторов.')
    frames, colors = [], []
    for offset in range(0, len(raw), 3072):
        im = Image.frombytes('RGB', (32, 32), raw[offset:offset+3072]).crop((4, 4, 28, 28))
        colors.append(list(im.resize((1, 1), Image.Resampling.BOX).getpixel((0, 0))))
        gray = im.convert('L')
        pixels = list(gray.resize((9, 8), Image.Resampling.LANCZOS).getdata())
        dh = sum(int(pixels[y*9+x] > pixels[y*9+x+1]) << (y*8+x) for y in range(8) for x in range(8))
        pixels = list(gray.resize((8, 8), Image.Resampling.LANCZOS).getdata())
        mean = sum(pixels)/64
        ah = sum(int(v > mean) << n for n, v in enumerate(pixels))
        frames.append(f'{dh:016x}{ah:016x}')
    return {'version': 1, 'duration': duration, 'frames': frames, 'colors': colors}


async def inspect(url):
    url = source_url(url)
    if not re.search(r'/video/[0-9]+$', url):
        raise ValueError('Для проверки нужна ссылка на один ролик.')
    info = await extract(url)
    item = normalize(info, url)
    if item['remote_id'] != url.rsplit('/', 1)[-1]:
        raise ValueError('TikTok вернул другой ролик.')
    data = await download(url)
    if data[4:8] != b'ftyp':
        raise ValueError('TikTok не вернул файл MP4.')
    return data, {'content_hash': hashlib.sha256(data).hexdigest(),
                  'fingerprint': await fingerprint(data, item['duration']), 'item': item}


async def prepare(app, url):
    url = source_url(url)
    # Cache successful upload receipts in the existing PostgreSQL-backed store.
    # A retry after a lost HTTP response reuses this receipt and never publishes.
    cache_key = 'content_upload_v2:' + hashlib.sha256(url.encode()).hexdigest()
    async with _prepare_gate:
        cached = app.s.get(cache_key)
        if cached:
            try:
                saved = json.loads(cached)
                if time.time() - saved['at'] < 86400:
                    return saved['result']
            except (ValueError, KeyError, TypeError):
                pass
        data, result = await inspect(url)
        upload = await app.max_api('POST', '/uploads', params={'type': 'video'})
        u = urlparse(upload['url'])
        if u.scheme != 'https' or u.hostname != 'omub.okcdn.ru' or u.username or u.password or u.port not in (None, 443):
            raise ValueError('MAX вернул неподдерживаемый адрес загрузки.')
        client = app.max_http if app.max_http is not None else app.http
        response = await client.post(upload['url'], files={'data': ('video.mp4', bytes(data), 'video/mp4')},
                                     follow_redirects=False, timeout=45)
        if response.is_error or response.is_redirect or not upload.get('token'):
            raise ValueError('MAX не подтвердил загрузку видео. Повторите позже.')
        result['body'] = {'text': '', 'attachments': [{'type': 'video', 'payload': {'token': upload['token']}}]}
        app.s.set(cache_key, json.dumps({'at': time.time(), 'result': result}))
        return result


async def download(url):
    url = source_url(url)
    if not re.search(r'/video/[0-9]+$', url):
        raise ValueError('Нужна ссылка на один ролик.')
    async with _gate:
        with tempfile.TemporaryDirectory(prefix='everypost-content-') as folder:
            target = Path(folder) / 'video.mp4'
            proc = await asyncio.create_subprocess_exec(
                sys.executable, '-m', 'yt_dlp', '--ignore-config', '--no-warnings', '--quiet',
                '--no-playlist', '--use-extractors', 'tiktok.*', '--max-filesize', str(MAX_BYTES),
                '--socket-timeout', '12', '--retries', '1', '--extractor-retries', '1',
                '-f', CLEAN_FORMAT,
                '-o', str(target), '--', url,
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            async def monitor():
                while proc.returncode is None:
                    if sum(p.stat().st_size for p in Path(folder).glob('*') if p.is_file()) > MAX_BYTES:
                        raise ValueError('Ролик больше лимита MVP: 50 МБ.')
                    await asyncio.sleep(.25)
                await proc.wait()
            try:
                await asyncio.wait_for(monitor(), 80)
                if proc.returncode or not target.exists() or target.stat().st_size > MAX_BYTES:
                    raise ValueError('Не удалось получить MP4 без водяного знака TikTok до 50 МБ. Ролик не передан в очередь; требуется проверка.')
                return target.read_bytes()
            finally:
                if proc.returncode is None:
                    proc.kill()
                    await proc.wait()


async def action(app, data):
    if data.get('provider', 'tiktok') != 'tiktok':
        raise ValueError('Этот источник ещё не подключён.')
    if data['action'] == 'content_health':
        return {'service': 'everypost-content', 'version': 2}
    if data['action'] == 'content_inspect':
        _, result = await asyncio.wait_for(inspect(data.get('url')), 155)
        return result
    if data['action'] == 'content_fetch':
        return await fetch(data.get('source'))
    if data['action'] == 'content_prepare':
        return await asyncio.wait_for(prepare(app, data.get('url')), 195)
    raise ValueError('Неизвестное действие сбора контента.')
