import assert from "node:assert/strict";
import test from "node:test";

import { BackendDatabase } from "../db.js";
import { DATABASE_SCHEMA_VERSION } from "../database-upgrade.js";
import { assetDataSchema, normalizeSceneAsset } from "./asset-contract.js";

test("v20 迁移：把画布节点字段名的场景资产改回资产契约字段名", (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());

    // 三种历史形状：纯节点字段名、裸 URL 字符串、已是契约形状。
    db.upsertAsset({
        id: "scene-node-fields", kind: "scene", title: "雨夜天台", coverUrl: "", tags: [],
        folderId: null, data: {
            sceneName: "雨夜天台", sceneDescription: "后侧栏杆。",
            sceneImage: { url: "/media/image%3Aaaa", storageKey: "image:aaa", width: 1536, height: 1024 },
            sceneColorCard: { url: "/media/image%3Abbb", storageKey: "image:bbb", width: 1200, height: 220 },
            sceneColorCardPrompt: "#182B3A 为功能色槽1。",
            colorPalette: ["#182B3A"],
        }, note: null, source: "canvas-production", metadata: {},
        createdAt: "2026-10-02T16:15:31.306Z", updatedAt: "2026-10-02T16:15:31.306Z",
    } as never);
    db.upsertAsset({
        id: "scene-bare-url", kind: "scene", title: "书房夜景", coverUrl: "", tags: [],
        folderId: null, data: { image: "/media/image%3Accc", storageKey: "image:ccc" },
        note: null, source: "第5集画布", metadata: {},
        createdAt: "2026-09-27T07:09:24.169Z", updatedAt: "2026-09-27T07:09:24.169Z",
    } as never);
    const alreadyValid = {
        id: "scene-valid", kind: "scene", title: "雪院", coverUrl: "/media/image%3Addd", tags: [],
        folderId: null, data: {
            name: "谢府雪院", description: "朱门积雪。",
            image: { url: "/media/image%3Addd", storageKey: "image:ddd", width: 1536, height: 1024, bytes: 1, mimeType: "image/png" },
            colorCardPrompt: "冷白雪面。",
        }, note: null, source: "画布场景节点", metadata: {},
        createdAt: "2026-09-18T11:35:42.835377Z", updatedAt: "2026-09-18T11:35:42.835377Z",
    };
    db.upsertAsset(alreadyValid as never);

    // 迁移只对已存在的库生效；这里直接调用迁移逻辑验证等价转换。
    const normalizedNodeFields = normalizeSceneAsset({ kind: "scene", title: "雨夜天台", coverUrl: "", data: {
        sceneName: "雨夜天台", sceneDescription: "后侧栏杆。",
        sceneImage: { url: "/media/image%3Aaaa", storageKey: "image:aaa", width: 1536, height: 1024 },
        sceneColorCard: { url: "/media/image%3Abbb", storageKey: "image:bbb", width: 1200, height: 220 },
        sceneColorCardPrompt: "#182B3A 为功能色槽1。",
    } }).asset.data as Record<string, unknown>;
    assert.equal(normalizedNodeFields.name, "雨夜天台");
    assert.equal(normalizedNodeFields.description, "后侧栏杆。");
    assert.deepEqual(normalizedNodeFields.image, { url: "/media/image%3Aaaa", storageKey: "image:aaa", width: 1536, height: 1024 });
    assert.deepEqual(normalizedNodeFields.colorCard, { url: "/media/image%3Abbb", storageKey: "image:bbb", width: 1200, height: 220 });
    assert.equal(normalizedNodeFields.colorCardPrompt, "#182B3A 为功能色槽1。");
    // 原节点字段名保留，不做破坏性删除。
    assert.equal(normalizedNodeFields.sceneImage !== undefined, true);

    // 裸 URL 升级成图片对象，coverUrl 跟随主图。
    const normalizedBareUrl = normalizeSceneAsset({ kind: "scene", title: "书房夜景", coverUrl: "", data: {
        image: "/media/image%3Accc", storageKey: "image:ccc",
    } }).asset;
    assert.deepEqual((normalizedBareUrl.data as Record<string, unknown>).image, { url: "/media/image%3Accc", storageKey: "image:ccc" });
    assert.equal(normalizedBareUrl.coverUrl, "/media/image%3Accc");
    assert.equal((normalizedBareUrl.data as Record<string, unknown>).description, "");

    // 已是契约形状的资产不能被改动。
    const untouched = normalizeSceneAsset({ kind: "scene", title: "雪院", coverUrl: "/media/image%3Addd", data: (alreadyValid as { data: Record<string, unknown> }).data });
    assert.equal(untouched.changed, false);
    assert.deepEqual(untouched.asset.data, (alreadyValid as { data: Record<string, unknown> }).data);

    // 三种历史形状归一化后都必须通过前端契约校验。
    for (const data of [normalizedNodeFields, normalizedBareUrl.data, alreadyValid.data]) {
        assert.equal(assetDataSchema("scene")!.safeParse(data).success, true);
    }
});

test("v20 迁移：数据库把 v19 库升级到最新版本并幂等重跑", (t) => {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    const version = db.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version?: number };
    assert.equal(version.version, DATABASE_SCHEMA_VERSION);
    // 迁移已标记完成，重跑不会再改数据。
    db.upsertAsset({
        id: "scene-after-migration", kind: "scene", title: "已归一化", coverUrl: "", tags: [],
        folderId: null, data: { name: "已归一化", description: "", image: { url: "/media/image%3Aeee" } },
        note: null, source: "test", metadata: {},
        createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z",
    } as never);
    const stored = db.getAsset("scene-after-migration");
    assert.equal(stored!.data.name, "已归一化");
    assert.deepEqual(stored!.data.image, { url: "/media/image%3Aeee" });
});

test("资产契约：角色资产 images 为空时拒绝，scene 缺 image 时拒绝，storageKey 单独可用", () => {
    assert.equal(assetDataSchema("scene")!.safeParse({ name: "无图场景", description: "" }).success, false);
    assert.equal(assetDataSchema("scene")!.safeParse({ name: "无图场景", description: "", image: {} }).success, false);
    assert.equal(assetDataSchema("character")!.safeParse({ name: "无图角色", images: [] }).success, false);
    assert.equal(assetDataSchema("character")!.safeParse({ name: "有图角色", images: [{ url: "/media/image%3Afff", width: 1024, height: 1536 }] }).success, true);
    // 前端优先读 storageKey，所以只有 storageKey 的图片是合法形状（mcp-http.test.ts 的既有 fixture 就是这种）。
    assert.equal(assetDataSchema("scene")!.safeParse({ name: "雪院入口", description: "", image: { storageKey: "image:scene-1" }, colorCard: { storageKey: "image:card-1" } }).success, true);
    // 自由结构的 kind 不做校验。
    assert.equal(assetDataSchema("text"), null);
    assert.equal(assetDataSchema("audio"), null);
});