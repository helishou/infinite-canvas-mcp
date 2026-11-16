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

test("primary navigation has no workbench tab — the logo is the home entry", () => {
    // 首页导航项已移除：左上角 logo 即回主页入口，顶栏不再重复放一个「工作台」tab。
    // workbench 仍是合法 area（见路由解析 / 上方 URL 用例），只是不作为可见导航项渲染。
    assert.deepEqual(
        navigationTools.map((item) => item.slug),
        ["projects", "freeCanvas", "resources", "workflows", "skills"],
    );
    assert.deepEqual(
        navigationTools.map((item) => item.href),
        ["/projects", "/projects?type=canvas", "/assets", "/workflows", "/skills"],
    );
    // slug 类型里仍保留 workbench（路由 area 用），但不可作为可见 tab：转成字符串再断言，避免无意义的字面量比较。
    assert.ok(!navigationTools.some((item) => (item.slug as string) === "workbench"), "no visible workbench tab");
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
