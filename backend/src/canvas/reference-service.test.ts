import assert from "node:assert/strict";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";
import { CanvasReferenceService } from "./reference-service.js";

const asset = (label = "书房") => ({
    id: "scene",
    label,
    role: "scene",
    tags: ["study"],
    storageKey: "image:valid",
    url: "/media/image%3Amissing",
});

test("批量同步重复 assetId 保持输入顺序与后项覆盖语义", (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [], connections: [] });
    const service = new CanvasReferenceService(createStores(db));

    const assets = service.upsertMany("p", [
        asset("书房"),
        { ...asset("另一个 Clip 的局部名称"), role: "prop", tags: ["other"], url: "/media/image%3Aother" },
    ]);

    assert.equal(assets.length, 2);
    assert.deepEqual(assets.map((item) => item.label), ["书房", "另一个 Clip 的局部名称"]);
    assert.deepEqual(assets.map((item) => item.role), ["scene", "prop"]);
    assert.deepEqual(service.monitor("p").assets, [{ assetId: "scene", attempts: 2, changed: 2 }]);
    assert.deepEqual(service.list("p").map((item) => ({ id: item.id, label: item.label, role: item.role, tags: item.tags })), [
        { id: "scene", label: "另一个 Clip 的局部名称", role: "prop", tags: ["other"] },
    ]);
});

test("20 次 unchanged reference upsert 只增加 attempts，不增加 changed 或 revision", (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [], connections: [] });
    const service = new CanvasReferenceService(createStores(db));

    service.upsert("p", asset());
    const revisionBefore = Number(db.getCanvasProject("p")?.revision ?? 0);
    const monitorBefore = service.monitor("p");

    for (let index = 0; index < 20; index += 1) service.upsert("p", asset());

    const revisionAfter = db.getCanvasProject("p")?.revision;
    const monitorAfter = service.monitor("p");
    const catalogAfter = service.list("p");
    assert.equal(monitorAfter.attempts - monitorBefore.attempts, 20);
    assert.equal(monitorAfter.changed - monitorBefore.changed, 0);
    assert.equal(revisionAfter, revisionBefore);
    assert.equal(catalogAfter.length, 1);
    assert.equal(catalogAfter[0]?.label, "书房");
});

test("合法字段变化提交一次 changed 并将 revision 增加 1", (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "p", nodes: [], connections: [] });
    const service = new CanvasReferenceService(createStores(db));

    service.upsert("p", asset());
    const revisionBefore = Number(db.getCanvasProject("p")?.revision ?? 0);
    const monitorBefore = service.monitor("p");
    const changed = service.upsert("p", { ...asset(), label: "新书房" });

    assert.equal(changed.label, "新书房");
    assert.equal(db.getCanvasProject("p")?.revision, revisionBefore + 1);
    assert.equal(service.monitor("p").attempts - monitorBefore.attempts, 1);
    assert.equal(service.monitor("p").changed - monitorBefore.changed, 1);
});
