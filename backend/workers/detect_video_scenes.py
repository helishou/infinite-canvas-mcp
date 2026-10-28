"""Detect video shot boundaries with PySceneDetect AdaptiveDetector.

The script is intentionally a small JSON bridge for the Backend process. Keep
stdout machine-readable; diagnostics and dependency errors go to stderr.
"""
import json
import sys


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: detect_video_scenes.py VIDEO_PATH", file=sys.stderr)
        return 2

    try:
        from scenedetect import AdaptiveDetector, detect
    except ImportError:
        print(
            "PySceneDetect is missing. Install backend/workers/requirements-video-shot-detection.txt "
            "in the Python environment used by Backend.",
            file=sys.stderr,
        )
        return 3

    scenes = detect(
        sys.argv[1],
        AdaptiveDetector(min_scene_len=0.2, adaptive_threshold=3.0, min_content_val=10.0),
        show_progress=False,
    )
    cuts = [
        {"frame": start.frame_num, "time": start.seconds}
        for start, _end in scenes[1:]
    ]
    print(json.dumps({"cuts": cuts}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
