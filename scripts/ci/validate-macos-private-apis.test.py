import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('private_apis', Path(__file__).with_name('validate-macos-private-apis.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PrivateApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = Path(self.temp.name) / 'Mindwtr.app'
        self.app.mkdir()

    def binary(self, name='Contents/MacOS/Mindwtr', magic='cffaedfe'):
        path = self.app / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(bytes.fromhex(magic))
        return path

    def scan(self, output, **kwargs):
        return patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, output, ''), **kwargs)

    def test_success_ignores_resource_strings_and_near_match(self):
        self.binary()
        resource = self.app / 'Contents/Resources/fixture.txt'
        resource.parent.mkdir()
        resource.write_text('_ubrk_clone\n')
        with self.scan('U _malloc\nU _ubrk_clone_extra\n') as nm:
            self.assertEqual(module.validate(self.app), 1)
            self.assertEqual(nm.call_count, 1)

    def test_nested_helper_dylib_and_widget_are_scanned(self):
        self.binary()
        for name in ('Contents/MacOS/helper', 'Contents/Frameworks/fixture.dylib',
                     'Contents/PlugIns/Widget.appex/Contents/MacOS/Widget'):
            self.binary(name)
        with self.scan('U _ubrk_clone\n') as nm:
            with self.assertRaises(ValueError) as error:
                module.validate(self.app)
        self.assertEqual(nm.call_count, 4)
        for name in ('Contents/MacOS/helper', 'Contents/Frameworks/fixture.dylib',
                     'Contents/PlugIns/Widget.appex/Contents/MacOS/Widget'):
            self.assertIn(name, str(error.exception))
        self.assertIn('_ubrk_clone', str(error.exception))

    def test_non_leading_fat_architecture_import_is_rejected(self):
        binary = self.binary(magic='cafebabe')
        output = f'{binary} (for architecture x86_64):\n_malloc\n{binary} (for architecture arm64):\n_ubrk_clone\n'
        for platform, flags in [('darwin', ['-arch', 'all', '-u']), ('linux', ['--arch=all', '-u'])]:
            with self.subTest(platform=platform), patch.object(module.sys, 'platform', platform), self.scan(output) as nm:
                with self.assertRaisesRegex(ValueError, '_ubrk_clone'):
                    module.validate(self.app)
                self.assertEqual(nm.call_args.args[0][1:-1], flags)

    def test_missing_bundle_or_no_mach_o_fails(self):
        with self.assertRaisesRegex(ValueError, 'not found'):
            module.validate(self.app / 'missing')
        with self.assertRaisesRegex(ValueError, 'No Mach-O'):
            module.validate(self.app)

    def test_failed_missing_or_warning_scan_fails(self):
        self.binary()
        for result in (subprocess.CompletedProcess([], 1, '', 'bad binary'),
                       subprocess.CompletedProcess([], 0, '', 'warning: architecture skipped')):
            with self.subTest(result=result), patch.object(module.subprocess, 'run', return_value=result):
                with self.assertRaisesRegex(ValueError, 'nm scan failed'):
                    module.validate(self.app)
        with patch.object(module.subprocess, 'run', side_effect=FileNotFoundError('missing nm')):
            with self.assertRaisesRegex(OSError, 'missing nm'):
                module.validate(self.app)

    def test_missing_or_empty_rejection_list_fails(self):
        symbols = Path(self.temp.name) / 'symbols.txt'
        with patch.object(module, 'REJECTED_SYMBOLS', symbols):
            with self.assertRaises(OSError):
                module.validate(self.app)
            symbols.write_text('# no names\n')
            with self.assertRaisesRegex(ValueError, 'symbol list is empty'):
                module.validate(self.app)


if __name__ == '__main__':
    unittest.main()
