import assert from "node:assert/strict";
import test from "node:test";

import type { Asset, AssetKind } from "@/stores/use-asset-store";
import {
    CREATIVE_MODES,
    DEFAULT_REFERENCE_FILTERS,
    buildReferenceAssets,
    countReferenceFacets,
    creativeCapabilityForMode,
    creativeModeGenerates,
    creativeModelKey,
    creativeProjectTitle,
    filterReferenceAssets,
    paginateReferences,
    referenceAttachmentSummary,
    toAgentAttachments,
    toReferenceAsset,
    toggleReferenceSelection,
    type ReferenceFilters,
} from "./creative-pad";

function asset(kind: AssetKind, id: string, overrides: Record<string, unknown> = {}): Asset {
    const base = {
        id,
        title: `素材-${id}`,
        coverUrl: "",
        tags: [],
        source: "",
        note: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
    };
    if (kind === "image") return { ...base, kind, data: { dataUrl: `data:image/png;base64,${id}`, storageKey: `img/${id}`, width: 320, height: 180, bytes: 1024, mimeType: "image/png" }, ...overrides } as Asset;
    if (kind === "video") return { ...base, kind, data: { url: `/media/${id}.mp4`, storageKey: `vid/${id}`, width: 640, height: 360, bytes: 2048, mimeType: "video/mp4" }, ...overrides } as Asset;
    if (kind === "audio") return { ...base, kind, data: { url: `/media/${id}.wav`, storageKey: `aud/${id}`, bytes: 512, mimeType: "audio/wav" }, ...overrides } as Asset;
    if (kind === "text") return { ...base, kind, data: { content: `正文-${id}` }, ...overrides } as Asset;
    if (kind === "character") return {
        ...base, kind, data: {
            name: `角色-${id}`, englishName: "", description: "", voice: "", voiceName: "", voiceDescription: "",
            voiceAssetId: "", images: [{ url: `/media/${id}.png`, storageKey: `char/${id}`, name: "正面", width: 300, height: 400, bytes: 900, mimeType: "image/png", outfit: "", outfitDescription: "" }],
            primaryIndex: 0,
        }, ...overrides,
    } as Asset;
    if (kind === "scene" || kind === "prop") return {
        ...base, kind, data: {
            name: `物件-${id}`, description: "", image: { url: `/media/${id}.jpg`, storageKey: `obj/${id}`, name: "主图", width: 800, height: 600, bytes: 3000, mimeType: "image/jpeg" },
            colorCardPrompt: "",
        }, ...overrides,
    } as Asset;
    throw new Error(`unsupported kind ${kind}`);
}

const kinds: AssetKind[] = ["image", "video", "audio", "text", "character", "scene", "prop"];

test("every asset kind maps to a stable reference identity, and missing shared sources are excluded", () => {
    const items = buildReferenceAssets(kinds.map((kind, index) => asset(kind, `k${index}`)));
    assert.equal(items.length, kinds.length);
    assert.equal(items[0].mediaType, "image");
    assert.equal(items[0].dataUrl, "data:image/png;base64,k0");
    assert.equal(items[1].mediaType, "video");
    assert.equal(items[1].url, "/media/k1.mp4");
    assert.equal(items[2].mediaType, "audio");
    assert.equal(items[3].mediaType, "other");
    assert.equal(items[4].category, "character");
    assert.equal(items[4].url, "/media/k4.png");
    assert.equal(items[5].category, "scene");
    assert.equal(items[6].category, "prop");
    assert.equal(toReferenceAsset(asset("image", "gone", { metadata: { sharedAssetMissing: true } })), null);
});

test("keyword search covers title, tags, source and note without breaking on mixed filters", () => {
    const items = buildReferenceAssets([
        asset("image", "a", { title: "雨夜街角", tags: ["氛围"], source: "分镜" }),
        asset("video", "b", { title: "推轨镜头", note: "开场" }),
        asset("character", "c", { title: "沈侯" }),
    ]);
    const filters = (patch: Partial<ReferenceFilters>): ReferenceFilters => ({ ...DEFAULT_REFERENCE_FILTERS, ...patch });
    assert.deepEqual(filterReferenceAssets(items, filters({ keyword: "氛围" })).map(i => i.id), ["a"]);
    assert.deepEqual(filterReferenceAssets(items, filters({ keyword: "开场" })).map(i => i.id), ["b"]);
    assert.deepEqual(filterReferenceAssets(items, filters({ keyword: "分镜" })).map(i => i.id), ["a"]);
    assert.deepEqual(filterReferenceAssets(items, filters({ mediaType: "image" })).map(i => i.id), ["a", "c"]);
    assert.deepEqual(filterReferenceAssets(items, filters({ category: "character" })).map(i => i.id), ["c"]);
    assert.deepEqual(filterReferenceAssets(items, filters({ mediaType: "video", category: "character" })), []);
});

test("facet counts ignore their own dimension so sidebar numbers match the list", () => {
    const items = buildReferenceAssets([
        asset("image", "i1"), asset("image", "i2", { tags: ["夜戏"] }),
        asset("video", "v1", { tags: ["夜戏"] }), asset("character", "c1"), asset("text", "t1"),
    ]);
    const all = countReferenceFacets(items, DEFAULT_REFERENCE_FILTERS);
    assert.equal(all.mediaType.all, 5);
    assert.equal(all.mediaType.image, 3);
    assert.equal(all.mediaType.video, 1);
    assert.equal(all.mediaType.other, 1);
    assert.equal(all.category.all, 5);
    assert.equal(all.category.image, 2);
    assert.equal(all.category.character, 1);
    assert.equal(all.category.other, 2);

    const night = countReferenceFacets(items, { keyword: "夜戏", mediaType: "image", category: "all" });
    assert.equal(night.mediaType.all, 2, "keyword hits one image + one video");
    assert.equal(night.mediaType.video, 1, "mediaType facet ignores the active mediaType filter");
    assert.equal(night.category.all, 1, "category facet still respects the active mediaType filter");
    assert.equal(filterReferenceAssets(items, { keyword: "夜戏", mediaType: "image", category: "all" }).length, night.category.all);
});

test("pagination clamps out-of-range pages and reports honest from/to", () => {
    const items = buildReferenceAssets(kinds.map((kind, index) => asset(kind, `p${index}`)));
    const first = paginateReferences(items, 1, 3);
    assert.equal(first.page, 1);
    assert.equal(first.totalPages, 3);
    assert.equal(first.from, 1);
    assert.equal(first.to, 3);
    assert.equal(first.items.length, 3);
    assert.equal(paginateReferences(items, 99, 3).page, 3);
    assert.equal(paginateReferences(items, -4, 3).page, 1);
    const empty = paginateReferences([], 5, 3);
    assert.deepEqual([empty.total, empty.from, empty.to, empty.totalPages], [0, 0, 0, 1]);
});

test("multi-select never silently displaces an existing pick at the cap", () => {
    let selected: string[] = [];
    selected = toggleReferenceSelection(selected, "a", 2);
    selected = toggleReferenceSelection(selected, "b", 2);
    assert.deepEqual(toggleReferenceSelection(selected, "c", 2), ["a", "b"]);
    assert.deepEqual(toggleReferenceSelection(selected, "a", 2), ["b"]);
    assert.deepEqual(toggleReferenceSelection(["a", "b"], "c", 0), ["a", "b", "c"]);
});

test("each creative mode maps to the model capability it actually uses", () => {
    assert.deepEqual([...CREATIVE_MODES], ["canvas", "image", "video", "storyboard", "text", "audio"]);
    assert.equal(creativeCapabilityForMode("canvas"), "image");
    assert.equal(creativeCapabilityForMode("storyboard"), "video");
    assert.equal(creativeCapabilityForMode("text"), "text");
    assert.equal(creativeCapabilityForMode("audio"), "audio");
    assert.equal(creativeModelKey("audio"), "audioModel");
    assert.equal(creativeModelKey("text"), "textModel");
    // 画布 / 分镜只建画布并交给 Agent，其余模式当场提交生成。
    assert.deepEqual([...CREATIVE_MODES].filter(creativeModeGenerates), ["image", "video", "text", "audio"]);
});

test("only real image assets become Agent attachments; audio/video/text are registered but not faked", () => {
    const items = buildReferenceAssets([
        asset("image", "i"), asset("character", "c"), asset("video", "v"), asset("audio", "a"), asset("text", "t"),
    ]);
    const attachments = toAgentAttachments(items);
    assert.equal(attachments.length, 2);
    assert.deepEqual(attachments.map(a => a.name), ["素材-i", "素材-c"]);
    assert.equal(attachments[0].dataUrl, "data:image/png;base64,i");
    assert.equal(attachments[1].url, "/media/c.png");
    for (const attachment of attachments) {
        assert.ok(attachment.url && attachment.dataUrl, "both URL channels must be populated for the composer");
    }
    assert.deepEqual(referenceAttachmentSummary(items), { attached: 2, registeredOnly: 3 });
});

test("project title keeps the authored wording and truncates long drafts", () => {
    assert.equal(creativeProjectTitle("  一个雨夜  的街头  "), "一个雨夜 的街头");
    assert.equal(creativeProjectTitle("一二三四五六七八九十".repeat(4)), "一二三四五六七八九十一二三四五六七八九十一二三四…");
    assert.equal(creativeProjectTitle("   "), "");
});
