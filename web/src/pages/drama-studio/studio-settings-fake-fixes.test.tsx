import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import { StudioSettingsTab, loadStudioSettings, type StudioProductionSettings } from "./studio-settings-tab";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

function render(override: Partial<StudioProductionSettings> = {}) {
    useCanvasStore.setState({ folders: [] } as never);
    const settings: StudioProductionSettings = { ...loadStudioSettings("drama"), ...override };
    return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(StudioSettingsTab, {
        dramaId: "drama",
        settings,
        onChange: () => undefined,
        onSave: () => undefined,
        onReset: () => undefined,
        saving: false,
        onRedoRefs: () => undefined,
    })));
}

test("参考图默认方案：可选真实 AssetSchemeId，方案卡片可写，并真写回资产卡", () => {
    const html = render();
    const group = html.match(/<div[^>]*data-studio-reference-layout[^>]*>/)?.[0] || "";
    assert.ok(group, "必须渲染设定版式选择区（影策资产方案卡片）");
    assert.doesNotMatch(group, /\sdisabled(?:=|\s|>)/, "设定版式不再是只读 disabled");
    assert.match(html, /自定义 \/ 自动/);
    assert.match(html, /data-studio-reference-layout-option="portrait"/, "角色定妆照是真实方案 id");
    assert.match(html, /data-studio-reference-layout-option="turnaround"/, "三视图设定板是真实方案 id");
    assert.match(html, /data-studio-reference-layout-apply/);
    assert.match(html, /应用到本剧全部设定/);
    assert.match(html, /view_layout/, "说明真实写回的字段");
});

test("重做参考图：按钮文案诚实标为手动，不再假装能重做", () => {
    const html = render();
    assert.match(html, /前往画布手动重做角色参考图/);
    assert.match(html, /前往画布手动重做道具参考图/);
    assert.match(html, /前往画布手动重做场景参考图/);
    assert.doesNotMatch(html, />重做(角色|道具|场景)参考图</, "不能出现假装一键重做的按钮文案");
    assert.match(html, /没有「按当前方案一键重做参考图」的后端能力/);
});

test("transitionMs / episodeSeconds 明确标注软约束，影响拆镜提示词", () => {
    const html = render();
    const episodeHint = html.match(/<p[^>]*data-studio-soft-hint="episode-seconds"[^>]*>[\s\S]*?<\/p>/)?.[0] || "";
    const transitionHint = html.match(/<p[^>]*data-studio-soft-hint="transition-ms"[^>]*>[\s\S]*?<\/p>/)?.[0] || "";
    for (const hint of [episodeHint, transitionHint]) {
        assert.ok(hint, "两个软约束提示都要出现");
        assert.match(hint, /软约束，影响拆镜提示词/);
    }
    assert.match(episodeHint, /storyboardRules\.episodeSeconds/);
    assert.match(transitionHint, /storyboardRules\.transitionMs/);
    assert.match(html, /data-studio-episode-seconds/);
    assert.match(html, /data-studio-transition-ms/);
});

test("审阅策略 reviewPolicy：有 UI 且与 reviewMode 两套闸门的关系说明清楚", () => {
    const html = render();
    assert.match(html, /data-studio-review-policy/);
    const radios = html.match(/<input[^>]*name="studio-review-policy-mode"[^>]*>/g) || [];
    assert.equal(radios.length, 4, "none / automatic / mixed / manual 四档");
    assert.match(html, /data-studio-review-policy-relation/);
    assert.match(html, /reviewMode/);
    assert.match(html, /reviewPolicy/);
    assert.match(html, /settings\.reviewPolicy/, "说明写入制作稿真值字段");
});

test("审阅策略 mixed 档展开共享资产/场次两个审核点", () => {
    const html = render({ reviewPolicy: { mode: "mixed", shared: "manual", scene: "automatic" } });
    assert.match(html, /data-studio-review-policy-points/);
    assert.match(html, /共享资产/);
    assert.match(html, /场次/);
});

test("制作阶段 productionStage：只读展示六段游标，明确来自制作稿真值", () => {
    const html = render();
    assert.match(html, /data-studio-production-stage/);
    for (const label of ["剧本", "资产", "空间", "分镜", "关键帧", "成片"]) assert.match(html, new RegExp(label));
    assert.match(html, /draft\.settings\.productionStage/);
    assert.match(html, /不造假开关/);
});

test("loadStudioSettings 缺省与非法 reviewPolicy 都收敛为合法档", () => {
    const store = new Map<string, string>();
    const previous = (globalThis as Record<string, unknown>).localStorage;
    (globalThis as Record<string, unknown>).localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
    };
    try {
        const fallback = loadStudioSettings("no-such-drama");
        assert.deepEqual(fallback.reviewPolicy, { mode: "none", shared: "none", scene: "none" });
        localStorage.setItem("drama-studio:settings:bad", JSON.stringify({ reviewPolicy: { mode: "manual", shared: "automatic", scene: "none" } }));
        const bad = loadStudioSettings("bad");
        assert.deepEqual(bad.reviewPolicy, { mode: "manual", shared: "manual", scene: "manual" });
    } finally {
        (globalThis as Record<string, unknown>).localStorage = previous;
    }
});

test("音色库档案选中后真写 character.voice：cast 面板写回链路存在", () => {
    const source = readFileSync(new URL("./studio-cast-panel.tsx", import.meta.url), "utf8");
    assert.match(source, /voiceprofile:/, "音色库档案进入声音下拉");
    assert.match(source, /patch: \{ voice: voiceRecord, voice_description: voiceDescription \}/, "选中档案写 character.voice 与 voice_description");
    assert.match(source, /voice_description: voiceDescription/, "档案描述写入角色声线");
    assert.match(source, /data-studio-cast-voice-select/);
    const settings = readFileSync(new URL("./studio-settings-tab.tsx", import.meta.url), "utf8");
    assert.match(settings, /选中立即真写进对应角色的 character\.voice/);
});
