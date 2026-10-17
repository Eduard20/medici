"""Build the browser-only async homr archive, retaining upstream source/comments.

The original pinned homr.zip is unchanged. Only these named functions and calls
are made async; ordinary image processing remains synchronous in the worker.
Run from any directory with Python 3.10+. No third-party build dependencies.
"""

import ast
import hashlib
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "vendor/homr.zip"
OUTPUT = ROOT / "vendor/homr-async.zip"
SOURCE_SHA256 = "d7734ba7f9647625b737dbace263442144dc608d50d9f36b1e330b890f2664c8"

# Function -> exact call expression -> expected number of sites. Fail closed
# if a future upstream archive changes the call graph instead of silently
# shipping a coroutine into synchronous code.
PATCHES = {
    "homr/segmentation/inference_segnet.py": {
        "Segnet.run": {"self.model.run_with_iobinding": 1},
        "inference": {"_segnet_inference.run": 2},
        "extract": {"inference": 1},
    },
    "homr/transformer/encoder_inference.py": {
        "Encoder.generate": {"self.encoder.run_with_iobinding": 1},
    },
    "homr/transformer/decoder_inference.py": {
        "ScoreDecoder.generate": {"self.net.run_with_iobinding": 1},
    },
    "homr/transformer/staff2score.py": {
        "Staff2Score.predict": {"self.encoder.generate": 1, "self.decoder.generate": 1},
        "test_transformer_on_image": {"model.predict": 1},
    },
    "homr/staff_parsing_tromr.py": {
        "predict_best": {"inference.predict": 1},
        "parse_staff_tromr": {"predict_best": 1},
    },
    "homr/staff_parsing.py": {
        "parse_staff_image": {"parse_staff_tromr": 1},
        "parse_staffs": {"parse_staff_image": 1},
    },
    "homr/main.py": {
        "get_predictions": {"extract": 1},
        "load_and_preprocess_predictions": {"get_predictions": 1},
        "detect_staffs_in_image": {"load_and_preprocess_predictions": 1},
        "process_image": {"detect_staffs_in_image": 1, "parse_staffs": 1},
        "run_homr": {"process_image": 1},
        "main": {"process_image": 1, "run_homr": 2},
    },
}


def transform(source, patches, filename):
    tree = ast.parse(source, filename)
    lines = source.splitlines(keepends=True)
    offsets = [0]
    for line in lines:
        offsets.append(offsets[-1] + len(line))

    def position(line, column):
        # AST columns count UTF-8 bytes, not Unicode characters.
        return offsets[line - 1] + len(lines[line - 1].encode()[:column].decode())

    edits = []
    found = set()

    class Rewrite(ast.NodeVisitor):
        scope = []

        def visit_ClassDef(self, node):
            self.scope.append(node.name)
            self.generic_visit(node)
            self.scope.pop()

        def visit_FunctionDef(self, node):
            name = ".".join([*self.scope, node.name])
            if name not in patches:
                return
            found.add(name)
            calls = patches[name]
            counts = dict.fromkeys(calls, 0)
            edits.append((position(node.lineno, node.col_offset), "async "))
            for child in ast.walk(node):
                if not isinstance(child, ast.Call):
                    continue
                target = ast.unparse(child.func)
                if target in calls:
                    counts[target] += 1
                    edits.append((position(child.lineno, child.col_offset), "(await "))
                    edits.append((position(child.end_lineno, child.end_col_offset), ")"))
            if counts != calls:
                raise ValueError(f"{filename}:{name}: expected {calls}, got {counts}")

    Rewrite().visit(tree)
    if found != set(patches):
        raise ValueError(f"{filename}: missing functions {set(patches) - found}")
    for at, text in sorted(edits, reverse=True):
        source = source[:at] + text + source[at:]
    compile(source, filename, "exec")
    return source


def build():
    if hashlib.sha256(SOURCE.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise ValueError("Upstream homr archive changed. Review the async call graph before rebuilding.")
    with ZipFile(SOURCE) as original, ZipFile(OUTPUT, "w", ZIP_DEFLATED) as patched:
        for entry in original.infolist():
            data = original.read(entry.filename)
            if entry.filename in PATCHES:
                data = transform(data.decode(), PATCHES[entry.filename], entry.filename).encode()
            # Preserve timestamps and metadata so rebuilding is deterministic.
            patched.writestr(entry, data)
    return OUTPUT


if __name__ == "__main__":
    print(build())
