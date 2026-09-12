import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from runtime import data_folder, supervise


class PersistenceTests(unittest.TestCase):
    def test_refuses_ephemeral_render_directory(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {
            'DATA_DIR': folder, 'REQUIRE_PERSISTENT_DISK': '1', 'PERSISTENT_DISK_PATH': folder
        }), patch('runtime.os.path.ismount', return_value=False):
            with self.assertRaises(SystemExit):
                data_folder()

    def test_refuses_directory_outside_mount(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {
            'DATA_DIR': folder + '/elsewhere', 'REQUIRE_PERSISTENT_DISK': '1', 'PERSISTENT_DISK_PATH': folder + '/disk'
        }), patch('runtime.os.path.ismount', return_value=True):
            with self.assertRaises(SystemExit):
                data_folder()

    def test_accepts_directory_on_persistent_disk(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {
            'DATA_DIR': folder + '/bot', 'REQUIRE_PERSISTENT_DISK': '1', 'PERSISTENT_DISK_PATH': folder
        }), patch('runtime.os.path.ismount', return_value=True):
            self.assertEqual(data_folder(), (Path(folder) / 'bot').resolve())
            self.assertTrue((Path(folder) / 'bot').is_dir())


class ShutdownTests(unittest.IsolatedAsyncioTestCase):
    async def test_stops_all_jobs_before_returning(self):
        stop = asyncio.Event()
        began = asyncio.Event()
        finished = []
        async def job():
            began.set()
            try:
                await asyncio.Event().wait()
            finally:
                finished.append(True)
        runner = asyncio.create_task(supervise(job(), job(), stop_event=stop))
        await began.wait()
        stop.set()
        await runner
        self.assertEqual(len(finished), 2)

    async def test_failure_cancels_other_jobs(self):
        finished = []
        async def failed():
            await asyncio.sleep(0)
            raise RuntimeError('test')
        async def other():
            try:
                await asyncio.Event().wait()
            finally:
                finished.append(True)
        with self.assertRaisesRegex(RuntimeError, 'test'):
            await supervise(failed(), other(), stop_event=asyncio.Event())
        self.assertEqual(finished, [True])
