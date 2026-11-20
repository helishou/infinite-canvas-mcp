/**
 * 审批/媒体闸门持久化与重启恢复单测。
 * 用真实 PipelineStore + 真实 SQLite（临时文件），不 mock DB；reviewApproval 对账用真实本地 HTTP stub。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
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
import { DramaPipeline, needsReview } from "./pipeline.js";
import { PipelineStore } from "./pipeline-store.js";

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-approval-"));
    const file = path.join(dir, "runtime.sqlite");
    const raw = new DatabaseSync(file);
    raw.exec(DRAMA_PIPELINE_DDL);
    raw.close();
    return { dir, file };
}

test("approve/release 落持久化表，status 从持久化读回；重建实例（模拟重启）仍在", () => {
    const { dir, file } = fixture();
    try {
        const store = new PipelineStore(file);
        const p = new DramaPipeline({ store, token: "t" });
        try {
            p.approve("d1", "ep1");
            p.releaseMedia("d1", "assets");
            assert.deepEqual(p.status("d1").approvals, ["ep1"]);
            assert.deepEqual(p.status("d1").releasedMedia, ["assets"]);
            // 幂等：重复 approve 不产生重复行
            p.approve("d1", "ep1");
            assert.deepEqual(p.status("d1").approvals, ["ep1"]);
            // 持久化表确实有真值（不是内存镜像）
            assert.deepEqual(store.approvalTargets("d1", "approve"), ["ep1"]);
            assert.deepEqual(store.approvalTargets("d1", "release"), ["assets"]);
        } finally { p.stop(); store.close(); }

        // 全新 store + 全新 pipeline 指向同一 DB 文件 = 进程重启
        const store2 = new PipelineStore(file);
        const p2 = new DramaPipeline({ store: store2, token: "t" });
        try {
            assert.deepEqual(p2.status("d1").approvals, ["ep1"]);
            assert.deepEqual(p2.status("d1").releasedMedia, ["assets"]);
        } finally { p2.stop(); store2.close(); }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("重启后从持久化恢复的 approvals 让 needsReview 判定为已通过（闸门不重复卡）", () => {
    const { dir, file } = fixture();
    try {
        const store = new PipelineStore(file);
        const p = new DramaPipeline({ store, token: "t" });
        p.approve("d1", "ep1");
        p.stop(); store.close();

        const store2 = new PipelineStore(file);
        const restored = new Set(store2.approvalTargets("d1", "approve"));
        assert.equal(needsReview("every", 1, restored, "ep1", true), false);
        // 未批准的集仍要审（没有误放行）
        assert.equal(needsReview("every", 2, restored, "ep2", true), true);
        store2.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("持久化 reviewApproval 已批准的集在对账后自动放行；重启不再要求审批", async () => {
    const { dir, file } = fixture();
    const approvedEp = "ep-approved";
    const pendingEp = "ep-pending";
    let approvedCalls = 0;
    let pendingCalls = 0;
    const server = http.createServer((req, res) => {
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/drama/projects/d1/episodes") {
            res.end(JSON.stringify({ ok: true, episodes: [
                { id: approvedEp, episodeNumber: 1 },
                { id: pendingEp, episodeNumber: 2 },
            ] }));
            return;
        }
        if (req.url === `/drama/episodes/${approvedEp}/production`) {
            approvedCalls += 1;
            res.end(JSON.stringify({ ok: true, production: { draft: { director: { workflow: {
                reviewApproval: { approvedAt: "2026-01-01T00:00:00.000Z", by: "user" },
            } } } } }));
            return;
        }
        if (req.url === `/drama/episodes/${pendingEp}/production`) {
            pendingCalls += 1;
            res.end(JSON.stringify({ ok: true, production: { draft: { director: { workflow: {} } } } }));
            return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: "not found" }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        const store = new PipelineStore(file);
        const p = new DramaPipeline({ store, token: "t", baseUrl });
        try {
            // 真实路径是 tick() 自动调用；这里直接驱动同一方法以确定性断言。
            await (p as any).reconcileReviewApprovals("d1");
            assert.deepEqual(p.status("d1").approvals, [approvedEp]);
            assert.equal(approvedCalls, 1);
            assert.equal(pendingCalls, 1);
            // 对账结果已落持久化表，不只是内存
            assert.deepEqual(store.approvalTargets("d1", "approve"), [approvedEp]);
        } finally { p.stop(); store.close(); }

        // 重启：新实例无需再打 HTTP 即可从 DB 恢复放行（再次对账也不会重复要求审批）
        const store2 = new PipelineStore(file);
        const p2 = new DramaPipeline({ store: store2, token: "t", baseUrl });
        try {
            assert.deepEqual(p2.status("d1").approvals, [approvedEp]);
            await (p2 as any).reconcileReviewApprovals("d1");
            // 已放行的集不再重复拉制作稿；未批准的集仍会被检查（不能误放行）
            assert.equal(approvedCalls, 1);
            assert.equal(pendingCalls, 2);
            assert.deepEqual(p2.status("d1").approvals, [approvedEp]);
        } finally { p2.stop(); store2.close(); }
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
