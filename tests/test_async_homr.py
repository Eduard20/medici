"""Deterministic, standard-library-only checks for the browser coroutine bridge."""
import ast
import importlib.util
from pathlib import Path
import unittest
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('builder', ROOT / 'scripts/build_async_homr.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

class AsyncHomrTests(unittest.TestCase):
    def test_archive_matches_reproducible_build(self):
        with ZipFile(builder.SOURCE) as original, ZipFile(builder.OUTPUT) as current:
            self.assertEqual(original.namelist(), current.namelist())
            for name in original.namelist():
                expected = original.read(name)
                if name in builder.PATCHES:
                    expected = builder.transform(expected.decode(), builder.PATCHES[name], name).encode()
                self.assertEqual(current.read(name), expected, name)

    def test_builder_fails_on_changed_function_or_call_graph(self):
        with self.assertRaises(ValueError):
            builder.transform('def changed():\n    model.run()\n', {'original': {'model.run': 1}}, 'fixture')
        with self.assertRaises(ValueError):
            builder.transform('def original():\n    model.changed()\n', {'original': {'model.run': 1}}, 'fixture')

    def test_runner_wrappers_are_coroutines(self):
        tree = ast.parse((ROOT / 'omr/runner.py').read_text())
        methods = {node.name: node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
        for name in ['_parse_staff_image_once', '_split_false_grand_staffs', '_parse_staffs_by_layout', '_parse_staffs_fixed', '_generate_in_js', 'recognise', 'recognise_profiled']:
            self.assertIsInstance(methods[name], ast.AsyncFunctionDef, name)
        self.assertNotIn('run_sync', (ROOT / 'omr/runner.py').read_text())
        self.assertNotIn('run_sync', (ROOT / 'omr/onnxruntime.py').read_text())

    def test_worker_uses_plain_async_bridge(self):
        source = (ROOT / 'omr-worker.js').read_text()
        self.assertNotIn('.callPromising(', source)
        self.assertIn('enableRunUntilComplete: false', source)
        self.assertIn('ort.wasm.min.mjs', source)
        self.assertLess(source.index('for (const name of MODELS) await self.omrOrt.create(name)'), source.index('post({ type: "ready"'))

if __name__ == '__main__':
    unittest.main()
