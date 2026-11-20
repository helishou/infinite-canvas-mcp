/**
 * 业务门禁语义测试：sample 跨集闸门 / approve 前置校验（对齐影策 drama_orchestrator.go +
 * drama_actions.go）。用真实 PipelineStore + 临时 SQLite，不 mock DB。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// 双 runner：vitest 验收与项目 node:test runner 共用同一份用例。
type TestFn = (name: string, fn: () => void | Promise<void>) => void;
let test: TestFn;
if ((process.env as Record<string, string | undefined>).VITEST) {
    // @ts-ignore vitest 由 npx 临时提供
    test = (await import("vitest")).test as unknown as TestFn;
} else {
    test = (await import("node:test")).default as unknown as TestFn;
}
import { DatabaseSync } from "node:sqlite";
import { DRAMA_PIPELINE_DDL } from "../database-schema.js";
import { DramaPipeline, needsReview, sampleBlocked } from "./pipeline.js";
import { PipelineStore } from "./pipeline-store.js";

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-gates-"));
    const file = path.join(dir, "runtime.sqlite");
    const raw = new DatabaseSync(file);
    raw.exec(DRAMA_PIPELINE_DDL);
    raw.close();
    return { dir, file };
}

function enqueue(store: PipelineStore, dramaId: string, episodeId: string, episodeNumber: number, stage: string) {
    const id = `${dramaId}:${episodeId}:${stage}`;
    store.enqueue({
        id, dramaId, episodeId, kind: stage, stage,
        dedupeKey: id, label: `ep${episodeNumber}/${stage}`,
        payload: { episodeId, episodeNumber },
    });
    return store.job(id)!;
}

test("sampleBlocked 对齐影策：样片未批准时阻断所有非第1集，第1集与 auto/every 不挡", () => {
    assert.equal(sampleBlocked("sample", 1, false), false, "第1集是样片本身，不被跨集闸门挡");
    assert.equal(sampleBlocked("sample", 2, false), true, "样片未批准 → 第2集挡");
    assert.equal(sampleBlocked("sample", 3, false), true, "样片未批准 → 第3集也挡");
    assert.equal(sampleBlocked("sample", 7, false), true, "样片未批准 → 任意非第1集都挡");
    assert.equal(sampleBlocked("sample", 2, true), false, "样片批准后放行");
    assert.equal(sampleBlocked("auto", 2, false), false);
    assert.equal(sampleBlocked("every", 2, false), false);
});

test("needsReview 三模式：sample 第1集要审+其余等样片；every 逐集；auto 放行", () => {
    assert.equal(needsReview("auto", 2, new Set(), "ep2"), false);
    assert.equal(needsReview("every", 2, new Set(), "ep2"), true);
    assert.equal(needsReview("every", 2, new Set(["ep2"]), "ep2"), false);
    assert.equal(needsReview("sample", 1, new Set(), "ep1"), true);
    assert.equal(needsReview("sample", 1, new Set(["ep1"]), "ep1"), false);
    assert.equal(needsReview("sample", 2, new Set(), "ep2"), true, "样片未批准 → 非第1集要挡");
    assert.equal(needsReview("sample", 2, new Set(), "ep2", false, true), false, "样片批准 → 放行");
    assert.equal(needsReview("sample", 2, new Set(["ep2"]), "ep2"), true, "非第1集自己 approve 不能绕过样片闸门");
    assert.equal(needsReview("sample", 2, new Set(["all"]), "ep2"), false, "all 哨兵全集放行");
});

test("approve 前置校验：样片未出成片/提示词未就绪拒绝；就绪后放行并写样片哨兵", () => {
    const { dir, file } = fixture();
    try {
        const store = new PipelineStore(file);
        const p = new DramaPipeline({ store, token: "t" });
        try {
            store.upsert({ dramaId: "d1", status: "running", reviewMode: "sample", mediaMode: "auto" });
            const ep1Render = enqueue(store, "d1", "ep1", 1, "render");
            enqueue(store, "d1", "ep1", 1, "prompts");
            enqueue(store, "d1", "ep2", 2, "prompts");

            // 样片成片作业还没成功 → 拒绝 approve（裸奔已修复）
            assert.throws(() => p.approve("d1", "ep1"), /样片完成后才能确认样片/);
            assert.deepEqual(p.status("d1").approvals, []);

            // render 成功 = 成片已合成写回 → 可批准样片
            store.succeed(ep1Render.id, { storageKey: "fake" });
            p.approve("d1", "ep1");
            const approvals = p.status("d1").approvals as string[];
            assert.ok(approvals.includes("ep1"), "样片集本身被批准");
            assert.ok(approvals.includes("sample"), "写入全局样片批准哨兵");
            assert.ok(store.approvalTargets("d1", "approve").includes("sample"), "哨兵落持久化表，重启不丢");
        } finally { p.stop(); store.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("jobAllowed：样片未批准挡住第2集 video；批准后放行（真值取持久化 approvals）", () => {
    const { dir, file } = fixture();
    try {
        const store = new PipelineStore(file);
        const p = new DramaPipeline({ store, token: "t" });
        try {
            store.upsert({ dramaId: "d1", status: "running", reviewMode: "sample", mediaMode: "auto" });
            const ep1Render = enqueue(store, "d1", "ep1", 1, "render");
            const ep2Prompts = enqueue(store, "d1", "ep2", 2, "prompts");
            const ep2Video = enqueue(store, "d1", "ep2", 2, "video");
            store.succeed(ep2Prompts.id, {}); // 前置阶段就绪，隔离闸门断言
            store.succeed(ep1Render.id, {});
            const pipeline = store.get("d1")!;
            const check = () => (p as any).jobAllowed(pipeline, ep2Video,
                new Set(store.approvalTargets("d1", "approve")), new Set());

            assert.equal(check(), false, "样片未批准 → 第2集 video 被闸门挡住");
            p.approve("d1", "ep1");
            assert.equal(check(), true, "样片批准后 → 第2集 video 放行");
        } finally { p.stop(); store.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("every 模式 approve：段提示词作业未成功拒绝，成功后放行", () => {
    const { dir, file } = fixture();
    try {
        const store = new PipelineStore(file);
        const p = new DramaPipeline({ store, token: "t" });
        try {
            store.upsert({ dramaId: "d1", status: "running", reviewMode: "every", mediaMode: "auto" });
            enqueue(store, "d1", "ep1", 1, "prompts");
            enqueue(store, "d1", "ep2", 2, "prompts");
            assert.throws(() => p.approve("d1", "ep2"), /所有剧情段视频提示词就绪后才能确认/);
            const ep2Prompts = store.job("d1:ep2:prompts")!;
            store.succeed(ep2Prompts.id, {});
            p.approve("d1", "ep2");
            assert.ok((p.status("d1").approvals as string[]).includes("ep2"));
        } finally { p.stop(); store.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("对账恢复跳过前置校验：制作稿已批准的老数据无需本地作业记录也能恢复放行", () => {
    const { dir, file } = fixture();
    try {
        const store = new PipelineStore(file);
        const p = new DramaPipeline({ store, token: "t" });
        try {
            store.upsert({ dramaId: "d1", status: "running", reviewMode: "sample", mediaMode: "auto" });
            assert.doesNotThrow(() => p.approve("d1", "ep1", { skipReadinessCheck: true }));
            assert.ok((p.status("d1").approvals as string[]).includes("ep1"));
        } finally { p.stop(); store.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
