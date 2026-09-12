"""One-time private owner pairing. Does not change existing webhooks."""
import asyncio
import hmac
import json
import os
import secrets
import time
from pathlib import Path

import httpx
from dotenv import dotenv_values, set_key
from core import Store


def pairing_owner(update, challenge):
    message = update.get('message', {})
    user = message.get('from', {})
    chat = message.get('chat', {})
    user_id = user.get('id')
    text = message.get('text', '')
    if (type(user_id) is int and user_id > 0 and user.get('is_bot') is False
            and chat.get('type') == 'private' and chat.get('id') == user_id
            and isinstance(text, str)
            and hmac.compare_digest(text.encode(), ('/start ' + challenge).encode())):
        return user_id
    return None


async def main():
    os.umask(0o077)
    config = Path(__file__).with_name('.env')
    values = dotenv_values(config)
    if values.get('OWNER_ID'):
        raise SystemExit('Владелец уже настроен; повторная привязка отключена.')
    token = values.get('TG_BOT_TOKEN')
    if not token:
        raise SystemExit('Заполни TG_BOT_TOKEN.')
    folder = Path(values.get('DATA_DIR') or 'data')
    if not folder.is_absolute():
        folder = config.parent / folder
    folder.mkdir(parents=True, exist_ok=True)
    import fcntl
    with (folder / 'app.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit('Останови работающий экземпляр бота перед привязкой.')
        async with httpx.AsyncClient(timeout=40) as http:
            async def tg(method, **body):
                response = await http.post('https://api.telegram.org/bot' + token + '/' + method, json=body)
                if response.is_error:
                    raise RuntimeError('Telegram HTTP ' + str(response.status_code))
                data = response.json()
                if not data.get('ok'):
                    raise RuntimeError('Telegram API ' + str(data.get('error_code')))
                return data['result']

            identity = await tg('getMe')
            expected = (values.get('EXPECTED_TG_BOT_USERNAME') or '').lstrip('@').lower()
            if expected and identity.get('username', '').lower() != expected:
                raise SystemExit('Токен принадлежит другому боту.')
            if (await tg('getWebhookInfo')).get('url'):
                raise SystemExit('Существующее подключение активно. Привязка не начата; webhook не изменён.')
            challenge = 'bind_' + secrets.token_urlsafe(24)
            url = 'https://t.me/' + identity['username'] + '?start=' + challenge
            print(json.dumps({'setup_url': url, 'expires_in_seconds': 600}), flush=True)
            deadline, offset = time.monotonic() + 600, 0
            while time.monotonic() < deadline:
                remaining = max(1, int(deadline - time.monotonic()))
                updates = await tg('getUpdates', timeout=min(25, remaining), offset=offset, allowed_updates=['message'])
                if time.monotonic() >= deadline:
                    break
                for update in updates:
                    offset = update['update_id'] + 1
                    owner = pairing_owner(update, challenge)
                    if owner is not None:
                        # Save the consumed pairing offset before persisting ownership.
                        store = Store(folder / 'bot.sqlite3')
                        store.set('offset', offset)
                        store.db.close()
                        set_key(config, 'OWNER_ID', str(owner))
                        config.chmod(0o600)
                        print('OWNER_PAIRED', flush=True)
                        return
            raise SystemExit('Срок ссылки истёк. Запусти привязку ещё раз.')


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        # Network exceptions may contain the token-bearing request URL.
        raise SystemExit('Привязка остановлена: ' + type(exc).__name__) from None
