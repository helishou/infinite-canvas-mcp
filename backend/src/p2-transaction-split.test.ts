import assert from "node:assert/strict";
import test from "node:test";
import { BackendDatabase } from "./db.js";
import { ensureProductionCanvas } from "./drama/production-canvas.js";
import { decodeStoredJson } from "./json-storage.js";
import { sourceOf } from "./canvas/drama-asset-library.js";

function dramaFixture() {
    const db = new BackendDatabase(":memory:");
    db.upsertCanvasFolder({ id: "drama", name: "剧目", isDrama: true, createdAt: new Date().toISOString() });
    return db;
}

// 长内容确保批次明文超过 encodeStoredJson 的 1024 字节阈值，派生事务会将其压缩为 gzip blob。
const longContent = "保存完整中文提示词、参考素材身份与工作流快照。\n".repeat(1500);

test("P2-B 派生同步移出主事务后：共享资产登记与历史压缩仍生效", () => {
    const db = dramaFixture();
    try {
        const shared = ensureProductionCanvas(db, "shared-assets", "drama");
        // 非嵌套（普通提交）路径：派生同步应落到 COMMIT 后的独立短事务里。
        db.applyCanvasProjectOperations(shared.project.id, undefined, [{
            type: "add_node", id: "shared-character", nodeType: "character", title: "共享角色",
            position: { x: 20, y: 30 }, width: 240, height: 320,
            metadata: { characterName: "共享角色", characterDescription: longContent, characterImages: [] },
        }]);
        // 资产登记由 syncSharedCanvasAssetRecords 在派生事务执行，必须已落地。
        const assets = db.listSharedAssetRecordsForProject(shared.project.id);
        assert.ok(assets.some(a => sourceOf(a)?.sourceNodeId === "shared-character"), "COMMIT 后的派生事务应登记共享资产记录");
        // 历史批次由 gzip 在派生事务内完成，最终应为 blob 且可解码。
        const batch = db.db.prepare("SELECT typeof(operations_json) AS type, operations_json FROM canvas_operation_batches WHERE project_id=? ORDER BY revision DESC LIMIT 1").get(shared.project.id) as { type: string; operations_json: unknown };
        assert.equal(batch.type, "blob");
        const decoded = decodeStoredJson(batch.operations_json) as Array<{ type: string }>;
        assert.equal(decoded.length, 1);
        assert.equal(decoded[0].type, "add_node");
    } finally { db.close(); }
});

test("P2 不同节点并发提交同一项目均成功且互不覆盖", async () => {
    const db = new BackendDatabase(":memory:");
    try {
        db.createCanvasProject({ id: "p", title: "canvas", revision: 0, nodes: [
            { id: "a", type: "text", title: "A", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "a0" } },
            { id: "b", type: "text", title: "B", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "b0" } },
        ], connections: [], updatedAt: new Date().toISOString() });
        // 模拟「同时操作多个不同节点」：两个不同节点的更新一起提交。
        await Promise.all([
            Promise.resolve(db.applyCanvasProjectOperations("p", undefined, [{ type: "update_node", id: "a", patch: { title: "A2" } }], { operationId: "op-a" })),
            Promise.resolve(db.applyCanvasProjectOperations("p", undefined, [{ type: "update_node", id: "b", patch: { title: "B2" } }], { operationId: "op-b" })),
        ]);
        const proj = db.getCanvasProject("p")!;
        const a = (proj.nodes as Array<{ id: string; title: string }>).find(n => n.id === "a");
        const b = (proj.nodes as Array<{ id: string; title: string }>).find(n => n.id === "b");
        assert.equal(a?.title, "A2");
        assert.equal(b?.title, "B2");
        assert.equal(proj.revision, 2);
    } finally { db.close(); }
});
