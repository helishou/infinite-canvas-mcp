import assert from "node:assert/strict";
import test from "node:test";
import { productionOverviewMedia } from "./production-overview-media";

const production = (draft: Record<string, unknown>, published: Record<string, unknown> = {}) => ({
  draft: { director: { shotInputs: {}, assets: {} }, keyframes: {}, clipGroups: [], ...draft }, published,
}) as unknown as Parameters<typeof productionOverviewMedia>[0];

test("overview does not reuse published Clip or frame bindings after draft regrouping", () => {
  const value = production({}, { keyframes: { S1: { nodeId: "old-image", storageKey: "old.webp" } }, clipGroups: [{ id: "OLD", shotIds: ["S1"], nodeId: "video", segmentId: "old" }] });
  assert.deepEqual(productionOverviewMedia(value, [{ id: "video", metadata: { segments: [{ id: "old", resultStorageKey: "old.mp4" }] } }], "S1"), {});
});

test("overview resolves only the current draft Clip's exact node and segment", () => {
  const value = production({ clipGroups: [{ id: "NEW", shotIds: ["S1"], nodeId: "video", segmentId: "new" }] });
  const result = productionOverviewMedia(value, [{ id: "video", metadata: { segments: [null, { id: "old", resultStorageKey: "old.mp4" }, { id: "new", resultStorageKey: "new.mp4" }] } }], "S1");
  assert.deepEqual(result, { clip: { id: "NEW", storageKey: "new.mp4", inputOutdated: false } });
});

test("overview carries outdated input evidence from Clip records and runtime results", () => {
  for (const [groupOutdated, resultOutdated] of [[true, false], [false, true]]) {
    const value = production({ clipGroups: [{ id: "C1", shotIds: ["S1"], nodeId: "video", segmentId: "clip", inputOutdated: groupOutdated }] });
    assert.equal(productionOverviewMedia(value, [{ id: "video", metadata: { segments: [{ id: "clip", resultStorageKey: "old.mp4", inputOutdated: resultOutdated }] } }], "S1").clip?.inputOutdated, true);
  }
});

test("overview never falls back to a published asset and preserves current frame outdated status", () => {
  const draft = { director: { shotInputs: { S1: { keyframeAssetId: "A1" } }, assets: { A1: { nodeId: "image", inputOutdated: true } } } };
  const value = production(draft, { director: { assets: { A1: { storageKey: "old.webp" } } } });
  assert.deepEqual(productionOverviewMedia(value, [], "S1"), {});
  const current = production({ director: { ...draft.director, assets: { A1: { nodeId: "image", storageKey: "frame.webp", inputOutdated: true } } } });
  assert.deepEqual(productionOverviewMedia(current, [], "S1"), { frame: { storageKey: "frame.webp", inputOutdated: true } });
});

test("current legacy keyframes also carry canvas input-outdated evidence", () => {
  const value = production({ keyframes: { S1: { nodeId: "frame", storageKey: "frame.webp" } } });
  assert.equal(productionOverviewMedia(value, [{ id: "frame", metadata: { inputOutdated: true } }], "S1").frame?.inputOutdated, true);
});
