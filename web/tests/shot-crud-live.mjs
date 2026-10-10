// Run with: node --import ./backend/node_modules/tsx/dist/loader.mjs web/tests/shot-crud-live.mjs
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { editDirectorShot } from "../../backend/src/drama/shot-edit.ts";
import { directorHash } from "../../backend/src/drama/director.ts";
import { productionOperationSchema } from "@basketikun/canvas-agent/drama/production-contract";
const camera = { framing: "CU", attention_subject_ids: ["SPEAKER"], editorial_reason: "看清栓子发问" };
const source = { prompt_assembly: { version: 2 }, fps_num: 24, fps_den: 1, scene_registry: [{ id: "SC", name: "院落" }], character_registry: [{ id: "P1", name: "栓子" }, { id: "P2", name: "翠子" }],
    subject_registry: ["SPEAKER", "LISTENER"].map((id, index) => ({ id, kind: "character", entityRef: { ownerKind: "episode", ownerId: "fixture", kind: "character", id: `P${index + 1}` }, pictureBindings: [{ id: `PB${index}`, assetId: `A${index}`, sourceNode: { projectId: "fixture", nodeId: `N${index}` }, selection: { mode: "node_selection" }, provides: ["identity"], retain: [], exclude: [], defaultFor: ["identity"], applicableState: {} }] })),
    ledger: { contract_version: 2, facts: [], timelines: [{ id: "T", name: "主线" }], initial: [], events: [], requirements: [], coverage: [] },
    shots: ["S1", "S2"].map((id, index) => ({ id, title: index ? "等待回应" : "问蛋", visual: index ? "栓子等待回应。" : "栓子向翠子发问。", timeline_id: "T", scene_id: "SC", story_order: index, duration_frames: 96, camera, subject_usages: ["SPEAKER", "LISTENER"].map(subjectId => ({ subjectId, presentation: "visible", pictureBindingIds: [], referencePurpose: ["identity"], continuityFactIds: [], stateRequirements: [] })), keyframes: [], utterance_refs: index ? [] : [{ utteranceId: "U", role: "speaker", localStartFrame: 0, localEndFrame: 96, textStart: 0, textEnd: 5 }] })),
    segments: [{ id: "C", mode: "T2VA", shot_ids: ["S1", "S2"] }], utterances: [{ id: "U", speakerSubjectId: "SPEAKER", text: "回来先问蛋", start: { shotId: "S1", localFrame: 0 }, end: { shotId: "S1", localFrame: 96 } }] };
const director = { schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "test", runtimeId: "test", version: "4.3.9" }, source, sourceHash: directorHash(source), modules: {}, assets: {}, artifacts: [], shotInputs: {}, boundaries: [], unresolved: [], workflow: {} };
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], commands = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(value => { window.shotFixtureSource = value; }, source);
    await page.exposeFunction("applyFixtureShot", operation => { const parsed = productionOperationSchema.parse(operation); editDirectorShot(director, parsed); commands.push(parsed); return director.source; });
    await page.goto(`${process.env.WORKBENCH_WEB_URL || "http://127.0.0.1:3001"}/tests/shot-crud-fixture.html`);
    const menu = async label => { await page.getByRole("button", { name: "镜头操作", exact: true }).click(); await page.getByRole("menuitem", { name: label, exact: true }).click(); };
    await menu("复制镜头设计"); await page.getByLabel("当前镜头").filter({ hasText: "副本" }).waitFor();
    await menu("本片段内下移"); assert.equal(director.source.shots.at(-1).title, "问蛋 · 副本");
    await menu("删除镜头"); await page.waitForFunction(() => JSON.parse(document.querySelector('[aria-label="制作源稿"]').textContent).shots.length === 2);
    // Select the first Shot through a fresh fixture reload with current source.
    await page.reload(); await menu("拆分镜头");
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox").nth(0).fill("翠子的反应");
    await dialog.getByRole("textbox").nth(2).fill("翠子侧耳听，保持闭口。");
    await dialog.getByText("对白切字位置", { exact: false }).locator("..").getByRole("combobox").click();
    await page.getByTitle("回来 ｜ 先问蛋", { exact: true }).click();
    await dialog.getByRole("checkbox").check(); await dialog.getByRole("button", { name: "保存镜头变更", exact: true }).click();
    await page.waitForFunction(() => JSON.parse(document.querySelector('[aria-label="制作源稿"]').textContent).shots.length === 3);
    const split = director.source.shots[1];
    assert.equal(split.utterance_refs[0].role, "reaction"); assert.equal(split.subject_usages.find(usage => usage.subjectId === "SPEAKER").presentation, "offscreen_voice");
    assert.deepEqual(split.camera.attention_subject_ids, ["LISTENER"]); assert.equal(director.source.utterances[0].text, "回来先问蛋");
    await page.getByRole("button", { name: "新增镜头", exact: true }).click();
    const add = page.getByRole("dialog"); await add.getByRole("textbox").nth(0).fill("望向门口"); await add.getByRole("textbox").nth(1).fill("翠子转头望向门口。"); await add.getByRole("textbox").nth(2).fill("交代下一步移动方向。");
    await add.getByRole("button", { name: "保存镜头变更", exact: true }).click();
    await page.waitForFunction(() => JSON.parse(document.querySelector('[aria-label="制作源稿"]').textContent).shots.length === 4);
    assert.equal(director.source.shots[2].title, "望向门口");
    await menu("与下一镜合并"); await page.getByRole("dialog").getByRole("button", { name: "保存镜头变更", exact: true }).click();
    await page.waitForFunction(() => JSON.parse(document.querySelector('[aria-label="制作源稿"]').textContent).shots.length === 3);
    assert.equal(director.source.shots[2].duration_frames, 192); assert.equal(director.source.utterances[0].text, "回来先问蛋");
    await page.reload(); await menu("删除镜头");
    await page.waitForFunction(() => JSON.parse(document.querySelector('[aria-label="制作源稿"]').textContent).shots.length === 2);
    assert.equal(director.source.utterances[0].text, "先问蛋");
    assert.equal(director.source.shots.some(shot => shot.id === "S1"), false);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, commands: commands.map(command => command.action), listenerReaction: true, originalDialoguePreserved: true, mediaSubmitted: false }));
} finally { await browser.close(); }
