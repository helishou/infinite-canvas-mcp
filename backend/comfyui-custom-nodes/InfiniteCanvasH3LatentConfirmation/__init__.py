"""Durable confirmation boundary in the native NanFeng V15 latent two-pass graph."""

from copy import deepcopy
from pathlib import Path
import os
import re
import tempfile

import folder_paths
import nodes
import torch
from comfy.nested_tensor import NestedTensor


def checkpoint_path(checkpoint_id):
    if not re.fullmatch(r"[a-f0-9]{64}", checkpoint_id):
        raise ValueError("Invalid H3 checkpoint identity")
    return Path(folder_paths.get_output_directory()) / "infinite-canvas-h3-confirmation" / (checkpoint_id + ".pt")


def pack(value):
    """Only tensors and primitive containers cross the weights-only disk boundary."""
    if isinstance(value, NestedTensor):
        return {"__h3_nested__": [pack(t) for t in value.unbind()]}
    if isinstance(value, torch.Tensor):
        return value.detach().cpu()
    if isinstance(value, dict):
        return {key: pack(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return type(value)(pack(item) for item in value)
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise ValueError(f"Unsupported H3 checkpoint value: {type(value).__name__}")


def unpack(value):
    if isinstance(value, dict):
        if set(value) == {"__h3_nested__"}:
            return NestedTensor([unpack(t) for t in value["__h3_nested__"]])
        return {key: unpack(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return type(value)(unpack(item) for item in value)
    return value


class SaveH3Checkpoint:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"latent": ("LATENT",), "conditioning": ("CONDITIONING",),
                             "sigmas": ("SIGMAS",), "checkpoint_id": ("STRING",)}}

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "save"
    CATEGORY = "Infinite Canvas/H3"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def save(self, latent, conditioning, sigmas, checkpoint_id):
        target = checkpoint_path(checkpoint_id)
        target.parent.mkdir(parents=True, exist_ok=True)
        payload = pack({"version": 1, "checkpoint_id": checkpoint_id, "latent": latent,
                        "conditioning": conditioning, "sigmas": sigmas})
        fd, temporary = tempfile.mkstemp(dir=target.parent, suffix=".tmp")
        os.close(fd)
        try:
            torch.save(payload, temporary)
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        # Decoding the denoised first-pass output forces persistence before success.
        return (latent,)


class LoadH3Checkpoint:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"checkpoint_id": ("STRING",)}}

    RETURN_TYPES = ("LATENT", "CONDITIONING", "SIGMAS")
    FUNCTION = "load"
    CATEGORY = "Infinite Canvas/H3"

    @classmethod
    def IS_CHANGED(cls, checkpoint_id):
        # Upscaling may mutate tensors/conditioning. Every explicit retry must
        # reload the original disk snapshot, never reuse a mutated cache object.
        return float("nan")

    def load(self, checkpoint_id):
        target = checkpoint_path(checkpoint_id)
        if not target.exists():
            raise ValueError("一采潜变量快照缺失；请保留一采或重新生成，不能从头自动重跑")
        payload = torch.load(target, map_location="cpu", weights_only=True)
        if payload.get("version") != 1 or payload.get("checkpoint_id") != checkpoint_id:
            raise ValueError("H3 checkpoint version or identity mismatch")
        payload = unpack(payload)
        return (payload["latent"], payload["conditioning"], payload["sigmas"])


def prune(graph, result):
    """Keep only ancestors of native outputs, so no disconnected sampler can run."""
    needed = set()

    def visit(value):
        if isinstance(value, (list, tuple)) and len(value) == 2 and isinstance(value[0], str) and isinstance(value[1], int) and value[0] in graph:
            node_id = value[0]
            if node_id not in needed:
                needed.add(node_id)
                visit(graph[node_id]["inputs"])
        elif isinstance(value, dict):
            for item in value.values():
                visit(item)
        elif isinstance(value, (list, tuple)):
            for item in value:
                visit(item)

    visit(result)
    return {key: value for key, value in graph.items() if key in needed}


def split_confirmation(expansion, phase, checkpoint_id, te_accel=False):
    graph = deepcopy(expansion["expand"])
    upscalers = [key for key, value in graph.items() if value["class_type"] == "NanFengH3LowPeakLatentUpscalerV15"]
    if len(upscalers) != 1:
        raise ValueError("H3 native latent two-pass graph has changed; cannot establish confirmation boundary")
    upscale = graph[upscalers[0]]
    first_id, first_output = upscale["inputs"]["latent"]
    first = graph[first_id]
    if first["class_type"] != "SamplerCustomAdvanced" or first_output != 1:
        raise ValueError("H3 first-pass denoised latent is not available")
    sigma_id, sigma_output = first["inputs"]["sigmas"]
    if graph[sigma_id]["class_type"] != "SplitSigmas" or sigma_output != 0:
        raise ValueError("H3 first-pass sigma boundary is not available")
    seconds = [key for key, value in graph.items() if value["class_type"] == "SamplerCustomAdvanced" and value["inputs"].get("sigmas") == [sigma_id, 1]]
    if len(seconds) != 1:
        raise ValueError("H3 remaining second-pass sigmas are not available")
    second_id = seconds[0]
    guider = graph[first["inputs"]["guider"][0]]
    condition_link = guider["inputs"]["conditioning"]
    ready_id, condition_output = condition_link
    ready = graph[ready_id]
    if ready["class_type"] != "NanFengH3ReleaseBeforeSamplingV15" or condition_output != 1:
        raise ValueError("H3 native sampling release boundary has changed")
    checkpoint = first_id + "_confirmation_checkpoint"
    if te_accel:
        te_id = checkpoint + "_te"
        graph[te_id] = {"class_type": "TESpeedMiniMaxH3", "inputs": {
            "model": ready["inputs"]["model"], "processing_control_value": 0.08,
            "processing_percent_1": 0.1, "processing_percent_2": 0.9, "mcs": 2,
            "device": "auto", "mode": "standard"}}
        ready["inputs"]["model"] = [te_id, 0]
    if phase == "first":
        graph[checkpoint] = {"class_type": "InfiniteCanvasH3SaveCheckpoint", "inputs": {
            "latent": [first_id, 1], "conditioning": condition_link,
            "sigmas": [sigma_id, 1], "checkpoint_id": checkpoint_id}}
        # Replace the final sample with a durable first-pass preview.
        for value in graph.values():
            for key, item in value["inputs"].items():
                if isinstance(item, (list, tuple)) and len(item) == 2 and item[0] == second_id:
                    value["inputs"][key] = [checkpoint, 0]
    elif phase == "second":
        # Validate availability before returning any runnable expansion.
        checkpoint_path(checkpoint_id)
        if not checkpoint_path(checkpoint_id).is_file():
            raise ValueError("一采潜变量快照缺失；请保留一采或重新生成")
        graph[checkpoint] = {"class_type": "InfiniteCanvasH3LoadCheckpoint", "inputs": {"checkpoint_id": checkpoint_id}}
        for value in graph.values():
            for key, item in value["inputs"].items():
                if item == [first_id, 1]:
                    value["inputs"][key] = [checkpoint, 0]
                elif item == condition_link:
                    value["inputs"][key] = [checkpoint, 1]
        ready["inputs"]["conditioning"] = [checkpoint, 1]
        ready["inputs"]["latent"] = [checkpoint, 0]
        graph[second_id]["inputs"]["sigmas"] = [checkpoint, 2]
    else:
        raise ValueError("Invalid H3 confirmation phase")
    expansion = {**expansion, "expand": prune(graph, expansion["result"])}
    if phase == "first" and upscalers[0] in expansion["expand"]:
        raise ValueError("H3 first-pass graph still reaches latent upscaling")
    if phase == "second" and first_id in expansion["expand"]:
        raise ValueError("H3 second-pass graph still reaches first-pass sampling")
    return expansion


class ConfirmedGeneratorV15:
    RETURN_TYPES = ("IMAGE", "AUDIO", "FLOAT", "VIDEO", "STRING")
    FUNCTION = "generate"
    CATEGORY = "Infinite Canvas/H3"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    @classmethod
    def INPUT_TYPES(cls):
        schema = deepcopy(nodes.NODE_CLASS_MAPPINGS["NanFengH3MultiReferenceGeneratorV15"].INPUT_TYPES())
        schema["required"].update({"checkpoint_phase": (["first", "second"],),
                                   "checkpoint_id": ("STRING",), "checkpoint_te_accel": ("BOOLEAN", {"default": False})})
        return schema

    def generate(self, checkpoint_phase, checkpoint_id, checkpoint_te_accel=False, **kwargs):
        checkpoint_path(checkpoint_id)
        if kwargs.get("启用H3潜空间放大二采") is not True or kwargs.get("启用潜空间续写") is True:
            raise ValueError("H3 confirmation requires latent upscaling without Motion Context")
        native = nodes.NODE_CLASS_MAPPINGS["NanFengH3MultiReferenceGeneratorV15"]()
        expansion = getattr(native, native.FUNCTION)(**kwargs)
        return split_confirmation(expansion, checkpoint_phase, checkpoint_id, checkpoint_te_accel)


NODE_CLASS_MAPPINGS = {
    "InfiniteCanvasH3ConfirmedGeneratorV15": ConfirmedGeneratorV15,
    "InfiniteCanvasH3SaveCheckpoint": SaveH3Checkpoint,
    "InfiniteCanvasH3LoadCheckpoint": LoadH3Checkpoint,
}
