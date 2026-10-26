import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flattenUseEverywhere } from "./runninghub-use-everywhere.js";

/** 造一个带 Anything Everywhere3 的最小 UI 图：CLIP/VAE 各一个空缺输入。 */
function workflow() {
    return {
        last_node_id: 10,
        last_link_id: 3,
        nodes: [
            { id: 1, type: "CLIPLoader", order: 0, mode: 0, inputs: [{ name: "clip_name", type: "COMBO", widget: { name: "clip_name" }, link: null }], outputs: [{ name: "CLIP", type: "CLIP", links: [1] }], widgets_values: ["t5xxl.safetensors"] },
            { id: 2, type: "VAELoader", order: 1, mode: 0, inputs: [], outputs: [{ name: "VAE", type: "VAE", links: [2] }], widgets_values: ["ae.safetensors"] },
            { id: 3, type: "Anything Everywhere", order: 2, mode: 0, properties: { "Node name for S&R": "Anything Everywhere3" }, inputs: [
                { name: "anything", type: "*", link: null },
                { name: "anything2", type: "CLIP", link: 1 },
                { name: "anything3", type: "VAE", link: 2 },
            ], outputs: [] },
            { id: 4, type: "TextEncodeQwenImage21", order: 3, mode: 0, inputs: [
                { name: "clip", type: "CLIP", link: null },
                { name: "vae", type: "VAE", link: null },
                { name: "prompt", type: "STRING", widget: { name: "prompt" }, link: null },
            ], outputs: [], widgets_values: [""] },
            { id: 5, type: "VAEDecode", order: 4, mode: 0, inputs: [{ name: "vae", type: "VAE", link: null }, { name: "samples", type: "LATENT", link: null }], outputs: [] },
        ],
        links: [[1, 1, 0, 3, 1, "CLIP"], [2, 2, 0, 3, 2, "VAE"]],
    } as any;
}

const inputOf = (workflow: any, nodeId: number, name: string) =>
    workflow.nodes.find((node: any) => node.id === nodeId)?.inputs.find((input: any) => input.name === name);

const sourceOf = (workflow: any, linkId: number) => workflow.links.find((row: any[]) => row[0] === linkId);

describe("runninghub-use-everywhere", () => {
    it("按类型把广播写实成真实连线，再删掉广播节点", () => {
        const result = flattenUseEverywhere(workflow());
        assert.equal(result.removedNodes.length, 1);
        assert.equal(result.links, 3, "CLIP 1 条 + VAE 2 条");

        const wf = result.workflow as any;
        assert.equal(wf.nodes.length, 4, "广播节点被移除");
        const clipLink = inputOf(wf, 4, "clip").link;
        assert.deepEqual(sourceOf(wf, clipLink)?.slice(1, 3), [1, 0], "clip 接回 CLIPLoader");
        const vaeLink = inputOf(wf, 4, "vae").link;
        assert.deepEqual(sourceOf(wf, vaeLink)?.slice(1, 3), [2, 0], "vae 接回 VAELoader");
        assert.deepEqual(sourceOf(wf, inputOf(wf, 5, "vae").link)?.slice(1, 3), [2, 0], "第二个 vae 也接上");
    });

    it("不覆盖已经有连线的输入", () => {
        const wf = workflow();
        const existing = inputOf(wf, 4, "clip");
        existing.link = 99;
        wf.links.push([99, 2, 0, 4, 0, "CLIP"]);
        const result = flattenUseEverywhere(wf);
        assert.equal((result.workflow as any).nodes.find((node: any) => node.id === 4).inputs[0].link, 99);
    });

    it("类型不同不广播（CLIP 不发给 STRING/COMBO）", () => {
        const result = flattenUseEverywhere(workflow());
        const wf = result.workflow as any;
        assert.equal(inputOf(wf, 4, "prompt").link, null, "STRING 输入不该被 CLIP/VAE 通道填上");
    });

    it("没有广播节点时原样返回", () => {
        const plain = { nodes: [{ id: 1, type: "SaveImage", inputs: [], outputs: [] }], links: [] } as any;
        const result = flattenUseEverywhere(plain);
        assert.equal(result.links, 0);
        assert.equal(result.workflow, plain);
    });

    it("bypass 的广播节点不参与", () => {
        const wf = workflow();
        wf.nodes.find((node: any) => node.id === 3).mode = 4;
        const result = flattenUseEverywhere(wf);
        assert.equal(result.links, 0);
        assert.equal(result.removedNodes.length, 0);
    });

    it("两个通道抢同一个输入时按歧义跳过，两个都不连", () => {
        const wf = workflow();
        // 给广播节点加第二个 CLIP 通道，指向另一个 CLIPLoader
        wf.nodes.push({ id: 6, type: "CLIPLoader", order: 5, mode: 0, inputs: [], outputs: [{ name: "CLIP", type: "CLIP", links: [3] }], widgets_values: ["other"] });
        wf.nodes.find((node: any) => node.id === 3).inputs.push({ name: "anything11", type: "CLIP", link: 3 });
        wf.links.push([3, 6, 0, 3, 3, "CLIP"]);

        const result = flattenUseEverywhere(wf);
        const out = result.workflow as any;
        assert.equal(result.ambiguous, 1, "唯一的空 CLIP 输入被两个通道同时匹配");
        assert.equal(inputOf(out, 4, "clip").link, null, "有歧义就不连，交给用户手动处理");
        assert.equal(inputOf(out, 4, "vae").link !== null, true, "VAE 通道没有冲突，照常写实");
    });
});
