"""Exercise prepared native cache hooks without importing torch or running ComfyUI."""
import ast
import math
import pathlib
import sys
import types
import unittest

source = pathlib.Path(sys.argv.pop(1)).read_bytes()
tree = ast.parse(source)
names = {"NanFengH3ReleaseAtStartV15", "NanFengH3ReleaseBeforeConditionLoadersV15", "NanFengH3ReleaseBeforeConditioningV15", "NanFengH3ReleaseBeforeSamplingV15", "NanFengH3ReleaseBeforeDecodeV15"}
mm = types.ModuleType("comfy.model_management")
mm.EXTRA_RESERVED_VRAM = 0
mm.current_loaded_models = []
comfy = types.ModuleType("comfy")
comfy.model_management = mm
sys.modules["comfy"] = comfy
sys.modules["comfy.model_management"] = mm
released = []
namespace = {"_vram_snapshot": lambda _: (30 * 1024**3, 46 * 1024**2, len(mm.current_loaded_models)), "_aggressive_h3_vram_release": lambda *_: released.append(True)}
classes = [node for node in tree.body if isinstance(node, ast.ClassDef) and node.name in names]
exec(compile(ast.Module(body=classes, type_ignores=[]), "native-cache-hooks", "exec"), namespace)

class NativeCacheTests(unittest.TestCase):
    def test_default_keeps_original_forced_release(self):
        for name in names:
            self.assertTrue(math.isnan(namespace[name].IS_CHANGED()))

    def test_loader_reuse_is_stable_and_opt_in(self):
        for name in names - {"NanFengH3ReleaseBeforeSamplingV15", "NanFengH3ReleaseBeforeDecodeV15"}:
            cls = namespace[name]
            self.assertEqual(cls.INPUT_TYPES()["optional"]["keep_loader_cache"], ("BOOLEAN", {"default": False}))
            self.assertEqual(cls.IS_CHANGED(keep_loader_cache=True), cls.IS_CHANGED(keep_loader_cache=True))

    def test_changed_reserve_reexecutes_preparation(self):
        cls = namespace["NanFengH3ReleaseAtStartV15"]
        mm.EXTRA_RESERVED_VRAM = 1024**3
        self.assertTrue(math.isnan(cls.IS_CHANGED(keep_loader_cache=True, reserved_vram_gb=0)))
        mm.EXTRA_RESERVED_VRAM = 0
        self.assertEqual(cls.IS_CHANGED(keep_loader_cache=True, reserved_vram_gb=0), "reuse-loader-cache")

    def test_sampling_and_decode_still_release_and_preserve_results(self):
        released.clear()
        model, conditioning, latent = object(), object(), object()
        self.assertEqual(namespace["NanFengH3ReleaseBeforeSamplingV15"]().release(model, conditioning, latent), (model, conditioning, latent))
        self.assertEqual(namespace["NanFengH3ReleaseBeforeDecodeV15"]().release(latent), (latent,))
        self.assertEqual(len(released), 2)

    def test_generator_declares_optional_reuse_and_passes_it_to_three_barriers(self):
        labels = [node for node in ast.walk(tree) if isinstance(node, ast.Assign) and isinstance(node.value, ast.Tuple) and node.value.elts and isinstance(node.value.elts[0], ast.Constant) and node.value.elts[0].value == "BOOLEAN" and any(isinstance(target, ast.Subscript) and isinstance(target.slice, ast.Constant) and target.slice.value == "复用加载器缓存" for target in node.targets)]
        self.assertEqual(len(labels), 1)
        self.assertEqual(ast.literal_eval(labels[0].value), ("BOOLEAN", {"default": False}))
        calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call) and node.args and isinstance(node.args[0], ast.Constant) and node.args[0].value in names and isinstance(node.func, ast.Attribute) and node.func.attr == "node"]
        self.assertEqual(sum(any(keyword.arg == "keep_loader_cache" for keyword in call.keywords) for call in calls), 3)

unittest.main()
