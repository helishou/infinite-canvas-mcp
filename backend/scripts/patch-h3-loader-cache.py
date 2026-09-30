"""Prepare or apply a reversible native V15 Loader-cache patch; never restart ComfyUI."""
import argparse
import ast
import difflib
import hashlib
import pathlib

parser = argparse.ArgumentParser()
parser.add_argument("source", type=pathlib.Path)
parser.add_argument("--output", type=pathlib.Path, required=True)
parser.add_argument("--apply", action="store_true")
args = parser.parse_args()
original = args.source.read_bytes()
newline = "\r\n" if b"\r\n" in original else "\n"
tree = ast.parse(original)
lines = original.splitlines(keepends=True)
starts = [0]
for line in lines:
    starts.append(starts[-1] + len(line))

def span(node):
    return starts[node.lineno - 1] + node.col_offset, starts[node.end_lineno - 1] + node.end_col_offset

changes = []
targets = {"NanFengH3ReleaseAtStartV15", "NanFengH3ReleaseBeforeConditionLoadersV15", "NanFengH3ReleaseBeforeConditioningV15"}
for cls in (node for node in tree.body if isinstance(node, ast.ClassDef) and node.name in targets):
    methods = {node.name: node for node in cls.body if isinstance(node, ast.FunctionDef)}
    schema = next(node for node in ast.walk(methods["INPUT_TYPES"]) if isinstance(node, ast.Return))
    a, b = span(schema.value)
    changes.append((b - 1, b, b', "optional": {"keep_loader_cache": ("BOOLEAN", {"default": False})}}'))
    changed = methods["IS_CHANGED"]
    a, b = span(changed)
    body = 'def IS_CHANGED(cls, keep_loader_cache=False, **kwargs):\n        if keep_loader_cache:\n'
    if cls.name == "NanFengH3ReleaseAtStartV15":
        body += ('            import comfy.model_management as mm\n'
                 '            reserve = max(0.0, min(24.0, round(float(kwargs.get("reserved_vram_gb", 0.0)), 1)))\n'
                 '            if mm.EXTRA_RESERVED_VRAM != int(reserve * 1024 ** 3):\n'
                 '                return float("NaN")\n')
    body += '            return "reuse-loader-cache"\n        return float("NaN")'
    changes.append((a, b, body.replace("\n", newline).encode("utf-8")))
    release = methods["release"]
    a, _ = span(release)
    line_end = starts[release.lineno] - 1
    signature = original[a:line_end]
    if b"keep_loader_cache" in signature:
        raise RuntimeError("Source already patched; refusing duplicate patch")
    close = signature.rfind(b")")
    changes.append((a + close, a + close, b", keep_loader_cache=False"))

native = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "NanFengH3MultiReferenceGeneratorV15")
schema_method = next(node for node in native.body if isinstance(node, ast.FunctionDef) and node.name == "INPUT_TYPES")
ret = next(node for node in ast.walk(schema_method) if isinstance(node, ast.Return))
a, _ = span(ret)
changes.append((a, a, ('schema.setdefault("optional", {})["复用加载器缓存"] = ("BOOLEAN", {"default": False})' + newline + '        ').encode("utf-8")))
calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "node" and node.args and isinstance(node.args[0], ast.Constant) and node.args[0].value in targets]
if len(calls) != 3 or len(changes) != 10:
    raise RuntimeError("Native node shape changed; refusing patch")
for call in calls:
    a, b = span(call)
    argument = 'keep_loader_cache=bool(kwargs.get("复用加载器缓存", False))'.encode("utf-8")
    closing_start = starts[call.end_lineno - 1]
    indent = original[closing_start:b - 1]
    if not indent.strip():
        changes.append((closing_start, b, indent + b"    " + argument + b"," + newline.encode() + indent + b")"))
    else:
        changes.append((b - 1, b - 1, b", " + argument))
patched = original
for a, b, replacement in sorted(changes, reverse=True):
    patched = patched[:a] + replacement + patched[b:]
ast.parse(patched)
args.output.mkdir(parents=True, exist_ok=True)
(args.output / "h3_generator.previous.py").write_bytes(original)
(args.output / "h3_generator.patched.py").write_bytes(patched)
(args.output / "native-loader-cache.diff").write_text("".join(difflib.unified_diff(original.decode("utf-8").replace("\r\n", "\n").splitlines(keepends=True), patched.decode("utf-8").replace("\r\n", "\n").splitlines(keepends=True), fromfile="h3_generator.py", tofile="h3_generator.py")), encoding="utf-8", newline="\n")
if args.apply:
    if args.source.read_bytes() != original:
        raise RuntimeError("Source changed while preparing patch")
    args.source.write_bytes(patched)
print({"applied": args.apply, "changes": len(changes), "original_sha256": hashlib.sha256(original).hexdigest(), "patched_sha256": hashlib.sha256(patched).hexdigest(), "output": str(args.output)})
