import assert from "node:assert/strict";
import test from "node:test";

import { navigationTools, workspaceSecondaryNavigation } from "@/constant/navigation-tools";
import { resolveWorkspaceNavigation } from "./workspace-navigation";

// Protect old shared/bookmarked URLs while changing their navigation grouping.
for (const [pathname, area] of [
    ["/", "workbench"],
    ["/projects", "projects"],
    ["/canvas", "freeCanvas"],
    ["/canvas/project-a", "freeCanvas"],
    ["/production", "projects"],
    ["/director", "projects"],
    ["/director/project-a", "projects"],
    ["/drama", "projects"],
    ["/drama/episodes/episode-a/production", "projects"],
    ["/drama/scenes/scene-a/production", "projects"],
    ["/image", "workbench"],
    ["/video", "workbench"],
    ["/assets", "resources"],
    ["/prompts", "resources"],
    ["/workflows", "workflows"],
    ["/skills", "skills"],
] as const) {
    test(`${pathname} stays in the ${area} workspace`, () => {
        assert.equal(resolveWorkspaceNavigation(pathname).area, area);
    });
}

test("primary navigation keeps the merged workspaces without a standalone generate entry", () => {
    assert.deepEqual(
        navigationTools.map((item) => item.slug),
        ["workbench", "projects", "freeCanvas", "resources", "workflows", "skills"],
    );
    assert.deepEqual(
        navigationTools.map((item) => item.href),
        ["/", "/projects", "/projects?type=canvas", "/assets", "/workflows", "/skills"],
    );
});

test("retired quick generate URLs classify as the home workbench and keep no secondary tab", () => {
    assert.equal("generate" in workspaceSecondaryNavigation, false);
    assert.deepEqual(resolveWorkspaceNavigation("/image"), { area: "workbench", compact: false });
    assert.deepEqual(resolveWorkspaceNavigation("/video", "?prompt=kept"), { area: "workbench", compact: false });
});

test("assets and prompts remain separately reachable full pages", () => {
    assert.deepEqual(
        workspaceSecondaryNavigation.resources.map((item) => item.href),
        ["/assets", "/prompts"],
    );
    assert.equal(resolveWorkspaceNavigation("/prompts").activeSecondary, "prompts");
});

test("project filters select matching tabs, including legacy catalogue routes", () => {
    assert.equal(resolveWorkspaceNavigation("/projects", "?type=canvas").area, "freeCanvas");
    assert.equal(resolveWorkspaceNavigation("/projects", "?type=canvas").secondary, undefined);
    assert.equal(resolveWorkspaceNavigation("/projects", "?type=drama").activeSecondary, "dramaProjects");
    assert.equal(resolveWorkspaceNavigation("/projects", "?type=unknown").activeSecondary, "allProjects");
    assert.equal(resolveWorkspaceNavigation("/canvas").area, "freeCanvas");
    assert.equal(resolveWorkspaceNavigation("/director").activeSecondary, "canvasProjects");
    assert.equal(resolveWorkspaceNavigation("/production").activeSecondary, "dramaProjects");
});

test("canvas details keep compact global navigation without catalogue tabs", () => {
    assert.deepEqual(resolveWorkspaceNavigation("/canvas/project-a", "?from=dramas&workspace=storyboard"), { area: "freeCanvas", compact: true });
    assert.equal(resolveWorkspaceNavigation("/canvas/").compact, false);
});

test("production editor pages do not show project catalogue tabs", () => {
    assert.equal(resolveWorkspaceNavigation("/production", "?dramaId=drama-a").secondary, undefined);
    assert.equal(resolveWorkspaceNavigation("/director/project-a").secondary, undefined);
});

test("settings and diagnostics stay utilities rather than activating a primary workspace", () => {
    assert.deepEqual(resolveWorkspaceNavigation("/config"), { compact: false });
    assert.deepEqual(resolveWorkspaceNavigation("/diagnostics/mcp"), { compact: false });
    assert.deepEqual(resolveWorkspaceNavigation("/canvas-extra"), { compact: false });
});
