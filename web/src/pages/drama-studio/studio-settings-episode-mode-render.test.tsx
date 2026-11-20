import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import { StudioSettingsTab, loadStudioSettings } from "./studio-settings-tab";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

function render(mode?: "auto" | "chapter", planDone = false) {
    const folder = {
        id: "drama", name: "测试剧", isDrama: true, createdAt: "2026-01-01", updatedAt: "2026-01-01",
        productionPlan: {
            sourceScript: "第一章\n甲在雨夜回到旧城。\n\n第二章\n乙守住码头。",
            sourceSplit: { excluded: [], perEpisode: 1, maxChars: 3000 },
            ...(mode ? { episodeMode: mode } : {}),
        },
    };
    useCanvasStore.setState({ folders: [folder] } as never);
    return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(StudioSettingsTab, {
        dramaId: "drama",
        settings: loadStudioSettings("drama"),
        onChange: () => undefined,
        onSave: () => undefined,
        onReset: () => undefined,
        saving: false,
        studioInfo: { dramaName: "测试剧", episodeCount: 0, chapterCount: 2, perEpisode: 1, excludedCount: 0, episodeMode: mode ?? "chapter", planDone, lastChapterIndex: planDone ? 2 : 0, planCursor: planDone ? 3 : 0 },
    })));
}

test("设置页分集方式：按章模式无预览按钮，模型自动分集模式有真实预览入口", () => {
    const chapter = render("chapter");
    assert.match(chapter, /按章分集/);
    assert.doesNotMatch(chapter, /预览模型分集/);

    const auto = render("auto");
    assert.match(auto, /模型自动分集/);
    assert.match(auto, /预览模型分集/);
    assert.match(auto, /分批规划/);
    assert.match(auto, /分集方式/);
});

test("plan_done 后分集方式与预览入口禁用并给出完成锁定提示", () => {
    const locked = render("auto", true);
    assert.match(locked, /data-episode-plan-locked/);
    assert.match(locked, /分集已完成/);
    assert.match(locked, /均已锁定/);
    // 两个 radio 与预览按钮都 disabled（SSR 静态标记里属性顺序不固定）。
    const radios = locked.match(/<input[^>]*name="studio-episode-mode"[^>]*>/g) || [];
    assert.equal(radios.length, 2);
    assert.ok(radios.every((radio) => /disabled/.test(radio)), JSON.stringify(radios));
    const previewButton = locked.match(/<button[^>]*>预览模型分集<\/button>/)?.[0] || "";
    assert.match(previewButton, /disabled/);
});

test("老剧目没有 episodeMode 时按按章分集展示，不误标成模型自动分集", () => {
    const legacy = render(undefined);
    assert.match(legacy, /按章分集/);
    assert.doesNotMatch(legacy, /预览模型分集/);
});
