#!/usr/bin/env node
/**
 * rh-flow —— 独立的 RunningHub 工作流小工具（不依赖 Infinite-Canvas、不依赖任何 npm 包）。
 *
 * 把本机 ComfyUI 的工作流 JSON 直接推到 RunningHub，或把云端工作流拉回本地文件。
 * 整目录拷走就能用，只需要 Node 22+。
 *
 *   node rh-flow.mjs push <工作流.json> [选项]
 *   node rh-flow.mjs pull <workflowId> --api-key <OpenAPI Key> [选项]
 *   node rh-flow.mjs token                       # 从本机浏览器里找网页登录令牌
 *
 * push 选项：
 *   --name <名字>       云端工作流名，默认取文件名
 *   --site cn|ai        站点，默认 cn（runninghub.cn）
 *   --token <JWT>       网页登录令牌，默认自动从浏览器读取
 *   --no-tail           不注入 Play Sound KJ → Save Image To Local
 *   --keep-model-paths  保留模型文件名的目录前缀（默认去掉）
 *   --dry-run           只做本地预处理并打印结果，不上传
 *
 * pull 选项：
 *   --api-key <KEY>     RunningHub OpenAPI Key（必填）
 *   --site cn|ai        站点，默认 cn
 *   --out <目录>        输出目录，默认当前目录
 *
 * 处理器说明（与 Infinite-Canvas 后端同一套规则，为保持独立而在此复刻）：
 * - UI 格式（带 nodes/links）→ 转成 API 格式用于提交，UI 原件原样上传给编辑器；
 * - 模型文件名去掉本地子目录前缀（云端模型是平铺的）；
 * - 输出节点后面接 `Play Sound KJ` → `Save Image To Local`（图像与视频输出都接同一条链）。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SITES = { cn: "https://www.runninghub.cn", ai: "https://www.runninghub.ai" };

// ── 基础工具 ────────────────────────────────────────────────────────────────

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const asRecord = (value) => (isRecord(value) ? value : {});
const asArray = (value) => (Array.isArray(value) ? value : []);
const num = (value, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const str = (value, fallback = "") => (typeof value === "string" ? value : fallback);

// ── 1. UI 格式 → API 格式 ───────────────────────────────────────────────────

export function isApiGraph(value) {
    if (!isRecord(value)) return false;
    const entries = Object.values(value);
    return entries.length > 0 && entries.every((node) => isRecord(node) && typeof node.class_type === "string" && isRecord(node.inputs));
}

export function toApiGraph(value) {
    if (isApiGraph(value)) return value;
    const graph = asRecord(value);
    if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) throw new Error("文件既不是 ComfyUI 工作流图（nodes），也不是 API 格式（class_type）");

    const links = new Map();
    for (const raw of Array.isArray(graph.links) ? graph.links : Object.values(asRecord(graph.links))) {
        if (Array.isArray(raw) && raw.length >= 5) {
            links.set(String(raw[0]), { originId: String(raw[1]), originSlot: Number(raw[2]), targetId: String(raw[3]), targetSlot: Number(raw[4]) });
            continue;
        }
        const link = asRecord(raw);
        const id = link.id ?? link.link_id;
        const originId = link.origin_id ?? link.originId;
        const targetId = link.target_id ?? link.targetId;
        if (id === undefined || originId === undefined || targetId === undefined) continue;
        links.set(String(id), {
            originId: String(originId),
            originSlot: Number(link.origin_slot ?? link.originSlot),
            targetId: String(targetId),
            targetSlot: Number(link.target_slot ?? link.targetSlot),
        });
    }

    const api = {};
    for (const node of graph.nodes.map(asRecord)) {
        if (node.id === undefined || typeof node.type !== "string" || !node.type) continue;
        const id = String(node.id);
        if (api[id]) throw new Error(`工作流里有重复节点编号：${id}`);
        const inputs = {};
        const nodeInputs = asArray(node.inputs).map(asRecord);
        const widgetValues = Array.isArray(node.widgets_values) ? node.widgets_values : [];
        const widgetObject = isRecord(node.widgets_values) ? node.widgets_values : null;
        let widgetIndex = 0;
        for (const input of nodeInputs) {
            const name = str(input.name);
            if (!name) continue;
            if (input.link !== null && input.link !== undefined) {
                const link = links.get(String(input.link));
                if (!link) throw new Error(`节点 ${id} 的输入 ${name} 引用了不存在的连线`);
                inputs[name] = [link.originId, link.originSlot];
            }
            if (input.widget) {
                const widget = asRecord(input.widget);
                const widgetName = str(widget.name, name);
                const value = widgetObject ? widgetObject[widgetName] : widgetValues[widgetIndex];
                widgetIndex += 1;
                if ((input.link === null || input.link === undefined) && value !== undefined) inputs[name] = value;
            }
        }
        api[id] = { class_type: node.type, inputs };
    }
    if (!Object.keys(api).length) throw new Error("工作流里没有可转换的节点");
    for (const link of links.values()) {
        if (!api[link.originId] || !api[link.targetId]) throw new Error(`连线引用了不存在的节点：${link.originId} → ${link.targetId}`);
        const target = graph.nodes.map(asRecord).find((node) => String(node.id) === link.targetId);
        const nodeInputs = asArray(target?.inputs);
        const targetInput = nodeInputs.map(asRecord).find((input, index) => Number(input.slot_index ?? input.slotIndex ?? index) === link.targetSlot);
        const name = str(targetInput?.name);
        if (name) api[link.targetId].inputs[name] = [link.originId, link.originSlot];
    }
    return api;
}

// ── 2. 模型文件名去目录前缀 ─────────────────────────────────────────────────

const MODEL_EXT = /\.(safetensors|ckpt|pt|pth|bin|gguf|onnx)$/i;
const LOADER_TYPES = new Set([
    "LoraLoader", "LoraLoaderModelOnly", "LoadLoRA", "Load LoRA", "UNETLoader", "UnetLoaderGGUF", "UnetLoaderGGUFAdvanced",
    "VAELoader", "CLIPLoader", "DualCLIPLoader", "TripleCLIPLoader", "CheckpointLoaderSimple", "CheckpointLoader",
    "unCLIPCheckpointLoader", "UpscaleModelLoader", "ControlNetLoader", "DiffControlNetLoader", "CLIPVisionLoader",
    "StyleModelLoader", "PhotoMakerLoader", "IPAdapterModelLoader", "InstantIDModelLoader",
]);
const MODEL_KEYS = new Set([
    "lora_name", "unet_name", "vae_name", "clip_name", "clip_name1", "clip_name2", "clip_name3", "ckpt_name",
    "control_net_name", "model_name", "upscale_model", "style_model_name", "clip_vision_name", "ipadapter_file",
]);

function stripModelFolder(value) {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (!MODEL_EXT.test(trimmed)) return trimmed;
    const base = trimmed.split(/[\\/]+/).filter(Boolean).pop();
    return base && base !== trimmed ? base : trimmed;
}

export function stripModelPathsFromApiGraph(graph) {
    let changed = false;
    const next = {};
    for (const [nodeId, raw] of Object.entries(graph)) {
        const node = asRecord(raw);
        if (!isRecord(node.inputs)) {
            next[nodeId] = raw;
            continue;
        }
        const loader = LOADER_TYPES.has(str(node.class_type));
        const inputs = {};
        let nodeChanged = false;
        for (const [key, value] of Object.entries(node.inputs)) {
            const stripped = typeof value === "string" && (loader || MODEL_KEYS.has(key)) ? stripModelFolder(value) : value;
            inputs[key] = stripped;
            if (stripped !== value) nodeChanged = true;
        }
        if (!nodeChanged) {
            next[nodeId] = raw;
            continue;
        }
        changed = true;
        next[nodeId] = { ...node, inputs };
    }
    return changed ? next : graph;
}

export function stripModelPathsFromUiWorkflow(workflow) {
    const nodes = asArray(workflow.nodes);
    let changed = false;
    const nextNodes = nodes.map((raw) => {
        const node = asRecord(raw);
        if (!LOADER_TYPES.has(str(node.type))) return raw;
        const patch = {};
        if (Array.isArray(node.widgets_values)) {
            const values = node.widgets_values.map(stripModelFolder);
            if (values.some((value, index) => value !== node.widgets_values[index])) patch.widgets_values = values;
        }
        if (isRecord(node.widgets_values_named)) {
            const named = {};
            let namedChanged = false;
            for (const [key, value] of Object.entries(node.widgets_values_named)) {
                const stripped = stripModelFolder(value);
                named[key] = stripped;
                if (stripped !== value) namedChanged = true;
            }
            if (namedChanged) patch.widgets_values_named = named;
        }
        if (!Object.keys(patch).length) return raw;
        changed = true;
        return { ...node, ...patch };
    });
    return changed ? { ...workflow, nodes: nextNodes } : workflow;
}

// ── 3. 尾节点：Play Sound KJ → Save Image To Local ──────────────────────────

const IMAGE_SINKS = new Set(["SaveImage", "PreviewImage", "SaveImageWebsocket", "SaveImageAndMetadata", "Image Save", "Save Image"]);
const VIDEO_SINKS = new Set(["SaveVideo", "VHS_VideoCombine", "SaveWEBM", "SaveAnimatedWEBP", "SaveAnimatedPNG"]);
const TAIL_PLAY = "PlaySoundKJ";
const TAIL_SAVE = "SaveImageToLocal";
const TAIL_DEFAULTS = { audioPath: "", mode: "always", volume: 0.2, duration: 5, filePath: "output" };

function maxOf(values, fallback) {
    const usable = values.filter((value) => Number.isFinite(value));
    return usable.length ? Math.max(...usable) : fallback;
}

function collectSinks(nodes) {
    const image = [];
    const video = [];
    nodes.forEach((node, index) => {
        const type = str(node.type);
        const active = node.mode !== 2 && node.mode !== 4;
        if (!active) return;
        const imageType = IMAGE_SINKS.has(type);
        const videoType = VIDEO_SINKS.has(type);
        if (!imageType && !videoType) return;
        const slots = asArray(node.outputs).map(asRecord);
        const imageSlot = slots.findIndex((slot) => str(slot.type) === "IMAGE");
        const order = num(node.order, index);
        if (imageSlot >= 0) {
            image.push({ node, slot: imageSlot, type: "IMAGE", kind: "image", order, index });
            return;
        }
        if (videoType && slots.length) video.push({ node, slot: 0, type: str(slots[0].type, "VIDEO"), kind: "video", order, index });
    });
    return { image, video };
}

const lastOf = (candidates) => candidates.sort((a, b) => b.order - a.order || b.index - a.index)[0];

/** 在输出节点后面接 Play Sound KJ → Save Image To Local；已有这两个节点则原样返回。 */
export function appendTail(workflow, options = {}) {
    const settings = { ...TAIL_DEFAULTS, ...options };
    const rawNodes = asArray(workflow.nodes);
    if (!Array.isArray(workflow.nodes) || !Array.isArray(workflow.links) || !rawNodes.length) return { workflow, added: false, reason: "not-ui" };
    const nodes = rawNodes.map(asRecord);
    if (nodes.some((node) => str(node.type) === TAIL_PLAY) || nodes.some((node) => str(node.type) === TAIL_SAVE)) return { workflow, added: false, reason: "already" };

    const sinks = collectSinks(nodes);
    const sink = lastOf(sinks.video) || lastOf(sinks.image);
    if (!sink) return { workflow, added: false, reason: "no-sink" };

    const links = asArray(workflow.links).map((link) => (Array.isArray(link) ? [...link] : link));
    const nextNodeId = maxOf([num(workflow.last_node_id), ...nodes.map((node) => num(node.id))], nodes.length);
    const playId = nextNodeId + 1;
    const saveId = nextNodeId + 2;
    let nextLinkId = maxOf([num(workflow.last_link_id), ...links.map((link) => (Array.isArray(link) ? num(link[0], NaN) : NaN))], links.length);

    const sinkNode = sink.node;
    const sinkOutputs = asArray(sinkNode.outputs).map(asRecord);
    const sinkOutput = sinkOutputs[sink.slot] || {};
    const sinkOutputType = str(sinkOutput.type, sink.kind === "video" ? "VIDEO" : "IMAGE");

    const linkIn = ++nextLinkId;
    sinkOutputs[sink.slot] = { ...sinkOutput, links: [...asArray(sinkOutput.links), linkIn] };
    sinkNode.outputs = sinkOutputs;
    const linkSave = ++nextLinkId;

    const pos = asArray(sinkNode.pos);
    const size = asArray(sinkNode.size);
    const baseX = num(pos[0]) + num(size[0], 320) + 80;
    const baseY = num(pos[1]);
    const lastOrder = maxOf(nodes.map((node) => num(node.order, NaN)), nodes.length - 1);

    const playNode = {
        id: playId,
        type: TAIL_PLAY,
        pos: [baseX, baseY],
        size: [315, 130],
        flags: {},
        order: lastOrder + 1,
        mode: 0,
        inputs: [
            { name: "any_input", type: "*", link: linkIn },
            { name: "audio", type: "AUDIO", link: null },
            { widget: { name: "audio_path" }, name: "audio_path", type: "STRING" },
            { widget: { name: "mode" }, name: "mode", type: "COMBO" },
            { widget: { name: "volume" }, name: "volume", type: "FLOAT" },
            { widget: { name: "duration" }, name: "duration", type: "FLOAT" },
        ],
        outputs: [{ name: "any_output", type: "*", links: [linkSave] }],
        properties: { "Node name for S&R": TAIL_PLAY, cnr_id: "comfyui-kjnodes" },
        widgets_values: [settings.audioPath, settings.mode, settings.volume, settings.duration],
        widgets_values_named: { audio_path: settings.audioPath, mode: settings.mode, volume: settings.volume, duration: settings.duration },
    };
    const saveNode = {
        id: saveId,
        type: TAIL_SAVE,
        pos: [baseX + 315 + 90, baseY],
        size: [330, 120],
        flags: {},
        order: lastOrder + 2,
        mode: 0,
        inputs: [
            { name: "images", type: "IMAGE", link: linkSave },
            { widget: { name: "file_path" }, name: "file_path", type: "STRING" },
        ],
        outputs: [],
        properties: { "Node name for S&R": TAIL_SAVE, cnr_id: "comfyui-mixlab-nodes" },
        widgets_values: [settings.filePath],
        widgets_values_named: { file_path: settings.filePath },
    };

    links.push([linkIn, num(sinkNode.id), sink.slot, playId, 0, sinkOutputType]);
    links.push([linkSave, playId, 0, saveId, 0, "*"]);

    return {
        workflow: { ...workflow, nodes: [...nodes, playNode, saveNode], links, last_node_id: saveId, last_link_id: linkSave },
        added: true,
        kind: sink.kind,
        sinkId: num(sinkNode.id),
        nodeIds: [playId, saveId],
    };
}

// ── 4. 网页登录令牌 ─────────────────────────────────────────────────────────

// 登录态的域名可能是主域也可能是子域（本站点实际用的是 `rhtv.runninghub.cn`），
// 所以按「任意子域 + 站点后缀」匹配，键名后跟若干二进制字节再是 JWT。
// LevelDB 里同一条值偶尔会被截断，这里放宽到 2 段以上，选出最完整的一份。
function extractTokens(text, site) {
    const pattern = new RegExp(`_?https://(?:[a-z0-9-]+\\.)*runninghub\\.${site}[\\s\\S]{0,64}?Rh-Accesstoken[\\s\\S]{0,64}?(eyJ[A-Za-z0-9_-]{8,}(?:\\.[A-Za-z0-9_-]{8,})+)`, "gi");
    const tokens = [];
    for (const match of text.matchAll(pattern)) tokens.push(match[1]);
    return tokens;
}

/** JWT 的 exp（秒）；解析不出来给 0。 */
function tokenExpiry(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
        return Number(payload.exp) || 0;
    } catch {
        return 0;
    }
}

async function readLeveldbTokens(directory, site) {
    let names;
    try { names = await fs.readdir(directory); } catch { return []; }
    const found = [];
    for (const name of names) {
        if (!/\.(ldb|log)$/i.test(name)) continue;
        const file = path.join(directory, name);
        try {
            const text = (await fs.readFile(file)).toString("latin1");
            if (!text.includes("Rh-Accesstoken")) continue;
            const stat = await fs.stat(file);
            for (const token of extractTokens(text, site)) found.push({ token, mtime: stat.mtimeMs, exp: tokenExpiry(token) });
        } catch {
            /* 文件被浏览器占用时跳过 */
        }
    }
    return found;
}

/** 从 Edge / Chrome 的 Local Storage 里找 RunningHub 网页登录令牌（同站点取未过期的最近一份）。 */
export async function readBrowserToken(site = "cn") {
    const roots = [
        path.join(os.homedir(), "AppData/Local/Microsoft/Edge/User Data"),
        path.join(os.homedir(), "AppData/Local/Google/Chrome/User Data"),
        path.join(os.homedir(), "Library/Application Support/Google/Chrome"),
        path.join(os.homedir(), ".config/google-chrome"),
    ];
    const candidates = [];
    for (const root of roots) {
        let profiles;
        try { profiles = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
        for (const profile of profiles) {
            if (!profile.isDirectory()) continue;
            if (!/^(Default|Profile \d+|Guest Profile)$/i.test(profile.name)) continue;
            candidates.push(...await readLeveldbTokens(path.join(root, profile.name, "Local Storage", "leveldb"), site));
        }
    }
    if (!candidates.length) return "";
    const now = Math.floor(Date.now() / 1000);
    const usable = candidates.filter((item) => item.exp === 0 || item.exp > now);
    const pool = usable.length ? usable : candidates;
    // 先比完整性（段数多的更像完整 JWT），再比有效期和文件新旧。
    pool.sort((left, right) => right.token.split(".").length - left.token.split(".").length || right.exp - left.exp || right.mtime - left.mtime);
    return pool[0].token;
}

// ── 5. 网络 ────────────────────────────────────────────────────────────────

function siteBase(site) {
    const base = SITES[site];
    if (!base) throw new Error(`未知站点：${site}（可选 cn / ai）`);
    return base;
}

async function uploadWorkflow({ base, token, name, json, fileName }) {
    const boundary = `----rhflow${Math.random().toString(16).slice(2)}`;
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="workflowFile"; filename="${fileName}"\r\nContent-Type: application/json\r\n\r\n`;
    const tailPart = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="workflowName"\r\n\r\n${name}\r\n--${boundary}--\r\n`;
    const body = Buffer.concat([Buffer.from(head, "utf8"), Buffer.from(json, "utf8"), Buffer.from(tailPart, "utf8")]);
    const response = await fetch(`${base}/api/workflow/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body,
    });
    const payload = await response.json().catch(() => ({}));
    if (Number(payload.code) === 403 || Number(payload.code) === 412) throw new Error("网页登录令牌无效或已过期，请重新登录 RunningHub，或用 --token 传新令牌");
    if (!response.ok || Number(payload.code) !== 0) throw new Error(`上传失败：${payload.msg || payload.code || response.status}`);
    const id = String(asRecord(payload.data).id || "");
    if (!id) throw new Error("平台没有返回 workflowId");
    return id;
}

async function pullWorkflow({ base, apiKey, workflowId }) {
    const response = await fetch(`${base}/api/openapi/getJsonApiFormat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ apiKey, workflowId }),
    });
    const payload = await response.json().catch(() => ({}));
    const prompt = asRecord(payload.data).prompt;
    const graph = typeof prompt === "string" ? JSON.parse(prompt) : prompt;
    if (!isRecord(graph) || !Object.values(graph).some((node) => asRecord(node).class_type)) {
        throw new Error(`读不回节点图（${payload.msg || payload.code || response.status}）：新上传的工作流是草稿，先在网页端打开跑一次`);
    }
    return graph;
}

// ── 6. CLI ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const positional = [];
    const flags = {};
    const booleans = { "no-tail": "noTail", "keep-model-paths": "keepModelPaths", "dry-run": "dryRun" };
    for (let index = 0; index < argv.length; index += 1) {
        const item = argv[index];
        if (!item.startsWith("--")) {
            positional.push(item);
            continue;
        }
        const key = item.slice(2);
        if (booleans[key]) {
            flags[booleans[key]] = true;
            continue;
        }
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) throw new Error(`--${key} 缺少取值`);
        flags[key] = value;
        index += 1;
    }
    return { positional, flags };
}

function usage() {
    console.log(`rh-flow —— 独立的 RunningHub 工作流工具（只用 Node，无需安装依赖）

  node rh-flow.mjs push <工作流.json> [--name 名字] [--site cn|ai] [--token JWT] [--no-tail] [--keep-model-paths] [--dry-run]
  node rh-flow.mjs pull <workflowId> --api-key <OpenAPI Key> [--site cn|ai] [--out 目录]
  node rh-flow.mjs token [--site cn|ai]

push：读本地 ComfyUI 的 UI/API 工作流 → 去模型目录前缀 → 输出节点后接 Play Sound KJ → Save Image To Local → 上传。
pull：用 OpenAPI Key 把云端工作流读回成本地 API 格式 JSON。`);
}

async function commandPush(flags, file) {
    if (!file) throw new Error("缺少工作流文件路径");
    const site = flags.site || "cn";
    const raw = JSON.parse(await fs.readFile(path.resolve(file), "utf8"));
    const isUi = Array.isArray(raw.nodes);
    const name = flags.name || path.basename(file).replace(/\.json$/i, "");

    let apiGraph = toApiGraph(raw);
    if (!flags.keepModelPaths) apiGraph = stripModelPathsFromApiGraph(apiGraph);
    let uiWorkflow = isUi ? raw : undefined;
    if (uiWorkflow && !flags.keepModelPaths) uiWorkflow = stripModelPathsFromUiWorkflow(uiWorkflow);
    let tail = { added: false, reason: "not-ui" };
    if (isUi && !flags.noTail) {
        tail = appendTail(uiWorkflow);
        uiWorkflow = tail.workflow;
    }

    console.log(`输入：${path.basename(file)}｜${isUi ? "UI 格式（含 nodes）" : "API 格式"}｜API 节点 ${Object.keys(apiGraph).length}`);
    console.log(`模型路径：${flags.keepModelPaths ? "保留目录前缀" : "已去目录前缀"}`);
    if (isUi) {
        console.log(tail.added
            ? `尾节点：已接上 Play Sound KJ → Save Image To Local（${tail.kind === "video" ? "视频" : "图像"}输出，${tail.nodeIds.join(" / ")}）`
            : `尾节点：跳过（${tail.reason === "already" ? "图里已有" : tail.reason === "no-sink" ? "没找到输出节点" : "不适用"}）`);
    }
    if (flags.dryRun) {
        console.log("--dry-run：到此为止，没有上传。");
        return;
    }

    const token = flags.token || await readBrowserToken(site);
    if (!token) throw new Error("没找到网页登录令牌：请先在浏览器登录 RunningHub，或用 --token 传 Rh-Accesstoken");
    const base = siteBase(site);
    const payload = uiWorkflow || apiGraph;
    const workflowId = await uploadWorkflow({ base, token, name, json: JSON.stringify(payload), fileName: `${name}.json` });
    console.log(`上传完成：${base}｜workflowId=${workflowId}｜编辑器格式 ${uiWorkflow ? "UI" : "API（编辑器看不到节点）"}`);
    console.log("提示：新上传的是草稿，在网页端打开跑一次后即可用 pull 读回平台图。");
}

async function commandPull(flags, workflowId) {
    if (!workflowId) throw new Error("缺少 workflowId");
    if (!flags["api-key"]) throw new Error("缺少 --api-key（RunningHub 的 OpenAPI Key）");
    const graph = await pullWorkflow({ base: siteBase(flags.site || "cn"), apiKey: flags["api-key"], workflowId });
    const outDir = path.resolve(flags.out || ".");
    await fs.mkdir(outDir, { recursive: true });
    const file = path.join(outDir, `${workflowId}.json`);
    await fs.writeFile(file, JSON.stringify(graph, null, 2), "utf8");
    console.log(`读回：${workflowId}｜节点 ${Object.keys(graph).length}`);
    console.log(`已写入：${file}`);
}

async function commandToken(flags) {
    const site = flags.site || "cn";
    const token = await readBrowserToken(site);
    if (!token) {
        console.error(`没找到 ${site} 站点的登录令牌：先在该站点登录 RunningHub，或用 --token 直接传 Rh-Accesstoken`);
        process.exitCode = 1;
        return;
    }
    console.log(token);
    const expiry = tokenExpiry(token);
    const segments = token.split(".").length;
    console.error(`站点 ${site}｜长度 ${token.length}｜段数 ${segments}｜有效期至 ${expiry ? new Date(expiry * 1000).toLocaleString() : "未知"}`);
    if (segments < 3) console.error("注意：令牌不完整（缺签名段），上传可能被拒；从浏览器 F12 → Application → Local Storage → Rh-Accesstoken 复制完整值，用 --token 传入。");
}

async function main() {
    const { positional, flags } = parseArgs(process.argv.slice(2));
    const command = positional[0];
    if (!command || command === "help" || command === "--help") return usage();
    if (command === "push") return commandPush(flags, positional[1]);
    if (command === "pull") return commandPull(flags, positional[1]);
    if (command === "token") return commandToken(flags);
    usage();
    throw new Error(`未知命令：${command}`);
}

// 作为 CLI 运行时才执行；被测试 import 时只导出函数。
const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
    main().catch((error) => {
        console.error(`\n失败：${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
}
