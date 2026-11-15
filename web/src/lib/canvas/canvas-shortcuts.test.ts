import { test } from "node:test";
import assert from "node:assert/strict";

import { CANVAS_SHORTCUTS, resolveShortcutKeys, searchCanvasShortcuts, SHORTCUT_CATEGORY_ORDER } from "./canvas-shortcuts.js";

const translate = (key: string) => ({ "canvas.shortcut.drag": "拖拽", "canvas.shortcut.click": "点击", "canvas.shortcut.wheel": "滚轮", "canvas.shortcut.zoomSlider": "缩放滑块", "canvas.shortcut.dropMedia": "拖入媒体" })[key] || key;

test("快捷键表覆盖原有全部键位且 id 唯一", () => {
    assert.equal(CANVAS_SHORTCUTS.length, 15);
    assert.equal(new Set(CANVAS_SHORTCUTS.map(item => item.id)).size, CANVAS_SHORTCUTS.length);
    assert.ok(CANVAS_SHORTCUTS.every(item => SHORTCUT_CATEGORY_ORDER.includes(item.category)));
});

test("空查询按固定分类顺序返回全部分组", () => {
    const groups = searchCanvasShortcuts("", translate);
    assert.deepEqual(groups.map(item => item.category), SHORTCUT_CATEGORY_ORDER);
    assert.equal(groups.reduce((total, item) => total + item.entries.length, 0), CANVAS_SHORTCUTS.length);
    assert.equal(groups[0].label, "导航");
});

test("搜索命中键位、中文说明与英文关键词", () => {
    assert.deepEqual(searchCanvasShortcuts("Cmd + Z", translate).flatMap(group => group.entries.map(item => item.id)), ["undo"]);
    assert.ok(searchCanvasShortcuts("重做", translate).flatMap(group => group.entries.map(item => item.id)).includes("redo"));
    assert.ok(searchCanvasShortcuts("撤销", translate).flatMap(group => group.entries.map(item => item.id)).includes("undo"));
    assert.ok(searchCanvasShortcuts("MARQUEE", translate).flatMap(group => group.entries.map(item => item.id)).includes("box-select"));
    assert.ok(searchCanvasShortcuts("拖入媒体", translate).flatMap(group => group.entries.map(item => item.id)).includes("upload"));
});

test("无结果与 token 本地化替换", () => {
    assert.equal(searchCanvasShortcuts("不存在的快捷键", translate).length, 0);
    assert.equal(resolveShortcutKeys("Ctrl / Space + {drag}", translate), "Ctrl / Space + 拖拽");
    assert.equal(resolveShortcutKeys("{unknown}", translate), "{unknown}");
    assert.equal(resolveShortcutKeys("Esc", translate), "Esc");
});
