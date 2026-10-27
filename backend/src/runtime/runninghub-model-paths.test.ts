import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripModelFolder, stripModelFoldersFromApiGraph, stripModelFoldersFromUiWorkflow } from "./runninghub-model-paths.js";

describe("runninghub-model-paths.stripModelFolder", () => {
    it("反斜杠与正斜杠的子目录都去掉", () => {
        assert.equal(stripModelFolder("Minimax\\minimax_h3_dmad_full_dareties_v4_step.safetensors"), "minimax_h3_dmad_full_dareties_v4_step.safetensors");
        assert.equal(stripModelFolder("lora/deep/MysticXXX_MMH3-V1.safetensors"), "MysticXXX_MMH3-V1.safetensors");
    });

    it("不是模型文件名的字符串不动", () => {
        assert.equal(stripModelFolder("a\\b.png"), "a\\b.png");
        assert.equal(stripModelFolder("这是提示词，含 \\ 符号"), "这是提示词，含 \\ 符号");
        assert.equal(stripModelFolder("9:16 (Portrait Widescreen)"), "9:16 (Portrait Widescreen)");
    });

    it("非字符串原样返回", () => {
        assert.equal(stripModelFolder(1.5), 1.5);
        assert.equal(stripModelFolder(null), null);
    });
});

describe("runninghub-model-paths.stripModelFoldersFromApiGraph", () => {
    it("清掉 LoRA / UNET / VAE / CLIP 的目录前缀", () => {
        const graph = {
            "53": { class_type: "LoraLoader", inputs: { model: ["1", 0], clip: ["2", 0], lora_name: "Minimax\\minimax_h3_dmad_full_dareties_v4_step.safetensors", strength_model: 0.8, strength_clip: 1 } },
            "400": { class_type: "LoraLoaderModelOnly", inputs: { model: ["53", 0], lora_name: "Minimax\\MysticXXX_MMH3-V1.safetensors", strength_model: 0.35 } },
            "977": { class_type: "UNETLoader", inputs: { unet_name: "Qwen\\qwen_image_2.1_int8_convrot.safetensors", weight_dtype: "default" } },
            "252": { class_type: "VAELoader", inputs: { vae_name: "Qwen\\qwen_image_2.1_vae_bf16.safetensors" } },
        };
        const out = stripModelFoldersFromApiGraph(graph) as any;
        assert.equal(out["53"].inputs.lora_name, "minimax_h3_dmad_full_dareties_v4_step.safetensors");
        assert.equal(out["53"].inputs.strength_model, 0.8);
        assert.deepEqual(out["53"].inputs.model, ["1", 0], "连线不能动");
        assert.equal(out["400"].inputs.lora_name, "MysticXXX_MMH3-V1.safetensors");
        assert.equal(out["977"].inputs.unet_name, "qwen_image_2.1_int8_convrot.safetensors");
        assert.equal(out["252"].inputs.vae_name, "qwen_image_2.1_vae_bf16.safetensors");
    });

    it("素材路径与普通文本不受影响", () => {
        const graph = {
            "420": { class_type: "LoadImage", inputs: { image: "sub\\dir\\photo.png" } },
            "949": { class_type: "TextEncodeQwenImage21", inputs: { prompt: "a\\b 的提示词" } },
        };
        const out = stripModelFoldersFromApiGraph(graph) as any;
        assert.equal(out["420"].inputs.image, "sub\\dir\\photo.png");
        assert.equal(out["949"].inputs.prompt, "a\\b 的提示词");
    });

    it("已经平铺的图原样返回同一个对象", () => {
        const graph = { "53": { class_type: "LoraLoader", inputs: { lora_name: "abc.safetensors" } } };
        assert.equal(stripModelFoldersFromApiGraph(graph), graph);
    });
});

describe("runninghub-model-paths.stripModelFoldersFromUiWorkflow", () => {
    it("清 LoadLoRA 的 widgets_values 与 widgets_values_named", () => {
        const workflow = {
            nodes: [
                { id: 400, type: "LoraLoaderModelOnly", widgets_values: ["Minimax\\MysticXXX_MMH3-V1.safetensors", 0.35], widgets_values_named: { lora_name: "Minimax\\MysticXXX_MMH3-V1.safetensors", strength_model: 0.35 } },
                { id: 420, type: "LoadImage", widgets_values: ["sub\\photo.png", "image"] },
            ],
        };
        const out = stripModelFoldersFromUiWorkflow(workflow) as any;
        assert.deepEqual(out.nodes[0].widgets_values, ["MysticXXX_MMH3-V1.safetensors", 0.35]);
        assert.equal(out.nodes[0].widgets_values_named.lora_name, "MysticXXX_MMH3-V1.safetensors");
        assert.deepEqual(out.nodes[1].widgets_values, ["sub\\photo.png", "image"], "素材节点不动");
    });

    it("没有可清理内容时原样返回同一个对象", () => {
        const workflow = { nodes: [{ id: 1, type: "SaveImage", widgets_values: ["ComfyUI"] }] };
        assert.equal(stripModelFoldersFromUiWorkflow(workflow), workflow);
    });
});
