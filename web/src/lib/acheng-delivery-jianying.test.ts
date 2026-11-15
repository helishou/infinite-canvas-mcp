import { test } from "node:test";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";

import { exportAchengDeliveryBundle } from "./acheng-delivery-export.js";
import { DRAFT_ROOT_PLACEHOLDER } from "./jianying-draft.js";

/** 真实跑一遍 ZIP 装配：确认剪映草稿文件确实进包，且帧窗换算不是估算值。 */
test("Acheng 交付包内包含剪映草稿，帧精确时长与字幕轨可解析", async () => {
    const source = {
        version: 2,
        prompt_assembly: { version: 2 },
        ledger: { contract_version: 2, timelines: [{ id: "main", start_frame: 0 }] },
        fps_num: 24,
        fps_den: 1,
        shots: [{ id: "shot1", duration_frames: 48, story_order: 0, timeline_id: "main", utterance_refs: [] }],
        segments: [{ id: "seg1", shot_ids: ["shot1"], locked: true }],
        utterances: [],
    };
    const production = {
        revision: 7,
        publishedVersion: null,
        published: null,
        draft: {
            director: { engine: "minimax-h3", sourceHash: "fixture-hash", source, artifacts: [], assets: {} },
            keyframes: {},
        },
    };
    const readiness = { unresolved: [], targets: [], nextAction: "fixture" };
    const blob = await exportAchengDeliveryBundle({
        owner: { kind: "episode" as const, id: "ep1" },
        title: "测试集",
        projectId: "project-1",
        production: production as never,
        readiness: readiness as never,
        canvasNodes: [],
        includeGeneratedMedia: false,
    });
    const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const names = Object.keys(entries);
    const draftKey = names.find(name => name.endsWith("/draft_content.json"));
    assert.ok(draftKey, `交付包缺少剪映草稿：${names.join(", ")}`);
    const folder = draftKey.slice(0, -"draft_content.json".length);
    const content = JSON.parse(strFromU8(entries[draftKey]));
    // 48 帧 / 24fps = 2.000000s，来自 Shot duration_frames，不是按时长估算。
    assert.equal(content.duration, 2_000_000);
    assert.equal(content.fps, 24);
    assert.equal(content.tracks.length, 1);
    assert.equal(content.tracks[0].segments[0].target_timerange.duration, 2_000_000);
    assert.equal(content.materials.videos[0].duration, 2_000_000);
    assert.match(content.materials.videos[0].path, /seg1\.mp4$/);
    assert.ok(content.materials.videos[0].path.includes(DRAFT_ROOT_PLACEHOLDER));
    assert.equal(strFromU8(entries[`${folder}draft_info.json`]), strFromU8(entries[draftKey]));
    const meta = JSON.parse(strFromU8(entries[`${folder}draft_meta_info.json`]));
    assert.equal(meta.draft_id, content.id);
    assert.equal(meta.tm_duration, 2_000_000);
    assert.ok(entries[`${folder}apply-draft-root.mjs`]);
    assert.ok(entries[`${folder}导入说明.txt`]);
    const manifest = JSON.parse(strFromU8(entries["manifest.json"]));
    assert.equal(manifest.jianying.contract, "jianying-draft-1");
    assert.equal(manifest.jianying.clips, 1);
    assert.equal(manifest.jianying.durationUs, 2_000_000);
    assert.ok(manifest.jianying.warnings.some((item: string) => item.includes("占位符")));
    assert.match(strFromU8(entries["README.txt"]), /Jianying draft: jianying\//);
});
