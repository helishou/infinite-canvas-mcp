#!/usr/bin/env python3
"""通过本地 chatgpt2api 读图（Chat Completions 多模态）。

用途：抽帧后逐帧做画面/动作判读。当自带 vision 通道不可用时，本脚本是等价替代
（返回文本、判据不变），不要因为一条通道不通就跳过画面/动作核对。

用法：
  python vision_via_api.py <图片路径> [提问] [模型]

依赖：本地 chatgpt2api 在 127.0.0.1:8000（`/v1/chat/completions`，需图像模型）。
注意：模型名因环境而异；默认依次尝试下述三个，全失败再报错。
"""
import base64
import io
import json
import os
import sys
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8000/v1/chat/completions"
KEY = "chatgpt2api"
MODELS = ["gpt-5-6", "gpt-5-5-mini", "gpt-5-5"]

# 动作判读默认提问：只问动作，不谈画质（两者混在一问里会得到模糊答案）
DEFAULT_Q = (
    "只回答动作，不要谈色调画质。严格回答：1)画面里有几个人？"
    "2)每个人在做什么动作（站立/坐/低头/抬头/转身）？3)人物朝向（面向左/右/镜头）？"
    "4)手上有没有拿东西、拿的什么？5)两人之间有没有视线交流？用一句话，不要展开。"
)


def encode_image(path: str) -> str:
    """读图并编码。大图先缩到最长边 1536，避免请求体过大被拒。"""
    from PIL import Image

    im = Image.open(path)
    if im.mode not in ("RGB", "L"):
        im = im.convert("RGB")
    w, h = im.size
    longest = max(w, h)
    if longest > 1536:
        scale = 1536 / longest
        im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "PNG" if path.lower().endswith(".png") else "JPEG", quality=92)
    return base64.b64encode(buf.getvalue()).decode()


def ask(path: str, question: str = DEFAULT_Q, model: str | None = None) -> str:
    if not os.path.exists(path):
        return f"图片不存在：{path}"
    b64 = encode_image(path)
    content = [
        {"type": "text", "text": question},
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
    ]
    last_err = ""
    for m in ([model] if model else MODELS):
        body = {"model": m, "messages": [{"role": "user", "content": content}], "max_tokens": 1600}
        req = urllib.request.Request(
            BASE,
            data=json.dumps(body).encode(),
            headers={"content-type": "application/json", "authorization": f"Bearer {KEY}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=240) as r:
                data = json.loads(r.read().decode())
            return ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "(空响应)"
        except urllib.error.HTTPError as e:
            last_err = f"{m} HTTP {e.code}: {e.read().decode()[:300]}"
        except Exception as e:  # noqa: BLE001 - 逐模型降级重试
            last_err = f"{m} {type(e).__name__}: {str(e)[:200]}"
    return f"全部模型失败：{last_err}"


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    print(ask(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else DEFAULT_Q,
              sys.argv[3] if len(sys.argv) > 3 else None))
