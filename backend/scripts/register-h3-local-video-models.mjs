import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildNativeNanFengV15Workflow } from "../src/comfyui/bridge.ts";
import { BASE_H3_NODE_METADATA, H3_VIDEO_RATIOS } from "../../canvas-agent/src/plugins/minimax-h3/node-factory.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const endpoint = process.env.H3_SETUP_BACKEND || "http://127.0.0.1:17370";
const connection = await fetch(`${endpoint}/config`).then((r) => r.json());
const headers = { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" };
async function api(route, method = "GET", body) {
    const response = await fetch(`${endpoint}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(`${method} ${route}: ${data.error || response.status}`);
    return data;
}
const initial = (await api("/settings/ai-config")).config;
const local = initial.channels.find((channel) => channel.kind === "comfyui");
if (!local) throw new Error("没有本地 ComfyUI 渠道");
const defaults = (await api("/plugins/minimax-h3/defaults")).defaults || {};
const comfy = await api("/comfy/config");
const backup = path.join(root, ".local-backups", "h3-local-models", new Date().toISOString().replace(/[:.]/g, "-"));
await fs.mkdir(backup, { recursive: true });
await fs.writeFile(path.join(backup, "previous-ai-config.json"), JSON.stringify(initial, null, 2));
await fs.writeFile(path.join(backup, "h3-defaults.json"), JSON.stringify(defaults, null, 2));
const definitions = [
    { mode: "t2v", suffix: "t2va", name: "MiniMax H3 文生视频", images: 0, scenario: "text" },
    { mode: "fl2v", suffix: "fl2va", name: "MiniMax H3 首尾帧", images: 2, scenario: "multi" },
    { mode: "ref2va", suffix: "ref2va", name: "MiniMax H3 多参视频", images: 9, scenario: "multi" },
    { mode: "i2v", suffix: "i2va", name: "MiniMax H3 图生视频", images: 1, scenario: "single" },
];
const packages = [];
for (const item of definitions) {
    const params = { ...BASE_H3_NODE_METADATA, ...defaults, mode: item.mode, taskMode: item.mode, steps: defaults.videoSteps ?? BASE_H3_NODE_METADATA.videoSteps,
        duration: defaults.duration ?? BASE_H3_NODE_METADATA.duration, motionContextEnabled: false, previousVideoAsReference: false, lockAudio: false, audioDrive: false, noiseSeedMode: "fixed", seed: 1 };
    const count = item.mode === "ref2va" ? 1 : item.images;
    const graph = await buildNativeNanFengV15Workflow({ prompt: "", references: Array.from({ length: count }, (_, i) => `slot-${i + 1}.png`) }, params, async (name) => name, comfy.url, new AbortController().signal);
    const node = graph.nf_v15;
    if (!node || node.class_type !== "NanFengH3MultiReferenceGeneratorV15") throw new Error("H3 默认设置未生成原生 V15 工作流，停止登记");
    for (let i = 1; i <= 9; i++) node.inputs[`图片${i}`] = "未选择";
    node.inputs["固定随机种子"] = true;
    node.inputs["随机种子"] = 1;
    const fields = Array.from({ length: item.images }, (_, i) => ({ id: `reference_image_${i + 1}`, node: "nf_v15", input: `图片${i + 1}`, name: item.mode === "fl2v" ? i ? "尾帧" : "首帧" : item.mode === "i2v" ? "首帧图片" : `参考图片 ${i + 1}`, type: "image", required: item.mode === "ref2va" ? i === 0 : true }));
    fields.push({ id: "prompt", node: "nf_v15", input: "提示词", name: "视频提示词", type: "text", required: true, isPrompt: true, default: "" });
    const settings = [["duration", "时长秒", "时长（秒）", "number"], ["aspect_ratio", "画面比例", "画面比例", "dropdown"], ["megapixels", "百万像素", "百万像素", "number"],
        ["steps", "采样步数", "采样步数", "number"], ["sampler", "采样器", "采样器", "dropdown"], ["scheduler", "调度器", "调度器", "dropdown"], ["denoise", "降噪强度", "降噪强度", "number"],
        ["model", "模型", "H3 模型权重", "dropdown"], ["text_encoder", "文本编码器", "文本编码器", "dropdown"], ["video_vae", "视频VAE", "视频 VAE", "dropdown"], ["audio_vae", "音频VAE", "音频 VAE", "dropdown"]];
    for (const [id, input, name, type] of settings) fields.push({ id, node: "nf_v15", input, name, type, default: node.inputs[input], ...(type === "number" ? { step: id === "megapixels" ? 0.1 : id === "denoise" ? 0.01 : 1 } : {}), ...(type === "dropdown" ? { options: input === "画面比例" ? [...Object.keys(H3_VIDEO_RATIOS), ...(["i2v", "fl2v"].includes(item.mode) ? ["原图比例"] : [])] : [String(node.inputs[input])] } : {}) });
    fields.push({ id: "noise_seed", node: "nf_v15", input: "随机种子", name: "随机种子", type: "number", default: -1, randomEnabled: true });
    const name = `custom/h3-local-${item.suffix}.json`;
    graph.nf_output.inputs.filename_prefix = `video/H3_${item.suffix}`;
    const pkg = { format: "infinite-canvas-workflow", version: 1, name, workflow: graph, config: { title: item.name, backend: "comfyui", operation: "video-generation", description: `${item.name}；使用 H3 导演台原生 V15 节点及当前默认参数。${item.mode === "fl2v" ? "图片1=首帧，图片2=尾帧。" : ""}`, fields, mediaInputs: {}, miniCards: {} } };
    await fs.writeFile(path.join(backup, `prepared-${item.suffix}.json`), JSON.stringify(pkg, null, 2));
    packages.push({ item, name, pkg });
}
const listed = (await api("/api/workflows")).workflows;
for (const { item, name, pkg } of packages) {
    if (listed.some((entry) => entry.name === name)) {
        const previous = await api(`/api/workflows/${encodeURIComponent(name)}/export`);
        await fs.writeFile(path.join(backup, `previous-${item.suffix}.json`), JSON.stringify(previous, null, 2));
    }
    await api("/api/workflows/import", "POST", { name, package: pkg, exposeModel: false });
    const restored = await api(`/api/workflows/${encodeURIComponent(name)}/export`);
    if (JSON.stringify(restored.workflow) !== JSON.stringify(pkg.workflow) || restored.config.fields.length !== pkg.config.fields.length) throw new Error(`${name} 导入往返不一致`);
}
const current = (await api("/settings/ai-config")).config;
const channel = current.channels.find((entry) => entry.id === local.id && entry.kind === "comfyui");
if (!channel) throw new Error("本地渠道已改变，工作流已保存，未覆盖渠道配置");
for (const { item, name } of packages) {
    const routing = { text: "__unsupported__", single: "__unsupported__", multi: "__unsupported__", [item.scenario]: name };
    if (item.mode === "ref2va") routing.single = name;
    const model = { name: item.name, capability: "video", workflows: [name], workflowRouting: routing };
    const index = channel.models.findIndex((entry) => entry.name === item.name);
    if (index < 0) channel.models.push(model);
    else channel.models[index] = { ...channel.models[index], ...model, script: "" };
}
await api("/settings/ai-config", "PUT", { config: current });
const saved = (await api("/settings/ai-config")).config.channels.find((entry) => entry.id === local.id);
console.log(JSON.stringify({ channel: saved.name, models: saved.models.filter((model) => definitions.some((item) => item.name === model.name)), backup }, null, 2));
