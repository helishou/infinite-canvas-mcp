/**
 * 视频批量生成前只读体检的行为测试（忠实对齐影策 cloudAgentHandleCanvasPreflight 的静态检查）。
 * 纯函数层：不碰 DB / 文件系统；媒体就绪状态由测试注入，便于穷举失败分支。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { PRERUN_PROMPT_MAX_CHARS, planVideoPrerun, type PrerunSegment } from "./video-prerun.js";

const ready = { found: true, fileExists: true, bytes: 1024, mimeType: "image/png" };

function imageRef(label = "<Picture 1> 角色", storageKey = "image:hero", media = ready) {
    return { id: "ref-1", label, storageKey, mediaType: "image" as const, enabled: true, media };
}

function segment(patch: Partial<PrerunSegment> = {}): PrerunSegment {
    return {
        nodeId: "h3-node",
        segmentId: "seg-1",
        title: "第 1 段",
        prompt: "角色进门。<Picture 1>",
        duration: 5,
        references: [imageRef()],
        ...patch,
    };
}

test("正常段通过：绿 status=ok，ok=true，issues 缺省", () => {
    const report = planVideoPrerun({ episodeId: "ep", segments: [segment()] });
    assert.equal(report.ok, true);
    assert.equal(report.failed, 0);
    assert.equal(report.warnings, 0);
    assert.equal(report.total, 1);
    assert.equal(report.items[0].status, "ok");
    assert.equal(report.items[0].issues, undefined);
    assert.equal(report.items[0].title, "第 1 段");
});

test("参考图缺失：媒体未入库 / 文件不存在都判 error，且不创建任务", () => {
    const notStored = planVideoPrerun({ segments: [segment({
        references: [imageRef("<Picture 1> 角色", "image:missing", { found: false, fileExists: false, bytes: 0 })],
    })] });
    assert.equal(notStored.ok, false);
    assert.equal(notStored.failed, 1);
    assert.equal(notStored.items[0].status, "error");
    assert.ok(notStored.items[0].issues!.some(issue => issue.includes("参考《<Picture 1> 角色》还不能用") && issue.includes("媒体文件未入库")));

    const noFile = planVideoPrerun({ segments: [segment({
        references: [imageRef("<Picture 1> 角色", "image:gone", { found: true, fileExists: false, bytes: 0, detail: "media/gone.png" })],
    })] });
    assert.equal(noFile.items[0].status, "error");
    assert.ok(noFile.items[0].issues!.some(issue => issue.includes("文件不存在")));
});

test("<Picture N> 编号超过参考连线数 = error（影策 @图片N 同款口径）", () => {
    const report = planVideoPrerun({ segments: [segment({ prompt: "角色进门。<Picture 2>" })] });
    assert.equal(report.ok, false);
    assert.equal(report.items[0].status, "error");
    assert.ok(report.items[0].issues!.some(issue => issue.includes("<Picture 2>") && issue.includes("没有对应的参考连线")));
});

test("绑定了参考图但提示词没有 <Picture> 标签 = error（参考图没进视频）", () => {
    const report = planVideoPrerun({ segments: [segment({ prompt: "角色走进房间，没有任何引用标记。" })] });
    assert.equal(report.items[0].status, "error");
    assert.ok(report.items[0].issues!.some(issue => issue.includes("参考图不会进入视频")));
});

test("部分绑定未被提示词引用 = warning，不误判为 error", () => {
    const refs = [imageRef("<Picture 1> 角色", "image:hero"), imageRef("<Picture 2> 场景", "image:room")];
    const report = planVideoPrerun({ segments: [segment({ references: refs, prompt: "只用到了 <Picture 1>。" })] });
    assert.equal(report.items[0].status, "warning");
    assert.equal(report.failed, 0);
    assert.equal(report.warnings, 1);
    assert.ok(report.items[0].issues!.some(issue => issue.includes("<Picture 2>")));
});

test("空提示词 = error", () => {
    const report = planVideoPrerun({ segments: [segment({ prompt: "   \n  " })] });
    assert.equal(report.items[0].status, "error");
    assert.ok(report.items[0].issues!.some(issue => issue.includes("提示词为空")));
});

test("提示词超过 16000 字符 = error（按 Unicode 码点计数）", () => {
    const report = planVideoPrerun({ segments: [segment({ prompt: "🎬".repeat(PRERUN_PROMPT_MAX_CHARS + 1) })] });
    assert.equal(report.items[0].status, "error");
    assert.ok(report.items[0].issues!.some(issue => issue.includes("提示词超过 16000 字符")));
});

test("视频段没有参考图 = warning，ok 仍为 true", () => {
    const report = planVideoPrerun({ segments: [segment({ references: [], prompt: "纯文本生成的镜头。" })] });
    assert.equal(report.ok, true);
    assert.equal(report.failed, 0);
    assert.equal(report.warnings, 1);
    assert.equal(report.items[0].status, "warning");
    assert.ok(report.items[0].issues!.some(issue => issue.includes("文生视频")));
});

test("时长缺失/超范围只警告，不误判为 error", () => {
    const noDuration = planVideoPrerun({ segments: [segment({ duration: 0 })] });
    assert.equal(noDuration.items[0].status, "warning");
    assert.ok(noDuration.items[0].issues!.some(issue => issue.includes("时长")));
    const tooLong = planVideoPrerun({ segments: [segment({ duration: 120 })] });
    assert.equal(tooLong.items[0].status, "warning");
    assert.ok(tooLong.items[0].issues!.some(issue => issue.includes("60 秒")));
});

test("带模型时标注跳过本地计价准入；体检本身不创建任务/不预留积分", () => {
    const report = planVideoPrerun({ segments: [segment()], model: "engine-local::H3 展开流", pricingSkipped: true });
    assert.equal(report.ok, true);
    assert.match(report.items[0].spec || "", /engine-local::H3 展开流/);
    assert.match(report.items[0].spec || "", /5秒/);
    assert.match(report.items[0].quote || "", /跳过/);
    assert.ok(report.notes.some(note => note.includes("不创建任务") || note.includes("跳过")));
});

test("多段汇总：failed/warnings/total 按段计数，error 优先于 warning", () => {
    const report = planVideoPrerun({ segments: [
        segment({ title: "正常", segmentId: "s1" }),
        segment({ title: "缺参考", segmentId: "s2", references: [], prompt: "纯文本。" }),
        segment({ title: "空提示词", segmentId: "s3", prompt: "" }),
    ] });
    assert.equal(report.total, 3);
    assert.equal(report.failed, 1);
    assert.equal(report.warnings, 1);
    assert.equal(report.ok, false);
    assert.deepEqual(report.items.map(item => item.status), ["ok", "warning", "error"]);
    assert.match(report.summary, /1 失败 \/ 1 警告（共 3 条）/);
});


// ==== 参考图就绪却没绑进段（断链）必须拦截，真 T2V 不受影响 ====
test("断链拦截：本集有可用参考图但段 0 绑定 = error（T2VA+空绑定不再放行）", () => {
    const report = planVideoPrerun({
        episodeId: "ep",
        hasAvailableAssets: true,
        segments: [segment({ references: [], prompt: "角色进门，无任何 Picture 标签" })],
    });
    assert.equal(report.ok, false);
    assert.equal(report.failed, 1);
    assert.equal(report.items[0].status, "error");
    assert.ok(report.items[0].issues!.some(issue => issue.includes("没有绑定任何参考图") && issue.includes("不会进入视频")));
});

test("真·纯 T2V：本集无参考图资产，段 0 绑定仍只警告放行", () => {
    const report = planVideoPrerun({
        episodeId: "ep",
        hasAvailableAssets: false,
        segments: [segment({ references: [], prompt: "角色进门，无任何 Picture 标签" })],
    });
    assert.equal(report.ok, true);
    assert.equal(report.failed, 0);
    assert.equal(report.warnings, 1);
    assert.equal(report.items[0].status, "warning");
    assert.ok(report.items[0].issues!.some(issue => issue.includes("按文生视频提交")));
});

test("已正确绑定参考图的段不因 hasAvailableAssets 误判", () => {
    const report = planVideoPrerun({
        episodeId: "ep",
        hasAvailableAssets: true,
        segments: [segment()], // segment() 默认带 1 张 <Picture 1> 参考
    });
    assert.equal(report.ok, true);
    assert.equal(report.failed, 0);
    assert.equal(report.items[0].status, "ok");
});
