import assert from "node:assert/strict";
import test from "node:test";
import { resolveDramaArtStyleByDb, resolveProjectArtProfile } from "./art-style.js";
import type { BackendDatabase } from "../db.js";

function fakeDb({ dramaByCanvas = {}, folders = [] as Array<Record<string, unknown>> }): BackendDatabase {
    return {
        getDramaIdByCanvasId: (canvasId: string) => dramaByCanvas[canvasId] || "",
        listCanvasFolders: (id?: string) => (id ? folders.filter((folder) => folder.id === id) : folders),
    } as unknown as BackendDatabase;
}

const dramaA = { id: "drama-A", productionPlan: { topic: { artStyle: "国风水墨", language: "中文" } } };

test("分集画布 / 共享资产画布都能解析出剧目的画风", () => {
    const db = fakeDb({ dramaByCanvas: { "canvas-ep": "drama-A", "canvas-shared": "drama-A" }, folders: [dramaA] });
    assert.deepEqual(resolveProjectArtProfile(db, "canvas-ep"), { artStyle: "国风水墨", language: "中文" });
    assert.deepEqual(resolveProjectArtProfile(db, "canvas-shared"), { artStyle: "国风水墨", language: "中文" });
});

test("自由画布、未知画布、空 projectId 都不加画风", () => {
    const db = fakeDb({ dramaByCanvas: {}, folders: [dramaA] });
    assert.deepEqual(resolveProjectArtProfile(db, "free-canvas"), { artStyle: "", language: "" });
    assert.deepEqual(resolveProjectArtProfile(db, undefined), { artStyle: "", language: "" });
});

test("剧目没选画风时为空（不写空后缀）", () => {
    const db = fakeDb({ dramaByCanvas: { "canvas-b": "drama-B" }, folders: [{ id: "drama-B", productionPlan: { topic: {} } }] });
    assert.equal(resolveProjectArtProfile(db, "canvas-b").artStyle, "");
});

test("解析抛错不影响出图，按无画风处理", () => {
    const db = { getDramaIdByCanvasId: () => { throw new Error("db down"); }, listCanvasFolders: () => [] } as unknown as BackendDatabase;
    assert.deepEqual(resolveProjectArtProfile(db, "canvas-x"), { artStyle: "", language: "" });
});

test("按 dramaId 直接取（资产设定卡用）", () => {
    const db = fakeDb({ folders: [dramaA] });
    assert.deepEqual(resolveDramaArtStyleByDb(db, "drama-A"), { artStyle: "国风水墨", language: "中文" });
    assert.equal(resolveDramaArtStyleByDb(db, "drama-missing").artStyle, "");
});
