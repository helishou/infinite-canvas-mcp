"""Infinite Canvas' self-contained MiniMax H3 face-refinement node."""

from __future__ import annotations

import torch
from .face_refine.runtime import apply_face_refine, apply_full_frame_refine


class InfiniteCanvasH3FaceRefine:
    @classmethod
    def INPUT_TYPES(cls):
        optional = {f"reference_{index}": ("IMAGE",) for index in range(1, 10)}
        return {
            "required": {
                "images": ("IMAGE",),
                "audio": ("AUDIO",),
                "model": ("MODEL",),
                "vae": ("VAE",),
                "audio_vae": ("VAE",),
                "clip": ("CLIP",),
                "prompt": ("STRING", {"default": "", "multiline": True}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF}),
                "cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 30.0, "step": 0.01}),
                "shift_video": ("FLOAT", {"default": 12.0, "min": 0.01, "max": 100.0, "step": 0.01}),
                "shift_audio": ("FLOAT", {"default": 3.0, "min": 0.01, "max": 100.0, "step": 0.01}),
                "detector": ("STRING", {"default": "face_yolov8m.pt"}),
                "confidence": ("FLOAT", {"default": 0.35, "min": 0.05, "max": 0.95, "step": 0.05}),
                "crop_factor": ("FLOAT", {"default": 2.5, "min": 1.2, "max": 8.0, "step": 0.1}),
                "canvas_size": ("INT", {"default": 768, "min": 128, "max": 1344, "step": 32}),
                "denoise": ("FLOAT", {"default": 0.4, "min": 0.02, "max": 1.0, "step": 0.01}),
                "steps": ("INT", {"default": 8, "min": 1, "max": 50}),
                "sampler": ("STRING", {"default": "euler"}),
                "scheduler": ("STRING", {"default": "simple"}),
                "paste_region": (["face_only", "face_ellipse", "full_crop"],),
                "mask_dilation": ("INT", {"default": 16, "min": 0, "max": 256}),
                "feather": ("INT", {"default": 24, "min": 0, "max": 256}),
                "colour_match": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "blend": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "ref_image_size": (["match", "max"],),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("IMAGE", "AUDIO", "STRING")
    RETURN_NAMES = ("images", "audio", "report")
    FUNCTION = "refine"
    CATEGORY = "InfiniteCanvas/MiniMaxH3"

    def refine(
        self, images, audio, model, vae, audio_vae, clip, prompt, seed, cfg,
        shift_video, shift_audio, detector, confidence, crop_factor, canvas_size,
        denoise, steps, sampler, scheduler, paste_region, mask_dilation, feather,
        colour_match, blend, ref_image_size="match", **kwargs,
    ):
        if not isinstance(images, torch.Tensor) or images.ndim != 4 or images.shape[0] < 1:
            raise ValueError("人脸精修需要一采视频帧 IMAGE。")
        ref_items = []
        for index in range(1, 10):
            reference = kwargs.get(f"reference_{index}")
            if reference is None:
                continue
            if not isinstance(reference, torch.Tensor) or reference.ndim != 4 or reference.shape[0] < 1:
                raise ValueError(f"第 {index} 张人物参考图不是有效的 IMAGE。")
            ref_items.append((index, reference[:1]))
        pack = {
            "enabled": True,
            "detector": str(detector or "face_yolov8m.pt"),
            "confidence": float(confidence),
            "crop_factor": float(crop_factor),
            "canvas_width": int(canvas_size),
            "canvas_height": int(canvas_size),
            "canvas_mode": "manual",
            "select": "largest_face",
            "denoise": float(denoise),
            "steps": int(steps),
            "sampler": str(sampler or "euler"),
            "scheduler": str(scheduler or "simple"),
            "seed_mode": "inherit",
            "paste_region": str(paste_region or "face_only"),
            "mask_dilation": int(mask_dilation),
            "feather": int(feather),
            "colour_match": float(colour_match),
            "blend": float(blend),
        }
        refined, report = apply_face_refine(
            frames=images,
            references=ref_items,
            prompt=str(prompt or ""),
            ref_image_size=str(ref_image_size or "match"),
            pack=pack,
            model=model,
            vae=vae,
            audio_vae=audio_vae,
            clip=clip,
            seed=int(seed),
            cfg=float(cfg),
            shift_video=float(shift_video),
            shift_audio=float(shift_audio),
        )
        return refined, audio, str(report)


class MiniMaxH3PostGenerationFullFrameRefine:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE",), "audio": ("AUDIO",), "model": ("MODEL",),
            "vae": ("VAE",), "audio_vae": ("VAE",), "clip": ("CLIP",),
            "prompt": ("STRING", {"default": "", "multiline": True}),
            "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF}),
            "steps": ("INT", {"default": 4, "min": 1, "max": 100}),
            "denoise": ("FLOAT", {"default": 0.28, "min": 0.01, "max": 1.0}),
            "sampler": ("STRING", {"default": "res_multistep"}),
            "scheduler": ("STRING", {"default": "simple"}),
            "target_megapixels": ("FLOAT", {"default": 0.4, "min": 0.1, "max": 2.0}),
        }, "optional": {
            "cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 30.0}),
            "shift_video": ("FLOAT", {"default": 12.0}),
            "shift_audio": ("FLOAT", {"default": 3.0}),
        }}

    RETURN_TYPES = ("IMAGE", "AUDIO")
    RETURN_NAMES = ("images", "audio")
    FUNCTION = "refine"
    CATEGORY = "InfiniteCanvas/MiniMaxH3"

    def refine(self, images, audio, model, vae, audio_vae, clip, prompt, seed,
               steps, denoise, sampler, scheduler, target_megapixels,
               cfg=1.0, shift_video=12.0, shift_audio=3.0):
        refined = apply_full_frame_refine(
            frames=images, model=model, vae=vae, audio_vae=audio_vae, clip=clip,
            prompt=prompt, seed=seed, steps=steps, denoise=denoise,
            sampler=sampler, scheduler=scheduler, target_megapixels=target_megapixels,
            cfg=cfg, shift_video=shift_video, shift_audio=shift_audio,
        )
        return refined, audio


NODE_CLASS_MAPPINGS = {
    "InfiniteCanvasH3FaceRefine": InfiniteCanvasH3FaceRefine,
    "MiniMaxH3PostGenerationFullFrameRefine": MiniMaxH3PostGenerationFullFrameRefine,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "InfiniteCanvasH3FaceRefine": "Infinite Canvas H3 Face Refine",
    "MiniMaxH3PostGenerationFullFrameRefine": "MiniMax H3 Full Frame Refine",
}
