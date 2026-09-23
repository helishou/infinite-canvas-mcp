#!/usr/bin/env python3
"""量测图片的 CIE-LAB 均值（L* / a* / b*），用于色温漂移的量化判据。

为什么需要它：用户说「发黄」「色调不一致」时，肉眼与主观形容词无法比较、也无法验收。
LAB 的 b* 是唯一能跨图比较、可定容差、可重复的判据（越大越黄）。

用法：
    python lab_bstar.py <图片路径> [更多图片...]
    python lab_bstar.py --ref <基准图> <待测图>...     # 相对基准输出偏差 ΔL / Δb*

容差参考（本链路实测口径）：b* ±1.5、L* ±3.0 以内视为同一基准。

判据纪律：
  - 排查「色温不一致」先量**宫格原图**，再量视频 —— 宫格之间就已经差约 3.0 时，
    问题在上游生成环节，不在 H3，也不在洗图。
  - 一个指标 = 一个结论来源。色偏/亮度只在做「画风或参考图处理程度」类 A/B 时才是主指标；
    提示词类改动先验动作。
"""
import sys

import numpy as np
from PIL import Image

TOLERANCE_B = 1.5
TOLERANCE_L = 3.0

# sRGB -> linear -> XYZ(D65) -> LAB 的固定矩阵
_M = np.array([[0.4124, 0.3576, 0.1805],
               [0.2126, 0.7152, 0.0722],
               [0.0193, 0.1192, 0.9505]])
_WP = np.array([0.95047, 1.0, 1.08883])


def lab_of(path: str, sample: int = 700):
    """返回该图的 (L*, a*, b*) 均值。先缩略到 sample 边长，避免大图拖慢。"""
    im = Image.open(path).convert("RGB")
    im.thumbnail((sample, sample))
    rgb = np.asarray(im).astype(np.float32) / 255.0
    lin = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    xyz = (lin @ _M.T) / _WP
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    L = 116 * f[..., 1] - 16
    a = 500 * (f[..., 0] - f[..., 1])
    b = 200 * (f[..., 1] - f[..., 2])
    return float(L.mean()), float(a.mean()), float(b.mean())


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 1

    ref_path = None
    if "--ref" in args:
        i = args.index("--ref")
        try:
            ref_path = args[i + 1]
        except IndexError:
            print("用法错误：--ref 后面要跟基准图路径")
            return 1
        args = args[:i] + args[i + 2:]

    if ref_path:
        rL, ra, rb = lab_of(ref_path)
        print(f"基准  L*={rL:6.2f}  a*={ra:+6.2f}  b*={rb:+6.2f}  {ref_path}")
        print(f"容差  b* ±{TOLERANCE_B}   L* ±{TOLERANCE_L}\n")

    bad = 0
    for path in args:
        try:
            L, a, b = lab_of(path)
        except Exception as exc:  # 单张读不了不该中断整批
            print(f"  ✗ 读取失败 {path}: {exc}")
            bad += 1
            continue
        if ref_path:
            dL, db = L - rL, b - rb
            flag = "✓" if (abs(db) <= TOLERANCE_B and abs(dL) <= TOLERANCE_L) else \
                   ("✗ 偏黄" if db > TOLERANCE_B else "✗ 偏蓝" if db < -TOLERANCE_B else "✗ 偏亮" if dL > 0 else "✗ 偏暗")
            if flag != "✓":
                bad += 1
            print(f"  ΔL={dL:+6.2f}  Δb*={db:+6.2f}  {flag:8s} {path}")
        else:
            print(f"  L*={L:6.2f}  a*={a:+6.2f}  b*={b:+6.2f}  {path}")

    if ref_path:
        print(f"\n{'全部在容差内' if bad == 0 else f'{bad} 项偏离基准'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
