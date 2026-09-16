import assert from "node:assert/strict";
import test from "node:test";

import { runtimeMediaUrl } from "./media-store.js";

test("ComfyUI 落地媒体返回实际注册的 runtime 读取路由", () => {
    assert.equal(runtimeMediaUrl("片段 1.mp4"), "/runtime/media-file?name=%E7%89%87%E6%AE%B5%201.mp4");
});
