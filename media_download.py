"""Bounded, read-only downloads. Publication requests must never use this retry helper."""
import asyncio
import httpx


class MediaTemporary(Exception):
    def __init__(self, message, retry_after=60):
        super().__init__(message)
        self.retry_after = max(60, min(3600, retry_after))


async def download(http, url, limit, label, timeout=45):
    for attempt in range(3):
        try:
            async with http.stream('GET', url, follow_redirects=False, timeout=timeout) as response:
                code = response.status_code
                if code in (408, 425, 429) or 500 <= code <= 599:
                    delay = response.headers.get('retry-after', '60')
                    raise MediaTemporary(f'{label}: временный ответ сервера HTTP {code}.',
                                         int(delay) if delay.isdecimal() else 60)
                if code != 200:
                    raise ValueError(f'{label}: файл недоступен (HTTP {code}). Проверь оригинал в разделе ошибок.')
                length = response.headers.get('content-length', '')
                if length.isdecimal() and int(length) > limit:
                    raise ValueError(f'{label}: файл превышает {limit // 1_000_000} МБ.')
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > limit:
                        raise ValueError(f'{label}: файл превышает {limit // 1_000_000} МБ.')
                if not data:
                    raise MediaTemporary(f'{label}: сервер вернул пустой файл.')
                return bytes(data)
        except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError):
            failure = MediaTemporary(f'{label}: соединение прервалось во время загрузки.')
        except MediaTemporary as exc:
            failure = exc
            # Honour rate limits through the durable queue, not an immediate loop.
            if 'HTTP 429' in str(exc):
                raise
        if attempt == 2:
            raise failure
        await asyncio.sleep((1, 3)[attempt])
