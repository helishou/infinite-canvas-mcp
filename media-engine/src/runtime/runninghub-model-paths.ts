/**
 * 上传 RunningHub 前清理模型文件名的目录前缀。
 *
 * 本地 ComfyUI 习惯把模型放在子目录里（`Minimax\minimax_h3_...safetensors`），
 * 但云端工作台一般把模型平铺在根目录，带目录的写法在平台上选不中、跑不起来。
 * 这里只清洗「模型加载器节点上的模型文件名」，不动素材路径（LoadImage/LoadVideo 的上传名）。
 *
 * 两条路都要清：
 * - UI 格式（开发台上传）：改节点的 `widgets_values`；
 * - API 格式（内联提交 / 档案落库）：改 `inputs` 里对应的键。
 */
type Json = Record<string, any>;

const MODEL_EXT = /\.(safetensors|ckpt|pt|pth|bin|gguf|onnx)$/i;

/** 会放模型文件名的加载器节点。只清洗这些节点上的字符串 widget。 */
const LOADER_TYPES = new Set([
    "LoraLoader",
    "LoraLoaderModelOnly",
    "LoadLoRA",
    "Load LoRA",
    "UNETLoader",
    "UnetLoaderGGUF",
    "UnetLoaderGGUFAdvanced",
    "VAELoader",
    "CLIPLoader",
    "DualCLIPLoader",
    "TripleCLIPLoader",
    "CheckpointLoaderSimple",
    "CheckpointLoader",
    "unCLIPCheckpointLoader",
    "UpscaleModelLoader",
    "ControlNetLoader",
    "DiffControlNetLoader",
    "CLIPVisionLoader",
    "StyleModelLoader",
    "PhotoMakerLoader",
    "IPAdapterModelLoader",
    "InstantIDModelLoader",
]);

/** API 格式里明确是模型文件名的输入键（比节点类型更准，两条规则取并集）。 */
const MODEL_INPUT_KEYS = new Set([
    "lora_name",
    "unet_name",
    "vae_name",
    "clip_name",
    "clip_name1",
    "clip_name2",
    "clip_name3",
    "ckpt_name",
    "control_net_name",
    "model_name",
    "upscale_model",
    "style_model_name",
    "clip_vision_name",
    "ipadapter_file",
]);

function stripFolder(value: string): string {
    const trimmed = value.trim();
    if (!MODEL_EXT.test(trimmed)) return trimmed;
    const base = trimmed.split(/[\\/]+/).filter(Boolean).pop();
    return base && base !== trimmed ? base : trimmed;
}

/** 单个值清洗：只处理「看起来是模型文件名」的字符串，其余原样返回。 */
export function stripModelFolder(value: unknown): unknown {
    return typeof value === "string" ? stripFolder(value) : value;
}

/** UI 格式：按加载器类型清洗 widgets_values / widgets_values_named。 */
export function stripModelFoldersFromUiWorkflow(workflow: Json): Json {
    const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : null;
    if (!nodes) return workflow;
    let changed = false;
    const nextNodes = nodes.map((node: Json) => {
        if (!node || typeof node !== "object" || !LOADER_TYPES.has(String(node.type || ""))) return node;
        const patch: Json = {};
        if (Array.isArray(node.widgets_values)) {
            const values = node.widgets_values.map((value: unknown) => stripModelFolder(value));
            if (values.some((value: unknown, index: number) => value !== node.widgets_values[index])) patch.widgets_values = values;
        }
        const named = node.widgets_values_named;
        if (named && typeof named === "object" && !Array.isArray(named)) {
            const values: Json = {};
            let namedChanged = false;
            for (const [key, value] of Object.entries(named)) {
                const stripped = stripModelFolder(value);
                values[key] = stripped;
                if (stripped !== value) namedChanged = true;
            }
            if (namedChanged) patch.widgets_values_named = values;
        }
        if (!Object.keys(patch).length) return node;
        changed = true;
        return { ...node, ...patch };
    });
    return changed ? { ...workflow, nodes: nextNodes } : workflow;
}

/** API 格式：按加载器类型或键名清洗 inputs 里的模型文件名。 */
export function stripModelFoldersFromApiGraph(graph: Json): Json {
    if (!graph || typeof graph !== "object") return graph;
    let changed = false;
    const next: Json = {};
    for (const [nodeId, raw] of Object.entries(graph)) {
        const node = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Json : null;
        if (!node || !node.inputs || typeof node.inputs !== "object") {
            next[nodeId] = raw;
            continue;
        }
        const loader = LOADER_TYPES.has(String(node.class_type || ""));
        const inputs: Json = {};
        let nodeChanged = false;
        for (const [key, value] of Object.entries(node.inputs as Json)) {
            const stripped = typeof value === "string" && (loader || MODEL_INPUT_KEYS.has(key)) ? stripFolder(value) : value;
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
