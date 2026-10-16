import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { ProductionWorkspaceNavigation } from "./production-workspace-navigation";
import { productionNavigationGroups } from "./production-workspace";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const navigationSource = read("./production-workspace-navigation.tsx");
const i18n = createInstance();
void i18n.init({ lng: "en", initAsync: false, resources: {} });
const render = (element: ReactElement) =>
    renderToStaticMarkup(createElement(I18nextProvider, { i18n }, element));

test("production navigation never adds a second app-preferences action", () => {
    // Closed Ant overlays are not emitted by server rendering: inspect their source as well.
    assert.doesNotMatch(navigationSource, /app-preferences|openConfigDialog|config\.title|config\.preferences/);
    for (const scope of ["episode", "canvas", "shared-assets"] as const) {
        const groups = productionNavigationGroups({ hasSeries: scope === "episode", scope });
        assert.deepEqual(groups.find(group => group.id === "settings")?.items, [
            { id: "advanced", workspace: "advanced", labelKey: "director.workspace.tab.advanced" },
        ]);
        const props = { groups, selectedId: "advanced", onSelect: () => undefined };
        for (const layout of [{ horizontal: true, compact: false }, { horizontal: false, compact: true }, { horizontal: false, compact: false }]) {
            const html = render(createElement(ProductionWorkspaceNavigation, { ...props, ...layout }));
            assert.doesNotMatch(html, /app-preferences|config\.preferences/);
            if (!layout.horizontal) assert.match(html, /director.workspace.tab.advanced/);
        }
    }
});

test("standalone, setup, and embedded production share the real global settings host", () => {
    const router = read("../../router.tsx");
    const layout = read("../../layouts/user-layout.tsx");
    const topNav = read("../../components/layout/app-top-nav.tsx");
    const agent = read("../../components/agent/agent-panel.tsx");
    const production = read("./production.tsx");
    assert.match(router, /<UserLayout>[\s\S]*<Outlet \/>[\s\S]*children: \[/);
    assert.match(router, /path: "\/director\/:projectId", element: lazyPage\(EpisodeProductionPage\)/);
    assert.match(layout, /<AppTopNav \/>/);
    assert.match(layout, /<AgentPanel \/>/);
    assert.match(agent, /<ProductionEditor[^>]*embedded dialog/);
    assert.match(production, /const seriesNav = productionNavigationGroups\(\{ hasSeries: true, scope: "episode", setup: true, seriesSubviews: true \}\)/);
    assert.equal((topNav.match(/<UserStatusActions \/>/g) || []).length, 1);
    assert.equal((topNav.match(/<AppConfigModal \/>/g) || []).length, 1);
});

test("global app preferences remain reachable on mobile and desktop", () => {
    const actions = read("../../components/layout/user-status-actions.tsx");
    const button = actions.match(/\{showConfig && variant !== "canvas" \? \(([\s\S]*?)\) : null\}/)?.[1];
    assert.ok(button, "Global configuration action must remain present");
    assert.match(button, /openConfigDialog\(false\)/);
    assert.match(button, /aria-label=\{t\("workspaceNavigation.settings"\)\}/);
    assert.doesNotMatch(button, /hidden/);
    const iconClass = actions.match(/const naturalIconClass = "([^"]+)"/)?.[1];
    assert.ok(iconClass);
    assert.doesNotMatch(iconClass, /hidden/);
});
