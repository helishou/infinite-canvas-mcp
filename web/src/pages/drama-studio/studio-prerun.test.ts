import assert from "node:assert/strict";
import test from "node:test";

import { PRERUN_TONE_LABEL, prerunBanner, prerunTone } from "./studio-prerun.js";

test("prerunTone 只认后端三态，未知状态按失败显示", () => {
    assert.equal(prerunTone("ok"), "ok");
    assert.equal(prerunTone("warning"), "warning");
    assert.equal(prerunTone("error"), "error");
    assert.equal(prerunTone(undefined), "error");
    assert.equal(prerunTone("success"), "error");
    assert.equal(PRERUN_TONE_LABEL.ok, "通过");
    assert.equal(PRERUN_TONE_LABEL.warning, "提醒");
    assert.equal(PRERUN_TONE_LABEL.error, "失败");
});

test("prerunBanner 失败优先于提醒，全部通过才提示可生成", () => {
    assert.equal(prerunBanner(2, 3, 10).tone, "error");
    assert.match(prerunBanner(2, 3, 10).text, /2 个失败项/);
    assert.equal(prerunBanner(0, 1, 4).tone, "warning");
    assert.match(prerunBanner(0, 1, 4).text, /1 段有提醒/);
    assert.equal(prerunBanner(0, 0, 4).tone, "ok");
    assert.match(prerunBanner(0, 0, 4).text, /4 段待生成内容就绪/);
});
