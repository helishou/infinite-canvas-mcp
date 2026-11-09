/**
 * H3 节点通用潜空间续写：纯图变换，无副作用，存储的原工作流从不改动。
 *
 * 统一机制只有一套：上段采样器输出的 AV latent（SaveLatent 无损落盘）→ 下段 LoadLatent
 * → MiniMaxH3MotionContext 把尾帧/尾音频钉成不重绘的条件 → 解码后 Trim 裁掉钉住头。
 * 两类落点共用这一机制：
 * - NanFeng V15 主节点已内置整套节点：只填「启用潜空间续写 / 潜空间续写任务」字段；
 * - 裸 H3 AV 图：从最终视频输出回溯探测采样器/解码/条件钩子，动态追加 lc_* 节点接线。
 *   循环流（easy forLoopStart）在续写运行时强制单段，循环体退化为普通裸图套同一模板。
 *
 * 身份与目录复用 comfyui/continuation-seed 的命名空间：每个运行把输出存在自己目录的
 * clip_00001 号槽；下段 LoadLatent 直接指向来源文件，无需复制（V15 内置路径除外，
 * 它按描述符目录取固定槽，由调用方先 stageH3ContinuationSeed 复制种子）。
 */

type ApiNode = { class_type?: string; inputs?: Record<string, unknown> };
type Link = [string, number];

export const V15_GENERATOR_CLASS = "NanFengH3MultiReferenceGeneratorV15";
export const V15_CONTINUATION_NODE_ID = "nf_v15";

function nodeOf(value: unknown): ApiNode | null {
    return value && typeof value === "object" && !Array.isArray(value) ? value as ApiNode : null;
}

function linkOf(value: unknown): Link | null {
    return Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "number" ? [value[0], value[1]] : null;
}

function sameLink(value: unknown, target: Link | null): boolean {
    const link = linkOf(value);
    return Boolean(link && target && link[0] === target[0] && link[1] === target[1]);
}

function inputsOf(node: ApiNode): Record<string, unknown> {
    return node.inputs && typeof node.inputs === "object" ? node.inputs : {};
}

function entriesOf(workflow: Record<string, unknown>): Array<[string, ApiNode]> {
    return Object.entries(workflow).filter(([, value]) => nodeOf(value)?.class_type) as Array<[string, ApiNode]>;
}

export type H3AvHooks = {
    samplerId: string;
    /** 喂最终画面/音频解码的采样器输出 latent（SaveLatent 取同一条链接）。 */
    latentLink: Link;
    /** 采样器 latent_image 输入的空目标 AV latent（MotionContext 需要它确定画布）。 */
    targetLatentLink: Link;
    /** 喂 BasicGuider 的条件链接（MotionContext 插入点）。 */
    conditioningLink: Link;
    conditioningConsumer: { id: string; input: string };
    videoVaeLink: Link;
    /** 音频解码器的 VAE（像素回退把上一段尾音频编码成条件时需要）。 */
    audioVaeLink: Link;
    decodeImageId: string;
    decodeAudioId: string;
    videoNodeId: string;
    videoImagesInput: string;
    videoAudioInput: string;
    loopId?: string;
};

const VIDEO_ASSEMBLY: Record<string, { images: string; audio: string }> = {
    CreateVideo: { images: "images", audio: "audio" },
    VHS_VideoCombine: { images: "images", audio: "audio" },
};

/**
 * 从最终视频装配节点（CreateVideo / VHS_VideoCombine）的画面与音频输入向上回溯，
 * 定位共享同一条 AV latent 的 VAEDecode + VAEDecodeAudio、其采样器、目标 latent、
 * 条件插入点与视频 VAE。API 图里 SetNode/GetNode/Reroute 已在转换期解析为直连，
 * 这里只需穿过 ifElse/VRAM_Debug 等透传/分支节点。探测不到返回 null（非 H3 AV 图）。
 */
export function detectH3AvHooks(workflow: Record<string, unknown>): H3AvHooks | null {
    const entries = entriesOf(workflow);
    const byId = new Map(entries);
    const findAncestor = (start: unknown, className: string): { id: string; node: ApiNode } | null => {
        const link = linkOf(start);
        if (!link) return null;
        const queue = [link[0]];
        const visited = new Set<string>();
        while (queue.length) {
            const id = queue.shift()!;
            if (visited.has(id)) continue;
            visited.add(id);
            if (visited.size > 512) return null;
            const node = byId.get(id);
            if (!node) continue;
            if (node.class_type === className) return { id, node };
            for (const value of Object.values(inputsOf(node))) {
                const next = linkOf(value);
                if (next && !visited.has(next[0])) queue.push(next[0]);
            }
        }
        return null;
    };
    for (const [videoId, videoNode] of entries) {
        const names = VIDEO_ASSEMBLY[String(videoNode.class_type)];
        if (!names) continue;
        const inputs = inputsOf(videoNode);
        const decodeImage = findAncestor(inputs[names.images], "VAEDecode");
        const decodeAudio = findAncestor(inputs[names.audio], "VAEDecodeAudio");
        if (!decodeImage || !decodeAudio) continue;
        const latentLink = linkOf(inputsOf(decodeImage.node).samples);
        if (!latentLink || !sameLink(inputsOf(decodeAudio.node).samples, latentLink)) continue;
        const sampler = byId.get(latentLink[0]);
        if (sampler?.class_type !== "SamplerCustomAdvanced") continue;
        const targetLatentLink = linkOf(inputsOf(sampler).latent_image);
        const guiderLink = linkOf(inputsOf(sampler).guider);
        const guider = guiderLink ? byId.get(guiderLink[0]) : null;
        if (guider?.class_type !== "BasicGuider") continue;
        const conditioningLink = linkOf(inputsOf(guider).conditioning);
        const videoVaeLink = linkOf(inputsOf(decodeImage.node).vae);
        const audioVaeLink = linkOf(inputsOf(decodeAudio.node).vae);
        if (!targetLatentLink || !conditioningLink || !videoVaeLink || !audioVaeLink || !guiderLink) continue;
        const loops = entries.filter(([, node]) => node.class_type === "easy forLoopStart" || node.class_type === "forLoopStart");
        return {
            samplerId: latentLink[0], latentLink, targetLatentLink, conditioningLink,
            conditioningConsumer: { id: guiderLink[0], input: "conditioning" },
            videoVaeLink, audioVaeLink, decodeImageId: decodeImage.id, decodeAudioId: decodeAudio.id,
            videoNodeId: videoId, videoImagesInput: names.images, videoAudioInput: names.audio,
            ...(loops.length === 1 ? { loopId: loops[0][0] } : {}),
        };
    }
    return null;
}

export type LatentContinuationSummary = {
    family: "h3-av";
    folder: string;
    saved: boolean;
    loadedFrom?: string;
    /** 缺潜变量种子时回退：加载上一段成片，尾帧/尾音频经 VAE 编码钉成条件（有损但可续写）。 */
    loadedVideoFrom?: string;
    addedNodes: number;
    conditioningRewires: number;
    outputRewires: number;
    loopForced?: { startNode: string; endNode: string };
};

export type LatentContinuationOptions = {
    /** 本次运行自己的潜变量目录（相对 ComfyUI output/，正斜杠）。仅导出侧需要。 */
    folder?: string;
    /** 导出侧：挂 SaveLatent 侧支，把输出存进自己目录的 clip_00001 号槽。 */
    save: boolean;
    /** 导入侧：直接指向来源运行的 latent 文件；存在时本次按续段运行。 */
    load?: { file: string; contextLength: string; audioContextLength: number };
    /** 导入侧回退：没有潜变量种子时加载上一段成片，MotionContext 走像素/音频编码路径。 */
    loadVideo?: { file: string; contextLength: string; audioContextLength: number };
};

/** 循环流续写时强制单段：起始/结束段号 = 1，循环体退化为裸图。与 video-continuation 同构的定位法。 */
function forceSingleSegment(result: Record<string, unknown>, entries: Array<[string, ApiNode]>, loopId: string): { startNode: string; endNode: string } {
    const indexLink: Link = [loopId, 1];
    const adder = entries.find(([, node]) => node.class_type === "MathExpression|pysssss" && sameLink(inputsOf(node).a, indexLink));
    const startLink = adder ? linkOf(inputsOf(adder[1]).b) : null;
    const startNode = startLink ? nodeOf(result[startLink[0]]) : null;
    if (!startLink || startNode?.class_type !== "PrimitiveInt") throw new Error("潜空间续写找不到起始段号节点（当前循环工作流不支持续写）");
    const totalMath = entries.find(([, node]) => node.class_type === "ComfyMathExpression" && sameLink(inputsOf(node)["values.b"], startLink));
    const endLink = totalMath ? linkOf(inputsOf(totalMath[1])["values.a"]) : null;
    const endNode = endLink ? nodeOf(result[endLink[0]]) : null;
    if (!endLink || endNode?.class_type !== "PrimitiveInt") throw new Error("潜空间续写找不到结束段号节点（当前循环工作流不支持续写）");
    inputsOf(startNode).value = 1;
    inputsOf(endNode).value = 1;
    return { startNode: startLink[0], endNode: endLink[0] };
}

/**
 * 在克隆图上接通用潜空间续写。save 为纯追加侧支（零改写）；load 追加
 * LoadLatent/MotionContext/Trim 并改写三条链接：条件插入 MotionContext、
 * 最终视频装配的画面/音频改接 Trim 输出（绕过循环流的像素混合坡道——
 * 潜空间钉帧不需要它）。循环流仅在 load 时强制单段。
 */
export function applyLatentContinuation(
    workflow: Record<string, unknown>,
    hooks: H3AvHooks,
    options: LatentContinuationOptions,
): { workflow: Record<string, unknown>; summary: LatentContinuationSummary } {
    if (options.save && (!options.folder || !options.folder.startsWith("nanfeng_v15_context/"))) throw new Error("潜空间续写目录必须位于隔离的生成命名空间");
    if (!options.save && !options.load && !options.loadVideo) throw new Error("潜空间续写至少需要导出或导入一侧");
    const loadSide = options.load ?? options.loadVideo;
    if (loadSide && !["5", "22", "39", "56"].includes(loadSide.contextLength)) throw new Error("潜空间续写 context_length 必须为 5/22/39/56");
    const result: Record<string, unknown> = JSON.parse(JSON.stringify(workflow));
    const entries = entriesOf(result);
    const added: string[] = [];
    const claim = (id: string) => { if (result[id]) throw new Error(`潜空间续写节点 ID 冲突：${id}`); added.push(id); };

    let conditioningRewires = 0;
    let outputRewires = 0;
    let loopForced: { startNode: string; endNode: string } | undefined;
    if (options.save) {
        claim("lc_save");
        result.lc_save = { class_type: "MiniMaxH3MotionContextSaveLatent", inputs: { latent: hooks.latentLink, filename_prefix: `${options.folder}/clip`, clip_index: 1 } };
    }
    if (loadSide) {
        claim("lc_context"); claim("lc_trim");
        const contextInputs: Record<string, unknown> = {
            conditioning: hooks.conditioningLink, vae: hooks.videoVaeLink, latent: hooks.targetLatentLink,
            context_length: loadSide.contextLength, audio_context_length: loadSide.audioContextLength,
        };
        if (options.load) {
            claim("lc_load");
            result.lc_load = { class_type: "MiniMaxH3MotionContextLoadLatent", inputs: { latent_path: options.load.file, clip_index: 1 } };
            contextInputs.context_latent = ["lc_load", 0];
        } else {
            // 像素回退：加载上一段成片，MotionContext 自动取尾帧重编码、尾音频经 audio_vae 编码。
            claim("lc_video");
            result.lc_video = { class_type: "VHS_LoadVideo", inputs: { video: options.loadVideo!.file, force_rate: 24, custom_width: 0, custom_height: 0, frame_load_cap: 0, skip_first_frames: 0, select_every_nth: 1, format: "AnimateDiff" } };
            contextInputs.context_frames = ["lc_video", 0];
            contextInputs.context_audio = ["lc_video", 2];
            contextInputs.audio_vae = hooks.audioVaeLink;
        }
        result.lc_context = { class_type: "MiniMaxH3MotionContext", inputs: contextInputs };
        const consumer = nodeOf(result[hooks.conditioningConsumer.id]);
        if (!consumer) throw new Error("潜空间续写找不到条件消费节点");
        inputsOf(consumer)[hooks.conditioningConsumer.input] = ["lc_context", 0];
        conditioningRewires++;
        result.lc_trim = {
            class_type: "MiniMaxH3MotionContextTrim",
            inputs: { images: [hooks.decodeImageId, 0], audio: [hooks.decodeAudioId, 0], trim_frames: ["lc_context", 1], fps: 24, match_tail: true },
        };
        const videoNode = nodeOf(result[hooks.videoNodeId]);
        if (!videoNode) throw new Error("潜空间续写找不到最终视频装配节点");
        inputsOf(videoNode)[hooks.videoImagesInput] = ["lc_trim", 0];
        inputsOf(videoNode)[hooks.videoAudioInput] = ["lc_trim", 1];
        outputRewires += 2;
        if (hooks.loopId) loopForced = forceSingleSegment(result, entries, hooks.loopId);
    }
    return {
        workflow: result,
        summary: {
            family: "h3-av", folder: options.folder ?? "", saved: options.save,
            ...(options.load ? { loadedFrom: options.load.file } : {}),
            ...(options.loadVideo ? { loadedVideoFrom: options.loadVideo.file } : {}),
            addedNodes: added.length, conditioningRewires, outputRewires,
            ...(loopForced ? { loopForced } : {}),
        },
    };
}

export type V15LatentContinuationSummary = {
    family: "v15";
    folder: string;
    generatorNode: string;
    renamedFrom?: string;
    index: number;
};

export function findV15Generator(workflow: Record<string, unknown>): { id: string; node: ApiNode } | null {
    const matches = entriesOf(workflow).filter(([, node]) => node.class_type === V15_GENERATOR_CLASS);
    return matches.length === 1 ? { id: matches[0][0], node: matches[0][1] } : null;
}

/**
 * V15 主节点内置了 LoadLatent/MotionContext/Trim/SaveLatent 整套机制：
 * 只填开关与任务描述符，零追加节点。描述符 node 必须等于主节点在提交图里的
 * 实际 ID（南风用 unique_id 校验）；不是 nf_v15 时在克隆图上改号并同步全部引用，
 * 让目录算法与后台命名空间保持一致。index=1 仅导出；index=2 载入已复制到
 * 本次目录 1 号槽的种子（调用方负责 stageH3ContinuationSeed）。
 */
export function applyV15LatentContinuation(
    workflow: Record<string, unknown>,
    options: { descriptor: string; folder: string; index: number },
): { workflow: Record<string, unknown>; summary: V15LatentContinuationSummary } {
    const result: Record<string, unknown> = JSON.parse(JSON.stringify(workflow));
    const found = findV15Generator(result);
    if (!found) throw new Error("潜空间续写需要工作流恰好有一个 NanFeng V15 主节点");
    let nodeId = found.id;
    let renamedFrom: string | undefined;
    if (nodeId !== V15_CONTINUATION_NODE_ID) {
        if (result[V15_CONTINUATION_NODE_ID]) throw new Error(`潜空间续写节点 ID 冲突：${V15_CONTINUATION_NODE_ID}`);
        renamedFrom = nodeId;
        result[V15_CONTINUATION_NODE_ID] = result[nodeId];
        delete result[nodeId];
        for (const [, node] of entriesOf(result)) {
            const inputs = inputsOf(node);
            for (const [name, value] of Object.entries(inputs)) {
                const link = linkOf(value);
                if (link && link[0] === renamedFrom) inputs[name] = [V15_CONTINUATION_NODE_ID, link[1]];
            }
        }
        nodeId = V15_CONTINUATION_NODE_ID;
    }
    const inputs = inputsOf(nodeOf(result[nodeId])!);
    inputs["启用潜空间续写"] = true;
    inputs["潜空间续写任务"] = options.descriptor;
    return {
        workflow: result,
        summary: { family: "v15", folder: options.folder, generatorNode: nodeId, ...(renamedFrom ? { renamedFrom } : {}), index: options.index },
    };
}