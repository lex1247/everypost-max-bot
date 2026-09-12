"""Run locally once; login codes and passwords never go through the bot."""
import asyncio
import argparse
import os
from pathlib import Path


async def main(export=False):
    from dotenv import load_dotenv
    from telethon import TelegramClient
    load_dotenv()
    if not os.getenv('TG_API_ID') or not os.getenv('TG_API_HASH'):
        raise SystemExit('Сначала получи api_id и api_hash на https://my.telegram.org → API development tools '
                         'и сохрани их в TG_API_ID и TG_API_HASH файла .env. Команду в чат Telegram-бота отправлять не нужно.')
    os.umask(0o077)
    folder = Path(os.getenv('DATA_DIR', 'data'))
    folder.mkdir(parents=True, exist_ok=True)
    import fcntl
    lock = (folder / 'app.lock').open('w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('Сначала останови app.py; сессия используется.')
    async with TelegramClient(str(folder / 'reader'), int(os.environ['TG_API_ID']), os.environ['TG_API_HASH']) as client:
        await client.get_me()
        if export:
            from telethon.sessions import StringSession
            destination = folder / 'render-session.secret'
            # Export only to a private local file, never stdout or logs.
            fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w') as secret_file:
                os.fchmod(secret_file.fileno(), 0o600)
                secret_file.write(StringSession.save(client.session))
            print('Сессия сохранена в data/render-session.secret (или DATA_DIR). Значение внеси в TG_SESSION_STRING на Render.')
        else:
            print('Аккаунт подключён. Теперь можно запустить app.py.')
    lock.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--export-render', action='store_true')
    asyncio.run(main(parser.parse_args().export_render))
