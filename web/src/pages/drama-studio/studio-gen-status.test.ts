import assert from "node:assert/strict";
import test from "node:test";
import "@/i18n";
import { deriveGenStatus } from "./studio-cast-panel.js";

test("已有真实归档图但状态字段缺失时判 ready，不再被当成待生成重复准备", () => {
    const result = deriveGenStatus("asset-scene", { "asset-scene": { storageKey: "image:done" } }, []);
    assert.equal(result.status, "ready");
    assert.ok(result.thumb, "缩略图应来自本地真实归档图");
});

test("明确的 busy/failed 状态优先于已有 storageKey", () => {
    assert.equal(deriveGenStatus("a", { a: { storageKey: "image:x", status: "running" } }, []).status, "busy");
    assert.equal(deriveGenStatus("a", { a: { storageKey: "image:x", status: "queued" } }, []).status, "busy");
    assert.equal(deriveGenStatus("a", { a: { storageKey: "image:x", status: "failed" } }, []).status, "failed");
    assert.equal(deriveGenStatus("a", { a: { storageKey: "image:x", status: "error" } }, []).status, "failed");
});

test("画布实体节点上的真实图也判 ready，且本地图优先于共享兜底图", () => {
    const result = deriveGenStatus("a", {}, [], { storageKey: "image:shared", status: "ready" }, "image:node");
    assert.equal(result.status, "ready");
    assert.ok(result.thumb.includes("image%3Anode"), "缩略图应指向分集节点自己的图，不被共享图覆盖");
});

test("既无制作稿图也无节点图时仍为 idle，不误报就绪", () => {
    assert.equal(deriveGenStatus("a", {}, []).status, "idle");
    assert.equal(deriveGenStatus("a", {}, []).thumb, "");
});
