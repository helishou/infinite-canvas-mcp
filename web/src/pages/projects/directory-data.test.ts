import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { CanvasFolder, CanvasProject } from "../../stores/canvas/use-canvas-store";
import type { DramaEpisode } from "../../services/backend-api";
import { canvasProjectDestination, dramaCanvasOwners, dramaProjectDestination, matchesProjectQuery, ordinaryCanvasProjects, projectDirectoryType, updateProjectDirectoryLocation } from "./directory-data";

const project = (id: string, folderId?: string) => ({ id, folderId, title: id, nodes: [], connections: [] }) as unknown as CanvasProject;
const episode = (id: string, canvasId: string | null) => ({ id, canvasId }) as DramaEpisode;

test("directory filters are deep-linkable while legacy entry points retain their scope", () => {
    assert.equal(projectDirectoryType("/projects", new URLSearchParams()), "all");
    assert.equal(projectDirectoryType("/projects", new URLSearchParams("type=canvas&q=one")), "canvas");
    assert.equal(projectDirectoryType("/projects", new URLSearchParams("type=drama")), "drama");
    assert.equal(projectDirectoryType("/projects", new URLSearchParams("type=unknown")), "all");
    assert.equal(projectDirectoryType("/canvas", new URLSearchParams("mode=choose&type=drama")), "canvas");
    assert.equal(projectDirectoryType("/production", new URLSearchParams("type=canvas")), "drama");
});

test("search and type changes preserve Agent bootstrap hash, query context and legacy search scope", () => {
    const location = { pathname: "/canvas", search: "?mode=choose&from=agent", hash: "#agentUrl=https%3A%2F%2Flocalhost&agentToken=example" };
    const searched = updateProjectDirectoryLocation(location, { q: "Test Project" });
    assert.equal(searched.pathname, "/canvas");
    assert.equal(searched.hash, location.hash);
    assert.equal(new URLSearchParams(searched.search).get("q"), "Test Project");
    assert.equal(new URLSearchParams(searched.search).get("mode"), "choose");
    const filtered = updateProjectDirectoryLocation(searched, { type: "canvas" });
    assert.equal(filtered.pathname, "/projects");
    assert.equal(filtered.hash, location.hash);
    assert.equal(new URLSearchParams(filtered.search).get("type"), "canvas");
    assert.equal(new URLSearchParams(filtered.search).get("q"), "Test Project");
    const cleared = updateProjectDirectoryLocation(filtered, { type: "all", q: "" });
    assert.deepEqual(cleared, { pathname: "/projects", search: "mode=choose&from=agent", hash: location.hash });
});

test("one case-insensitive, whitespace-tolerant search matches canvas and drama names", () => {
    assert.equal(matchesProjectQuery("A Long Journey", "  JOURNEY  "), true);
    assert.equal(matchesProjectQuery("春日剧目", "春日"), true);
    assert.equal(matchesProjectQuery("Canvas", ""), true);
    assert.equal(matchesProjectQuery("Canvas", "Drama"), false);
});

test("the free directory excludes actual shared and episode bindings, not legacy drama folder membership", () => {
    const folders: CanvasFolder[] = [
        { id: "ordinary", name: "Ordinary", createdAt: "" },
        { id: "series", name: "Series", createdAt: "", isDrama: true, sharedAssetCanvasId: "shared" },
    ];
    const standalone = project("standalone");
    const filed = project("filed", "ordinary");
    const projects = [standalone, filed, project("internal", "series"), project("shared", "ordinary"), project("episode"), project("another-episode", "ordinary")];
    const episodes = { series: [episode("e1", "episode"), episode("e2", "another-episode"), episode("unbound", null)] };
    const ordinary = ordinaryCanvasProjects(projects, folders, episodes);
    assert.deepEqual(ordinary.map(item => item.id), ["standalone", "filed", "internal"]);
    assert.equal(ordinary[0], standalone, "a second editor view must reuse the original project object");
    assert.equal(projects.length, 6, "discovery cannot mutate or migrate projects");
});

test("unread ownership stays conservative until a successful empty episode list confirms legacy canvases are unbound", () => {
    const folders: CanvasFolder[] = [{ id: "series", name: "Series", createdAt: "", isDrama: true, sharedAssetCanvasId: "shared" }];
    const projects = [project("internal", "series"), project("shared"), project("free")];
    assert.deepEqual(ordinaryCanvasProjects(projects, folders, {}).map(item => item.id), ["free"]);
    assert.deepEqual(ordinaryCanvasProjects(projects, folders, { series: undefined }).map(item => item.id), ["free"]);
    assert.deepEqual(ordinaryCanvasProjects(projects, folders, { series: [] }).map(item => item.id), ["internal", "free"]);
});

test("canvas and production views use the same encoded project ID and preserve bootstrap query/hash", () => {
    const search = "mode=choose&nodeId=node%2Fone&segmentId=part&from=agent";
    const hash = "#agentUrl=https%3A%2F%2Flocalhost&agentToken=example";
    const canvas = canvasProjectDestination("same/id", "canvas", `?${search}`, hash);
    const production = canvasProjectDestination("same/id", "production", search, hash);
    assert.deepEqual(canvas, { to: `/canvas/same%2Fid?${search}${hash}`, replace: true });
    assert.deepEqual(production, { to: `/director/same%2Fid?${search}${hash}`, replace: true });
    assert.deepEqual(canvasProjectDestination("same/id", "canvas", "", "#ordinary-anchor"), { to: "/canvas/same%2Fid", replace: false });
    for (const mode of ["new", "recent", "choose"]) {
        assert.equal(new URL(canvasProjectDestination("p", "canvas", `mode=${mode}&extra=kept`).to, "https://example.test").searchParams.get("mode"), mode);
    }
});

test("drama cards open the drama workbench rather than an internal canvas or stale episode", () => {
    const destination = new URL(dramaProjectDestination("series/id", "dramaId=old&episodeId=other&manage=1&workspace=story&from=agent"), "https://example.test");
    assert.equal(destination.pathname, "/production");
    assert.equal(destination.searchParams.get("dramaId"), "series/id");
    assert.equal(destination.searchParams.has("episodeId"), false);
    assert.equal(destination.searchParams.has("manage"), false);
    assert.equal(destination.searchParams.get("workspace"), "story");
    assert.equal(destination.searchParams.get("from"), "agent");
});

test("the unified directory is additive and preserves all established routes", () => {
    const router = readFileSync(new URL("../../router.tsx", import.meta.url), "utf8");
    const paths = [...router.matchAll(/path:\s*"([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(new Set(paths), new Set([
        "/", "/projects", "/production", "/director", "/director/:projectId", "/image", "/video", "/assets", "/prompts", "/canvas", "/canvas/performance", "/canvas/:id", "/drama", "/drama/episodes/:episodeId/production", "/drama/scenes/:sceneId/production", "/workflows", "/config", "/diagnostics/mcp", "/analytics/local", "/pelican-bike", "*",
    ]));
    assert.match(router, /const CanvasProjectPage = lazy\(loadCanvasProjectPage\)/, "the existing draft-safe lazy project loader must stay in use");
});


test("retired folder hierarchies flatten without changing projects, unknown fields, or persisted membership", () => {
    const folders = [
        { id: "root", name: "Old root", createdAt: "" },
        { id: "nested", name: "Old nested", parentId: "root", createdAt: "" },
        { id: "missing-parent", name: "Old detached", parentId: "removed", createdAt: "" },
        { id: "series", name: "Series", createdAt: "", isDrama: true, sharedAssetCanvasId: "shared" },
    ];
    const projects = [
        project("unfiled"), project("root-canvas", "root"), project("nested-canvas", "nested"),
        project("detached-canvas", "missing-parent"), project("orphan-canvas", "deleted-folder"),
        project("legacy-drama-orphan", "series"), project("episode", "root"), project("shared", "deleted-folder"),
    ];
    const before = structuredClone({ folders, projects });
    const episodes = { series: [episode("bound", "episode")] };
    const flat = ordinaryCanvasProjects(projects, folders, episodes);
    assert.deepEqual(flat.map(item => item.id), ["unfiled", "root-canvas", "nested-canvas", "detached-canvas", "orphan-canvas", "legacy-drama-orphan"]);
    assert.ok(flat.every(item => item === projects.find(original => original.id === item.id)), "flattening reuses the original project objects");
    assert.deepEqual({ folders, projects }, before, "discovery does not move, rewrite or delete persisted data");
    const owners = dramaCanvasOwners(folders, episodes);
    assert.deepEqual([...owners.keys()].sort(), ["episode", "shared"]);
    assert.equal(owners.get("episode"), folders[3]);
    assert.equal(owners.get("shared"), folders[3]);
});

test("legacy folder query values are inert while search and Agent deep links remain intact", () => {
    const location = { pathname: "/canvas", search: "?folderId=removed&folder=nested&type=canvas&mode=choose", hash: "#agentUrl=https%3A%2F%2Flocalhost&agentToken=example" };
    const searched = updateProjectDirectoryLocation(location, { q: "orphan" });
    const query = new URLSearchParams(searched.search);
    assert.equal(projectDirectoryType(searched.pathname, query), "canvas");
    const projects = ordinaryCanvasProjects([project("orphan-canvas", "removed"), project("root-canvas")], [], {});
    assert.deepEqual(projects.filter(item => matchesProjectQuery(item.title, query.get("q") || "")).map(item => item.id), ["orphan-canvas"]);
    const opened = canvasProjectDestination(projects[0].id, "canvas", searched.search, searched.hash);
    assert.equal(new URL(opened.to, "https://example.test").pathname, "/canvas/orphan-canvas");
    assert.equal(new URL(opened.to, "https://example.test").searchParams.get("mode"), "choose");
    assert.equal(opened.replace, true);
    assert.ok(opened.to.endsWith(location.hash));
});
