import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendRunningHubApiTail, appendRunningHubOutputTail, TAIL_PLAY_SOUND, TAIL_SAVE_LOCAL } from "./runninghub-workflow-tail.js";

/** 造一个最小 UI 格式工作流：VAEDecode（IMAGE）→ SaveImage。 */
function uiWorkflow() {
    return {
        last_node_id: 2,
        last_link_id: 1,
        nodes: [
            { id: 1, type: "VAEDecode", pos: [0, 0], size: [200, 100], order: 0, mode: 0, inputs: [], outputs: [{ name: "IMAGE", type: "IMAGE", links: [1] }] },
            { id: 2, type: "SaveImage", pos: [300, 0], size: [300, 200], order: 1, mode: 0, inputs: [{ name: "images", type: "IMAGE", link: 1 }], outputs: [{ name: "images", type: "IMAGE", links: [] }] },
        ],
        links: [[1, 1, 0, 2, 0, "IMAGE"]],
    };
}

/** VAEDecode → CreateVideo → SaveVideo（视频输出，帧来源在两层上游）。 */
function videoWorkflow() {
    return {
        last_node_id: 3,
        last_link_id: 2,
        nodes: [
            { id: 1, type: "VAEDecode", pos: [0, 0], size: [200, 100], order: 0, mode: 0, inputs: [], outputs: [{ name: "IMAGE", type: "IMAGE", links: [1] }] },
            { id: 2, type: "CreateVideo", pos: [300, 0], size: [240, 120], order: 1, mode: 0, inputs: [{ name: "images", type: "IMAGE", link: 1 }, { name: "audio", type: "AUDIO", link: null }], outputs: [{ name: "VIDEO", type: "VIDEO", links: [2] }] },
            { id: 3, type: "SaveVideo", pos: [600, 0], size: [300, 200], order: 2, mode: 0, inputs: [{ name: "video", type: "VIDEO", link: 2 }], outputs: [{ name: "video", type: "VIDEO", links: null }] },
        ],
        links: [[1, 1, 0, 2, 0, "IMAGE"], [2, 2, 0, 3, 0, "VIDEO"]],
    };
}

function nodeOf(workflow: { nodes: Array<Record<string, any>> }, type: string) {
    return workflow.nodes.find((node) => node.type === type);
}

function linkRow(workflow: { links: any[] }, id: number) {
    return workflow.links.find((row) => Array.isArray(row) && row[0] === id);
}

describe("runninghub-workflow-tail 图像输出", () => {
    it("在输出节点后面接上 Play Sound KJ → Save Image To Local", () => {
        const result = appendRunningHubOutputTail(uiWorkflow());
        assert.equal(result.added, true);
        assert.equal(result.kind, "image");
        const wf = result.workflow as any;
        assert.equal(wf.nodes.length, 4);

        const save = nodeOf(wf, "SaveImage")!;
        const play = nodeOf(wf, TAIL_PLAY_SOUND)!;
        const local = nodeOf(wf, TAIL_SAVE_LOCAL)!;

        assert.equal(save.outputs[0].links.length, 1);
        const linkIn = save.outputs[0].links[0];
        assert.equal(play.inputs[0].name, "any_input");
        assert.equal(play.inputs[0].link, linkIn);

        const linkOut = play.outputs[0].links[0];
        assert.equal(local.inputs[0].name, "images");
        assert.equal(local.inputs[0].link, linkOut);

        assert.deepEqual(linkRow(wf, linkIn), [linkIn, 2, 0, play.id, 0, "IMAGE"]);
        assert.deepEqual(linkRow(wf, linkOut), [linkOut, play.id, 0, local.id, 0, "*"]);
        assert.equal(wf.last_node_id, local.id);
        assert.equal(wf.last_link_id, linkOut);
    });

    it("widget 默认值与截图一致（always / 0.20 / 5.0），落盘目录给 output 而不是空串", () => {
        const wf = appendRunningHubOutputTail(uiWorkflow()).workflow as any;
        assert.deepEqual(nodeOf(wf, TAIL_PLAY_SOUND)!.widgets_values, ["", "always", 0.2, 5]);
        // 空串会让 mixlab 的 os.makedirs("") 抛 FileNotFoundError，所以默认给 output
        assert.deepEqual(nodeOf(wf, TAIL_SAVE_LOCAL)!.widgets_values, ["output"]);
    });

    it("已经接过就不再重复插（幂等）", () => {
        const once = appendRunningHubOutputTail(uiWorkflow());
        const twice = appendRunningHubOutputTail(once.workflow as any);
        assert.equal(twice.added, false);
        assert.equal(twice.reason, "already");
        assert.equal((twice.workflow as any).nodes.length, 4);
        assert.equal((twice.workflow as any).links.length, 3);
    });

    it("API 格式原样返回", () => {
        const api = { "1": { class_type: "SaveImage", inputs: { images: ["2", 0] } }, "2": { class_type: "VAEDecode", inputs: {} } };
        const result = appendRunningHubOutputTail(api as any);
        assert.equal(result.added, false);
        assert.equal(result.reason, "not-ui");
        assert.equal(result.workflow, api);
    });

    it("没有输出节点时不硬塞", () => {
        const noSink = { last_node_id: 1, last_link_id: 0, nodes: [{ id: 1, type: "VAEDecode", outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }] }], links: [] };
        const result = appendRunningHubOutputTail(noSink as any);
        assert.equal(result.added, false);
        assert.equal(result.reason, "no-sink");
        assert.equal((result.workflow as any).nodes.length, 1);
    });

    it("多个图像输出节点时取执行顺序最后的一个", () => {
        const wf = uiWorkflow() as any;
        wf.nodes.push({ id: 3, type: "PreviewImage", pos: [700, 0], size: [300, 200], order: 9, mode: 0, inputs: [{ name: "images", type: "IMAGE", link: null }], outputs: [{ name: "images", type: "IMAGE", links: [] }] });
        wf.last_node_id = 3;
        const result = appendRunningHubOutputTail(wf);
        const preview = (result.workflow as any).nodes.find((node: any) => node.type === "PreviewImage");
        assert.equal(preview.outputs[0].links.length, 1, "应该接在 PreviewImage 后面");
        const save = (result.workflow as any).nodes.find((node: any) => node.type === "SaveImage");
        assert.equal(save.outputs[0].links.length, 0, "SaveImage 不该被动到");
    });
});

describe("runninghub-workflow-tail 视频输出", () => {
    it("SaveVideo：Play Sound 接 VIDEO 输出，Save Image To Local 接 Play Sound 后面", () => {
        const result = appendRunningHubOutputTail(videoWorkflow());
        assert.equal(result.added, true);
        assert.equal(result.kind, "video");

        const wf = result.workflow as any;
        const play = nodeOf(wf, TAIL_PLAY_SOUND)!;
        const local = nodeOf(wf, TAIL_SAVE_LOCAL)!;
        const saveVideo = nodeOf(wf, "SaveVideo")!;
        const decode = nodeOf(wf, "VAEDecode")!;

        // 第一段：视频输出 → Play Sound（VIDEO 类型）
        const linkIn = play.inputs[0].link;
        assert.deepEqual(linkRow(wf, linkIn), [linkIn, 3, 0, play.id, 0, "VIDEO"]);
        assert.equal(saveVideo.outputs[0].links.length, 1);

        // 第二段：Play Sound.any_output（*）→ Save Image To Local.images
        const linkSave = local.inputs[0].link;
        assert.deepEqual(linkRow(wf, linkSave), [linkSave, play.id, 0, local.id, 0, "*"]);
        assert.deepEqual(play.outputs[0].links, [linkSave]);
        assert.equal(wf.last_link_id, linkSave);
        assert.equal(decode.outputs[0].links.length, 1, "上游帧来源不该被改动");
    });

    it("VHS_VideoCombine：Filenames 接 Play Sound，再串到 Save Image To Local", () => {
        const wf = {
            last_node_id: 2,
            last_link_id: 1,
            nodes: [
                { id: 1, type: "VAEDecode", pos: [0, 0], size: [200, 100], order: 0, mode: 0, inputs: [], outputs: [{ name: "IMAGE", type: "IMAGE", links: [1] }] },
                { id: 2, type: "VHS_VideoCombine", pos: [300, 0], size: [300, 240], order: 1, mode: 0, inputs: [{ name: "images", type: "IMAGE", link: 1 }, { name: "audio", type: "AUDIO", link: null }], outputs: [{ name: "Filenames", type: "VHS_FILENAMES", links: [] }] },
            ],
            links: [[1, 1, 0, 2, 0, "IMAGE"]],
        };
        const result = appendRunningHubOutputTail(wf as any);
        assert.equal(result.kind, "video");
        const out = result.workflow as any;
        const play = nodeOf(out, TAIL_PLAY_SOUND)!;
        const local = nodeOf(out, TAIL_SAVE_LOCAL)!;
        assert.deepEqual(linkRow(out, play.inputs[0].link), [play.inputs[0].link, 2, 0, play.id, 0, "VHS_FILENAMES"]);
        assert.deepEqual(linkRow(out, local.inputs[0].link), [local.inputs[0].link, play.id, 0, local.id, 0, "*"]);
        assert.equal(nodeOf(out, "VAEDecode")!.outputs[0].links.length, 1, "VAEDecode 的输出保持只有 VHS 一条");
    });

    it("视频链的两个节点排成一行：Save Image To Local 在 Play Sound 右侧", () => {
        const wf = appendRunningHubOutputTail(videoWorkflow()).workflow as any;
        const play = nodeOf(wf, TAIL_PLAY_SOUND)!;
        const local = nodeOf(wf, TAIL_SAVE_LOCAL)!;
        assert.equal(local.pos[1], play.pos[1], "同一行");
        assert.ok(local.pos[0] > play.pos[0], "Save Image To Local 应该在 Play Sound 后面");
        assert.equal(play.pos[0], 600 + 300 + 80, "Play Sound 紧接视频输出节点右侧");
    });

    it("图像和视频输出同时存在时优先接视频输出", () => {
        const wf = videoWorkflow() as any;
        wf.nodes.push({ id: 4, type: "SaveImage", pos: [600, 400], size: [300, 200], order: 5, mode: 0, inputs: [{ name: "images", type: "IMAGE", link: null }], outputs: [{ name: "images", type: "IMAGE", links: [] }] });
        wf.last_node_id = 4;
        const result = appendRunningHubOutputTail(wf);
        assert.equal(result.kind, "video");
        const out = result.workflow as any;
        assert.equal(nodeOf(out, "SaveImage")!.outputs[0].links.length, 0, "SaveImage 不该被动到");
        assert.equal(nodeOf(out, "SaveVideo")!.outputs[0].links.length, 1);
    });
});

/** 真实案例（fantui2.1）：磁盘上只有 API 格式，图里没有 links 也没有输出槽。 */
function apiWorkflow() {
    return {
        "738": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
        "748": { class_type: "VAEDecode", inputs: { samples: ["772", 0], vae: ["738", 0] } },
        "772": { class_type: "KSampler", inputs: { seed: 666, model: ["773", 0] } },
        "773": { class_type: "UNETLoader", inputs: { unet_name: "qwen.safetensors" } },
        "797": { class_type: "SaveImage", inputs: { filename_prefix: "ComfyUI", images: ["748", 0] } },
    } as Record<string, any>;
}

describe("runninghub-workflow-tail API 格式", () => {
    it("接在输出节点自己的输出槽上，和 UI 版一样排在它后面", () => {
        const result = appendRunningHubApiTail(apiWorkflow());
        assert.equal(result.added, true);
        assert.equal(result.kind, "image");
        const graph = result.graph as any;
        const [playId, saveId] = result.nodeIds!;

        assert.equal(Object.keys(graph).length, 7, "原 5 个节点 + 2 个收尾节点");
        assert.equal(graph[playId].class_type, TAIL_PLAY_SOUND);
        assert.deepEqual(graph[playId].inputs.any_input, ["797", 0], "接输出节点自己的第一个输出槽，不是它的数据来源");
        assert.equal(graph[playId].inputs.audio_path, "");
        assert.equal(graph[playId].inputs.mode, "always");
        assert.equal(graph[saveId].class_type, TAIL_SAVE_LOCAL);
        assert.deepEqual(graph[saveId].inputs.images, [playId, 0]);
        assert.equal(graph[saveId].inputs.file_path, "output", "空串会让 mixlab 的 makedirs 抛错");
        assert.deepEqual(graph["797"].inputs.images, ["748", 0], "原输出节点不动");
    });

    it("API 图已有收尾节点时就跳过，不重复插", () => {
        const graph = apiWorkflow();
        graph["900"] = { class_type: TAIL_PLAY_SOUND, inputs: {} };
        const result = appendRunningHubApiTail(graph);
        assert.equal(result.added, false);
        assert.equal(result.reason, "already");
    });

    it("API 图没有输出节点时如实报 no-sink", () => {
        const graph = { "1": { class_type: "KSampler", inputs: { seed: 1 } } } as Record<string, any>;
        const result = appendRunningHubApiTail(graph);
        assert.equal(result.added, false);
        assert.equal(result.reason, "no-sink");
    });

    it("新节点编号避开已占用的数字 id", () => {
        const graph = apiWorkflow();
        // 797 是最大 id，但 798 已被占用 → play 该用 799
        graph["798"] = { class_type: "PreviewAny", inputs: { source: ["748", 0] } };
        const result = appendRunningHubApiTail(graph);
        const [playId, saveId] = result.nodeIds!;
        assert.equal(playId, "799");
        assert.equal(saveId, "800");
    });
});

describe("runninghub-workflow-tail API 多输出节点", () => {
    /** 真实案例（终极资产图）：3 个输出节点，只有一个在链路末端。 */
    function multiSink() {
        return {
            "718": { class_type: "VAEDecode", inputs: { samples: ["772", 0] } },
            "772": { class_type: "KSampler", inputs: { seed: 1 } },
            "380": { class_type: "PreviewImage", inputs: { images: ["718", 0] } },
            "445": { class_type: "PreviewImage", inputs: { images: ["718", 0] } },
            "684": { class_type: "ImageComposite", inputs: { a: ["718", 0] } },
            "743": { class_type: "SaveImage", inputs: { images: ["684", 0] } },
        } as Record<string, any>;
    }

    it("多个输出节点时接拓扑最深的那条，而不是先遇到的第一个", () => {
        const result = appendRunningHubApiTail(multiSink());
        const graph = result.graph as any;
        const [playId] = result.nodeIds!;
        assert.deepEqual(graph[playId].inputs.any_input, ["743", 0], "应该接 SaveImage 743，不是 PreviewImage 380");
    });

    it("深度比 id 更重要：更深的那条即使 id 更小也优先", () => {
        const graph = {
            "748": { class_type: "VAEDecode", inputs: { samples: ["772", 0] } },
            "772": { class_type: "KSampler", inputs: { seed: 1 } },
            "684": { class_type: "ImageComposite", inputs: { a: ["748", 0] } },
            "380": { class_type: "PreviewImage", inputs: { images: ["684", 0] } },
            "743": { class_type: "SaveImage", inputs: { images: ["748", 0] } },
        } as Record<string, any>;
        const result = appendRunningHubApiTail(graph);
        const out = result.graph as any;
        assert.deepEqual(out[result.nodeIds![0]].inputs.any_input, ["380", 0], "380 在链路末端，743 在它上游");
    });

    it("有视频输出时接视频那条（和 UI 版一致）", () => {
        const graph = {
            "748": { class_type: "VAEDecode", inputs: { samples: ["772", 0] } },
            "772": { class_type: "KSampler", inputs: { seed: 1 } },
            "743": { class_type: "SaveImage", inputs: { images: ["748", 0] } },
            "900": { class_type: "SaveVideo", inputs: { video: ["748", 0] } },
        } as Record<string, any>;
        const result = appendRunningHubApiTail(graph);
        const out = result.graph as any;
        assert.deepEqual(out[result.nodeIds![0]].inputs.any_input, ["900", 0]);
        assert.equal(result.kind, "video");
    });
});
