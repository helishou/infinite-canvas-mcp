import assert from "node:assert/strict";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { planRestyle, applyRestylePlan, makeActiveTaskChecker, type RestyleTarget } from "./drama-restyle-routes.js";

type Seg = Record<string, any>;
const segment = (id: string, extra: Seg): Seg => ({ id, title: id, status: "succeeded", ...extra });

function fixture() {
    const db = new BackendDatabase(":memory:");
    const charNode = {
        id: "char-node", type: "character", title: "慕璃",
        metadata: { characterAssetId: "AST-CHAR-MULI", productionEntity: { entityId: "ENT-MULI", kind: "character" } },
    };
    const h3Node = {
        id: "h3-node", type: "minimax-h3:video",
        metadata: {
            segments: [
                segment("clip-a", {
                    h3CharacterGroups: { "GROUP-MULI": { id: "GROUP-MULI", characterAssetId: "AST-CHAR-MULI", characterNodeId: "char-node", outfits: [] } },
                    resultStorageKey: "video:a",
                }),
                segment("clip-b", {
                    referenceBindings: [{ id: "rb", assetId: "asset-1", sourceNodeId: "char-node", subjectId: "SUBJ-MULI" }],
                    resultStorageKey: "video:b",
                }),
                segment("clip-c", {
                    referenceBindings: [{ id: "rb2", assetId: "asset-2", sourceNodeId: "scene-node" }],
                    resultStorageKey: "video:c",
                }),
                segment("clip-d", {
                    h3CharacterGroups: { "GROUP-MULI": { characterAssetId: "AST-CHAR-MULI", characterNodeId: "char-node" } },
                    // 未出片：不该标脏
                }),
            ],
        },
    };
    db.createCanvasProject({ id: "canvas-1", nodes: [charNode, h3Node], connections: [] });
    return db;
}

const segmentsOf = (db: BackendDatabase, projectId = "canvas-1"): Seg[] => {
    const project = db.getCanvasProject(projectId)!;
    return ((project.nodes as Seg[]).find((node) => node.id === "h3-node")!.metadata.segments) as Seg[];
};

test("只读反查：assetId / groupId 都能查到真实引用段，未引用段排除", () => {
    const db = fixture();
    const byAsset = planRestyle(db, { assetId: "AST-CHAR-MULI", dramaId: "drama-1" });
    assert.equal(byAsset.impact.segments, 3, "clip-a / clip-b / clip-d 都引用该角色，clip-c 不引用");
    assert.deepEqual(byAsset.all.map((target) => target.segmentId).sort(), ["clip-a", "clip-b", "clip-d"]);
    assert.equal(byAsset.toMark.length, 2, "只有已出片的 clip-a / clip-b 需要标脏");
    const byGroup = planRestyle(db, { groupId: "GROUP-MULI", dramaId: "drama-1" });
    assert.equal(byGroup.impact.segments, 2, "按 groupId 反查命中 clip-a / clip-d");
    db.close();
});

test("造型粒度：lookId 只认 referenceBindings.outfitId，不拿角色级命中冒充", () => {
    const db = new BackendDatabase(":memory:");
    const charNode = {
        id: "char-node", type: "character", title: "慕璃",
        metadata: { characterAssetId: "AST-CHAR-MULI", productionEntity: { entityId: "ENT-MULI" } },
    };
    const h3Node = {
        id: "h3-node", type: "minimax-h3:video",
        metadata: {
            segments: [
                segment("clip-look-a", {
                    referenceBindings: [{ id: "rb-a", outfitId: "look-red", sourceNodeId: "char-node", storageKey: "image:red" }],
                    resultStorageKey: "video:a",
                }),
                segment("clip-role-only", {
                    h3CharacterGroups: { "GROUP-MULI": { characterAssetId: "AST-CHAR-MULI", outfits: [] } },
                    resultStorageKey: "video:b",
                }),
            ],
        },
    };
    db.createCanvasProject({ id: "canvas-look", nodes: [charNode, h3Node], connections: [] });
    const byLook = planRestyle(db, { assetId: "AST-CHAR-MULI", lookId: "look-red", dramaId: "drama-1" });
    assert.deepEqual(byLook.all.map((target) => target.segmentId), ["clip-look-a"], "只命中明确引用该造型的段");
    assert.equal(byLook.toMark.length, 1);
    const byRole = planRestyle(db, { assetId: "AST-CHAR-MULI", dramaId: "drama-1" });
    assert.equal(byRole.all.length, 2, "角色粒度仍命中两段，不受 lookId 改动影响");
    db.close();
});

test("restyle=false 语义：只换造型，不标脏任何段", () => {
    const db = fixture();
    const plan = planRestyle(db, { assetId: "AST-CHAR-MULI", dramaId: "drama-1", restyleSegments: false });
    assert.equal(plan.impact.segments, 3, "影响集仍如实报告");
    assert.equal(plan.toMark.length, 0, "restyle=false 不改段状态");
    assert.deepEqual(applyRestylePlan(db, plan, "test"), { marked: 0 });
    assert.equal(segmentsOf(db).every((seg) => seg.inputOutdated !== true), true);
    db.close();
});

test("真标脏 + 幂等：重放不重复写，保留原视频", () => {
    const db = fixture();
    const first = planRestyle(db, { assetId: "AST-CHAR-MULI", dramaId: "drama-1" });
    const applied = applyRestylePlan(db, first, "asset-idempotency-key");
    assert.equal(applied.marked, 2);
    const after = segmentsOf(db);
    const byId = new Map(after.map((seg) => [seg.id, seg]));
    assert.equal(byId.get("clip-a")!.inputOutdated, true);
    assert.equal(byId.get("clip-b")!.inputOutdated, true);
    assert.equal(byId.get("clip-c")!.inputOutdated, undefined, "无关段不被动");
    assert.equal(byId.get("clip-a")!.resultStorageKey, "video:a", "标脏不等于删视频");

    const replay = planRestyle(db, { assetId: "AST-CHAR-MULI", dramaId: "drama-1" });
    assert.equal(replay.toMark.length, 0, "已过期段不再进入 toMark");
    assert.equal(replay.skippedAlreadyOutdated, 2);
    assert.deepEqual(applyRestylePlan(db, replay, "asset-idempotency-key"), { marked: 0 });
    db.close();
});

test("活跃任务跳过走轻量绑定索引，不逐段解码任务大列", () => {
    const db = fixture();
    db.createTask("canvas-h3-run", { projectId: "canvas-1", nodeId: "h3-node", segmentId: "clip-a" });
    const checker = makeActiveTaskChecker({} as Parameters<typeof makeActiveTaskChecker>[0], db);
    const plan = planRestyle(db, { assetId: "AST-CHAR-MULI", dramaId: "drama-1", isActive: checker });
    assert.equal(plan.skippedActiveTask, 1);
    assert.deepEqual(plan.toMark.map(target => target.segmentId), ["clip-b"]);
    db.close();
});

test("幂等：正在生成的段不提交标脏", () => {
    const db = fixture();
    const plan = planRestyle(db, {
        assetId: "AST-CHAR-MULI", dramaId: "drama-1",
        isActive: (target: Pick<RestyleTarget, "segmentId">) => target.segmentId === "clip-a",
    });
    assert.equal(plan.skippedActiveTask, 1);
    assert.deepEqual(plan.toMark.map((target) => target.segmentId), ["clip-b"]);
    applyRestylePlan(db, plan, "asset-skip-active");
    const byId = new Map(segmentsOf(db).map((seg) => [seg.id, seg]));
    assert.equal(byId.get("clip-a")!.inputOutdated, undefined, "在跑段保持原状态");
    assert.equal(byId.get("clip-b")!.inputOutdated, true);
    db.close();
});
