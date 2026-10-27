import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getAntThemeConfig } from "./app-theme";
const css = readFileSync(new URL("../styles/globals.css", import.meta.url), "utf8");
test("Ant and semantic UI roles share dimensions and the host font", () => {
    for (const dark of [false, true]) {
        const token = getAntThemeConfig(dark).token!;
        assert.equal(token.fontFamily, "var(--font-sans)");
        assert.equal(token.fontSize, 14);
        assert.equal(token.lineHeight, 22 / 14);
        assert.equal(token.fontSizeSM, 12);
        assert.equal(token.controlHeight, 36);
        assert.equal(token.controlHeightSM, 32);
        assert.equal(token.controlHeightLG, 44);
        assert.equal(token.borderRadius, 6);
        assert.equal(token.borderRadiusLG, 12);
    }
    for (const [name, value] of Object.entries({"title-size":24,"title-leading":32,"panel-size":16,"panel-leading":24,"body-size":14,"body-leading":22,"caption-size":12,"caption-leading":18,"radius-card":10})) assert.ok(css.includes(`--ui-${name}: ${value}px;`), name);
    assert.match(css, /--ui-title-size: 22px; --ui-title-leading: 30px/);
    assert.match(css, /--ui-control-height: 44px; --ui-icon-hit: 44px/);
});
test("UI typography uses the bundled variable font without remote font services", () => {
    assert.match(css, /--font-sans: "Noto Sans SC Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC"/);
    const bootstrap = readFileSync(new URL("../bootstrap.tsx", import.meta.url), "utf8");
    assert.match(bootstrap, /import "@fontsource-variable\/noto-sans-sc"/);
    assert.doesNotMatch(bootstrap, /body\.style\.fontFamily/);
    assert.match(css, /body \{ font-family: var\(--font-sans\); \}/);
    assert.doesNotMatch(css, /@font-face|fonts\.google|fonts\.gstatic/);
    const roles = css.slice(css.indexOf("/* UI roles are opt-in:"));
    assert.doesNotMatch(roles, /(?:^|\n)(?:h[1-6]|p|input|textarea|\*|\.canvas)[^{]*\{/);
    assert.doesNotMatch(roles, /font-family\s*:/);
});
test("wrapping result labels retain save, edit and download callback targets", () => {
    const source = readFileSync(new URL("../pages/image/index.tsx", import.meta.url), "utf8");
    const card = source.slice(source.indexOf("function ResultImageCard("), source.indexOf("function PendingImageCard("));
    assert.match(card, /onClick=\{\(\) => void onSaveAsset\(image, index\)\}/);
    assert.match(card, /onClick=\{\(\) => void onEdit\(image, index\)\}/);
    assert.match(card, /onClick=\{\(\) => onDownload\(image, index\)\}/);
    assert.match(css, /\.ui-result-action\.ant-btn > span:last-child[^}]*white-space: normal/);
    assert.doesNotMatch(source.match(/const RESULT_ACTION_BUTTON_CLASS = "([^"]+)"/)![1], /truncate|line-clamp|text-ellipsis/);
});

test("canvas authored prompts retain their previous face in inline and expanded editors", () => {
    const panel = readFileSync(new URL("../components/canvas/canvas-node-prompt-panel.tsx", import.meta.url), "utf8");
    assert.equal((panel.match(/canvas-authored-prompt/g) || []).length, 2);
    assert.match(css, /\.canvas-authored-prompt \{ font-family: "Inter", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;/);
    const nodes = readFileSync(new URL("../components/canvas/canvas-node.tsx", import.meta.url), "utf8");
    assert.match(nodes, /const fontSize = node.metadata\?\.fontSize \|\| 14/);
    assert.match(nodes, /font-mono select-text/);
});

test("safe browser fixture uses exact production result and reference components", () => {
    const source = readFileSync(new URL("../pages/image/index.tsx", import.meta.url), "utf8");
    const fixture = readFileSync(new URL("../../tests/visual-polish-cards.tsx", import.meta.url), "utf8");
    const slice = (text: string, name: string) => {
        const start = text.indexOf(name);
        assert.notEqual(start, -1, name);
        const next = text.indexOf("\nfunction ", start + 1);
        return text.slice(start, next < 0 ? text.length : next);
    };
    for (const name of ["function ResultImageCard(", "function ReferenceOrderButtons("]) {
        assert.ok(fixture.includes(slice(source, name)), name);
    }
});

test("control targets do not enlarge nested Ant input-clear buttons", () => {
    const roles = css.slice(css.indexOf("/* UI roles are opt-in:"));
    assert.doesNotMatch(roles, /\.ui-controls button\b/);
    assert.match(roles, /\.ui-controls \.ant-btn, \.ui-controls aside button/);
});

test("compact home route actions avoid reset heading margins and share button geometry", () => {
    const source = readFileSync(new URL("../pages/home/index.tsx", import.meta.url), "utf8");
    const actions = source.slice(source.indexOf("const creationActions = ("), source.indexOf("data-testid=\"home-workbench\""));
    // The Ant reset's h2 bottom margin previously raised the label and grew a 36px link to 43px.
    assert.match(actions, /hasWork \? <span>\{t\(`productionCanvas\.\$\{title\}`\)\}<\/span> :/);
    assert.match(actions, /<h2 className="ui-panel-title">/);
    assert.match(actions, /hasWork \? "ui-action-link border border-border"/);
    assert.match(actions, /hasWork \? "size-4" : "size-4\.5"/);
    assert.doesNotMatch(actions, /sm:min-h-9|sm:py-1\.5/);
    const actionRule = css.match(/\.ui-action-link \{([^}]+)\}/)![1];
    assert.match(actionRule, /height: var\(--ui-control-height\)/);
    assert.match(actionRule, /padding: 0 15px/);
    assert.match(actionRule, /align-items: center/);
    assert.match(actionRule, /line-height: var\(--ui-body-leading\); font-weight: 400/);
    assert.match(css, /\.ui-action-link:focus-visible \{ outline: 2px solid var\(--ring\)/);
});

test("font package keeps variable weights, lazy unicode subsets and its shipped license", () => {
    const font = readFileSync(new URL("../../../node_modules/@fontsource-variable/noto-sans-sc/index.css", import.meta.url), "utf8");
    assert.match(font, /font-weight: 100 900/);
    assert.match(font, /font-display: swap/);
    assert.match(font, /unicode-range:/);
    assert.doesNotMatch(font, /url\(https?:/);
    const license = readFileSync(new URL("../../public/licenses/noto-sans-sc-OFL-1.1.txt", import.meta.url), "utf8");
    assert.match(license, /SIL OPEN FONT LICENSE Version 1.1/);
    const h3 = readFileSync(new URL("../../../plugins/canvas/minimax-h3/src/styles/h3.css", import.meta.url), "utf8");
    assert.match(h3, /font-family:var\(--font-sans, system-ui, sans-serif\)/);
    assert.doesNotMatch(h3, /\[data-canvas-no-zoom\] \{ font-family:/);
    assert.match(h3, /\.minimax-prompt-side \.nfh3-panel-actions button \{[^}]*font-weight:500; letter-spacing:0;/);
    const clipSettings = readFileSync(new URL("../../../plugins/canvas/minimax-h3/src/components/ClipSettings.tsx", import.meta.url), "utf8");
    assert.match(clipSettings, /fontSize: 22, fontWeight: 400, lineHeight: "46px"/);
    assert.match(clipSettings, /color: "var\(--h3-control-text, var\(--h3-text\)\)"/);
    assert.doesNotMatch(clipSettings, /color: "#f3f7fb"/);
});
