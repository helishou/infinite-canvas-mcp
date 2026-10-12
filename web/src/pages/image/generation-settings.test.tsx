import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { VideoSettingsPanel } from "@/components/video-settings-panel";
import { AudioSettingsPanel } from "@/components/audio-settings-panel";
import { TextSettingsPanel } from "@/components/text-settings-panel";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { audioFormatOptions, audioVoiceOptions } from "@/lib/audio-generation";
import i18n from "@/i18n";
import { generationGroupsZhCN, generationGroupsEnUS } from "@/i18n/generation-groups";
import type { WorkflowField } from "@/types/workflow";

const theme = canvasThemes.light;
const noChange = () => {
    throw new Error("Rendering settings must not write configuration");
};
const fields: WorkflowField[] = [{ id: "seed", name: "Test workflow seed", type: "number", node: "1", input: "seed", default: 42 }];

// Register only the test labels, so this test also works while locale integration is in flight.
for (const [locale, labels] of [
    ["zh-CN", generationGroupsZhCN],
    ["en-US", generationGroupsEnUS],
] as const) {
    i18n.addResourceBundle(locale, "translation", { settingsPanels: { groups: labels.settingsPanels }, workbench: { groups: labels.workbench } }, true, true);
}

function buttons(html: string) {
    return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((match) => ({ attributes: match[1], text: match[2].replace(/<[^>]+>/g, "") }));
}

function image(config: Partial<AiConfig> = {}, props: Partial<Parameters<typeof ImageSettingsPanel>[0]> = {}) {
    return renderToStaticMarkup(<ImageSettingsPanel config={{ ...defaultConfig, ...config }} theme={theme} onConfigChange={noChange} {...props} />);
}

function video(config: Partial<AiConfig> = {}, props: Partial<Parameters<typeof VideoSettingsPanel>[0]> = {}) {
    return renderToStaticMarkup(<VideoSettingsPanel config={{ ...defaultConfig, ...config }} theme={theme} onConfigChange={noChange} {...props} />);
}

test("image common controls keep all qualities and batch counts before advanced settings", () => {
    const html = image({ quality: "xhigh", count: "15" });
    const common = html.split("<details")[0];
    for (const key of ["auto", "low", "medium", "high", "xhigh", "max"]) {
        assert.ok(
            buttons(common).some((button) => button.text === i18n.t(`settingsPanels.common.${key}`)),
            key,
        );
    }
    for (let count = 1; count <= 10; count++) assert.ok(common.includes(i18n.t("settingsPanels.image.images", { count })));
    assert.match(common, /max="15"/);
    assert.match(common, /value="15"/);
    assert.ok(buttons(common).some((button) => button.text === i18n.t("settingsPanels.common.xhigh") && button.attributes.includes('aria-pressed="true"')));
});

test("image advanced section retains high-resolution presets, exact dimensions and transparency", () => {
    const html = image({ size: "3840x2160", background: "transparent" });
    const [common, advanced] = html.split("<details");
    for (const label of ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "auto"]) assert.ok(buttons(common).some((button) => button.text === label));
    for (const label of ["1:1(2k)", "16:9(2k)", "9:16(2k)", "16:9(4k)", "9:16(4k)"]) assert.ok(buttons(advanced).some((button) => button.text === label));
    assert.match(advanced, /<summary/);
    assert.match(advanced, /value="3840"/);
    assert.match(advanced, /value="2160"/);
    assert.ok(buttons(advanced).some((button) => button.text === "16:9(4k)" && button.attributes.includes('aria-pressed="true"')));
    assert.ok(advanced.includes(i18n.t("settingsPanels.groups.globalPreference")));
    assert.match(advanced, /aria-label="透明背景"/);
    assert.match(advanced, /aria-checked="true"/);
});

test("image workflow mode keeps local fields, count and transparency while hiding standard controls", () => {
    const html = image({}, { hideStandardImageOptions: true, customFields: fields, customFieldValues: { seed: 91 }, onCustomFieldChange: noChange });
    assert.ok(html.includes("Test workflow seed"));
    assert.match(html, /value="91"/);
    assert.ok(html.includes(i18n.t("settingsPanels.image.count")));
    assert.ok(html.includes(i18n.t("settingsPanels.image.transparent")));
    assert.ok(!html.includes(i18n.t("settingsPanels.image.aspectRatio")));
    assert.ok(!html.includes("16:9(4k)"));
});

test("image unsupported and missing workflow diagnoses remain distinct and retain scenario details", () => {
    for (const blocked of [false, true]) {
        const html = image({}, { workflowParamsMissing: true, workflowParamsBlockedByScenario: blocked, debugScenario: "Scenario: three references" });
        assert.ok(html.includes(i18n.t(blocked ? "settingsPanels.image.workflowFieldsScenarioUnsupported" : "settingsPanels.image.workflowFieldsMissing")));
        assert.ok(html.includes("Scenario: three references"));
    }
});

test("video retains every generic size, duration and custom numeric control", () => {
    const html = video({ size: "auto", videoSeconds: "20", vquality: "1080" });
    for (const value of ["1280x720", "720x1280", "1024x1024", "1792x1024", "1024x1792"]) assert.ok(html.includes(value));
    for (const value of [6, 10, 12, 16, 20]) assert.ok(buttons(html).some((button) => button.text === `${value}s`));
    assert.match(html, /value="1080"/);
    assert.match(html, /max="20"/);
    const advanced = html.split("<details")[1];
    assert.equal((advanced.match(/disabled=""/g) || []).length, 2);
});

test("video workflow fields replace standard controls only when fields exist", () => {
    const workflow = video({}, { customFields: fields, customFieldValues: { seed: 17 }, onCustomFieldChange: noChange });
    assert.match(workflow, /Test workflow seed/);
    assert.match(workflow, /value="17"/);
    assert.ok(!workflow.includes("1280x720"));
    const missing = video({}, { customFields: [], implementationMissing: "Scenario unsupported" });
    assert.ok(missing.includes("Scenario unsupported"));
    assert.ok(missing.includes("1280x720"));
});

test("H3 keeps its specific duration presets, range and resolved-parameter feedback", () => {
    const config: AiConfig = {
        ...defaultConfig,
        model: "local::H3",
        videoModel: "local::H3",
        size: "720x1280",
        videoSeconds: "15",
        channels: [{ id: "local", name: "Local", kind: "comfyui", apiFormat: "openai", apiKey: "", baseUrl: "", models: [{ name: "H3", capability: "video", workflows: ["h3-local-t2va.json"] }] }],
    };
    const html = video(config);
    for (const value of [6, 10, 12, 15]) assert.ok(buttons(html).some((button) => button.text === `${value}s`));
    assert.ok(!buttons(html).some((button) => button.text === "20s"));
    assert.match(html, /max="15"/);
    assert.ok(html.includes("736x1280"));
});

test("audio preserves every voice and file format, editable speed and instructions", () => {
    const html = renderToStaticMarkup(<AudioSettingsPanel config={{ ...defaultConfig, audioSpeed: "1.25", audioInstructions: "Read softly" }} theme={theme} onConfigChange={noChange} />);
    for (const option of [...audioVoiceOptions, ...audioFormatOptions]) assert.ok(buttons(html).some((button) => button.text === option.label));
    assert.match(html, /min="0.25"/);
    assert.match(html, /max="4"/);
    assert.match(html, /step="0.05"/);
    assert.match(html, /Read softly/);
    assert.ok(html.indexOf(i18n.t("settingsPanels.audio.speed")) < html.indexOf(i18n.t("settingsPanels.groups.audioOutput")));
});

test("audio workflow-only mode retains fields without exposing hidden generic parameters", () => {
    const html = renderToStaticMarkup(<AudioSettingsPanel config={defaultConfig} theme={theme} onConfigChange={noChange} hideStandardAudioOptions customFields={fields} customFieldValues={{ seed: 23 }} onCustomFieldChange={noChange} />);
    assert.match(html, /value="23"/);
    assert.ok(!html.includes(i18n.t("settingsPanels.audio.voice")));
});

test("text reasoning choices expose their selected state without discarding any intensity", () => {
    const html = renderToStaticMarkup(<TextSettingsPanel config={{ ...defaultConfig, reasoningEffort: "high" }} theme={theme} onConfigChange={noChange} />);
    assert.equal(buttons(html).length, 5);
    assert.equal(buttons(html).filter((button) => button.attributes.includes('aria-pressed="true"')).length, 1);
    assert.ok(buttons(html).some((button) => button.text === i18n.t("settingsPanels.common.high") && button.attributes.includes('aria-pressed="true"')));
    assert.match(html, /<fieldset/);
    assert.match(html, /<legend/);
});

test("light and dark settings use the same control topology", () => {
    const topology = (html: string) => html.replace(/<([a-z][^\s/>]*)\b[^>]*>/gi, "<$1>");
    const render = (theme: typeof canvasThemes.light | typeof canvasThemes.dark) =>
        renderToStaticMarkup(
            <>
                <ImageSettingsPanel config={defaultConfig} theme={theme} onConfigChange={noChange} />
                <VideoSettingsPanel config={defaultConfig} theme={theme} onConfigChange={noChange} />
                <AudioSettingsPanel config={defaultConfig} theme={theme} onConfigChange={noChange} />
                <TextSettingsPanel config={defaultConfig} theme={theme} onConfigChange={noChange} />
            </>,
        );
    assert.equal(topology(render(canvasThemes.light)), topology(render(canvasThemes.dark)));
});

test("standalone history selection is never nested inside a restore button", () => {
    for (const page of ["../image/index.tsx", "../video/index.tsx"]) {
        const source = readFileSync(new URL(page, import.meta.url), "utf8");
        const tree = ts.createSourceFile(page, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const logCard = tree.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "LogCard");
        assert.ok(logCard);
        let checkboxCount = 0;
        const visit = (node: ts.Node, insideButton = false) => {
            if (ts.isJsxElement(node)) insideButton ||= node.openingElement.tagName.getText(tree) === "button";
            if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(tree) === "Checkbox") {
                checkboxCount++;
                assert.equal(insideButton, false, `${page} history checkbox must have its own keyboard target`);
            }
            ts.forEachChild(node, (child) => visit(child, insideButton));
        };
        visit(logCard);
        assert.equal(checkboxCount, 1);
        assert.match(logCard.getText(tree), /aria-current=/);
    }
});

test("new grouping labels have parity across English and Chinese", () => {
    for (const group of ["settingsPanels", "workbench"] as const) assert.deepEqual(Object.keys(generationGroupsEnUS[group]), Object.keys(generationGroupsZhCN[group]));
});

test("English grouping and scope labels render without untranslated keys", async () => {
    await i18n.changeLanguage("en-US");
    try {
        const html = image({ size: "2048x1152" });
        assert.ok(html.includes("Common parameters"));
        assert.ok(html.includes("Advanced · Size and background"));
        assert.ok(html.includes("Global preference"));
        assert.ok(!html.includes("settingsPanels.groups."));
        assert.ok(i18n.t("workbench.groups.defaultsHint").includes("global defaults"));
        assert.ok(i18n.t("workbench.groups.workflowHint").includes("current generation"));
    } finally {
        await i18n.changeLanguage("zh-CN");
    }
});
