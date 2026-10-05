import assert from "node:assert/strict";
import test from "node:test";
import { productionObjectForNode, productionObjectPath, productionObjectPrompt, productionObjectState } from "./production-object";
import type { EpisodeProduction, ProductionCanvasContext } from "../services/backend-api";

const context = { canvasId: "canvas-a", role: "episode", owner: { kind: "episode", id: "episode-a" } } as ProductionCanvasContext;
const production = { draft: {
    clipGroups: [{ id: "segment-a", nodeId: "h3-a", segmentId: "clip-a", shotIds: ["shot-a"] }, { id: "segment-b", nodeId: "h3-a", segmentId: "clip-b", shotIds: ["shot-b"] }],
    keyframes: {}, shots: [], director: { assets: { hero: { nodeId: "hero-a" } }, shotInputs: {}, source: { asset_plan: [{ asset_id: "hero", asset_name: "同名角色" }] } },
} } as unknown as EpisodeProduction;

test("a multi-Clip H3 node never guesses the conversation target from its name or first Clip", () => {
    assert.equal(productionObjectForNode(context, production, { id: "h3-a", title: "segment-b" }), null);
    assert.equal(productionObjectForNode(context, production, { id: "h3-a", title: "segment-b" }, "missing"), null);
    const object = productionObjectForNode(context, production, { id: "h3-a", title: "H3" }, "clip-b")!;
    assert.equal(object.targetId, "segment-b");
    assert.equal(object.segmentId, "clip-b");
    assert.match(productionObjectPrompt(object), /H3 Clip：clip-b/);
    const route = new URL(productionObjectPath(object), "http://fixture");
    assert.equal(route.searchParams.get("target"), "segment:segment-b");
    assert.equal(route.searchParams.get("segmentId"), "clip-b");
});

test("a keyframe review and runtime state use the exact selected Clip and formal review", () => {
    const object = productionObjectForNode(context, production, { id: "h3-a", title: "H3" }, "clip-b")!;
    const node = { metadata: { status: "loading", segments: [{ id: "clip-a", status: "loading" }, { id: "clip-b", status: "success", resultStorageKey: "video:b" }] } };
    assert.equal(productionObjectState(production, object, node).status, "complete");
    const changedInputs = structuredClone(production); changedInputs.draft.clipGroups[1].inputOutdated = true;
    assert.equal(productionObjectState(changedInputs, object, node).status, "outdated");
    node.metadata.segments[1].status = "loading";
    assert.equal(productionObjectState(production, object, node).working, true);
});

test("adopted media, outdated inputs and unpublished replacement media have distinct review eligibility", () => {
    const record = structuredClone(production);
    const asset = record.draft.director!.assets.hero;
    Object.assign(asset, { status: "approved", storageKey: "image:old" });
    record.published = structuredClone(record.draft); record.publishedVersion = 1;
    const object = productionObjectForNode(context, record, { id: "hero-a", title: "Hero" })!;
    assert.equal(productionObjectState(record, object, { metadata: { storageKey: "image:old" } }).status, "approved");
    asset.inputOutdated = true;
    assert.equal(productionObjectState(record, object, { metadata: { storageKey: "image:old" } }).status, "outdated");
    assert.equal(productionObjectState(record, object, { metadata: { storageKey: "image:new" } }).canReview, false);
    assert.equal(productionObjectState(record, object, { metadata: { storageKey: "image:old", status: "queued" } }).canReview, false);
});

test("identical display names do not associate an unrelated node with a formal asset", () => {
    assert.equal(productionObjectForNode(context, production, { id: "unrelated", title: "同名角色" }), null);
    assert.equal(productionObjectForNode(context, production, { id: "hero-a", title: "renamed locally" })?.targetId, "hero");
});

test("a scene group discusses the script occurrence rather than the reused environment", () => {
    const sceneProduction = structuredClone(production);
    sceneProduction.draft.director!.source.script_scenes = [{ id: "day", scene_id: "room", scene_name: "First visit" }, { id: "night", scene_id: "room", scene_name: "Return" }];
    const object = productionObjectForNode(context, sceneProduction, { id: "group-night", title: "Room", metadata: { productionSceneId: "night" } })!;
    assert.equal(object.targetKind, "scene"); assert.equal(object.targetId, "night"); assert.equal(object.title, "Return");
});
