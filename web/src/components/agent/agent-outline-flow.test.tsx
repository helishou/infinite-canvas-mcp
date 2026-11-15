import assert from "node:assert/strict";
import test from "node:test";
import { OUTLINE_STAGES, looksLikeOutlineWork, outlineFlowRows } from "./agent-outline-flow";

test("大纲流程按导演技能的写作合同分成六段", () => {
    assert.deepEqual(OUTLINE_STAGES.map((stage) => stage.label), [
        "主题与前提",
        "梗概与人物小传",
        "剧情线（A/B/C）",
        "节拍表",
        "知情与伏笔",
        "场景与分场正文",
    ]);
});

test("只在真的写大纲/剧本时挂大纲流程", () => {
    assert.equal(looksLikeOutlineWork(["开始生成视频，排队中"]), false);
    assert.equal(looksLikeOutlineWork(["拆分镜：本场 8 个镜头"]), false);
    assert.equal(looksLikeOutlineWork(["先锁主题的两种立场，再写梗概"]), true);
    assert.equal(looksLikeOutlineWork(["写入分场正文"]), true);
});

test("带完成词才算完成，只提到就算进行中", () => {
    const rows = outlineFlowRows(["主题与前提已确认", "梗概和小传写完", "现在排节拍表"], true);
    assert.deepEqual(rows.map((row) => row.tone), ["done", "done", "pending", "running", "pending", "pending"]);
    assert.equal(rows[3].statusKey, "agent.message.running");
    assert.equal(rows[0].statusKey, "agent.message.completed");
});

test("只提关键词没有完成词时不算写完", () => {
    const rows = outlineFlowRows(["正在补知情与伏笔"], true);
    assert.equal(rows[4].tone, "running");
    assert.ok(rows.filter((row, index) => index !== 4).every((row) => row.tone === "pending"));
});

test("本轮不在跑时全部保持未开始，不伪造进度", () => {
    const rows = outlineFlowRows(["开始处理"], false);
    assert.ok(rows.every((row) => row.tone === "pending"));
});
