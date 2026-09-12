"""Free local rewriting, with no cloud fallback or credentials."""
import asyncio
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

import httpx


class RewriteUnavailable(Exception):
    """Temporary model outage: keep the original queued for later."""


def uses_local_model():
    return os.getenv('LLM_PROVIDER', 'openai') == 'local'


def publishing_enabled():
    if os.getenv('LLM_PROVIDER') == 'llm7':
        return os.getenv('LLM7_APPROVED') == '1'
    return os.getenv('FREE_TEST_MODE') != '1' or uses_local_model()


def mode_description():
    if os.getenv('LLM_PROVIDER') == 'llm7':
        return ('Для режима «Переписать с ИИ» включён бесплатный онлайн-тест LLM7. '
                'При ограничении сервиса посты остаются в очереди. '
                + ('Бот размещён на Render; бесплатный сервер может засыпать без входящих сообщений.'
                   if os.getenv('WEB_MODE') == '1' else 'Бот работает, пока компьютер включён и не спит.'))
    if uses_local_model():
        return ('Бесплатная нейросеть на компьютере: автоматическое переписывание и отправка включены. '
                'Компьютер должен быть включён и не спать; обработка может занять несколько минут.')
    if os.getenv('FREE_TEST_MODE') == '1':
        return ('Бесплатный тест: сбор включён, переписывание и публикации пока выключены для режима ИИ. '
                'Режим «Как есть» работает без нейросети.')
    return 'Автоматическое переписывание и отправка включены.'


def local_base_url():
    value = os.getenv('LOCAL_LLM_URL', 'http://127.0.0.1:18081').rstrip('/')
    url = urlsplit(value)
    if (url.scheme != 'http' or url.hostname != '127.0.0.1' or url.username or url.password
            or url.path or url.query or url.fragment or not url.port):
        raise ValueError('LOCAL_LLM_URL должен указывать на http://127.0.0.1:порт без пути и пароля.')
    return value


class LocalModel:
    def __init__(self):
        self.lock = asyncio.Lock()

    async def generate(self, instructions, text, *, max_tokens=None, json_schema=None):
        # Use a separate client: no bot/API credentials, proxies or redirects.
        base = local_base_url()
        async with self.lock, httpx.AsyncClient(timeout=360, trust_env=False, follow_redirects=False) as client:
            try:
                payload = {
                    'model': os.getenv('LOCAL_MODEL_NAME', 'everypost-local'),
                    'messages': [{'role': 'system', 'content': instructions},
                                 {'role': 'user', 'content': text}],
                    'chat_template_kwargs': {'enable_thinking': False},
                    'reasoning_effort': 'none',
                    'temperature': 0.7, 'top_p': 0.8, 'top_k': 20, 'presence_penalty': 1.5,
                    'max_tokens': max_tokens or min(1800, max(160, len(text))), 'stream': False,
                }
                if json_schema:
                    payload['response_format'] = {'type': 'json_schema', 'json_schema': {
                        'name': 'repost_result', 'strict': True, 'schema': json_schema}}
                response = await client.post(base + '/v1/chat/completions', json=payload)
            except httpx.TransportError as exc:
                raise RewriteUnavailable('Локальная нейросеть временно недоступна; пост остаётся в очереди.') from exc
        if response.status_code >= 500 or response.status_code == 429:
            raise RewriteUnavailable('Локальная нейросеть занята; пост остаётся в очереди.')
        if response.is_error or response.is_redirect:
            raise ValueError('Локальная нейросеть отклонила текст; возможно, он не помещается в контекст.')
        try:
            choice = response.json()['choices'][0]
            result = choice['message']['content']
            finished = choice['finish_reason'] == 'stop'
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise ValueError('Локальная нейросеть вернула некорректный ответ.') from exc
        if not finished or not isinstance(result, str) or not result.strip() or '<think>' in result or '</think>' in result:
            raise ValueError('Локальная нейросеть не завершила ответ; публикация остановлена.')
        if json_schema:
            try:
                obj = json.loads(result)
                props = json_schema['properties']
                valid = isinstance(obj, dict) and set(obj) == set(props)
                valid = valid and all(isinstance(obj[k], str) and (
                    'enum' not in spec or obj[k] in spec['enum']) for k, spec in props.items())
            except (ValueError, KeyError, TypeError):
                valid = False
            if not valid:
                raise ValueError('Локальная нейросеть нарушила формат ответа; публикация остановлена.')
        return result.strip()


@asynccontextmanager
async def managed_local_server(folder):
    """Optionally own the local server for exactly the bot process lifetime."""
    if not uses_local_model():
        yield
        return
    base = local_base_url()
    binary = os.getenv('LLAMA_SERVER_PATH')
    if not binary:
        # An independently managed loopback server is also supported.
        yield
        return
    model = Path(os.getenv('LOCAL_MODEL_PATH', ''))
    if not Path(binary).is_file() or not model.is_file():
        raise ValueError('Не найдены программа или файл локальной нейросети.')
    log = (folder / 'local-model.log').open('w')
    process = None
    try:
        process = await asyncio.create_subprocess_exec(
            binary, '-m', str(model), '--host', '127.0.0.1', '--port', str(urlsplit(base).port),
            '--alias', os.getenv('LOCAL_MODEL_NAME', 'everypost-local'),
            '-c', '4096', '-np', '1', '-t', '4', '-tb', '4', '-ngl', '0',
            '--jinja', '--reasoning', 'off', '--cors-origins', 'localhost',
            '--no-context-shift', '--no-webui',
            stdout=log, stderr=log,
            env={k: os.environ[k] for k in ('PATH', 'LANG', 'LC_ALL', 'TMPDIR') if k in os.environ})
        async with httpx.AsyncClient(timeout=3, trust_env=False) as client:
            for _ in range(120):
                if process.returncode is not None:
                    raise ValueError('Локальная нейросеть не запустилась. Проверь data/local-model.log.')
                try:
                    response = await client.get(base + '/health')
                    if response.status_code == 200:
                        break
                except httpx.TransportError:
                    pass
                await asyncio.sleep(1)
            else:
                raise ValueError('Локальная нейросеть не успела загрузиться.')
        yield
    finally:
        if process is not None and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 10)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
        log.close()
