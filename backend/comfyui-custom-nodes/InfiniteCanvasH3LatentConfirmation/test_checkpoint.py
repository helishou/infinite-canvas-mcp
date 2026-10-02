"""CPU-only tests: no model loading, generation or connection to ComfyUI."""
import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path

import torch

# Supply only the host entrypoints; use ComfyUI's real NestedTensor implementation.
root = Path(__file__).parent
temporary = tempfile.TemporaryDirectory()
sys.modules["folder_paths"] = types.SimpleNamespace(get_output_directory=lambda: temporary.name)
sys.modules["nodes"] = types.SimpleNamespace(NODE_CLASS_MAPPINGS={})
spec = importlib.util.spec_from_file_location("checkpoint_nodes", root / "__init__.py")
checkpoint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checkpoint)


def native_graph(fl=False):
    graph = {
        "model": {"class_type": "UNETLoader", "inputs": {}},
        "condition": {"class_type": "Conditioning", "inputs": {}},
        "ready": {"class_type": "NanFengH3ReleaseBeforeSamplingV15", "inputs": {"model": ["model", 0], "conditioning": ["condition", 0], "latent": ["condition", 1]}},
        "guider": {"class_type": "BasicGuider", "inputs": {"model": ["ready", 0], "conditioning": ["ready", 1]}},
        "split": {"class_type": "SplitSigmas", "inputs": {}},
        "first": {"class_type": "SamplerCustomAdvanced", "inputs": {"guider": ["guider", 0], "sigmas": ["split", 0], "latent_image": ["ready", 2]}},
        "upscale": {"class_type": "NanFengH3LowPeakLatentUpscalerV15", "inputs": {"latent": ["first", 1]}},
        "clear": {"class_type": "NanFengH3ClearUpscalerCacheResidentV15", "inputs": {"latent": ["upscale", 0], "conditioning": ["ready", 1]}},
        "second_guider": {"class_type": "BasicGuider", "inputs": {"model": ["ready", 0], "conditioning": ["clear", 1]}},
        "second": {"class_type": "SamplerCustomAdvanced", "inputs": {"guider": ["second_guider", 0], "latent_image": ["clear", 0], "sigmas": ["split", 1]}},
        "decode": {"class_type": "NanFengH3TimedVideoVAEDecodeV15", "inputs": {"samples": ["second", 0]}},
        "audio": {"class_type": "NanFengH3TimedAudioVAEDecodeV15", "inputs": {"samples": ["second", 0]}},
    }
    if fl:
        graph["sync"] = {"class_type": "H3LatentUpscalerNode3DV3", "inputs": {"latent": ["upscale", 0], "positive": ["ready", 1]}}
        graph["clear"]["inputs"] = {"latent": ["sync", 0], "conditioning": ["sync", 1]}
    return {"expand": graph, "result": (["decode", 0], ["audio", 0])}


class CheckpointTests(unittest.TestCase):
    def setUp(self):
        self.identity = "a" * 64
        self.latent = {"samples": checkpoint.NestedTensor([torch.ones(1, 2, 3), torch.zeros(1, 4)]), "noise_mask": torch.ones(1)}
        self.conditioning = [[torch.ones(1, 3), {"reference_audio": torch.ones(2), "nested": checkpoint.NestedTensor([torch.ones(1)])}]]
        self.sigmas = torch.tensor([0.35, 0.22, 0.12, 0.05, 0.0])
        checkpoint.SaveH3Checkpoint().save(self.latent, self.conditioning, self.sigmas, self.identity)

    def test_disk_roundtrip_av_and_conditioning(self):
        latent, conditioning, sigmas = checkpoint.LoadH3Checkpoint().load(self.identity)
        self.assertIsInstance(latent["samples"], checkpoint.NestedTensor)
        self.assertEqual(len(latent["samples"].unbind()), 2)
        torch.testing.assert_close(latent["samples"].unbind()[0], self.latent["samples"].unbind()[0])
        torch.testing.assert_close(latent["samples"].unbind()[1], self.latent["samples"].unbind()[1])
        torch.testing.assert_close(latent["noise_mask"], self.latent["noise_mask"])
        torch.testing.assert_close(sigmas, self.sigmas)
        torch.testing.assert_close(conditioning[0][0], self.conditioning[0][0])
        self.assertIsInstance(conditioning[0][1]["nested"], checkpoint.NestedTensor)

    def test_first_pass_has_no_upscaler_or_second_sampler(self):
        graph = checkpoint.split_confirmation(native_graph(), "first", self.identity)["expand"]
        self.assertIn("first", graph)
        self.assertNotIn("upscale", graph)
        self.assertNotIn("second", graph)
        self.assertEqual(graph["decode"]["inputs"]["samples"], ["first_confirmation_checkpoint", 0])
        self.assertEqual(graph["first_confirmation_checkpoint"]["inputs"]["latent"], ["first", 1])

    def test_second_only_loads_original_checkpoint_and_keeps_fl_sync(self):
        for fl in (False, True):
            graph = checkpoint.split_confirmation(native_graph(fl), "second", self.identity, True)["expand"]
            self.assertNotIn("first", graph)
            self.assertNotIn("condition", graph)
            self.assertNotIn("split", graph)
            self.assertIn("upscale", graph)
            self.assertIn("second", graph)
            self.assertEqual("sync" in graph, fl)
            self.assertEqual(graph["second"]["inputs"]["sigmas"], ["first_confirmation_checkpoint", 2])
            self.assertEqual(graph["upscale"]["inputs"]["latent"], ["first_confirmation_checkpoint", 0])
            self.assertIn("first_confirmation_checkpoint_te", graph)

    def test_missing_or_foreign_checkpoint_never_falls_back_to_sampling(self):
        with self.assertRaisesRegex(ValueError, "快照缺失"):
            checkpoint.split_confirmation(native_graph(), "second", "b" * 64)
        with self.assertRaisesRegex(ValueError, "快照缺失"):
            checkpoint.LoadH3Checkpoint().load("b" * 64)
        with self.assertRaisesRegex(ValueError, "identity"):
            checkpoint.checkpoint_path("../outside")

    def test_native_graph_drift_rejects(self):
        graph = native_graph()
        graph["expand"]["upscale"]["inputs"]["latent"] = ["first", 0]
        with self.assertRaisesRegex(ValueError, "denoised latent"):
            checkpoint.split_confirmation(graph, "first", self.identity)


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        temporary.cleanup()
