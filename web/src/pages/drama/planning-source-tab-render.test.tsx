import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "@/i18n";
import { PlanningSourceTab } from "./planning-source-tab";

const source = readFileSync(new URL("./__fixtures__/three-chapters.txt", import.meta.url), "utf8");

function render(overrides: Partial<Parameters<typeof PlanningSourceTab>[0]> = {}) {
    return renderToStaticMarkup(createElement(PlanningSourceTab, {
        dramaId: "drama-1",
        source,
        onSourceChange: () => undefined,
        split: { excluded: [], perEpisode: 1, maxChars: 3000 },
        episodes: [],
        onSaveSource: async () => true,
        ...overrides,
    }));
}

test("原剧本页签把原文、拆章与编排成集放在同一屏", () => {
    const html = render();
    // 原文输入框与拆章结果同屏出现，不再分两个入口。
    assert.match(html, /novel-adapt-source/);
    assert.equal((html.match(/data-testid="novel-adapt-chapter"/g) || []).length, 3);
    assert.equal((html.match(/data-testid="novel-adapt-group"/g) || []).length, 3);
    // 建集按钮与「建集前会先保存」的说明同屏。
    assert.match(html, /data-new-drama-split|建集|创建/);
});

test("已存在的集在编排表里标为已存在，不重复建", () => {
    const withExisting = render({
        episodes: [{ id: "ep-1", dramaId: "drama-1", episodeNumber: 1, title: "第一章 二害与初遇", synopsis: "", canvasId: "canvas-1" } as never],
    });
    // 第一章标题与已建集一致 → 该组标「已存在」，且总组数仍是 3（未新增集号）。
    assert.equal((withExisting.match(/data-testid="novel-adapt-group"/g) || []).length, 3);
    assert.match(withExisting, /已存在/);
});

test("未勾选的章按预留处理，不参与本次建集", () => {
    const html = render({ split: { excluded: [3], perEpisode: 1, maxChars: 3000 } });
    // 预留章仍在列表里（可随时加回来），本次只编排前两章。
    assert.equal((html.match(/data-testid="novel-adapt-chapter"/g) || []).length, 3);
    assert.equal((html.match(/data-testid="novel-adapt-group"/g) || []).length, 2);
});
