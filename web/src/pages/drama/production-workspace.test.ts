import assert from "node:assert/strict";
import test from "node:test";
import type { EpisodeProduction } from "@/services/backend-api";
import { productionNavigationGroups, productionTargetTitle, productionWorkspaceQuery, productionWorkspaces, seriesWorkspaceView } from "./production-workspace";

test("series navigation separates real shared canvas management from current-episode assets", () => {
    const groups = productionNavigationGroups({ hasSeries: true, scope: "episode" });
    assert.deepEqual(groups.map(group => group.id), ["series", "owner", "settings"]);
    assert.deepEqual(groups[0].items.map(item => item.seriesView), ["planning", "episodes", "shared"]);
    assert.equal(groups[0].items.some(item => item.workspace === "assets"), false);
    assert.equal(groups[1].items.find(item => item.workspace === "assets")?.labelKey, "director.workspaceHierarchy.episodeAssets");
    assert.deepEqual([...new Set(groups.flatMap(group => group.items.map(item => item.workspace)))], productionWorkspaces);
});

test("ordinary, shared and setup navigation describe only their actual owner scopes", () => {
    const ordinary = productionNavigationGroups({ hasSeries: false, scope: "canvas" });
    assert.equal(ordinary.some(group => group.id === "series"), false);
    assert.equal(ordinary[0].items.find(item => item.workspace === "assets")?.labelKey, "director.workspaceHierarchy.projectAssets");
    const shared = productionNavigationGroups({ hasSeries: false, scope: "shared-assets" });
    assert.equal(shared[0].labelKey, "director.workspaceHierarchy.sharedProduction");
    assert.equal(shared[0].items.find(item => item.workspace === "assets")?.labelKey, "director.workspaceHierarchy.sharedAssets");
    assert.deepEqual(productionNavigationGroups({ hasSeries: true, scope: "episode", setup: true }).map(group => group.id), ["series"]);
});

test("workspace navigation preserves ownership and unrelated query fields while replacing previous object focus", () => {
    const search = new URLSearchParams("dramaId=drama&episodeId=ep&productionKind=episode&productionId=ep&from=dramas&workspace=shots&target=shot:old&nodeId=old&segmentId=old&runId=run&workId=work&custom=keep");
    const next = productionWorkspaceQuery(search, "assets", { target: { kind: "asset", id: "asset:1" } });
    for (const key of ["dramaId", "episodeId", "productionKind", "productionId", "from", "custom"]) assert.equal(next.get(key), search.get(key));
    assert.equal(next.get("target"), "asset:asset:1");
    for (const key of ["nodeId", "segmentId", "runId", "workId"]) assert.equal(next.has(key), false);
    assert.equal(search.get("target"), "shot:old");
});

test("embedded workspace navigation retains running work identity and legacy keyframe links", () => {
    const next = productionWorkspaceQuery(new URLSearchParams("workId=work&runId=run&productionKind=canvas&productionId=shared"), "shots", { embedded: true, target: { kind: "keyframe", id: "shot-1" } });
    assert.equal(next.get("workId"), "work");
    assert.equal(next.get("runId"), "run");
    assert.equal(next.get("productionId"), "shared");
    assert.equal(next.get("target"), "frame:shot-1");
});

test("new series subviews retain workspace=series and safely clear when leaving that scope", () => {
    const next = productionWorkspaceQuery(new URLSearchParams("dramaId=d&episodeId=e"), "series", { seriesView: "shared" });
    assert.equal(next.get("workspace"), "series");
    assert.equal(seriesWorkspaceView(next.get("seriesView")), "shared");
    assert.equal(productionWorkspaceQuery(next, "overview").has("seriesView"), false);
    assert.equal(seriesWorkspaceView(null), undefined);
    assert.equal(seriesWorkspaceView("assets"), undefined);
});

test("object breadcrumb uses current production source names and retains IDs only when no name is known", () => {
    const production = { draft: { shots: [{ id: "shot-old", title: "Existing shot" }], director: { source: {
        asset_plan: [{ asset_id: "asset:1", asset_name: "Mira's coat" }],
        shots: [{ id: "shot-1", title: "Window close-up" }],
        segments: [{ id: "segment-1", title: "Opening clip" }],
    } } } } as unknown as EpisodeProduction;
    assert.equal(productionTargetTitle(production, "asset:asset:1"), "Mira's coat");
    assert.equal(productionTargetTitle(production, "shot:shot-1"), "Window close-up");
    assert.equal(productionTargetTitle(production, "frame:shot-old"), "Existing shot");
    assert.equal(productionTargetTitle(production, "segment:segment-1"), "Opening clip");
    assert.equal(productionTargetTitle(production, "asset:missing"), "missing");
    assert.equal(productionTargetTitle(production, ""), undefined);
});
