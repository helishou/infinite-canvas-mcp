"""Canvas style-transfer bridge (vendored ImageF "只还原风格" algorithm).

License: PolyForm Noncommercial 1.0.0 — see style_transfer/LICENSE.txt.
Keep stdout machine-readable (one JSON result); logs and errors go to stderr.

usage: style_transfer_worker.py STYLE_IMAGE TARGET_IMAGE OUT_PNG OPTIONS_JSON
OPTIONS_JSON: {"strength": 1.0, "kind": "auto", "keep_black": false, "bg_follow": false, "scale": null}
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, os.path.join(HERE, "style_transfer"))

KINDS = ("auto", "scene", "region", "character")


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    if len(sys.argv) != 5:
        print("usage: style_transfer_worker.py STYLE_IMAGE TARGET_IMAGE OUT_PNG OPTIONS_JSON", file=sys.stderr)
        return 2
    style_path, target_path, out_path, options_raw = sys.argv[1:5]
    try:
        options = json.loads(options_raw or "{}")
    except ValueError:
        print("OPTIONS_JSON 不是合法 JSON", file=sys.stderr)
        return 2
    kind = str(options.get("kind") or "auto")
    if kind not in KINDS:
        print(f"kind 必须是 {'/'.join(KINDS)}，收到 {kind}", file=sys.stderr)
        return 2

    try:
        import cv2  # noqa: F401
        import numpy  # noqa: F401
    except ImportError:
        print(
            "风格迁移依赖缺失：请在 Backend 使用的 Python 环境安装 "
            "backend/workers/requirements-style-transfer.txt（numpy、opencv-python-headless）。",
            file=sys.stderr,
        )
        return 3

    from mj_io import InputError, with_alpha
    from mj_style_only import read_pair, style_only

    def log(message):
        print(message, file=sys.stderr, flush=True)

    try:
        strength = float(options.get("strength", 1.0))
        scale = options.get("scale")
        scale = float(scale) if scale is not None else None
        mj8, g8, g_alpha = read_pair(style_path, target_path)
        out8, _wb, _extra = style_only(
            mj8, g8, scale=scale, strength=strength, log=log,
            keep_black_on=bool(options.get("keep_black")),
            bg_follow=bool(options.get("bg_follow")), kind=kind,
        )
        # 调用方只在成功退出后读文件，无需原子替换；os.replace 会在 Windows 上与杀毒软件锁竞争。
        ok, buf = cv2.imencode(".png", with_alpha(out8, g_alpha))
        if not ok:
            raise IOError(f"无法编码结果图：{out_path}")
        with open(out_path, "wb") as f:
            f.write(buf.tobytes())
    except InputError as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception as error:  # noqa: BLE001 - worker boundary: report any algorithm failure
        print(f"风格迁移失败：{error}", file=sys.stderr)
        return 1

    height, width = out8.shape[:2]
    print(json.dumps({"ok": True, "out": out_path, "width": int(width), "height": int(height)}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())