import assert from "node:assert/strict";
import test from "node:test";
import type { Asset } from "@/stores/use-asset-store";
import { ALL_DRAMAS, ROOT_FOLDER, UNASSIGNED_DRAMA, countByDrama, countByFolder, filterAssets, type AssetLibraryFilters } from "./asset-facet-counts";

const kindData: Record<Asset["kind"], Record<string, unknown>> = {
    text: { content: "" },
    image: { mimeType: "image/png" },
    video: { mimeType: "video/mp4" },
    audio: { mimeType: "audio/wav" },
    character: { name: "", description: "", voiceName: "", images: [] },
    scene: { name: "", description: "", colorCardPrompt: "" },
    prop: { name: "", description: "", image: { url: "", storageKey: "", width: 0, height: 0, bytes: 0, mimeType: "" } },
};
const asset = (id: string, kind: Asset["kind"], extra: Partial<Asset> = {}) => ({ id, kind, title: id, coverUrl: "", tags: [], createdAt: "", updatedAt: "", data: kindData[kind], ...extra }) as Asset;

// 复现「资产页数据对不上」的现场：一个剧目下的资产、一个装有未归属角色的文件夹、未归档音频、
// 以及一条归属到已删除剧目的遗留资产。
const assets = [
    asset("a1", "image", { dramaId: "d1", folderId: "f1" }),
    asset("a2", "character", { dramaId: "d1" }),
    asset("a3", "audio"),
    asset("a4", "character", { folderId: "f1" }),
    asset("a5", "scene", { dramaId: "gone" }),
    asset("a6", "image", { dramaId: "d2", folderId: "f2" }),
];
const dramaIds = ["d1", "d2"];
const folders = ["f1", "f2"];
const base: AssetLibraryFilters = { keyword: "", kind: "all", dramaId: ALL_DRAMAS, folderId: null, dramaIds };

test("剧目块与文件夹块各自闭合，两个「全部」都等于列表总数", () => {
    const dramaSum = countByDrama(assets, base, "d1") + countByDrama(assets, base, "d2") + countByDrama(assets, base, UNASSIGNED_DRAMA);
    assert.equal(dramaSum, countByDrama(assets, base, ALL_DRAMAS));
    assert.equal(countByDrama(assets, base, ALL_DRAMAS), assets.length);
    const folderSum = countByFolder(assets, base, ROOT_FOLDER) + folders.reduce((total, id) => total + countByFolder(assets, base, id), 0);
    assert.equal(folderSum, countByFolder(assets, base, null));
    assert.equal(countByFolder(assets, base, null), assets.length);
});

test("归属到已删除剧目的资产算未归属，不再挂在已消失的剧目下", () => {
    assert.equal(countByDrama(assets, base, UNASSIGNED_DRAMA), 3);
    assert.equal(countByDrama(assets, base, "gone"), 0);
    assert.deepEqual(filterAssets(assets, { ...base, dramaId: UNASSIGNED_DRAMA }).map(item => item.id), ["a3", "a4", "a5"]);
});

test("选中文件夹后侧栏与列表同源，不再出现「侧栏 458、列表 3 条」", () => {
    const filters: AssetLibraryFilters = { ...base, folderId: "f1" };
    assert.deepEqual(filterAssets(assets, filters).map(item => item.id), ["a1", "a4"]);
    assert.equal(countByDrama(assets, filters, ALL_DRAMAS), 2);
    assert.equal(countByDrama(assets, filters, "d1"), 1);
    assert.equal(countByDrama(assets, filters, "d2"), 0);
    assert.equal(countByDrama(assets, filters, UNASSIGNED_DRAMA), 1);
    assert.equal(countByFolder(assets, filters, "f1"), 2);
    // 每个入口只忽略自身维度：点「全部文件夹」会清掉文件夹筛选，所以按其它筛选口径给出结果。
    assert.equal(countByFolder(assets, filters, null), 6);
    assert.equal(countByFolder(assets, filters, ROOT_FOLDER), 3);
    assert.equal(countByFolder(assets, filters, null), countByFolder(assets, filters, ROOT_FOLDER) + folders.reduce((total, id) => total + countByFolder(assets, filters, id), 0));
});

test("类型与搜索筛选同样进入侧栏计数", () => {
    const filters: AssetLibraryFilters = { ...base, kind: "character", folderId: "f1" };
    assert.deepEqual(filterAssets(assets, filters).map(item => item.id), ["a4"]);
    assert.equal(countByDrama(assets, filters, ALL_DRAMAS), 1);
    assert.equal(countByFolder(assets, filters, "f1"), 1);
    assert.equal(countByFolder(assets, filters, null), 2);
    assert.equal(countByFolder(assets, filters, ROOT_FOLDER), 1);
    assert.equal(countByDrama(assets, { ...base, keyword: "a2" }, "d1"), 1);
    assert.equal(countByDrama(assets, { ...base, keyword: "a2" }, "d2"), 0);
});

test("每个入口显示的数字就是点进去看到的条数", () => {
    const filters: AssetLibraryFilters = { ...base, keyword: "a" };
    for (const dramaId of [ALL_DRAMAS, UNASSIGNED_DRAMA, "d1", "d2"]) {
        assert.equal(countByDrama(assets, filters, dramaId), filterAssets(assets, { ...filters, dramaId }).length);
    }
    for (const folderId of [null, ROOT_FOLDER, "f1", "f2"]) {
        assert.equal(countByFolder(assets, filters, folderId), filterAssets(assets, { ...filters, folderId }).length);
    }
});
