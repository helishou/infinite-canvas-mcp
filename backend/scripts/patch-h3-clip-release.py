"""Prepare or apply a reversible CLIP-only release patch to the native V15 node."""
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
newline = b"\r\n" if b"\r\n" in original else b"\n"
tree = ast.parse(original)
lines = original.splitlines(keepends=True)
starts = [0]
for line in lines:
    starts.append(starts[-1] + len(line))


def span(node):
    return starts[node.lineno - 1] + node.col_offset, starts[node.end_lineno - 1] + node.end_col_offset


classes = [node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "NanFengH3ReleaseBeforeSamplingV15"]
if len(classes) != 1:
    raise RuntimeError("Native V15 sampling-release node is missing or ambiguous")
cls = classes[0]
methods = {node.name: node for node in cls.body if isinstance(node, ast.FunctionDef)}
if "INPUT_TYPES" not in methods or "release" not in methods:
    raise RuntimeError("Native V15 sampling-release node shape changed")

changes = []
schema_return = next((node for node in ast.walk(methods["INPUT_TYPES"]) if isinstance(node, ast.Return)), None)
if schema_return is None or not isinstance(schema_return.value, ast.Dict):
    raise RuntimeError("Native V15 sampling-release input schema changed")
schema = schema_return.value
schema_keys = {key.value for key in schema.keys if isinstance(key, ast.Constant)}
if "optional" not in schema_keys:
    _, end = span(schema)
    changes.append((end - 1, end - 1, b', "optional": {"clip": ("CLIP",)}'))
elif "clip" not in {key.value for key in ast.walk(schema) if isinstance(key, ast.Constant)}:
    raise RuntimeError("Sampling-release node has an unrecognized optional input schema")

release = methods["release"]
release_start, release_end = span(release)
release_source = original[release_start:release_end]
has_clip_argument = any(argument.arg == "clip" for argument in release.args.args + release.args.kwonlyargs)
if not has_clip_argument:
    line_end = starts[release.lineno]
    signature = original[release_start:line_end]
    close = signature.rfind(b")")
    if close < 0:
        raise RuntimeError("Sampling-release method signature changed")
    changes.append((release_start + close, release_start + close, b", clip=None"))

if b"unload_model_and_clones(clip.patcher" not in release_source:
    docstring = release.body[0] if release.body and isinstance(release.body[0], ast.Expr) and isinstance(release.body[0].value, ast.Constant) and isinstance(release.body[0].value.value, str) else None
    insert_at = starts[docstring.end_lineno] if docstring is not None else starts[release.lineno]
    branch = newline.join((
        b"        if clip is not None:",
        b"            import comfy.model_management as mm",
        b"            mm.unload_model_and_clones(clip.patcher, unload_additional_models=False)",
        b"            mm.soft_empty_cache(force=True)",
        '            print("[南风H3] 条件编码后已主动卸载 CLIP 驻留。")'.encode("utf-8"),
        b"            return (model, conditioning, latent)",
        b"",
    ))
    changes.append((insert_at, insert_at, branch))

patched = original
for start, end, replacement in sorted(changes, reverse=True):
    patched = patched[:start] + replacement + patched[end:]
ast.parse(patched)
args.output.mkdir(parents=True, exist_ok=True)
backup = args.output / "h3_generator.before-clip-release.py"
if not backup.exists():
    backup.write_bytes(original)
(args.output / "h3_generator.patched.py").write_bytes(patched)
baseline = backup.read_bytes()
before = baseline.decode("utf-8").replace("\r\n", "\n").splitlines(keepends=True)
after = patched.decode("utf-8").replace("\r\n", "\n").splitlines(keepends=True)
(args.output / "native-clip-release.diff").write_text("".join(difflib.unified_diff(before, after, fromfile="h3_generator.py", tofile="h3_generator.py")), encoding="utf-8", newline="\n")
if args.apply and patched != original:
    if args.source.read_bytes() != original:
        raise RuntimeError("Source changed while preparing patch")
    args.source.write_bytes(patched)
print({"applied": args.apply, "changed": patched != original, "original_sha256": hashlib.sha256(original).hexdigest(), "patched_sha256": hashlib.sha256(patched).hexdigest(), "backup": str(backup), "output": str(args.output)})
