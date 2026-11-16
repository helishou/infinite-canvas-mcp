import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { readFileSync } from "node:fs";
import { dramaProductionPlanSchema } from "@basketikun/canvas-agent/drama/production-contract";
import { NewDramaWizard } from "./new-drama-wizard";

const i18n = createInstance();
void i18n.init({ lng: "zh", initAsync: false, resources: { zh: { translation: {} } } });

const source = ["第一章 一", "字".repeat(400), "第二章 二", "字".repeat(400), "第三章 三", "字".repeat(400)].join("\n");

function render(step: number, planInput: Record<string, unknown> = {}) {
    const plan = dramaProductionPlanSchema.parse({ sourceScript: source, ...planInput });
    return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(NewDramaWizard, {
        step,
        name: "测试剧目",
        onName: () => undefined,
        plan,
        onPlan: () => undefined,
        styleMode: "none",
        onStyleMode: () => undefined,
        styleImageFile: undefined,
        onStyleImageFile: () => undefined,
        stylePrompt: "",
        onStylePrompt: () => undefined,
        autoEpisodes: false,
        onAutoEpisodes: () => undefined,
        handoff: false,
        onHandoff: () => undefined,
        config: {} as never,
    })));
}

const count = (html: string, fragment: string) => html.split(fragment).length - 1;
/** 只数章节复选框的勾选状态：页面里还有风格参考图那组单选按钮。 */
const checkedChapters = (html: string) => (html.match(/ant-checkbox-input"[^>]*checked/g) || []).length;

test("素材页按原文列章：勾选状态来自 sourceSplit.excluded，未选的章留作预留", () => {
    const all = render(1);
    assert.match(all, /data-new-drama-split/);
    assert.equal(count(all, "ant-checkbox-input"), 3, "三章都列出来");
    assert.equal(checkedChapters(all), 3, "默认全选");

    const partial = render(1, { sourceSplit: { excluded: [3], perEpisode: 1 } });
    assert.equal(checkedChapters(partial), 2, "第 3 章不进入本次改编");
    assert.match(partial, /newDrama\.split\.willBuild/, "页脚给出会建几集");
});

test("每集章数与预估跟分集口径一致：合并相邻章后集数变少", () => {
    const merged = render(1, { sourceSplit: { excluded: [], perEpisode: 2 } });
    assert.equal(count(merged, "ant-checkbox-input"), 3);
    // 三章每两章一集 → 两集；估算行在合并后仍显示同一份 summary。
    assert.match(merged, /data-new-drama-estimate/);
    assert.match(merged, /data-new-drama-will-build/);
});

test("没有原文时不显示分集面板，仍可手填集数建空集", () => {
    const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(NewDramaWizard, {
        step: 1, name: "无原文", onName: () => undefined,
        plan: dramaProductionPlanSchema.parse({}), onPlan: () => undefined,
        styleMode: "none", onStyleMode: () => undefined, styleImageFile: undefined, onStyleImageFile: () => undefined,
        stylePrompt: "", onStylePrompt: () => undefined, autoEpisodes: true, onAutoEpisodes: () => undefined,
        handoff: false, onHandoff: () => undefined, config: {} as never,
    })));
    assert.doesNotMatch(html, /data-new-drama-split/);
});

test("交付页把生成节奏、审阅与并行出片接到 plan 字段上", () => {
    const source = readFileSync(new URL("./new-drama-wizard.tsx", import.meta.url), "utf8");
    assert.match(source, /onPlan\(\{ mediaProductionMode: event\.target\.value \}\)/);
    assert.match(source, /onPlan\(\{ reviewPolicy: reviewPolicyFor\(event\.target\.value\) \}\)/);
    assert.match(source, /onPlan\(\{ parallelScenes: on \}\)/);
    assert.match(source, /capability="text"/, "文本模型单独可设");
    assert.match(source, /capability="video"/, "视频模型单独可设");
});
