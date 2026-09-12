"""Photo metadata and complete, resumable publication plans."""
import json
from urllib.parse import urlparse


def photo_url(value):
    if not isinstance(value, str):
        raise ValueError('Не удалось прочитать ссылку фотографии.')
    url = urlparse(value)
    host = (url.hostname or '').lower()
    allowed = ('telesco.pe', 'telegram-cdn.org', 'userapi.com', 'vkuser.net', 'vk-cdn.net', 'vkuserphoto.ru')
    if (url.scheme != 'https' or url.username or url.password or url.port not in (None, 443)
            or not any(host == domain or host.endswith('.' + domain) for domain in allowed)):
        raise ValueError('Фотография получена с неподдерживаемого адреса. Пост сохранён для проверки.')
    return value


def normal_media(value):
    if isinstance(value, str):
        value = json.loads(value or '{}')
    value = value or {}
    if not isinstance(value, dict):
        raise ValueError('Не удалось прочитать вложения поста.')
    photos = []
    items, unsupported = value.get('photos', []), value.get('unsupported', [])
    if not isinstance(items, list) or not isinstance(unsupported, list) or not all(isinstance(x, str) for x in unsupported):
        raise ValueError('Не удалось прочитать вложения поста.')
    for item in items:
        if isinstance(item, str):
            item = {'url': item}
        if not isinstance(item, dict):
            raise ValueError('Не удалось прочитать фотографию поста.')
        if 'url' in item:
            item = {'url': photo_url(item['url']), 'spoiler': bool(item.get('spoiler'))}
        elif 'tg_file_id' in item:
            if not isinstance(item['tg_file_id'], str) or not item['tg_file_id'] or len(item['tg_file_id']) > 1024:
                raise ValueError('Некорректная фотография Telegram.')
            item = {'tg_file_id': item['tg_file_id'], 'spoiler': bool(item.get('spoiler')), 'size': int(item.get('size', 0))}
        elif 'telegram_message' in item:
            item = {'telegram_message': int(item['telegram_message']), 'peer': int(item['peer']),
                    'spoiler': bool(item.get('spoiler'))}
        else:
            raise ValueError('Не удалось прочитать фотографию поста.')
        if item not in photos:
            photos.append(item)
    if len(photos) > 100:
        raise ValueError('В посте слишком много фотографий; нужна ручная проверка.')
    result = {'photos': photos, 'unsupported': list(dict.fromkeys(unsupported))}
    if 'gallery' in value:
        gallery = value['gallery']
        if not isinstance(gallery, list) or len(gallery) > 100:
            raise ValueError('Некорректный альбом.')
        result['gallery'] = []
        for item in gallery:
            if (not isinstance(item, dict) or item.get('type') not in ('photo', 'video')
                    or not isinstance(item.get('tg_file_id'), str) or not 1 <= len(item['tg_file_id']) <= 1024):
                raise ValueError('Некорректное вложение Telegram.')
            result['gallery'].append({'type': item['type'], 'tg_file_id': item['tg_file_id'],
                                      'size': max(0, int(item.get('size', 0))), 'spoiler': bool(item.get('spoiler'))})
    return result


def vk_media(post):
    photos, unsupported = [], []
    for entry in [post, *post.get('copy_history', [])]:
        for attachment in entry.get('attachments', []):
            kind = attachment.get('type')
            if kind == 'photo':
                sizes = attachment.get('photo', {}).get('sizes', [])
                if not sizes:
                    unsupported.append('недоступное фото')
                    continue
                biggest = max(sizes, key=lambda size: size.get('width', 0) * size.get('height', 0))
                photos.append({'url': photo_url(biggest['url'])})
            elif kind not in ('link', None):
                unsupported.append(kind)
    return normal_media({'photos': photos, 'unsupported': unsupported})


def utf16_len(text):
    return len(text.encode('utf-16-le')) // 2


def text_chunks(text, limit):
    if limit < 2:
        raise ValueError('Слишком маленький предел длины текста.')
    chunks = []
    while text:
        size, end = 0, 0
        for index, char in enumerate(text):
            units = 2 if ord(char) > 0xffff else 1
            if size + units > limit:
                break
            size += units
            end = index + 1
        if end < len(text):
            split = max(text.rfind('\n', 0, end), text.rfind(' ', 0, end))
            if split > end // 2:
                end = split + 1
        chunks.append(text[:end])
        text = text[end:]
    return chunks


def publication_parts(platform, text, media):
    media = normal_media(media)
    if media['unsupported']:
        raise ValueError('В посте есть неподдерживаемое вложение (' + ', '.join(media['unsupported'])
                         + '). Пост сохранён целиком, отправка остановлена.')
    photos = media['photos']
    if media.get('gallery'):
        if photos:
            raise ValueError('Смешанные способы хранения вложений не поддерживаются.')
        gallery = media['gallery']
        if platform == 'tg':
            caption = text if utf16_len(text) <= 1024 else ''
            parts = [{'kind': 'gallery', 'items': gallery[i:i+10], 'caption': caption if i == 0 else ''}
                     for i in range(0, len(gallery), 10)]
            if text and not caption:
                parts.extend({'kind': 'text', 'text': chunk} for chunk in text_chunks(text, 4096))
            return parts
        if platform == 'max':
            chunks = text_chunks(text, 4000)
            first = chunks.pop(0) if chunks else ''
            return [{'kind': 'max', 'photos': [], 'items': gallery[i:i+12], 'text': first if i == 0 else ''}
                    for i in range(0, len(gallery), 12)] + [{'kind': 'max', 'photos': [], 'text': c} for c in chunks]
        raise ValueError('Неподдерживаемая площадка публикации.')
    if not text.strip() and not photos:
        raise ValueError('В посте нет текста или фотографий.')
    result = []
    if platform == 'tg':
        caption = text if utf16_len(text) <= 1024 else ''
        for start in range(0, len(photos), 10):
            group = photos[start:start + 10]
            if len(group) == 1:
                result.append({'kind': 'photo', 'photo': group[0], 'caption': caption if start == 0 else ''})
            else:
                result.append({'kind': 'album', 'photos': group, 'caption': caption if start == 0 else ''})
        if not photos or not caption:
            result.extend({'kind': 'text', 'text': chunk} for chunk in text_chunks(text, 4096))
    elif platform == 'max':
        chunks = text_chunks(text, 4000)
        first_text = chunks.pop(0) if chunks else ''
        if photos:
            for start in range(0, len(photos), 12):
                result.append({'kind': 'max', 'photos': photos[start:start + 12],
                               'text': first_text if start == 0 else ''})
        elif first_text:
            result.append({'kind': 'max', 'photos': [], 'text': first_text})
        result.extend({'kind': 'max', 'photos': [], 'text': chunk} for chunk in chunks)
    else:
        raise ValueError('Неподдерживаемая площадка публикации.')
    return result
