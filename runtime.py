"""Startup and shutdown helpers for a single Render worker with a mounted disk."""
import asyncio
import os
import signal
from pathlib import Path


def data_folder():
    folder = Path(os.getenv('DATA_DIR', 'data')).resolve()
    if os.getenv('REQUIRE_PERSISTENT_DISK') == '1':
        mount = Path(os.getenv('PERSISTENT_DISK_PATH', '/var/data')).resolve()
        if not os.path.ismount(mount) or not folder.is_relative_to(mount):
            raise SystemExit('Постоянный диск не подключён или DATA_DIR находится вне диска. Запуск остановлен.')
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def reader_session(folder):
    from telethon.sessions import SQLiteSession, StringSession
    session = SQLiteSession(str(folder / 'reader'))
    seed = os.getenv('TG_SESSION_STRING', '').strip()
    # Keep updated server/entity information from the durable session on later starts.
    if session.auth_key is None and seed:
        try:
            original = StringSession(seed)
            if original.auth_key is None:
                raise ValueError('empty session')
            session.set_dc(original.dc_id, original.server_address, original.port)
            session.auth_key = original.auth_key
            session.save()
        except Exception:
            session.close()
            raise SystemExit('Не удалось прочитать TG_SESSION_STRING. Повтори локальный экспорт сессии.') from None
    return session


async def supervise(*coroutines, stop_event=None):
    """Cancel workers before closing clients/SQLite; in-flight sends stay uncertain."""
    stop = stop_event or asyncio.Event()
    loop = asyncio.get_running_loop()
    installed = []
    if stop_event is None:
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, stop.set)
            installed.append(sig)
    jobs = [asyncio.create_task(c) for c in coroutines]
    waiter = asyncio.create_task(stop.wait())
    try:
        done, _ = await asyncio.wait([*jobs, waiter], return_when=asyncio.FIRST_COMPLETED)
        if waiter not in done:
            for job in jobs:
                if job in done:
                    job.result()
            raise RuntimeError('Фоновая задача неожиданно завершилась.')
    finally:
        for task in [*jobs, waiter]:
            task.cancel()
        await asyncio.gather(*jobs, waiter, return_exceptions=True)
        for sig in installed:
            loop.remove_signal_handler(sig)
