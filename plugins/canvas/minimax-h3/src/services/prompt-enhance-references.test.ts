import test from "node:test";
import assert from "node:assert/strict";

import { promptEnhanceImagePayload } from "./prompt-enhance-references";
import type { H3Ref } from "../types";

test("增强提示词只把图片参考交给识图接口", () => {
    const refs: H3Ref[] = [
        { url: "/media/image-a", type: "image", name: "分镜图", storageKey: "image:a", mimeType: "image/png" },
        { url: "/media/voice.wav", type: "audio", name: "沈侯声线", storageKey: "audio:voice", mimeType: "audio/wav" },
        { url: "/media/motion.mp4", type: "video", name: "动作参考", storageKey: "video:motion", mimeType: "video/mp4" },
    ];
    assert.deepEqual(promptEnhanceImagePayload(refs), [
        { url: "/media/image-a", name: "分镜图", storageKey: "image:a", mimeType: "image/png" },
    ]);
});
