#!/usr/bin/env python
"""定场尾镜合成器：用静帧 + 虚拟摄影机生成固定时长的极速拉远段。

为什么不用生成模型：H3 一次生成整段，镜头时长由它按叙事节奏自己分配，
提示词里的 `At 00:11.000 ... 00:11.500` 只是文字，不是约束；音频和人物运动
也是同帧联合生成的，无法只让"画面冻结、机位后退"。这一镜本质是合成操作，
用静帧做虚拟摄影机可以同时保证：时长精确、画面绝对静止、无任何音效。

用法：
  # 1) 从成片尾帧取一张宽景底板
  python scripts/tail-plate.py extract --video in.mp4 --out plate.png

  # 2) 生成 12 帧（0.5s@24fps）极速拉远段，无音轨
  python scripts/tail-plate.py render --plate plate.png --out tail.mp4 --frames 12

  # 3) 可选：把上一镜最后几帧作为起幅做跨溶解，掩盖接缝
  python scripts/tail-plate.py render --plate plate.png --out tail.mp4 --head prev.png --head-frames 4

  # 4) 拼回主体（主体裁掉原生成拉远段，只保留到 tail-start）
  python scripts/tail-plate.py join --body in.mp4 --tail tail.mp4 --out out.mp4 --tail-start 8.0
"""
from __future__ import annotations

import argparse
import shlex
import subprocess
import sys
from pathlib import Path


def run(cmd: list[str]) -> None:
    print("$", " ".join(shlex.quote(part) for part in cmd), file=sys.stderr)
    subprocess.run(cmd, check=True)


def ffmpeg(*args: str) -> list[str]:
    return ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args]


def probe_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    return float(out)


def cmd_extract(args: argparse.Namespace) -> None:
    # 取最后一帧（-sseof 拉到最后再取 1 帧，避免长片解码）
    run(ffmpeg("-sseof", "-0.4", "-i", args.video, "-frames:v", "1", "-q:v", "1", args.out))


def gray_raw(path: str, w: int, h: int) -> list[int]:
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-vf", f"scale={w}:{h},format=gray",
         "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        capture_output=True, check=True,
    ).stdout
    return list(out)


def match_center(plate: str, head: str, zoom: float, pw: int = 96, ph: int = 54) -> tuple[float, float]:
    """把 head 缩到它在底板里的实际占比，滑窗找最小绝对差，返回归一化中心点。

    纯 Python 实现，图很小（96x54），不依赖 numpy/PIL。
    """
    hw = max(int(round(pw / zoom)), 8)
    hh = max(int(round(ph / zoom)), 6)
    P = gray_raw(plate, pw, ph)
    H = gray_raw(head, hw, hh)
    best = None
    for oy in range(ph - hh + 1):
        for ox in range(pw - hw + 1):
            sad = 0
            for y in range(hh):
                base = (oy + y) * pw + ox
                row = y * hw
                for x in range(hw):
                    sad += abs(P[base + x] - H[row + x])
            if best is None or sad < best[0]:
                best = (sad, ox, oy)
    assert best is not None
    _, ox, oy = best
    cx = (ox + hw / 2) / pw
    cy = (oy + hh / 2) / ph
    return min(max(cx, 0.0), 1.0), min(max(cy, 0.0), 1.0)


def cmd_render(args: argparse.Namespace) -> None:
    frames = args.frames
    fps = args.fps
    last = max(frames - 1, 1)

    cx, cy = args.center_x, args.center_y
    if args.head and args.auto_center:
        cx, cy = match_center(args.plate, args.head, args.zoom_start)
        print(f"auto-center -> x={cx:.3f} y={cy:.3f}", file=sys.stderr)

    # z 从 zoom_start 衰减到 1.0；指数 2 表示起步极快、末段迅速收住（ease-out）
    zexpr = f"1+{args.zoom_start - 1:.6f}*pow(1-min(on/{last},1),{args.ease:.3f})"
    zoompan = (
        f"zoompan=z='{zexpr}':d={frames}"
        f":x='iw*{cx:.4f}-(iw/zoom/2)':y='ih*{cy:.4f}-(ih/zoom/2)'"
        f":s={args.size}:fps={fps}"
    )

    base = ffmpeg("-loop", "1", "-i", args.plate, "-vf", zoompan,
                  "-frames:v", str(frames), "-an",
                  "-c:v", "libx264", "-crf", str(args.crf),
                  "-pix_fmt", "yuv420p", "-r", str(fps), args.out)

    if not args.head or args.head_frames <= 0:
        run(base)
        return

    # 起幅用上一镜真实尾帧做跨溶解：先渲一版纯拉远，再把头几帧与静态头帧混合
    tmp = str(Path(args.out).with_suffix(".plateonly.mp4"))
    run(ffmpeg("-loop", "1", "-i", args.plate, "-vf", zoompan,
               "-frames:v", str(frames), "-an",
               "-c:v", "libx264", "-crf", str(args.crf),
               "-pix_fmt", "yuv420p", "-r", str(fps), tmp))
    hf = args.head_frames
    # 第 0 帧等于上一镜真实尾帧，hf 帧内溶解到虚拟摄影机画面
    fade_d = max(hf / float(args.fps), 1.0 / args.fps)
    filt = (
        f"[1:v]scale={args.size},format=yuva420p,"
        f"fade=t=out:st=0:d={fade_d:.3f}:alpha=1[hd];"
        f"[0:v][hd]overlay=0:0:format=auto[v]"
    )
    run(ffmpeg("-i", tmp, "-loop", "1", "-i", args.head, "-filter_complex", filt,
               "-map", "[v]", "-frames:v", str(frames), "-an",
               "-c:v", "libx264", "-crf", str(args.crf),
               "-pix_fmt", "yuv420p", "-r", str(fps), args.out))
    Path(tmp).unlink(missing_ok=True)


def cmd_join(args: argparse.Namespace) -> None:
    body = probe_duration(Path(args.body))
    keep = body if args.tail_start is None else min(args.tail_start, body)
    # 主体只保留到拉远开始处；音轨在接点做 80ms 淡出，避免硬切爆音
    fade_start = max(keep - 0.08, 0)
    size = args.size
    filt = (
        f"[0:v]trim=0:{keep:.3f},setpts=PTS-STARTPTS,"
        f"scale={size.replace('x', ':')}:force_original_aspect_ratio=decrease,"
        f"pad={size.replace('x', ':')}:(ow-iw)/2:(oh-ih)/2,fps={args.fps},setsar=1[v0];"
        f"[0:a]atrim=0:{keep:.3f},asetpts=PTS-STARTPTS,"
        f"afade=t=out:st={fade_start:.3f}:d=0.08,apad=whole_dur={keep:.3f},atrim=0:{keep:.3f}[a0];"
        f"[1:v]trim=0,setpts=PTS-STARTPTS,"
        f"scale={size.replace('x', ':')}:force_original_aspect_ratio=decrease,"
        f"pad={size.replace('x', ':')}:(ow-iw)/2:(oh-ih)/2,fps={args.fps},setsar=1[v1];"
        f"anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:{args.tail_seconds:.3f}[a1];"
        f"[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]"
    )
    run(ffmpeg("-i", args.body, "-i", args.tail, "-filter_complex", filt,
               "-map", "[v]", "-map", "[a]",
               "-c:v", "libx264", "-crf", str(args.crf), "-pix_fmt", "yuv420p",
               "-c:a", "aac", "-b:a", "192k", args.out))


def motion_curve(video: str, fps: int = 24) -> list[float]:
    """逐帧运动能量：缩放成 96x54 灰度后做帧差，取平均亮度。"""
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", video,
         "-vf", "scale=96:54,format=gray,tblend=all_mode=difference,signalstats,"
                "metadata=print:key=lavfi.signalstats.YAVG:file=-",
         "-an", "-f", "null", "-"],
        capture_output=True, text=True,
    ).stdout
    vals = []
    for line in out.splitlines():
        if "YAVG=" in line:
            try:
                vals.append(float(line.split("YAVG=")[1]))
            except ValueError:
                pass
    return vals


def find_tail_start(curve: list[float], fps: int, floor: float, window: float = 0.5) -> float:
    """从片尾往前找「持续高于本段基线」的运动起点，返回秒数。

    只在最后 window 比例里找，避免把全片的切镜尖峰当基准。
    """
    if not curve:
        return 0.0
    lo = int(len(curve) * (1 - window))
    seg = curve[lo:]
    if not seg:
        return 0.0
    ordered = sorted(seg)
    baseline = ordered[len(ordered) // 2]
    thr = max(floor, baseline * 1.6)
    start = len(curve) - 1
    for i in range(len(curve) - 1, lo, -1):
        if curve[i] > thr and curve[i - 1] <= thr:
            start = i
            break
    # 留 2 帧余量，吃掉拉远起步的缓入
    return round(max(start - 2, 0) / fps, 2)


def cmd_analyze(args: argparse.Namespace) -> None:
    curve = motion_curve(args.video, args.fps)
    if not curve:
        print("no frames")
        return
    start = find_tail_start(curve, args.fps, args.floor)
    print(f"frames={len(curve)} max={max(curve):.1f} suggested tail-start={start:.2f}s")
    step = max(len(curve) // 40, 1)
    for i in range(0, len(curve), step):
        print(f"  {i / args.fps:5.2f}s {curve[i]:5.1f}" + ("  <= tail" if abs(i / args.fps - start) < step / args.fps else ""))


def cmd_batch(args: argparse.Namespace) -> None:
    src = Path(args.dir)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    videos = sorted([p for p in src.glob("*.mp4") if not p.name.endswith(("-tail.mp4", "-out.mp4"))])
    overrides = {}
    if args.map:
        import json as _json
        overrides = {Path(k).stem: float(v) for k, v in _json.loads(Path(args.map).read_text(encoding="utf-8")).items()}
    for video in videos:
        stem = video.stem
        tail_start = overrides.get(stem, args.tail_start)
        if tail_start is None:
            curve = motion_curve(str(video))
            tail_start = find_tail_start(curve, args.fps, args.floor)
        plate = out / f"{stem}-plate.png"
        tail = out / f"{stem}-tail.mp4"
        final = out / f"{stem}-out.mp4"
        head = out / f"{stem}-head.png"
        run(ffmpeg("-sseof", "-0.4", "-i", str(video), "-frames:v", "1", "-q:v", "1", str(plate)))
        run(ffmpeg("-ss", f"{max(tail_start - 0.04, 0):.3f}", "-i", str(video),
                   "-frames:v", "1", "-q:v", "1", str(head)))
        ns = argparse.Namespace(plate=str(plate), out=str(tail), frames=args.frames, fps=args.fps,
                                size=args.size, zoom_start=args.zoom_start, ease=args.ease,
                                head=str(head), head_frames=args.head_frames, crf=args.crf,
                                auto_center=args.auto_center, center_x=0.5, center_y=0.5)
        cmd_render(ns)
        nj = argparse.Namespace(body=str(video), tail=str(tail), out=str(final),
                                tail_start=tail_start, tail_seconds=args.frames / args.fps,
                                size=args.size, fps=args.fps, crf=args.crf)
        cmd_join(nj)
        print(f"{stem}: tail-start={tail_start:.2f}s -> {final}", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description="定场尾镜：静帧虚拟摄影机")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("extract", help="取视频最后一帧")
    p.add_argument("--video", required=True)
    p.add_argument("--out", required=True)
    p.set_defaults(func=cmd_extract)

    p = sub.add_parser("render", help="渲染极速拉远段")
    p.add_argument("--plate", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--frames", type=int, default=12)
    p.add_argument("--fps", type=int, default=24)
    p.add_argument("--size", default="1920x1080")
    p.add_argument("--zoom-start", type=float, default=2.0, help="起幅相对终幅的放大倍数")
    p.add_argument("--ease", type=float, default=2.0, help="衰减指数，越大起步越猛")
    p.add_argument("--head", default="")
    p.add_argument("--head-frames", type=int, default=0)
    p.add_argument("--auto-center", action="store_true", help="用 head 在底板里做模板匹配，自动定起幅中心")
    p.add_argument("--center-x", type=float, default=0.5)
    p.add_argument("--center-y", type=float, default=0.5)
    p.add_argument("--crf", type=int, default=16)
    p.set_defaults(func=cmd_render)

    p = sub.add_parser("join", help="拼回主体")
    p.add_argument("--body", required=True)
    p.add_argument("--tail", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--tail-start", type=float, default=None, help="主体保留到几秒")
    p.add_argument("--tail-seconds", type=float, default=0.5, help="尾段时长（用于补静音）")
    p.add_argument("--size", default="1920x1080")
    p.add_argument("--fps", type=int, default=24)
    p.add_argument("--crf", type=int, default=16)
    p.set_defaults(func=cmd_join)

    p = sub.add_parser("analyze", help="分析成片，定位拉远起点")
    p.add_argument("--video", required=True)
    p.add_argument("--fps", type=int, default=24)
    p.add_argument("--floor", type=float, default=3.0)
    p.set_defaults(func=cmd_analyze)

    p = sub.add_parser("batch", help="批量：目录内每条成片都换掉尾部拉远段")
    p.add_argument("--dir", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--frames", type=int, default=12)
    p.add_argument("--fps", type=int, default=24)
    p.add_argument("--size", default="1920x1080")
    p.add_argument("--zoom-start", type=float, default=2.0)
    p.add_argument("--ease", type=float, default=2.0)
    p.add_argument("--head-frames", type=int, default=4)
    p.add_argument("--auto-center", action="store_true", default=True)
    p.add_argument("--no-auto-center", dest="auto_center", action="store_false")
    p.add_argument("--tail-start", type=float, default=None, help="不填则自动检测")
    p.add_argument("--map", default=None, help='每条片单独指定起点的 JSON，如 {"a":8.0}')
    p.add_argument("--floor", type=float, default=3.0)
    p.add_argument("--crf", type=int, default=16)
    p.set_defaults(func=cmd_batch)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
