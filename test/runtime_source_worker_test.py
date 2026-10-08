import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('worker', Path(__file__).resolve().parents[1] / 'scripts/read_powerapps_source.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
APP = 'f42a9b03-59b9-49d3-a33b-0a210cd3d51e'
ENV = '4d0aab59-43ec-ecf1-a9d1-869f2517adbb'
ENTRY = 'Src/S1_Home.pa.yaml'
REQUEST = dict(appId=APP, environment=ENV, entry=ENTRY)


class WorkerTests(unittest.TestCase):
    def test_only_list_download_and_exact_environment_app(self):
        calls, archives = [], []
        def pac(executable, arguments, timeout):
            calls.append(arguments)
            self.assertEqual(arguments[0], 'canvas')
            self.assertIn(arguments[1], ['list', 'download'])
            self.assertEqual(arguments[arguments.index('--environment') + 1], ENV)
            if arguments[1] == 'list':
                return ('App ID\n' + APP).encode()
            self.assertEqual(arguments[arguments.index('--name') + 1], APP)
            archive = Path(arguments[arguments.index('--file-name') + 1])
            archives.append(archive)
            with zipfile.ZipFile(archive, 'w') as package:
                package.writestr(ENTRY, 'Screens:\n  S1_Home: {}\n')
                package.writestr('../../escaped.txt', 'never extract this')
            return b'sensitive PAC diagnostic never emitted'
        with patch.object(worker, 'run_pac', side_effect=pac):
            result = worker.read_source(REQUEST)
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['appId'], APP)
        self.assertEqual(len(calls), 2)
        self.assertFalse(archives[0].exists())

    def test_exact_windows_entry_not_normalized_or_guessed(self):
        entry = r'Src\S1_Home.pa.yaml'
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'app.msapp'
            with zipfile.ZipFile(archive, 'w') as package:
                package.writestr(entry, 'Screens: {}')
            self.assertTrue(worker.valid_source_entry(entry))
            self.assertEqual(worker.extract_source(archive, entry)[0], 'Screens: {}')
            with self.assertRaises(RuntimeError):
                worker.extract_source(archive, 'Src/S1_Home.pa.yaml')
        for entry in [r'Src\..\Home.pa.yaml', r'Src\\Home.pa.yaml', '/Src/Home.pa.yaml', 'Src/./Home.pa.yaml', 'Src/Home.pa.yaml\0']:
            self.assertFalse(worker.valid_source_entry(entry))

    def test_environment_membership_rejection_no_download(self):
        with patch.object(worker, 'run_pac', return_value=b'other-app') as pac:
            self.assertEqual(worker.read_source(REQUEST)['reason'], 'app_not_found_in_environment')
            self.assertEqual(pac.call_count, 1)

    def test_encoding_and_missing_duplicate_source_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'app.msapp'
            for raw, encoding in [(b'\xef\xbb\xbfScreens: {}', 'utf-8'), ('Screens: {}'.encode('utf-16'), 'utf-16-le'), (b'\xfe\xff' + 'Screens: {}'.encode('utf-16-be'), 'utf-16-be')]:
                with zipfile.ZipFile(archive, 'w') as package:
                    package.writestr(ENTRY, raw)
                content, actual, _ = worker.extract_source(archive, ENTRY)
                self.assertEqual(content, 'Screens: {}')
                self.assertEqual(actual, encoding)
            with self.assertRaises(RuntimeError):
                worker.extract_source(archive, 'Src/Unknown.pa.yaml')
            with zipfile.ZipFile(archive, 'w') as package:
                package.writestr(ENTRY, 'Screens: {}')
                with self.assertWarns(UserWarning):
                    package.writestr(ENTRY, 'Screens: {}')
            with self.assertRaises(RuntimeError):
                worker.extract_source(archive, ENTRY)

    def test_invalid_targets_paths_timeout_fail_before_pac(self):
        with patch.object(worker, 'run_pac') as pac:
            for values in [dict(appId='guess'), dict(environment='guess'), dict(entry='../Src/Home.pa.yaml'), dict(entry='Src/../Home.pa.yaml'), dict(entry='Src/Home.fx.yaml'), dict(timeoutSeconds=500)]:
                self.assertEqual(worker.read_source({**REQUEST, **values})['status'], 'source_unavailable')
            pac.assert_not_called()

    def test_subprocess_no_shell_and_diagnostics_not_exposed(self):
        with patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, b'private-source', b'Bearer private-secret')) as run:
            with self.assertRaisesRegex(RuntimeError, '^pac_read_failed$'):
                worker.run_pac('pac', ['canvas', 'list', '--environment', ENV], 45)
            self.assertFalse(run.call_args.kwargs['shell'])
            self.assertEqual(run.call_args.kwargs['stdin'], subprocess.DEVNULL)


if __name__ == '__main__':
    result = unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(WorkerTests))
    if not result.wasSuccessful():
        raise SystemExit(1)
    print('worker tests passed')
