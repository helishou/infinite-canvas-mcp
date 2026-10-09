import assert from "node:assert/strict";
import test from "node:test";
import { dramaWorkbenchEpisode, dramaWorkbenchPath } from "./workbench-entry";
import type { DramaEpisode } from "@/services/backend-api";
const episodes = [{ id: "ep2", episodeNumber: 2 }, { id: "ep1", episodeNumber: 1 }] as DramaEpisode[];
test("entering a drama selects its first episode while explicit episode selection remains authoritative", () => {
    assert.equal(dramaWorkbenchEpisode(episodes)?.id, "ep1");
    assert.equal(dramaWorkbenchEpisode(episodes, "ep2")?.id, "ep2");
    assert.throws(() => dramaWorkbenchEpisode(episodes, "foreign"), /EPISODE_OUTSIDE_DRAMA/);
    assert.equal(dramaWorkbenchEpisode([]), undefined);
    assert.deepEqual(episodes.map(episode => episode.id), ["ep2", "ep1"]);
});
test("workbench links preserve episode and workspace without canvas or modal routing", () => {
    const url = new URL(dramaWorkbenchPath("drama/中文", "ep 2", "shots"), "https://example.test");
    assert.equal(url.pathname, "/production");
    assert.equal(url.searchParams.get("dramaId"), "drama/中文");
    assert.equal(url.searchParams.get("episodeId"), "ep 2");
    assert.equal(url.searchParams.get("workspace"), "shots");
    assert.equal(url.searchParams.has("edit"), false);
});
