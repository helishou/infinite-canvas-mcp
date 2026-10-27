import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { readFileSync } from "node:fs";
import { ProductionPageHeading } from "./production-page-heading";

const i18n = createInstance();
void i18n.init({ lng: "en", initAsync: false, resources: { en: { translation: { common: { details: "Details" } } } } });
const render = (props: Parameters<typeof ProductionPageHeading>[0]) => renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(ProductionPageHeading, props)));
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("task header keeps context, status and actions visible without a tutorial hero", () => {
    const html = render({ title: "Subjects", summary: "Episode assets", help: createElement("p", null, "Long binding instructions"), actions: createElement("button", { type: "button" }, "Add asset") });
    assert.match(html, /<h2[^>]*class="m-0 [^"]*"[^>]*>Subjects<\/h2>/);
    assert.match(html, /production-page-summary[^>]*>Episode assets/);
    assert.match(html, /aria-label="Subjects · Details"/);
    assert.match(html, /<button type="button">Add asset<\/button>/);
    assert.doesNotMatch(html, /Long binding instructions/);
    const withoutHelp = render({ title: "Script", summary: "3 scenes" });
    assert.doesNotMatch(withoutHelp, /aria-label=.*Details/);
    assert.match(withoutHelp, /3 scenes/);
});

test("asset registration shares the search toolbar and keeps style controls and editors", () => {
    const source = read("./director-panel.tsx");
    const toolbar = source.split('\n').find(line => line.includes('aria-label={t("director.studio.searchAssets")}')) || "";
    assert.match(toolbar, /setNewSubjectOpen\(true\)/);
    assert.match(toolbar, /data-asset-search-actions><div className="w-60 max-w-full">/);
    assert.match(source, /<Modal open=\{newSubjectOpen\}/);
    assert.match(source, /director\.studio\.styleSettings/);
    // 分集页不再提供风格锚点设置；只有非分集画布（共享资产画布等）保留该折叠面板。
    assert.match(source, /canvasRole !== "episode" && <details/);
    assert.match(source, /sourceDrafts\["style:style_policy_reason"\]/);
    assert.match(source, /assetScopeHint\} help=/);
    assert.doesNotMatch(source, /justify-end gap-3"><Button disabled=\{busy\} onClick=\{\(\) => setNewSubjectOpen/);
});

test("warnings and draft recovery stay outside optional header guidance", () => {
    const continuity = read("./continuity-panel.tsx");
    const heading = continuity.split('\n').find(line => line.includes('<ProductionPageHeading')) || "";
    for (const key of ["sourceConflict", "invalidDraft", "publishedReadOnly"]) {
        assert.match(continuity, new RegExp(key));
        assert.doesNotMatch(heading, new RegExp(key));
    }
    const director = read("./director-panel.tsx");
    assert.match(director, /compileError && <Alert type="error"/);
    assert.match(director, /sourceChanged \|\| invalidDraft/);
});


test("explicit parent-navigation context removes the duplicate title row, preserving accessible title and toolbar actions", () => {
    const html = render({ title: "Delivery", titleAlreadyVisible: true, help: "Instructions", toolbar: createElement("nav", { "aria-label": "Sections" }, "Checks · Tasks"), actions: createElement("button", null, "Refresh") });
    assert.match(html, /<h2 class="sr-only">Delivery<\/h2>/);
    assert.doesNotMatch(html, /production-page-context|production-page-title/);
    assert.match(html, /aria-label="Delivery · Details"/);
    assert.match(html, /<nav aria-label="Sections">Checks · Tasks<\/nav>/);
    assert.match(html, /<button>Refresh<\/button>/);
    assert.equal((html.match(/<header/g) || []).length, 1);
    assert.match(html, /<nav[\s\S]*Refresh[\s\S]*<\/header>/);
    const standalone = render({ title: "Delivery", toolbar: createElement("nav", null, "Sections") });
    assert.doesNotMatch(standalone, /sr-only/);
    assert.match(standalone, /<\/header><nav>Sections/);
});

test("only the owning full workspace opts into already-visible titles", () => {
    const production = read("./production.tsx");
    assert.match(production, /navigationTitleVisible=\{!embedded\} embedded=\{embedded\}/);
    assert.match(read("./director-panel.tsx"), /navigationTitleVisible = false/);
    assert.match(read("./manage-panel.tsx"), /navigationTitleVisible = false/);
});
