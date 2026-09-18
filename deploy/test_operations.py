import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import configure
import monitor


class OperationsTests(unittest.TestCase):
    def test_configuration_is_private_consistent_and_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp)/'config';configure.configure(folder)
            db=monitor.env_file(folder/'db.env')
            for name in ['max.env','telegram.env']:
                self.assertIn(db['POSTGRES_PASSWORD'],monitor.env_file(folder/name)['DATABASE_URL'])
                self.assertEqual((folder/name).stat().st_mode & 0o777,0o600)
            original=(folder/'db.env').read_text()
            with self.assertRaises(SystemExit):configure.configure(folder)
            self.assertEqual(original,(folder/'db.env').read_text())

    def test_only_unhealthy_running_workers_restart_with_a_rate_limit(self):
        for service in ['db','edge']:
            self.assertFalse(monitor.restart_allowed(service,'unhealthy',True,[],10000)[0])
        for running, health in [(False,'unhealthy'),(True,'healthy'),(True,'starting')]:
            self.assertFalse(monitor.restart_allowed('max',health,running,[],10000)[0])
        self.assertTrue(monitor.restart_allowed('max','unhealthy',True,[],10000)[0])
        self.assertFalse(monitor.restart_allowed('max','unhealthy',True,[9800],10000)[0])
        self.assertFalse(monitor.restart_allowed('telegram','unhealthy',True,[8000,8500,9000],10000)[0])
        self.assertTrue(monitor.restart_allowed('telegram','unhealthy',True,[100,200,300],10000)[0])

    def test_stopped_service_is_reported_without_automatic_start(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'state').mkdir();(root/'state/backup-success').write_text('10000')
            with patch.object(monitor,'ROOT',root), patch.object(monitor,'inspect_service',return_value=(False,'exited')), \
                 patch.object(monitor,'command',return_value='0\n0\n0') as command:
                problems=monitor.check({},10001)
            self.assertIn('max: exited',problems)
            self.assertFalse(any('restart' in call.args[0] for call in command.call_args_list))

    def test_queue_alerts_are_read_only_and_missing_backup_is_visible(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(monitor,'ROOT',Path(temp)),patch.object(monitor,'inspect_service',return_value=(True,'healthy')), \
                 patch.object(monitor,'command',return_value='1\n2\n3') as command:
                problems=monitor.check({},10000)
            self.assertIn('MAX: overdue posts',problems)
            self.assertIn('MAX: delivery needs review',problems)
            self.assertIn('Telegram: delivery needs review',problems)
            self.assertIn('No confirmed off-server backup',problems)
            self.assertNotRegex(command.call_args.kwargs['input'],r'(?i)\b(update|delete|insert)\b')


if __name__=='__main__':unittest.main()
