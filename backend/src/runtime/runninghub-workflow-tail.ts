/**
 * 上传 RunningHub 前的收尾处理：在输出节点后面自动接上两个节点
 *
 *   <输出节点> ──▶ Play Sound KJ(any_input) ──any_output──▶ Save Image To Local(images)
 *
 * 图像与视频输出都是这一条链：`any_input/any_output` 是万能类型（`*`），视频输出的
 * VIDEO / VHS_FILENAMES 也能接，用户明确要求 Save Image To Local 挂在 Play Sound 后面。
 *
 * 另外 `file_path` 不能留空：mixlab 的实现会走 `os.makedirs("")` 抛 FileNotFoundError，所以默认给 "output"。
 *
 * 两种格式各一条入口：
 *  - `appendRunningHubOutputTail()`：UI 格式（nodes/links），接在输出节点的输出槽上；
 *  - `appendRunningHubApiTail()`：API 格式（class_type/inputs），没有 links 也没有输出槽信息，
 *    改成接输出节点的**数据来源**（`SaveImage.images` / `SaveVideo.video` 指向的那个节点），
 *    效果一样：Play Sound 先拿到产出，再把图交给 Save Image To Local。
 *
 * 幂等：图里已经有这两个节点时原样返回，不重复插。
 */
type Json = Record<string, any>;

/** 图像输出（sink）节点：有 IMAGE 输出，可以直接串成一条链。 */
const IMAGE_SINK_TYPES = new Set([
    "SaveImage",
    "PreviewImage",
    "SaveImageWebsocket",
    "SaveImageAndMetadata",
    "Image Save",
    "Save Image",
]);

/** 视频输出（sink）节点：产出 VIDEO / VHS_FILENAMES，SaveImageToLocal 只能挂到它的帧来源上。 */
const VIDEO_SINK_TYPES = new Set([
    "SaveVideo",
    "VHS_VideoCombine",
    "SaveWEBM",
    "SaveAnimatedWEBP",
    "SaveAnimatedPNG",
]);

export const TAIL_PLAY_SOUND = "PlaySoundKJ";
export const TAIL_SAVE_LOCAL = "SaveImageToLocal";

export type TailOptions = {
    /** Play Sound KJ 的 audio_path（不接 audio 时用它播文件）。 */
    audioPath?: string;
    /** always / on_empty_queue / on_change。 */
    mode?: string;
    /** 0~1。 */
    volume?: number;
    /** 秒；0 = 整段。 */
    duration?: number;
    /** Save Image To Local 的目标路径；默认 `output`（空串会让 mixlab 的 makedirs 抛错）。 */
    filePath?: string;
};

export type TailResult = {
    workflow: Json;
    added: boolean;
    reason?: "not-ui" | "already" | "no-sink";
    /** 接在哪个输出上：图像直接串链，视频拆两条。 */
    kind?: "image" | "video";
    /** 视频链是否也接上了 Save Image To Local（找不到帧来源时为 false）。 */
    attachedSave?: boolean;
    /** 新插入的两个节点 id（Play Sound KJ、Save Image To Local）。 */
    nodeIds?: [number, number];
};

/** API 格式（class_type/inputs）的注入结果；没有 links 表，只能按输入来源接线。 */
export type ApiTailResult = {
    graph: Json;
    added: boolean;
    reason?: "already" | "no-sink";
    kind?: "image" | "video";
    nodeIds?: [string, string];
};

/**
 * 上传时给 Save Image To Local 的默认落盘目录。
 * 不能用空串：mixlab 的实现里 `file_path == ""` 会走到 `os.makedirs("")`，直接抛 FileNotFoundError，
 * 整个任务会在收尾节点崩掉。相对路径 "output" 落在 ComfyUI 的输出目录（不存在就创建），是最稳的默认值。
 */
const DEFAULT_SAVE_DIR = "output";

const DEFAULTS: Required<TailOptions> = { audioPath: "", mode: "always", volume: 0.2, duration: 5, filePath: DEFAULT_SAVE_DIR };

function obj(value: unknown): Json {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function arr(value: unknown): any[] {
    return Array.isArray(value) ? value : [];
}

function num(value: unknown, fallback = 0): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback = ""): string {
    return typeof value === "string" ? value : fallback;
}

function linkIdOf(link: unknown): number {
    return Array.isArray(link) ? num(link[0], Number.NaN) : num(obj(link).id, Number.NaN);
}

function maxOf(values: number[], fallback: number): number {
    const usable = values.filter((value) => Number.isFinite(value));
    return usable.length ? Math.max(...usable) : fallback;
}

type Sink = {
    node: Json;
    /** 用来接 Play Sound 的输出槽。 */
    slot: number;
    type: string;
    kind: "image" | "video";
    order: number;
    index: number;
};

function outputSlots(node: Json): Json[] {
    return arr(node.outputs).map(obj);
}

function isActive(node: Json): boolean {
    return node.mode !== 2 && node.mode !== 4; // bypass / never 的节点不算
}

/** 找执行顺序最后的一个 sink；同 order 时取数组里靠后的。 */
function lastOf(candidates: Sink[]): Sink | undefined {
    candidates.sort((left, right) => right.order - left.order || right.index - left.index);
    return candidates[0];
}

function collectSinks(nodes: Json[]): { image: Sink[]; video: Sink[] } {
    const image: Sink[] = [];
    const video: Sink[] = [];
    nodes.forEach((node, index) => {
        if (!isActive(node)) return;
        const type = str(node.type);
        const isImageType = IMAGE_SINK_TYPES.has(type);
        const isVideoType = VIDEO_SINK_TYPES.has(type);
        if (!isImageType && !isVideoType) return;
        const slots = outputSlots(node);
        const imageSlot = slots.findIndex((slot) => str(slot.type) === "IMAGE");
        const order = num(node.order, index);
        if (imageSlot >= 0) {
            image.push({ node, slot: imageSlot, type: "IMAGE", kind: "image", order, index });
            return;
        }
        // 没有 IMAGE 输出（SaveVideo 的 VIDEO、VHS_VideoCombine 的 VHS_FILENAMES）：视频链走这条路
        if (isVideoType && slots.length) {
            video.push({ node, slot: 0, type: str(slots[0].type, "VIDEO"), kind: "video", order, index });
        }
    });
    return { image, video };
}

/**
 * 给 UI 格式工作流补上云端收尾节点。
 * 返回新对象；原对象不被修改。
 */
export function appendRunningHubOutputTail(workflow: Json, options: TailOptions = {}): TailResult {
    const rawNodes = arr(workflow.nodes);
    if (!Array.isArray(workflow.nodes) || !Array.isArray(workflow.links) || !rawNodes.length) {
        return { workflow, added: false, reason: "not-ui" };
    }

    const nodes = rawNodes.map(obj);
    const types = new Set(nodes.map((node) => str(node.type)));
    // 用户自己接过了就别动，避免出现两套尾链或半截状态。
    if (types.has(TAIL_PLAY_SOUND) || types.has(TAIL_SAVE_LOCAL)) {
        return { workflow, added: false, reason: "already" };
    }

    const sinks = collectSinks(nodes);
    // 视频优先：明确要接视频输出时，图里同时有 SaveImage 也接视频那条。
    const sink = lastOf(sinks.video) || lastOf(sinks.image);
    if (!sink) return { workflow, added: false, reason: "no-sink" };

    const settings = { ...DEFAULTS, ...options };
    const links = arr(workflow.links).map((link) => (Array.isArray(link) ? [...link] : link));

    const nextNodeId = maxOf([num(workflow.last_node_id), ...nodes.map((node) => num(node.id))], nodes.length);
    const playId = nextNodeId + 1;
    const saveId = nextNodeId + 2;
    let nextLinkId = maxOf([num(workflow.last_link_id), ...links.map(linkIdOf)], links.length);

    const sinkNode = sink.node;
    const sinkId = num(sinkNode.id);
    const sinkOutputs = outputSlots(sinkNode);
    const sinkOutput = sinkOutputs[sink.slot] || {};
    const sinkOutputType = str(sinkOutput.type, sink.kind === "video" ? "VIDEO" : "IMAGE");

    // 输出节点 → Play Sound：视频接 VIDEO/Filenames，图像接 IMAGE。
    const linkIn = ++nextLinkId;
    sinkOutputs[sink.slot] = { ...sinkOutput, links: [...arr(sinkOutput.links), linkIn] };
    sinkNode.outputs = sinkOutputs;

    // Play Sound → Save Image To Local：两种输出都是这一条，串完即止（不写回来源节点）。
    const linkSave = ++nextLinkId;

    const pos = arr(sinkNode.pos);
    const size = arr(sinkNode.size);
    const baseX = num(pos[0]) + num(size[0], 320) + 80;
    const baseY = num(pos[1]);
    const lastOrder = maxOf(nodes.map((node) => num(node.order, Number.NaN)), nodes.length - 1);

    const playNode: Json = {
        id: playId,
        type: TAIL_PLAY_SOUND,
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
        // any_output 是万能类型，后面直接挂 Save Image To Local。
        outputs: [{ name: "any_output", type: "*", links: [linkSave] }],
        properties: { "Node name for S&R": TAIL_PLAY_SOUND, cnr_id: "comfyui-kjnodes" },
        widgets_values: [settings.audioPath, settings.mode, settings.volume, settings.duration],
        widgets_values_named: { audio_path: settings.audioPath, mode: settings.mode, volume: settings.volume, duration: settings.duration },
    };

    const saveNode: Json = {
        id: saveId,
        type: TAIL_SAVE_LOCAL,
        // 排成一行：Play Sound 在前，Save Image To Local 紧接在它右边。
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
        properties: { "Node name for S&R": TAIL_SAVE_LOCAL, cnr_id: "comfyui-mixlab-nodes" },
        widgets_values: [settings.filePath],
        widgets_values_named: { file_path: settings.filePath },
    };

    // [link_id, origin_id, origin_slot, target_id, target_slot, type]
    links.push([linkIn, sinkId, sink.slot, playId, 0, sinkOutputType]);
    // 第二段从 Play Sound 的 any_output（*）出来，万能类型，视频输出也走这条。
    links.push([linkSave, playId, 0, saveId, 0, "*"]);

    return {
        workflow: {
            ...workflow,
            nodes: [...nodes, playNode, saveNode],
            links,
            last_node_id: saveId,
            last_link_id: linkSave,
        },
        added: true,
        kind: sink.kind,
        attachedSave: true,
        nodeIds: [playId, saveId],
    };
}

/** API 格式里输出节点的数据输入名：取第一个是连线的那个当「上游产出」。 */
const API_SINK_INPUT_KEYS = ["images", "video", "frames", "pixels", "samples", "source"] as const;

/** `[nodeId, slot]` 形式的连线；API 格式里连线就长这样。 */
function asApiLink(value: unknown): [string, number] | null {
    return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number"
        ? [value[0], value[1]]
        : null;
}

/** API 图里最大数字 id，用于给新节点编号；遇到非数字 key 就跳过。 */
function maxApiNodeId(graph: Json): number {
    let max = 0;
    for (const key of Object.keys(graph)) {
        const value = Number(key);
        if (Number.isFinite(value) && value > max) max = value;
    }
    return max;
}

function nextFreeApiId(graph: Json, start: number): number {
    let id = start;
    while (Object.hasOwn(graph, String(id))) id += 1;
    return id;
}

/**
 * 每个节点到根的**最长**路径长度，等价于 UI 格式里的 `order`。
 * API 图没有 order，一张图常有好几个输出节点（多个 PreviewImage + 一个 SaveImage），
 * 只有拓扑最深的那条才是「最后一个节点」。带环保护。
 */
function apiDepths(graph: Json): Map<string, number> {
    const depths = new Map<string, number>();
    const visiting = new Set<string>();
    const depthOf = (id: string): number => {
        const cached = depths.get(id);
        if (cached !== undefined) return cached;
        if (visiting.has(id)) return 0;
        visiting.add(id);
        let best = 0;
        for (const value of Object.values(obj(obj(graph[id]).inputs))) {
            const link = asApiLink(value);
            if (!link || !Object.hasOwn(graph, link[0])) continue;
            best = Math.max(best, depthOf(link[0]) + 1);
        }
        visiting.delete(id);
        depths.set(id, best);
        return best;
    };
    for (const id of Object.keys(graph)) depthOf(id);
    return depths;
}

/** 同深度时的次序：id 数值大的更靠后，非数字 id 按字符串比。 */
function laterSink(a: { id: string }, b: { id: string }): number {
    const left = Number(a.id);
    const right = Number(b.id);
    if (Number.isFinite(left) && Number.isFinite(right)) return right - left;
    return b.id.localeCompare(a.id);
}

/**
 * 选收尾挂哪个输出节点：有视频输出就接视频（和 UI 版一致，用户明确要求），
 * 然后在候选里取**拓扑最深**的那条；只有深度并列时才比 id 大小。
 */
function pickLastSink<T extends { id: string; kind: "image" | "video" }>(candidates: T[], depths: Map<string, number>): T | undefined {
    if (!candidates.length) return undefined;
    const videos = candidates.filter((item) => item.kind === "video");
    const pool = videos.length ? videos : candidates;
    const deepest = Math.max(...pool.map((item) => depths.get(item.id) ?? 0));
    const top = pool.filter((item) => (depths.get(item.id) ?? 0) === deepest);
    return [...top].sort(laterSink)[0];
}

/**
 * 给 API 格式工作流补上云端收尾节点。
 *
 * API 图不保存输出槽信息，但输出节点本身是有输出的 —— ComfyUI 原生 `SaveImage` 就是
 * `RETURN_TYPES = ("IMAGE",) / RETURN_NAMES = ("images",)`，所以照样能接在它后面：
 *
 *   <输出节点> ──▶ Play Sound KJ ──▶ Save Image To Local
 *
 * 接头一律写 `[输出节点, 0]`（第一个输出槽），与 UI 版排布一致。
 * 返回新对象；原对象不被修改。
 */
export function appendRunningHubApiTail(graph: Json, options: TailOptions = {}): ApiTailResult {
    const source = obj(graph);
    const ids = Object.keys(source);
    if (!ids.length) return { graph: source, added: false, reason: "no-sink" };
    const types = new Set(ids.map((id) => str(obj(source[id]).class_type)));
    if (types.has(TAIL_PLAY_SOUND) || types.has(TAIL_SAVE_LOCAL)) return { graph: source, added: false, reason: "already" };

    // 视频优先，和 UI 版保持一致：图里同时有图像输出也接视频那条。
    const picked: { id: string; kind: "image" | "video" }[] = [];
    for (const id of ids) {
        const node = obj(source[id]);
        const type = str(node.class_type);
        const kind = VIDEO_SINK_TYPES.has(type) ? "video" : IMAGE_SINK_TYPES.has(type) ? "image" : "";
        if (!kind) continue;
        const inputs = obj(node.inputs);
        // 只认真的接了数据的输出节点：输入全是常量说明它不是这条链的末端。
        if (!API_SINK_INPUT_KEYS.some((name) => asApiLink(inputs[name]))) continue;
        picked.push({ id, kind });
    }
    const sink = pickLastSink(picked, apiDepths(source));
    if (!sink) return { graph: source, added: false, reason: "no-sink" };

    const settings = { ...DEFAULTS, ...options };
    const playId = String(nextFreeApiId(source, maxApiNodeId(source) + 1));
    const saveId = String(nextFreeApiId(source, Number(playId) + 1));

    const playNode: Json = {
        class_type: TAIL_PLAY_SOUND,
        inputs: {
            // 接输出节点自己的第一个输出槽：SaveImage 的 images、SaveVideo 的 video、VHS 的 VHS_FILENAMES。
            any_input: [sink.id, 0],
            audio_path: settings.audioPath,
            mode: settings.mode,
            volume: settings.volume,
            duration: settings.duration,
        },
        _meta: { title: TAIL_PLAY_SOUND },
    };
    const saveNode: Json = {
        class_type: TAIL_SAVE_LOCAL,
        inputs: { images: [playId, 0], file_path: settings.filePath },
        _meta: { title: TAIL_SAVE_LOCAL },
    };

    return {
        graph: { ...source, [playId]: playNode, [saveId]: saveNode },
        added: true,
        kind: sink.kind,
        nodeIds: [playId, saveId],
    };
}

