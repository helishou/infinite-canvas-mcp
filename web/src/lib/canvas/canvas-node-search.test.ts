import assert from "node:assert/strict";
import test from "node:test";

import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { canvasNodeFocusHref, canvasNodeTypeLabel, searchCanvasNodes } from "./canvas-node-search";

const node = (overrides: Partial<CanvasNodeData> & { id: string }): CanvasNodeData => ({
    type: CanvasNodeType.Text,
    title: "",
    position: { x: 0, y: 0 },
    width: 320,
    height: 180,
    ...overrides,
});

const nodes: CanvasNodeData[] = [
    node({ id: "a", title: "开场白", type: CanvasNodeType.Text, metadata: { content: "夜色下的港口，雨还没停" } as never }),
    node({ id: "b", title: "角色设定", type: CanvasNodeType.Character, metadata: { description: "红衣女侠，腰间挂剑" } as never }),
    node({
        id: "c",
        title: "第三集水府护宝",
        type: "minimax-h3:video",
        metadata: { segments: [{ prompt: "沉陆从伏地人群中出列", summary: "中景，雨夜" }, { prompt: "幕璃扫视沉陆" }] } as never,
    }),
    node({ id: "d", title: "空节点" }),
];

test("标题命中排在正文命中之前", () => {
    const hits = searchCanvasNodes(nodes, "护宝");
    assert.equal(hits[0]?.id, "c");
    assert.equal(hits[0]?.title, "第三集水府护宝");
});

test("多词查询是 AND，不是 OR", () => {
    assert.deepEqual(searchCanvasNodes(nodes, "雨夜 幕璃").map(hit => hit.id), ["c"]);
    assert.deepEqual(searchCanvasNodes(nodes, "雨夜 红衣").map(hit => hit.id), []);
});

test("段落提示词参与检索并给出片段", () => {
    const hits = searchCanvasNodes(nodes, "沉陆");
    assert.equal(hits[0]?.id, "c");
    assert.match(hits[0]?.snippet || "", /沉陆/);
});

test("空查询返回全部节点并遵守上限", () => {
    assert.equal(searchCanvasNodes(nodes, "  ").length, 4);
    assert.equal(searchCanvasNodes(nodes, "", 2).length, 2);
});

test("节点类型标签对插件型节点退化为末段", () => {
    assert.equal(canvasNodeTypeLabel("minimax-h3:video"), "video");
    assert.equal(canvasNodeTypeLabel(CanvasNodeType.Character), "角色");
    assert.equal(canvasNodeTypeLabel("custom-unknown"), "custom-unknown");
});

test("定位地址复用画布深链格式", () => {
    assert.equal(canvasNodeFocusHref("p 1", "n/2"), "/canvas/p%201?nodeId=n%2F2");
});
