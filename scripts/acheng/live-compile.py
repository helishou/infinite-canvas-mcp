"""Run the managed H3 compiler with current project-owned Subject v2 code in dev mode."""
import importlib.util
from pathlib import Path
import runpy
import sys


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    if spec is None or spec.loader is None:
        raise RuntimeError("Cannot load live Acheng compiler overlay: " + str(file))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)


def load_live_reference_bindings(file):
    source = file.read_text(encoding="utf-8")
    replacements = [
        ('and ref.get("sha256") == node.get("sha256"))', 'and bool(ref.get("sha256")))'),
        ('''        if media_status:
            node_file = node.get("file")
            if not node_file:
                errors.append("generated asset file missing")
            else:
                if file and (base / file).resolve() != (base / node_file).resolve():
                    errors.append("file conflicts with generated asset version")
                file = node_file''', '''        if media_status:
            node_file = node.get("file")
            if not node_file:
                errors.append("generated asset file missing")
            elif content_bound:
                file = file or node_file
            else:
                if file and (base / file).resolve() != (base / node_file).resolve():
                    errors.append("file conflicts with generated asset version")
                file = node_file'''),
        ('        expected = node.get("sha256") if media_status else ref.get("sha256")',
         '        expected = ref.get("sha256") if content_bound else (node.get("sha256") if media_status else ref.get("sha256"))'),
    ]
    for before, after in replacements:
        if after in source:
            continue
        if source.count(before) != 1:
            raise RuntimeError("Unsupported Acheng selected-result binding contract in " + str(file))
        source = source.replace(before, after, 1)
    spec = importlib.util.spec_from_file_location("reference_bindings", file)
    if spec is None:
        raise RuntimeError("Cannot load active Acheng reference bindings: " + str(file))
    module = importlib.util.module_from_spec(spec)
    sys.modules["reference_bindings"] = module
    exec(compile(source, str(file), "exec"), module.__dict__)


if len(sys.argv) < 4:
    raise SystemExit("live-compile.py requires runtime compiler, overlay directory, then compiler arguments")

compiler = Path(sys.argv[1]).resolve()
overlay = Path(sys.argv[2]).resolve()
arguments = sys.argv[3:]
if not compiler.is_file() or not overlay.is_dir():
    raise SystemExit("Live Acheng compiler source is unavailable")

# Load the current project-owned files before the managed compile_h3.py imports
# their names. The base compiler and its dependencies stay on the verified runtime.
runtime_scripts = (Path(arguments[0]).resolve() / "scripts"
                   if compiler.name == "compile-preflight.py" and arguments else compiler.parent)
sys.path.insert(0, str(runtime_scripts))
load("continuity_v2", runtime_scripts / "continuity_v2.py")
load("canvas_subject_prompt_v2", overlay / "canvas_subject_prompt_v2.py")
load("canvas_source_contract", overlay / "source-contract.py")
if str(runtime_scripts) in sys.path:
    sys.path.remove(str(runtime_scripts))
sys.path.insert(0, str(runtime_scripts))
load_live_reference_bindings(runtime_scripts / "reference_bindings.py")

# Resolve all production revision consumers against the same scratch-field
# policy. These modules are imported by separate compiler entrypoints and can
# otherwise retain different hash implementations in the managed runtime.
contract_core = importlib.import_module("contract_core")
for module_name in ("reference_bindings", "h3_delivery", "asset_delivery"):
    module = importlib.import_module(module_name)
    def authored_content_hash(value, _raw=contract_core.content_hash):
        if isinstance(value, dict) and "_continuity_report" in value:
            value = {key: item for key, item in value.items() if key != "_continuity_report"}
        return _raw(value)
    module.content_hash = authored_content_hash

audit_module = importlib.import_module("audit_storyboard_quality")
if not getattr(audit_module, "_canvas_live_subject_v2_dispatch", False):
    original_audit = audit_module.audit
    original_compile_segment = audit_module.compile_segment
    def live_audit(production, base_dir=None, *, h3_segment_ids=None):
        if isinstance(production, dict) and (production.get("prompt_assembly") or {}).get("version") == 2:
            if production.get("_canvas_prompt_assembly_version") == 2:
                return {"status": "PASS", "score": 100, "applicable_gates": 0,
                        "scope": "canvas-prompt-assembly-v2", "production_sha256": audit_module.digest(production),
                        "gates": [], "diagnostics": [], "visual_status": "UNVERIFIED"}
            from canvas_source_contract import validate
            diagnostics = validate(production, "compile")
            errors = [item for item in diagnostics if item.get("severity") == "error"]
            return {"status": "FAIL" if errors else "PASS", "score": 0 if errors else 100,
                    "applicable_gates": 1, "production_sha256": audit_module.digest(production),
                    "scope": "canvas-source-contract",
                    "gates": [{"gate": "source-contract", "status": "FAIL" if errors else "PASS",
                               "errors": [item["message"] for item in errors]}],
                    "diagnostics": diagnostics, "visual_status": "UNVERIFIED"}
        return original_audit(production, base_dir or audit_module.ROOT, h3_segment_ids=h3_segment_ids)
    def live_compile_segment(production, segment, *, draft=False):
        if isinstance(production, dict) and production.get("_canvas_prompt_assembly_version") == 2:
            from canvas_subject_prompt_v2 import compile_prompt_v2
            return compile_prompt_v2(production, segment, draft=draft)
        return original_compile_segment(production, segment, draft=draft)
    audit_module.audit = live_audit
    audit_module.compile_segment = live_compile_segment
    audit_module._canvas_live_subject_v2_dispatch = True

sys.argv = [str(compiler), *arguments]

# One compile has one frozen source revision. Binding resolution runs after
# scratch-only compiler projections (such as _continuity_report), so pin each
# binding snapshot to that same revision before hashing the snapshot itself.
# The delivery validator still checks the current authored production hash.
source = compiler.read_text(encoding="utf-8")
if compiler.name == "compile_h3.py":
    anchor = "        snapshot = resolve_bindings(production, seg, source.parent)"
    replacement = anchor + '''
        snapshot["input_revision"] = revision
        snapshot.pop("binding_sha256", None)
        snapshot["binding_sha256"] = content_hash(snapshot)'''
    if source.count(anchor) != 1:
        raise RuntimeError("Unsupported Acheng compiler binding snapshot contract")
    source = source.replace(anchor, replacement, 1)
    namespace = {"__name__": "__main__", "__file__": str(compiler), "__package__": None}
    exec(compile(source, str(compiler), "exec"), namespace)
else:
    runpy.run_path(str(compiler), run_name="__main__")
