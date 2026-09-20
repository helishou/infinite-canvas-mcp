"""Run face-only H3 resampling with ComfyUI's native MiniMax H3 nodes."""

from __future__ import annotations

from typing import Any

import torch

from .inject import inject_video_latent
from .stitch import stitch_faces
from .track import track_and_crop


def _node_args(output):
    args = getattr(output, "args", None)
    if args:
        return args
    if isinstance(output, (tuple, list)):
        return output
    raise RuntimeError(f"ComfyUI returned an unexpected node output: {type(output)!r}")


def _align_frame_count(frame_count: int) -> int:
    count = max(5, int(frame_count))
    return count + ((5 - count) % 17)


def _pad_frames(frames: torch.Tensor, length: int) -> torch.Tensor:
    if frames.shape[0] >= length:
        return frames[:length]
    return torch.cat([frames, frames[-1:].expand(length - frames.shape[0], -1, -1, -1)], dim=0)


def _sample_h3(*, model, positive, latent, seed, cfg, steps, sampler_name, scheduler, denoise,
               shift_video, shift_audio):
    try:
        from comfy_extras.nodes_custom_sampler import (
            BasicGuider,
            BasicScheduler,
            CFGGuider,
            KSamplerSelect,
            RandomNoise,
            SamplerCustomAdvanced,
        )
        from comfy_extras.nodes_minimax_h3 import MiniMaxH3SigmaShift
    except Exception as exc:
        raise RuntimeError(
            "当前 ComfyUI 未提供内置 MiniMax H3 采样节点，无法执行局部人脸精修。"
        ) from exc

    model_use = _node_args(
        MiniMaxH3SigmaShift.execute(model, float(shift_video), float(shift_audio))
    )[0]
    sigmas = _node_args(
        BasicScheduler.execute(model_use, str(scheduler), int(steps), float(denoise))
    )[0]
    sampler = _node_args(KSamplerSelect.execute(str(sampler_name)))[0]
    noise = _node_args(RandomNoise.execute(int(seed)))[0]
    if abs(float(cfg) - 1.0) < 1e-6:
        guider = _node_args(BasicGuider.execute(model_use, positive))[0]
    else:
        guider = _node_args(CFGGuider.execute(model_use, positive, [], float(cfg)))[0]
    return _node_args(
        SamplerCustomAdvanced.execute(noise, guider, sampler, sigmas, latent)
    )[0]


def apply_face_refine(
    *,
    frames: torch.Tensor,
    references: list[tuple[int, torch.Tensor]],
    prompt: str,
    ref_image_size: str,
    pack: dict[str, Any],
    model,
    vae,
    audio_vae,
    clip,
    seed: int,
    cfg: float,
    shift_video: float,
    shift_audio: float,
) -> tuple[torch.Tensor, str]:
    """Track one face, resample its crops with native H3, then paste them back."""
    if not isinstance(frames, torch.Tensor) or frames.ndim != 4 or frames.shape[0] < 1:
        raise ValueError("FaceRefine 需要解码后的视频帧 [N,H,W,C]。")
    if audio_vae is None:
        raise ValueError("H3 局部人脸精修需要 audio_vae。")

    base = frames[..., :3].contiguous().float().cpu()
    crops, transform, track_note = track_and_crop(base, pack)
    if crops is None or transform is None:
        return base, track_note

    canvas_w, canvas_h = transform["canvas"]
    sample_length = _align_frame_count(crops.shape[0])
    crop_input = _pad_frames(crops, sample_length)
    # ComfyUI 的 MiniMaxH3ReferenceToVideo ref_images 槽位从 0 开始；
    # 节点 UI 为了保持 reference_1...reference_9 的用户命名，从 1 开始收集，
    # 这里必须在进入原生 H3 节点前转换为 ref_image_0...ref_image_8。
    ref_images = {
        f"ref_image_{index - 1}": reference[:1]
        for index, reference in references
    } or None

    try:
        from comfy_extras.nodes_minimax_h3 import MiniMaxH3ReferenceToVideo
    except Exception as exc:
        raise RuntimeError(
            "当前 ComfyUI 未提供内置 MiniMax H3 Reference to Video 节点。"
        ) from exc

    conditioning = _node_args(
        MiniMaxH3ReferenceToVideo.execute(
            clip=clip,
            prompt=str(prompt or "a person, face close-up"),
            width=int(canvas_w),
            height=int(canvas_h),
            length=int(sample_length),
            ref_image_size=str(ref_image_size or "match"),
            vae=vae,
            audio_vae=audio_vae,
            ref_images=ref_images,
            ref_videos=None,
            ref_video_audios=None,
            ref_audios=None,
        )
    )
    positive, latent = conditioning[:2]
    latent = inject_video_latent(latent, crop_input, vae)
    sampled = _sample_h3(
        model=model,
        positive=positive,
        latent=latent,
        seed=int(seed),
        cfg=float(cfg),
        steps=int(pack.get("steps") or 8),
        sampler_name=str(pack.get("sampler") or "euler"),
        scheduler=str(pack.get("scheduler") or "simple"),
        denoise=float(pack.get("denoise") or 0.4),
        shift_video=float(shift_video),
        shift_audio=float(shift_audio),
    )

    from nodes import VAEDecode

    refined, = VAEDecode().decode(vae, sampled)
    if not isinstance(refined, torch.Tensor) or refined.ndim != 4:
        raise RuntimeError("FaceRefine 解码没有返回有效的视频帧。")
    refined = refined[: crops.shape[0], ..., :3].float().cpu()
    refined = _pad_frames(refined, crops.shape[0])
    stitched = stitch_faces(base, refined, transform, pack)
    report = (
        f"{track_note}; H3 crop resample {pack.get('sampler')} "
        f"steps={pack.get('steps')} denoise={float(pack.get('denoise') or 0):.2f} "
        f"seed={int(seed)}; references={len(references)}"
    )
    return stitched[: base.shape[0]].contiguous().cpu().float(), report
