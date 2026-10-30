import assert from "node:assert/strict";
import test from "node:test";

import { parsePortraitOriginCatalog, parsePortraitZhCatalog } from "./online-catalog";

// 样本取自站点当前发布的数据结构，只保留解析需要的字段。
const zhCatalog = JSON.stringify([
    { id: "f71f980dde3", 模式: "face", 类型: "正面脸图", 发长: "短发", 发型: "", 原始发长: "ショート", 原始发型: "",
        缩略图: "https://ai-portrait-gallery.pages.dev/img/thumb/f71f980dde3.webp", 原图: "https://ai-portrait-gallery.pages.dev/img/full/f71f980dde3.png" },
    { id: "f009cba9893", 模式: "face", 类型: "正面脸图", 发长: "短发", 发型: "收束感短发（后颈发尾较长·空气刘海）", 原始发长: "ショート", 原始发型: "くびれショート（襟足長め・シースルーバング）",
        缩略图: "https://ai-portrait-gallery.pages.dev/img/thumb/f009cba9893.webp", 原图: "https://ai-portrait-gallery.pages.dev/img/full/f009cba9893.png" },
]);

const originCatalog = `window.GALLERY_IMAGES = [
  {
    "id": "f71f980dde3",
    "section": "face",
    "hair": "ショート",
    "style": "",
    "full": "img/full/f71f980dde3.png",
    "thumb": "img/thumb/f71f980dde3.webp"
  },
  {
    "id": "ffd50b11c15",
    "section": "styling",
    "hair": "ロング",
    "style": "ストレートロング",
    "full": "img/full/ffd50b11c15.png",
    "thumb": "img/thumb/ffd50b11c15.webp"
  }
];
`;

test("the Chinese catalog maps hair length to the main filter and keeps Chinese keywords", () => {
    const items = parsePortraitZhCatalog(zhCatalog);
    assert.equal(items.length, 2);
    assert.deepEqual(items.map(item => item.category), ["短发", "短发"]);
    assert.deepEqual(items.map(item => item.poseType), ["正面脸图", "正面脸图"]);
    assert.equal(items[0].keywords, "正面脸图");
    assert.ok(items[1].keywords.includes("收束感短发"), items[1].keywords);
    assert.ok(items[1].keywords.includes("くびれショート"), "the original Japanese name stays searchable");
    assert.equal(items[0].thumbnail, "https://ai-portrait-gallery.pages.dev/img/thumb/f71f980dde3.webp");
    assert.equal(items[1].original, "https://ai-portrait-gallery.pages.dev/img/full/f009cba9893.png");
});

test("the Chinese catalog rejects image URLs outside the gallery origin", () => {
    const hostile = JSON.stringify([{ id: "x", 类型: "正面脸图", 发长: "短发", 缩略图: "https://example.com/a.webp", 原图: "https://example.com/a.png" }]);
    assert.throws(() => parsePortraitZhCatalog(hostile), /Invalid portrait image URL/);
});

test("the Chinese catalog rejects entries without the fields the panel filters on", () => {
    assert.throws(() => parsePortraitZhCatalog(JSON.stringify([{ id: "x", 类型: "正面脸图" }])), /Invalid portrait entry/);
    assert.throws(() => parsePortraitZhCatalog("{}"), /Invalid portrait catalog/);
});

test("the origin catalog fallback resolves relative images and labels the section", () => {
    const items = parsePortraitOriginCatalog(originCatalog);
    assert.equal(items.length, 2);
    assert.deepEqual(items.map(item => item.poseType), ["正面脸图", "造型参考"]);
    assert.deepEqual(items.map(item => item.category), ["ショート", "ロング"]);
    assert.equal(items[1].keywords, "造型参考 · ストレートロング");
    assert.equal(items[0].thumbnail, "https://ai-portrait-gallery.pages.dev/img/thumb/f71f980dde3.webp");
    assert.equal(items[1].original, "https://ai-portrait-gallery.pages.dev/img/full/ffd50b11c15.png");
});

test("a page without the origin catalog payload fails instead of returning empty results", () => {
    assert.throws(() => parsePortraitOriginCatalog("<html></html>"), /Portrait catalog unavailable/);
});
