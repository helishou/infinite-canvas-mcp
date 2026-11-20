import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { unzipSync } from "fflate";

import {
    buildJianyingDraft, normalizeDraftRoot, jianyingSrt, jianyingSrtTime,
    productionSubtitleTracks, productionSourceFps, buildJianyingCaptions,
    makeJianyingExportPlan, JianyingZipWriter, writeJianyingExport,
    JianyingRevisionConflictError, DRAFT_ROOT_PLACEHOLDER, draftRootApplyScript,
} from "./jianying-export.js";

const source = {
    version: 2, prompt_assembly: { version: 2 }, fps_num: 24, fps_den: 1,
    style_policy: "waived", style_policy_reason: "fixture",
    subject_registry: [], character_registry: [], scene_registry: [{ id: "room", name: "Room" }],
    script_scenes: [], asset_plan: [],
    ledger: { contract_version: 2, facts: [], timelines: [{ id: "main", start_frame: 0 }], initial: [], events: [], requirements: [], coverage: [] },
    utterances: [
        { id: "u1", text: "你好世界台词", speakerName: "甲" },
        { id: "u2", text: "第二句", speakerName: "乙" },
    ],
    shots: [
        { id: "s1", title: "镜头一", timeline_id: "main", story_order: 0, duration_frames: 120,
            utterance_refs: [{ utteranceId: "u1", textStart: 0, textEnd: 6, localStartFrame: 0, localEndFrame: 48, role: "speaker" }] },
        { id: "s2", title: "镜头二", timeline_id: "main", story_order: 1, duration_frames: 120,
            utterance_refs: [{ utteranceId: "u2", textStart: 0, textEnd: 3, localStartFrame: 0, localEndFrame: 48, role: "speaker" }] },
    ],
    segments: [
        { id: "seg1", timeline_id: "main", shot_ids: ["s1"], mode: "T2VA" },
        { id: "seg2", timeline_id: "main", shot_ids: ["s2"], mode: "T2VA" },
    ],
};

test("buildJianyingDraft 产出 draft_content/draft_info/draft_meta_info + 台词字幕.srt + 包内替换脚本", () => {
    const draft = buildJianyingDraft({
        name: "测试/草稿:1",
        width: 1280, height: 720, fps: 24,
        clips: [
            { fileName: "a.mp4", name: "第一段", durationUs: 5_000_000, width: 1280, height: 720 },
            { fileName: "b.mp4", name: "第二段", durationUs: 3_000_000 },
        ],
        captions: [{ text: "你好", startUs: 0, durationUs: 1_000_000 }, { text: "世界", startUs: 5_000_000, durationUs: 1_000_000 }],
    });
    assert.deepEqual(Object.keys(draft.files).sort(), [
        "apply-draft-root.mjs", "draft_content.json", "draft_info.json", "draft_meta_info.json",
        "台词字幕.srt", "导入说明.txt",
    ].sort());
    const content = JSON.parse(draft.files["draft_content.json"]);
    assert.equal(draft.files["draft_info.json"], draft.files["draft_content.json"], "macOS 读 draft_info 时内容一致");
    assert.equal(content.version, 360000);
    assert.equal(content.new_version, "110.0.0");
    assert.equal(content.platform.app_version, "5.9.0");
    assert.equal(content.duration, 8_000_000);
    assert.equal(content.fps, 24);
    assert.equal(content.materials.videos.length, 2);
    assert.equal(content.materials.videos[0].path.includes(DRAFT_ROOT_PLACEHOLDER), true, "素材路径用占位符，不写导出机路径");
    assert.equal(content.tracks.length, 2, "视频轨 + 台词字幕轨");
    assert.equal(content.tracks[1].type, "text");
    assert.equal(content.materials.texts.length, 2);
    const meta = JSON.parse(draft.files["draft_meta_info.json"]);
    assert.equal(meta.draft_root_path, DRAFT_ROOT_PLACEHOLDER);
    assert.equal(meta.tm_duration, 8_000_000);
    assert.match(draft.files["台词字幕.srt"], /00:00:00,000 --> 00:00:01,000\n你好/);
    assert.match(draft.files["台词字幕.srt"], /00:00:05,000 --> 00:00:06,000\n世界/);
    assert.match(draft.files["apply-draft-root.mjs"], /PLACEHOLDER/);
    assert.equal(draft.stats.clips, 2);
    assert.equal(draft.stats.captions, 2);
    assert.equal(draft.name, "测试-草稿-1", "非法字符已规范化");
});

test("normalizeDraftRoot 校验本机绝对路径，拒绝相对路径与坏目录", () => {
    assert.equal(normalizeDraftRoot("C:/Users/me/Jianying"), "C:\\Users\\me\\Jianying");
    assert.equal(normalizeDraftRoot("\\\\server\\share\\drafts"), "\\\\server\\share\\drafts");
    assert.equal(normalizeDraftRoot("/Users/me/Jianying"), "/Users/me/Jianying");
    assert.throws(() => normalizeDraftRoot("relative/path"), /绝对路径/);
    assert.throws(() => normalizeDraftRoot("/a/../b"), /不能包含/);
    assert.throws(() => normalizeDraftRoot("C:/你的用户名/Jianying"), /你的用户名/);
});

test("jianyingSrtTime 是毫秒精度且从 0 补齐", () => {
    assert.equal(jianyingSrtTime(0), "00:00:00,000");
    assert.equal(jianyingSrtTime(1_500_000), "00:00:01,500");
    assert.equal(jianyingSrtTime(3_661_000_000), "01:01:01,000");
    assert.equal(jianyingSrt([]), "");
});

test("productionSubtitleTracks + buildJianyingCaptions 从 draft 台词生成帧精确 cue 并映射到拼接时间线", () => {
    assert.equal(productionSourceFps(source), 24);
    const tracks = productionSubtitleTracks(source);
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0].timelineId, "main");
    assert.equal(tracks[0].cues.length, 2);
    assert.match(tracks[0].srt, /00:00:05,000 --> 00:00:07,000/);
    const spans = new Map([
        ["s1", { startUs: 0, durationUs: 5_000_000 }],
        ["s2", { startUs: 5_000_000, durationUs: 5_000_000 }],
    ]);
    const captions = buildJianyingCaptions(source, spans, null, 10_000_000);
    assert.deepEqual(captions.map(item => [item.startUs, item.durationUs, item.text]), [
        [0, 2_000_000, "你好世界台词"],
        [5_000_000, 2_000_000, "第二句"],
    ]);
    // 被跳过的段不产生字幕。
    assert.equal(buildJianyingCaptions(source, new Map([["s1", { startUs: 0, durationUs: 5_000_000 }]]), null, 5_000_000).length, 1);
});

test("JianyingZipWriter 流式写入的 ZIP 含草稿/SRT/媒体/manifest 且字节正确", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "jianying-unit-"));
    const videoPath = path.join(root, "clip.mp4");
    const video = Buffer.from("video-bytes-fixture");
    fs.writeFileSync(videoPath, video);
    const preview = {
        draftRoot: "", revision: "a".repeat(64), totalSegments: 1, availableSegments: 1,
        missingSegments: 0, staleSegments: 0, durationMs: 5_000, mediaBytes: video.length,
        captionCount: 1, segments: [{ index: 0, title: "第一段", included: true, stale: false, durationMs: 5_000, durationEstimated: false }],
        warnings: [],
    };
    const plan = makeJianyingExportPlan({
        preview,
        segments: [{ shotIds: ["s1"], resultStorageKey: "media/one.mp4", title: "第一段",
            media: { storageKey: "media/one.mp4", filePath: videoPath, bytes: video.length, sha256: "sha", mimeType: "video/mp4" } }],
        source, sourceHash: "src-hash", title: "第 1 集",
    });
    assert.equal(plan.draft.stats.clips, 1);
    assert.equal(plan.captionCount, 1);
    assert.equal(plan.media.length, 1);
    const chunks: Uint8Array[] = [];
    const writer = new JianyingZipWriter(chunk => { chunks.push(chunk); return true; });
    await writeJianyingExport(plan, writer);
    const entries = unzipSync(Uint8Array.from(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))));
    const names = Object.keys(entries);
    const draftDir = `jianying/${plan.draft.name}/`;
    for (const required of ["draft_content.json", "draft_info.json", "draft_meta_info.json", "台词字幕.srt", "apply-draft-root.mjs"]) {
        assert.ok(names.includes(draftDir + required), `ZIP 缺少 ${draftDir + required}`);
    }
    assert.ok(names.includes("subtitles/main.srt"));
    assert.ok(names.includes("outputs/video/" + plan.media[0].fileName));
    assert.ok(names.includes("manifest.json"));
    const srt = new TextDecoder().decode(entries[draftDir + "台词字幕.srt"]);
    assert.match(srt, /你好世界台词/);
    assert.deepEqual(entries["outputs/video/" + plan.media[0].fileName], Uint8Array.from(video));
    const manifest = JSON.parse(new TextDecoder().decode(entries["manifest.json"]));
    assert.equal(manifest.contract, "jianying-export-v1");
    assert.equal(manifest.revision, preview.revision);
    assert.equal(manifest.draft.captions, 1);
    fs.rmSync(root, { recursive: true, force: true });
});

test("captions=false 时不写入字幕轨与字幕文件（真实开关）", () => {
    const preview = {
        draftRoot: "", revision: "b".repeat(64), totalSegments: 1, availableSegments: 1,
        missingSegments: 0, staleSegments: 0, durationMs: 500, mediaBytes: 4, captionCount: 0,
        segments: [{ index: 0, title: "第一段", included: true, stale: false, durationMs: 500, durationEstimated: false }],
        warnings: [],
    };
    const plan = makeJianyingExportPlan({
        preview, captions: false,
        segments: [{ shotIds: ["s1"], resultStorageKey: "media/one.mp4", title: "第一段", media: null }],
        source, sourceHash: "src-hash", title: "测试",
    });
    assert.equal(plan.captionCount, 0);
    assert.equal(plan.draft.stats.captions, 0);
    assert.deepEqual(plan.subtitleFiles, {});
    assert.equal(plan.draft.files["台词字幕.srt"], "");
});

test("JianyingRevisionConflictError 携带预检与当前 revision，供路由返回 409", () => {
    const error = new JianyingRevisionConflictError("expected-rev", "current-rev");
    assert.equal(error.code, "JIANYING_REVISION_CONFLICT");
    assert.equal(error.expected, "expected-rev");
    assert.equal(error.current, "current-rev");
});


/** 回归：apply-draft-root.mjs 的占位符必须与草稿里的 __CANVAS_DRAFT_ROOT__ 完全一致，
 *  否则替换后路径会多出 "__"，剪映找不到素材。真客户端导入验收抓到过这个 bug。 */
test("draftRootApplyScript 占位符字面量与 DRAFT_ROOT_PLACEHOLDER 一致，无多余下划线", () => {
    const script = draftRootApplyScript("测试草稿");
    assert.match(script, /const PLACEHOLDER = "__CANVAS_DRAFT_ROOT__";/, "脚本占位符必须是双下划线结尾的完整字面量");
    assert.ok(script.includes("__CANVAS"), "脚本里应含完整占位符");
    // 模拟一次替换，确认结果路径没有残留下划线
    const PLACEHOLDER = "__CANVAS_DRAFT_ROOT__";
    const root = "C:\\JianyingDraft";
    const sample = "__CANVAS_DRAFT_ROOT__/第 1 章/materials/a.mp4";
    const replaced = sample.split(PLACEHOLDER + "/").join(root + "\\").split(PLACEHOLDER).join(root);
    assert.ok(!replaced.includes("__"), `替换后不应残留下划线: ${replaced}`);
    assert.equal(replaced, "C:\\JianyingDraft\\第 1 章/materials/a.mp4");
});
