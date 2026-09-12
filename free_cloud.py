"""Optional, explicitly approved anonymous LLM7 access. Never accepts billing keys."""
import asyncio
import json
import os
import time

import httpx
from local_model import RewriteUnavailable


def uses_free_cloud():
    return os.getenv('LLM_PROVIDER') == 'llm7'


class FreeCloud:
    def __init__(self, store):
        self.store = store
        self.lock = asyncio.Lock()

    async def generate(self, instructions, text, *, max_tokens=None):
        if os.getenv('LLM7_APPROVED') != '1':
            raise ValueError('Передача текстов в LLM7 ещё не согласована с владельцем.')
        model = os.getenv('LLM7_MODEL', 'default')
        if model not in ('default', 'minimax-m2.7', 'codestral-latest', 'mistral-Nemo-Instruct-2407'):
            raise ValueError('Эта модель не включена в бесплатную настройку LLM7.')
        async with self.lock:
            now = time.time()
            if now < float(self.store.get('llm7_pause_until', '0')):
                raise RewriteUnavailable('Бесплатный сервис временно ограничил запросы. Посты остаются в очереди.')
            history = [t for t in json.loads(self.store.get('llm7_requests', '[]')) if t > now - 3600]
            if len(history) >= 55 or sum(t > now - 60 for t in history) >= 8:
                raise RewriteUnavailable('Достигнут лимит бесплатного теста. Посты остаются в очереди.')
            # Anonymous capacity is shared upstream; space requests rather than
            # burst through the documented minute limit.
            if history and now - history[-1] < 15:
                await asyncio.sleep(15 - (now - history[-1]))
                now = time.time()
            self.store.set('llm7_requests', json.dumps([*history, now]))
            # The fixed anonymous token cannot access a paid account. Bot keys and
            # private HTTP-client headers are never reused for this provider.
            try:
                async with httpx.AsyncClient(timeout=120, trust_env=False, follow_redirects=False) as client:
                    response = await client.post('https://api.llm7.io/v1/chat/completions',
                        headers={'Authorization': 'Bearer unused'}, json={
                            'model': model,
                            'messages': [{'role': 'system', 'content': instructions},
                                         {'role': 'user', 'content': text}],
                            # Reasoning models count their internal work against this
                            # budget, even when the visible verdict is only OK/FAIL.
                            'max_tokens': max(2048 if model == 'minimax-m2.7' else 128,
                                              max_tokens or 2000), 'temperature': 0.3,
                        })
            except httpx.TransportError as exc:
                raise RewriteUnavailable('Бесплатный сервис недоступен. Посты остаются в очереди.') from exc
        if response.status_code == 429:
            try:
                delay = min(86400, max(60, float(response.headers.get('Retry-After', '300'))))
            except ValueError:
                delay = 300
            self.store.set('llm7_pause_until', str(time.time() + delay))
            raise RewriteUnavailable('Бесплатный сервис ограничил запросы. Посты остаются в очереди.')
        if response.is_error or response.is_redirect:
            raise RewriteUnavailable('Бесплатный сервис отклонил запрос. Посты остаются в очереди; платного переключения нет.')
        try:
            data = response.json()
            choice = data['choices'][0]
            result = choice['message']['content']
            finished = choice['finish_reason'] == 'stop'
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise RewriteUnavailable('Бесплатный сервис вернул некорректный ответ. Пост остаётся в очереди.') from exc
        if not finished or not isinstance(result, str) or not result.strip():
            raise ValueError('Пересказ не завершён; публикация остановлена.')
        self.store.set('llm7_last_model', str(data.get('model', model))[:120])
        return result.strip()
