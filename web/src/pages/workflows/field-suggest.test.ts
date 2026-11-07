import assert from "node:assert";
import { describe, it } from "node:test";
import { suggestMediaFields, mergeSuggestedFields } from "./field-suggest";

// UI 格式（nodes 数组）：含 LoadImage / LoadAudio / VHS_LoadVideo 与若干非媒体节点。
const uiWorkflow = {
    nodes: [
        { id: 1, type: "LoadImage", inputs: [{ name: "image", link: null }], widgets_values: ["a.png"] },
        { id: 2, type: "LoadImage", inputs: [{ name: "image", link: null }], widgets_values: ["b.png"] },
        { id: 3, type: "LoadAudio", inputs: [{ name: "audio", link: null }], widgets_values: ["a.wav"] },
        { id: 4, type: "VHS_LoadVideo", inputs: [{ name: "video", link: null }], widgets_values: ["a.mp4"] },
        { id: 5, type: "CLIPTextEncode", inputs: [{ name: "text", link: null }], widgets_values: ["prompt"] },
        { id: 6, type: "KSampler", inputs: [] },
    ],
    links: [],
};

// API 格式（节点字典）。
const apiWorkflow = {
    "10": { class_type: "LoadImage", inputs: { image: "x.png" } },
    "11": { class_type: "LoadAudio", inputs: { audio: "x.wav" } },
    "12": { class_type: "Note", inputs: {} },
};

describe("suggestMediaFields", () => {
    it("从 UI 格式扫描出 2 图 + 1 音频 + 1 视频，跳过文本/采样节点", () => {
        const fields = suggestMediaFields(uiWorkflow);
        assert.deepEqual(
            fields.map((f) => `${f.type}:${f.node}:${f.input}`).sort(),
            ["audio:3:audio", "image:1:image", "image:2:image", "video:4:video"].sort(),
        );
        assert.equal(fields.find((f) => f.type === "image")?.name, "参考图 1");
        assert.equal(fields.find((f) => f.type === "video")?.name, "参考视频 1");
        assert.equal(fields.find((f) => f.type === "audio")?.name, "参考音频 1");
    });

    it("从 API 格式也能识别", () => {
        const fields = suggestMediaFields(apiWorkflow);
        assert.deepEqual(fields.map((f) => f.type).sort(), ["audio", "image"]);
        assert.deepEqual(fields.map((f) => f.node).sort(), ["10", "11"]);
    });

    it("非媒体工作流返回空数组", () => {
        assert.equal(suggestMediaFields({ nodes: [{ id: 1, type: "KSampler", inputs: [] }], links: [] }).length, 0);
    });
});

describe("mergeSuggestedFields", () => {
    it("按 node::input 去重，只追加新字段", () => {
        const existing = [{ id: "x", node: "1", input: "image", type: "image" as const, name: "已有" }];
        const suggested = [
            { id: "x", node: "1", input: "image", type: "image" as const, name: "已有" },
            { id: "y", node: "2", input: "image", type: "image" as const, name: "新增" },
        ];
        const { fields, added } = mergeSuggestedFields(existing, suggested);
        assert.equal(added, 1);
        assert.equal(fields.length, 2);
    });
});
