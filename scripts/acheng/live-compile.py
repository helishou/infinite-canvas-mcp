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


if len(sys.argv) < 4:
    raise SystemExit("live-compile.py requires runtime compiler, overlay directory, then compiler arguments")

compiler = Path(sys.argv[1]).resolve()
overlay = Path(sys.argv[2]).resolve()
arguments = sys.argv[3:]
if not compiler.is_file() or not overlay.is_dir():
    raise SystemExit("Live Acheng compiler source is unavailable")

# Load the current project-owned files before the managed compile_h3.py imports
# their names. The base compiler and its dependencies stay on the verified runtime.
sys.path.insert(0, str(compiler.parent))
load("canvas_subject_prompt_v2", overlay / "canvas_subject_prompt_v2.py")
load("canvas_source_contract", overlay / "source-contract.py")
sys.argv = [str(compiler), *arguments]
runpy.run_path(str(compiler), run_name="__main__")
