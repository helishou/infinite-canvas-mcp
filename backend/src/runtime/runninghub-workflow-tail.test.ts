import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendRunningHubOutputTail, TAIL_PLAY_SOUND, TAIL_SAVE_LOCAL } from "./runninghub-workflow-tail.js";

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
    it("SaveVideo：Play Sound 接 VIDEO 输出，Save Image To Local 接上游帧来源", () => {
        const result = appendRunningHubOutputTail(videoWorkflow());
        assert.equal(result.added, true);
        assert.equal(result.kind, "video");
        assert.equal(result.attachedSave, true);

        const wf = result.workflow as any;
        const play = nodeOf(wf, TAIL_PLAY_SOUND)!;
        const local = nodeOf(wf, TAIL_SAVE_LOCAL)!;
        const saveVideo = nodeOf(wf, "SaveVideo")!;
        const decode = nodeOf(wf, "VAEDecode")!;

        // Play Sound 在视频输出之后：VIDEO 类型
        const linkIn = play.inputs[0].link;
        assert.deepEqual(linkRow(wf, linkIn), [linkIn, 3, 0, play.id, 0, "VIDEO"]);
        assert.equal(saveVideo.outputs[0].links.length, 1);
        assert.equal(play.outputs[0].links.length, 0, "视频链不把 any_output 串下去");

        // Save Image To Local 接帧来源（VAEDecode.IMAGE），不是接 Play Sound
        const linkSave = local.inputs[0].link;
        assert.deepEqual(linkRow(wf, linkSave), [linkSave, 1, 0, local.id, 0, "IMAGE"]);
        assert.equal(decode.outputs[0].links.length, 2);
        assert.equal(wf.last_link_id, linkSave);
    });

    it("VHS_VideoCombine：Filenames 接 Play Sound，帧来源取其 images 上游", () => {
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
        assert.deepEqual(linkRow(out, local.inputs[0].link), [local.inputs[0].link, 1, 0, local.id, 0, "IMAGE"]);
    });

    it("视频上游找不到 IMAGE 时只接 Play Sound，并给出原因", () => {
        const wf = {
            last_node_id: 2,
            last_link_id: 1,
            nodes: [
                { id: 1, type: "SomeVideoGen", pos: [0, 0], size: [200, 100], order: 0, mode: 0, inputs: [], outputs: [{ name: "VIDEO", type: "VIDEO", links: [1] }] },
                { id: 2, type: "SaveVideo", pos: [300, 0], size: [300, 200], order: 1, mode: 0, inputs: [{ name: "video", type: "VIDEO", link: 1 }], outputs: [{ name: "video", type: "VIDEO", links: null }] },
            ],
            links: [[1, 1, 0, 2, 0, "VIDEO"]],
        };
        const result = appendRunningHubOutputTail(wf as any);
        assert.equal(result.added, true);
        assert.equal(result.reason, "video-no-image");
        assert.equal(result.attachedSave, false);
        const out = result.workflow as any;
        const local = nodeOf(out, TAIL_SAVE_LOCAL)!;
        assert.equal(local.inputs[0].link, null, "没有帧来源就留空，不硬连");
        assert.ok(nodeOf(out, TAIL_PLAY_SOUND)!.inputs[0].link >= 0);
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
