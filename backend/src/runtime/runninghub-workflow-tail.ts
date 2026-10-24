/**
 * 上传 RunningHub 前的收尾处理：在输出节点后面自动接上两个节点
 *
 * 图像输出（SaveImage / PreviewImage …）：
 *   SaveImage.images ──▶ Play Sound KJ(any_input) ──any_output──▶ Save Image To Local(images)
 *
 * 视频输出（SaveVideo / VHS_VideoCombine …）：
 *   SaveVideo.video ──▶ Play Sound KJ(any_input)          ← 收尾/落地产出，保证在视频编码之后执行
 *   视频帧来源.IMAGE ──▶ Save Image To Local(images)       ← 只吃 IMAGE，所以接同一条链上的帧来源
 *
 * 为什么视频不能像图像那样串成一条：
 * `SaveImageToLocal` 的 images 必须是 IMAGE（源码里 `images: ("IMAGE",)`，实现直接取 `images[0].shape`）；
 * 把 VIDEO / VHS_FILENAMES 经 any_output 灌进去会在运行时报错。所以视频链拆成两条——
 * Play Sound 接视频输出（任何类型都行），Save Image To Local 接视频帧来源（通常是 VAEDecode）。
 *
 * 另外 `file_path` 不能留空：mixlab 的实现会走 `os.makedirs("")` 抛 FileNotFoundError，所以默认给 "output"。
 *
 * 只处理 UI 格式（nodes/links）；API 格式由 OpenAPI 内联提交，不经这条路径。
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
    reason?: "not-ui" | "already" | "no-sink" | "video-no-image";
    /** 接在哪个输出上：图像直接串链，视频拆两条。 */
    kind?: "image" | "video";
    /** 视频链是否也接上了 Save Image To Local（找不到帧来源时为 false）。 */
    attachedSave?: boolean;
    /** 新插入的两个节点 id（Play Sound KJ、Save Image To Local）。 */
    nodeIds?: [number, number];
};

/**
 * 上传时给 Save Image To Local 的默认落盘目录。
 * 不能用空串：mixlab 的实现里 `file_path == ""` 会走到 `os.makedirs("")`，直接抛 FileNotFoundError，
 * 整个任务会在收尾节点崩掉。相对路径 "output" 落在 ComfyUI 的输出目录（不存在就创建），是最稳的默认值。
 */
const DEFAULT_SAVE_DIR = "output";

const DEFAULTS: Required<TailOptions> = { audioPath: "", mode: "always", volume: 0.2, duration: 5, filePath: DEFAULT_SAVE_DIR };
/** 向上找帧来源的最大层数，避免在大合集工作流里翻遍全图。 */
const MAX_UPSTREAM_DEPTH = 8;

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
 * 从 sink 的输入出发向上找最近的 IMAGE 输出。
 * 视频节点自己不吃 IMAGE（SaveVideo 吃 VIDEO），所以得顺着依赖链往回找真正产帧的那个节点。
 */
function findImageSource(nodes: Json[], linksById: Map<number, any[]>, sink: Json): { nodeId: number; slot: number } | undefined {
    const byId = new Map<number, Json>();
    for (const node of nodes) byId.set(num(node.id), node);

    const inputLinks = arr(sink.inputs).map(obj).map((input) => num(input.link, Number.NaN)).filter((id) => Number.isFinite(id));
    let frontier: any[][] = inputLinks.map((id) => linksById.get(id)).filter(Boolean) as any[][];
    const seen = new Set<number>();

    for (let depth = 0; depth < MAX_UPSTREAM_DEPTH && frontier.length; depth++) {
        const next: any[][] = [];
        for (const row of frontier) {
            const rowId = num(row[0], Number.NaN);
            if (Number.isFinite(rowId)) {
                if (seen.has(rowId)) continue;
                seen.add(rowId);
            }
            const originId = num(row[1]);
            const originSlot = num(row[2]);
            const origin = byId.get(originId);
            if (!origin || !isActive(origin)) continue;
            const out = outputSlots(origin)[originSlot];
            if (out && str(out.type) === "IMAGE") return { nodeId: originId, slot: originSlot };
            for (const input of arr(origin.inputs).map(obj)) {
                const link = num(input.link, Number.NaN);
                if (!Number.isFinite(link)) continue;
                const upstream = linksById.get(link);
                if (upstream) next.push(upstream);
            }
        }
        frontier = next;
    }
    return undefined;
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
    const linksById = new Map<number, any[]>();
    for (const row of links) {
        if (Array.isArray(row)) linksById.set(num(row[0], Number.NaN), row);
    }

    const nextNodeId = maxOf([num(workflow.last_node_id), ...nodes.map((node) => num(node.id))], nodes.length);
    const playId = nextNodeId + 1;
    const saveId = nextNodeId + 2;
    let nextLinkId = maxOf([num(workflow.last_link_id), ...links.map(linkIdOf)], links.length);

    const sinkNode = sink.node;
    const sinkId = num(sinkNode.id);
    const sinkOutputs = outputSlots(sinkNode);
    const sinkOutput = sinkOutputs[sink.slot] || {};
    const sinkOutputType = str(sinkOutput.type, sink.kind === "video" ? "VIDEO" : "IMAGE");

    // Play Sound 挂在输出节点后面：视频接 VIDEO/Filenames，图像接 IMAGE。
    const linkIn = ++nextLinkId;
    sinkOutputs[sink.slot] = { ...sinkOutput, links: [...arr(sinkOutput.links), linkIn] };
    sinkNode.outputs = sinkOutputs;

    // Save Image To Local 只吃 IMAGE：图像用同一条链，视频去找帧来源。
    let saveSource: { nodeId: number; slot: number } | undefined;
    if (sink.kind === "image") {
        saveSource = { nodeId: playId, slot: 0 };
    } else {
        saveSource = findImageSource(nodes, linksById, sinkNode);
    }
    const linkSave = saveSource ? ++nextLinkId : Number.NaN;
    if (saveSource && saveSource.nodeId !== playId) {
        const source = nodes.find((node) => num(node.id) === saveSource!.nodeId);
        if (source) {
            const slots = outputSlots(source);
            slots[saveSource.slot] = { ...slots[saveSource.slot], links: [...arr(slots[saveSource.slot]?.links), linkSave] };
            source.outputs = slots;
        }
    }

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
        // 图像链：any_output 继续喂给 Save Image To Local；视频链就到它为止。
        outputs: [{ name: "any_output", type: "*", links: sink.kind === "image" ? [linkSave] : [] }],
        properties: { "Node name for S&R": TAIL_PLAY_SOUND, cnr_id: "comfyui-kjnodes" },
        widgets_values: [settings.audioPath, settings.mode, settings.volume, settings.duration],
        widgets_values_named: { audio_path: settings.audioPath, mode: settings.mode, volume: settings.volume, duration: settings.duration },
    };

    const saveNode: Json = {
        id: saveId,
        type: TAIL_SAVE_LOCAL,
        pos: [baseX + (sink.kind === "video" ? 0 : 315 + 90), baseY + (sink.kind === "video" ? 170 : 0)],
        size: [330, 120],
        flags: {},
        order: lastOrder + 2,
        mode: 0,
        inputs: [
            { name: "images", type: "IMAGE", link: saveSource ? linkSave : null },
            { widget: { name: "file_path" }, name: "file_path", type: "STRING" },
        ],
        outputs: [],
        properties: { "Node name for S&R": TAIL_SAVE_LOCAL, cnr_id: "comfyui-mixlab-nodes" },
        widgets_values: [settings.filePath],
        widgets_values_named: { file_path: settings.filePath },
    };

    // [link_id, origin_id, origin_slot, target_id, target_slot, type]
    links.push([linkIn, sinkId, sink.slot, playId, 0, sinkOutputType]);
    // 图像链的起点是 Play Sound 的 any_output（*），视频链的起点是真实的 IMAGE 输出。
    if (saveSource) links.push([linkSave, saveSource.nodeId, saveSource.slot, saveId, 0, saveSource.nodeId === playId ? "*" : "IMAGE"]);

    return {
        workflow: {
            ...workflow,
            nodes: [...nodes, playNode, saveNode],
            links,
            last_node_id: saveId,
            last_link_id: saveSource ? linkSave : linkIn,
        },
        added: true,
        kind: sink.kind,
        attachedSave: Boolean(saveSource),
        reason: sink.kind === "video" && !saveSource ? "video-no-image" : undefined,
        nodeIds: [playId, saveId],
    };
}
