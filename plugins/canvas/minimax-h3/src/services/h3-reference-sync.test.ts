import assert from "node:assert/strict";
import test from "node:test";
import type { CanvasReferenceAsset } from "@infinite-canvas/plugin-sdk";
import type { H3ReferenceBinding, H3Segment } from "../types";
import { referenceCatalogSignature, syncReferenceCatalog } from "./h3-reference-sync";

const binding: H3ReferenceBinding = { id: "binding-shared", assetId: "asset-shared", label: "婚书落雪", mediaType: "image", role: "storyboard", tags: [], enabled: true, usage: "reference", storageKey: "image:shared" };
const clips: H3Segment[] = [
    { id: "clip-1", referenceBindings: [binding] },
    { id: "clip-2", referenceBindings: [{ ...binding, label: "道具参考", role: "prop", tags: ["continuity"], subjectId: "document" }] },
];

test("同素材跨 Clip 的名称、职责、标签和主体不同，收到回写重绘后不重复提交", async () => {
    const cache = new Map<string, string>();
    const calls: unknown[] = [];
    const upsert = async (asset: unknown) => { calls.push(asset); return asset as CanvasReferenceAsset; };
    await syncReferenceCatalog(clips, cache, upsert);
    assert.equal(calls.length, 2);
    for (let render = 0; render < 20; render++) await syncReferenceCatalog(structuredClone(clips), cache, upsert);
    assert.equal(calls.length, 2);
    const edited = structuredClone(clips);
    edited[0].referenceBindings![0].tags = ["edited"];
    await syncReferenceCatalog(edited, cache, upsert);
    await syncReferenceCatalog(edited, cache, upsert);
    assert.equal(calls.length, 3, "真实标签编辑只提交一次");
});

test("StrictMode 重跑及在途重绘不会重发，失败只释放对应绑定", async () => {
    const cache = new Map<string, string>();
    let reject!: (error: Error) => void;
    let calls = 0;
    const upsert = async (asset: unknown) => {
        calls++;
        if (calls === 1) await new Promise<void>((_resolve, fail) => { reject = fail; });
        return asset as CanvasReferenceAsset;
    };
    const first = syncReferenceCatalog(clips, cache, upsert);
    await syncReferenceCatalog(clips, cache, upsert);
    assert.equal(calls, 2);
    reject(new Error("connection lost"));
    await first;
    await syncReferenceCatalog(clips, cache, upsert);
    assert.equal(calls, 3);
});

test("没有待同步绑定时不发送空批量请求", async () => {
    const cache = new Map<string, string>();
    let batchCalls = 0;
    let itemCalls = 0;

    await syncReferenceCatalog(
        [],
        cache,
        async (asset) => {
            itemCalls++;
            return asset as CanvasReferenceAsset;
        },
        async () => {
            batchCalls++;
            return [];
        },
    );

    assert.equal(batchCalls, 0);
    assert.equal(itemCalls, 0);
});

test("初始化同步优先合并为一次批量写入", async () => {
    const cache = new Map<string, string>();
    let batchCalls = 0;
    let itemCalls = 0;
    await syncReferenceCatalog(clips, cache, async (asset) => { itemCalls++; return asset as CanvasReferenceAsset; }, async (assets) => { batchCalls++; return assets as CanvasReferenceAsset[]; });
    assert.equal(batchCalls, 1);
    assert.equal(itemCalls, 0);
});

test("catalog signature 忽略对象换引用和 enabled，但包含 Clip/binding 身份、顺序与提交字段", () => {
    const base = structuredClone(clips);
    const sameContent = structuredClone(clips);
    sameContent[0].referenceBindings![0].enabled = false;
    assert.equal(referenceCatalogSignature(base), referenceCatalogSignature(sameContent));

    const changedField = structuredClone(clips);
    changedField[0].referenceBindings![0].label = "新名称";
    assert.notEqual(referenceCatalogSignature(base), referenceCatalogSignature(changedField));

    const copiedClip = structuredClone(clips);
    copiedClip[1].id = "clip-1-copy";
    assert.notEqual(referenceCatalogSignature(base), referenceCatalogSignature(copiedClip));

    const replacedBinding = structuredClone(clips);
    replacedBinding[0].referenceBindings![0].id = "binding-replacement";
    assert.notEqual(referenceCatalogSignature(base), referenceCatalogSignature(replacedBinding));

    const reordered = structuredClone(clips);
    [reordered[0], reordered[1]] = [reordered[1]!, reordered[0]!];
    assert.notEqual(referenceCatalogSignature(base), referenceCatalogSignature(reordered));

    const duplicateAssetRelativeOrder = [
        { id: "clip-a", referenceBindings: [{ ...binding, id: "binding-a", label: "A" }] },
        { id: "clip-b", referenceBindings: [{ ...binding, id: "binding-b", label: "B" }] },
    ] satisfies H3Segment[];
    const duplicateAssetReordered = [duplicateAssetRelativeOrder[1]!, duplicateAssetRelativeOrder[0]!];
    assert.notEqual(referenceCatalogSignature(duplicateAssetRelativeOrder), referenceCatalogSignature(duplicateAssetReordered));
});
