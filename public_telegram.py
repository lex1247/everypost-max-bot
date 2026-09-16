"""Read publicly available Telegram previews without an account or view-counter calls."""
import asyncio
import base64
import json
import re
import time
from dataclasses import dataclass
from datetime import datetime
from urllib.parse import urlparse

from bs4 import BeautifulSoup
from media import normal_media, photo_url, video_url
from media_download import MediaTemporary


class SourceMissing(ValueError):
    pass


def widget_media(widget):
    gallery, unsupported = [], []
    for node in widget.select('.tgme_widget_message_photo_wrap, .tgme_widget_message_video_player'):
        if 'tgme_widget_message_photo_wrap' in node.get('class', []):
            found = re.search(r'background-image\s*:\s*url\([\'\"]?(https://[^\'\"\)]+)', node.get('style', ''))
            if found:
                gallery.append({'type': 'photo', 'url': photo_url(found[1]),
                                'spoiler': 'spoiler' in ' '.join(node.get('class', []))})
            else:
                unsupported.append('недоступное фото')
        else:
            videos = [v for v in node.select('video') if 'blured' not in v.get('class', [])]
            urls = list(dict.fromkeys(v.get('src') or (v.select_one('source[src]') or {}).get('src', '') for v in videos))
            if len(urls) == 1 and urls[0]:
                gallery.append({'type': 'video', 'url': video_url(urls[0])})
            else:
                unsupported.append('видео')
    if widget.select_one('video') and not widget.select_one('.tgme_widget_message_video_player'):
        unsupported.append('видео')
    for selector, label in (('.tgme_widget_message_document_wrap', 'документ'),
                            ('.tgme_widget_message_voice_player', 'голосовое сообщение'),
                            ('.tgme_widget_message_audio_player', 'аудио'),
                            ('.tgme_widget_message_sticker_wrap', 'стикер')):
        if widget.select_one(selector):
            unsupported.append(label)
    # Telegram includes a browser fallback inside every working video player.
    for hidden in widget.select('.message_media_not_supported'):
        if not hidden.find_parent(class_='tgme_widget_message_video_player'):
            unsupported.append('вложение скрыто на публичной странице Telegram')
    if any(item['type'] == 'video' for item in gallery):
        return normal_media({'gallery': gallery, 'unsupported': unsupported})
    return normal_media({'photos': [{k: v for k, v in item.items() if k != 'type'} for item in gallery],
                         'unsupported': unsupported})


@dataclass
class Preview:
    peer_id: int
    title: str
    posts: list
    has_older: bool


def parse_preview(html, username):
    soup = BeautifulSoup(html, 'html.parser')
    heading = soup.select_one('.tgme_channel_info_header_title')
    if heading is None:
        raise ValueError('Посты этого канала недоступны на публичной странице Telegram. Нужен другой открытый источник или вход в аккаунт.')
    peers, posts = set(), {}
    for widget in soup.select('.tgme_widget_message[data-post]'):
        match = re.fullmatch(r'([A-Za-z0-9_]+)/(\d+)', widget.get('data-post', ''))
        if not match or match[1].lower() != username.lower():
            raise ValueError('Telegram вернул посты другого канала. Проверь ссылку источника.')
        post_id = int(match[2])
        try:
            token = widget['data-view']
            if len(token) > 2048:
                raise ValueError()
            data = json.loads(base64.urlsafe_b64decode(token + '=' * (-len(token) % 4)))
            # Public widgets use a negative bare channel ID; Bot API adds the 10^12 offset.
            channel = data['c']
            # Album widgets append 'g' to the leading post ID in their view metadata.
            metadata_post = data.get('p')
            post_matches = (type(metadata_post) is int and metadata_post == post_id) or metadata_post == f'{post_id}g'
            if type(channel) is not int or not -10**12 < channel < 0 or not post_matches:
                raise ValueError()
            peers.add(-10**12 + channel)
        except (KeyError, ValueError, TypeError):
            raise ValueError('Не удалось проверить канал на публичной странице Telegram. Формат страницы изменился.') from None
        body = widget.select_one('.tgme_widget_message_text')
        text = ''
        if body is not None:
            for tag in body.select('script, style'):
                tag.decompose()
            for emoji in body.select('img[alt]'):
                emoji.replace_with(emoji.get('alt', ''))
            for br in body.select('br'):
                br.replace_with('\n')
            for link in body.select('a[href]'):
                href = link.get('href', '')
                label = link.get_text()
                if urlparse(href).scheme in ('https', 'http', 'tg', 'mailto') and href != label.strip():
                    link.replace_with(label + ' (' + href + ')')
            text = body.get_text().replace('\xa0', ' ').strip()
        media = widget_media(widget)
        stamp = widget.select_one('time[datetime]')
        if stamp:
            try:
                media['published_at'] = datetime.fromisoformat(stamp['datetime'].replace('Z', '+00:00')).timestamp()
            except ValueError:
                pass
        posts[post_id] = (post_id, text, f'https://t.me/{username}/{post_id}', media)
    if not posts or len(peers) != 1:
        raise ValueError('На публичной странице нет доступных постов или не удалось проверить канал. Пришли открытый канал с опубликованными постами.')
    return Preview(peers.pop(), heading.get_text(' ', strip=True), sorted(posts.values()),
                   soup.select_one('a.tme_messages_more[data-before]') is not None)


class PublicTelegram:
    def __init__(self, http):
        self.http = http

    async def single(self, username, peer_id, post_id):
        if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{3,31}', username) or type(post_id) is not int or post_id < 1:
            raise ValueError('Некорректная ссылка исходного поста.')
        response = await self.http.get(f'https://t.me/{username}/{post_id}', params={'embed': 1},
                                       follow_redirects=False, timeout=25)
        if response.status_code == 429 or response.status_code >= 500:
            raise MediaTemporary('Telegram временно не отдаёт оригинал. Повтори проверку позже.')
        if response.status_code != 200 or len(response.content) > 3_000_000:
            raise ValueError('Не удалось проверить оригинал Telegram.')
        soup = BeautifulSoup(response.text, 'html.parser')
        error = soup.select_one('.tgme_widget_message_error')
        if error and error.get_text(' ', strip=True) == 'Post not found':
            raise SourceMissing('Telegram не находит оригинал. Для восстановления нужен исходный файл; можно пропустить эту отправку.')
        preview = parse_preview('<div class="tgme_channel_info_header_title">Telegram</div>' + response.text, username)
        if preview.peer_id != int(peer_id):
            raise ValueError('Исходный канал изменился. Восстановление остановлено.')
        for post in preview.posts:
            if post[0] == post_id:
                return post
        raise ValueError('Telegram вернул другой пост. Восстановление остановлено.')

    async def page(self, username, before=None):
        if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{3,31}', username):
            raise ValueError('Нужна ссылка на открытый канал Telegram.')
        response = await self.http.get('https://t.me/s/' + username,
                                       params={'before': before} if before else {},
                                       follow_redirects=False, timeout=25)
        if response.status_code == 429:
            raise ValueError('Telegram временно ограничил чтение публичной страницы. Бот повторит проверку позже.')
        if response.status_code != 200:
            raise ValueError('Публичная страница Telegram недоступна. Бот сможет читать источник, когда его посты будут доступны без входа.')
        if len(response.content) > 3_000_000:
            raise ValueError('Публичная страница Telegram слишком большая для чтения.')
        return parse_preview(response.text, username)

    async def since(self, username, peer_id, cursor, max_pages=50):
        result, before, newest, defer_from = {}, None, cursor, None
        for _ in range(max_pages):
            page = await self.page(username, before)
            if page.peer_id != int(peer_id):
                raise ValueError('Имя источника теперь принадлежит другому каналу. Чтение остановлено; добавь источник заново.')
            oldest = page.posts[0][0]
            if before is not None and oldest >= before:
                raise ValueError('Telegram не вернул предыдущие посты. Проверка будет повторена без пропуска очереди.')
            for post in page.posts:
                # Let a newly uploaded album finish forming before saving it.
                if post[3].get('published_at', 0) > time.time() - 15:
                    defer_from = min(defer_from, post[0]) if defer_from is not None else post[0]
                    continue
                newest = max(newest, post[0])
                if post[0] > cursor:
                    result[post[0]] = post
            if oldest <= cursor or not page.has_older:
                if defer_from is not None:
                    result = {key: post for key, post in result.items() if key < defer_from}
                    newest = max(cursor, min(newest, defer_from - 1))
                return sorted(result.values()), newest
            before = oldest
            await asyncio.sleep(0.4)
        raise ValueError('Накопилось больше постов, чем можно проверить за один проход. Чтение остановлено без пропуска очереди.')
