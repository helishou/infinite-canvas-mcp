import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import {
    applyDraftRoot, buildJianyingDraft, DRAFT_ROOT_PLACEHOLDER, jianyingSrt,
    jianyingSrtTime, normalizeDraftRoot, safeDraftName,
} from "./jianying-draft.js";

let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const base = {
    name: "悟空前传-第01集",
    width: 1920,
    height: 1080,
    fps: 24,
    now: new Date("2026-11-14T12:00:00Z"),
    uuid,
};
const clip = (fileName: string, durationUs: number) => ({ fileName, durationUs });
const caption = (text: string, startUs: number, durationUs: number) => ({ text, startUs, durationUs });

test("单段视频 + 帧精确字幕：时间轴、素材路径、轨道结构", () => {
    const draft = buildJianyingDraft({
        ...base,
        root: "C:\\Users\\wxy\\JianyingPro Drafts",
        clips: [clip("seg01.mp4", 5_000_000)],
        captions: [caption("师父，前面有妖气。", 1_000_000, 2_500_000)],
    });
    const content = JSON.parse(draft.files["draft_content.json"]);
    const meta = JSON.parse(draft.files["draft_meta_info.json"]);
    assert.equal(draft.durationUs, 5_000_000);
    assert.equal(content.duration, 5_000_000);
    assert.equal(content.fps, 24);
    assert.equal(content.tracks.length, 2);
    assert.equal(content.tracks[0].type, "video");
    assert.equal(content.tracks[1].type, "text");
    assert.deepEqual(content.tracks[0].segments[0].target_timerange, { start: 0, duration: 5_000_000 });
    assert.deepEqual(content.tracks[0].segments[0].source_timerange, { start: 0, duration: 5_000_000 });
    assert.deepEqual(content.tracks[1].segments[0].target_timerange, { start: 1_000_000, duration: 2_500_000 });
    assert.equal(content.tracks[1].segments[0].source_timerange, null);
    assert.equal(content.materials.videos[0].path, "C:\\Users\\wxy\\JianyingPro Drafts\\悟空前传-第01集\\materials\\seg01.mp4");
    assert.equal(content.materials.videos[0].duration, 5_000_000);
    assert.equal(meta.draft_id, content.id);
    assert.equal(meta.tm_duration, 5_000_000);
    assert.equal(draft.files["draft_info.json"], draft.files["draft_content.json"]);
    assert.equal(draft.stats.captions, 1);
    assert.match(draft.warnings.join(" "), /5\.9\.0/);
});

test("多段视频首尾相接，cursor 累加且素材顺序不变", () => {
    const draft = buildJianyingDraft({
        ...base, root: "D:/Drafts", clips: [clip("a.mp4", 2_000_000), clip("b.mp4", 3_500_000), clip("c.mp4", 1_250_000)],
    });
    const content = JSON.parse(draft.files["draft_content.json"]);
    assert.deepEqual(content.tracks[0].segments.map((item: { target_timerange: { start: number; duration: number } }) => item.target_timerange), [
        { start: 0, duration: 2_000_000 },
        { start: 2_000_000, duration: 3_500_000 },
        { start: 5_500_000, duration: 1_250_000 },
    ]);
    assert.equal(draft.durationUs, 6_750_000);
    assert.equal(content.tracks.length, 1);
    assert.equal(draft.stats.captions, 0);
});

test("字幕越界裁剪、空文本/负时长跳过，中文 range 按码点计数", () => {
    const draft = buildJianyingDraft({
        ...base, root: "D:/Drafts", clips: [clip("a.mp4", 4_000_000)],
        captions: [
            caption("第一句中文", 0, 1_000_000),
            caption("尾部越界", 3_500_000, 2_000_000),
            caption("  ", 0, 500_000),
            caption("负时长", 0, -1),
            caption("起点越界", 9_000_000, 1_000_000),
        ],
    });
    const content = JSON.parse(draft.files["draft_content.json"]);
    const textSegments = content.tracks[1].segments;
    assert.equal(textSegments.length, 2);
    assert.deepEqual(textSegments[1].target_timerange, { start: 3_500_000, duration: 500_000 });
    assert.equal(draft.stats.skippedCaptions, 3);
    const subtitle = JSON.parse(content.materials.texts[0].content);
    assert.equal(subtitle.text, "第一句中文");
    assert.deepEqual(subtitle.styles[0].range, [0, 5]);
    assert.match(draft.warnings.join(" "), /3 条字幕超出/);
});

test("草稿目录校验：拒绝相对路径、磁盘根、引号、控制字符与占位用户名", () => {
    for (const invalid of ["relative/drafts", "C:\\", 'C:\\a"b', "C:\\Users\\你的用户名\\Drafts", "C:\\a\\..\\b", `C:\\a\\b\\${String.fromCharCode(1)}`]) {
        assert.throws(() => normalizeDraftRoot(invalid), /草稿目录|用户名|无效|路径段/);
    }
    assert.equal(normalizeDraftRoot("C:/Users/wxy/Drafts/"), "C:\\Users\\wxy\\Drafts");
    assert.equal(normalizeDraftRoot("/Users/wxy/Drafts"), "/Users/wxy/Drafts");
});

test("名称规范化：非法字符、Windows 保留名、长度上限", () => {
    assert.equal(safeDraftName('  a/b:c*?  ', "fallback"), "a-b-c-");
    assert.equal(safeDraftName("CON"), "_CON");
    assert.equal(safeDraftName("", "fallback"), "fallback");
    assert.equal(Array.from(safeDraftName("长".repeat(200))).length, 120);
    const draft = buildJianyingDraft({ ...base, name: "剪辑:测试", root: "D:/Drafts", clips: [clip("a.mp4", 1_000_000)] });
    assert.equal(draft.name, "剪辑-测试");
    assert.match(draft.warnings.join(" "), /已规范化/);
});

test("root 留空产出占位符；applyDraftRoot 生成合法 JSON 且路径分隔符一致", () => {
    const draft = buildJianyingDraft({
        ...base,
        clips: [clip("a.mp4", 2_000_000)],
        captions: [caption("台词", 0, 1_000_000)],
    });
    assert.ok(draft.files["draft_content.json"].includes(DRAFT_ROOT_PLACEHOLDER));
    assert.match(draft.warnings.join(" "), /占位符/);
    const applied = applyDraftRoot(draft.files, "D:/Jianying/Drafts");
    const content = JSON.parse(applied["draft_content.json"]);
    const meta = JSON.parse(applied["draft_meta_info.json"]);
    assert.equal(content.materials.videos[0].path, "D:\\Jianying\\Drafts\\悟空前传-第01集\\materials\\a.mp4");
    assert.equal(meta.draft_fold_path, "D:\\Jianying\\Drafts\\悟空前传-第01集");
    assert.ok(!applied["draft_content.json"].includes(DRAFT_ROOT_PLACEHOLDER));
    assert.ok(applied["apply-draft-root.mjs"].includes(["__CANVAS", "DRAFT", "ROOT"].join("_")) === false);
    assert.ok(applied["apply-draft-root.mjs"].includes("PLACEHOLDER"));
    assert.throws(() => applyDraftRoot(draft.files, "not/absolute"), /绝对路径/);
});

test("包内替换脚本语法可执行，且不会破坏 JSON 转义", () => {
    const draft = buildJianyingDraft({ ...base, clips: [clip("a.mp4", 1_000_000)] });
    const directory = mkdtempSync(path.join(os.tmpdir(), "canvas-jianying-"));
    const scriptPath = path.join(directory, "apply-draft-root.mjs");
    writeFileSync(scriptPath, draft.files["apply-draft-root.mjs"], "utf8");
    assert.doesNotThrow(() => execFileSync(process.execPath, ["--check", scriptPath], { stdio: "pipe" }));
});

test("SRT 微秒换算与格式", () => {
    assert.equal(jianyingSrtTime(3_661_005_000), "01:01:01,005");
    const srt = jianyingSrt([caption("第一句", 0, 1_500_000), caption("第二句", 2_000_000, 500_000)]);
    assert.equal(srt, "1\n00:00:00,000 --> 00:00:01,500\n第一句\n\n2\n00:00:02,000 --> 00:00:02,500\n第二句\n\n");
});

test("无效片段直接抛错，不产出半成品草稿", () => {
    assert.throws(() => buildJianyingDraft({ ...base, clips: [] }), /视频片段/);
    assert.throws(() => buildJianyingDraft({ ...base, clips: [clip("a.mp4", 0)] }), /时长无效/);
    assert.throws(() => buildJianyingDraft({ ...base, clips: [clip("a.mp4", 1_000_000), clip("A.mp4", 1_000_000)] }), /文件名重复/);
    assert.throws(() => buildJianyingDraft({ ...base, clips: [clip("sub/a.mp4", 1_000_000)] }), /文件名无效/);
    assert.throws(() => buildJianyingDraft({ ...base, width: 0, clips: [clip("a.mp4", 1_000_000)] }), /画面尺寸/);
});
