/**
 * 加载视频续写的兜底（非侵入，纯克隆图变换）：潜空间机制不适用时把上一段成片
 * 塞进工作流自带的视频参考输入，绝不改动存储的原工作流。
 *
 * 两类落点：
 * - NanFeng V15 主节点没有暴露采样器/解码钩子，无法外挂 MotionContext；填它自带的
 *   「视频1/2/3」参考槽（选第一个空槽），让本段以上一段成片为参考生成。
 * - 探测不到 H3 AV 结构、但图里有原生 MiniMaxH3ReferenceToVideo 的流（如 SelfLift
 *   融合采样器、人物替换）：把成片填进喂 ref_videos 的空视频加载器；没有空槽时
 *   替换喂 ref_video_audios 的源视频加载器（ motion transfer 的 motion 源即上一段）。
 *
 * 找不到任何可载入视频的位置时抛错由调用方让任务失败，绝不静默产出无续写视频。
 */

import { findV15Generator } from "./latent-continuation.js";

type ApiNode = { class_type?: string; inputs?: Record<string, unknown> };
type Link = [string, number];

export type VideoReferenceFallbackSummary = {
    mode: "v15-reference" | "reference-slot";
    prevVideoFile: string;
    /** 被填入/替换的节点：V15 主节点 ID 或视频加载器 ID。 */
    targetNode: string;
    /** V15 参考槽名（视频N）或 H3 参考槽序号（ref_video_N）。 */
    slot?: string;
    /** reference-slot：true 表示替换了已有源视频（而非填空槽）。 */
    replaced?: boolean;
    /** reference-slot：是否顺带把同序号参考视频音频接上加载器音频输出。 */
    audioWired?: boolean;
};

function nodeOf(value: unknown): ApiNode | null {
    return value && typeof value === "object" && !Array.isArray(value) ? value as ApiNode : null;
}
function linkOf(value: unknown): Link | null {
    return Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "number" ? [value[0], value[1]] : null;
}
function inputsOf(node: ApiNode): Record<string, unknown> {
    return node.inputs && typeof node.inputs === "object" ? node.inputs : {};
}
function entriesOf(workflow: Record<string, unknown>): Array<[string, ApiNode]> {
    return Object.entries(workflow).filter(([, value]) => nodeOf(value)?.class_type) as Array<[string, ApiNode]>;
}
function isEmptySelection(value: unknown): boolean {
    return value === undefined || value === null || (typeof value === "string" && (!value.trim() || value === "未选择" || value === "None"));
}

/** V15 主节点：填第一个空「视频N」参考槽。槽位全占满时抛错（不覆盖用户已有参考）。 */
export function applyV15VideoReference(
    workflow: Record<string, unknown>,
    videoFile: string,
): { workflow: Record<string, unknown>; summary: VideoReferenceFallbackSummary } {
    if (!videoFile || !videoFile.trim()) throw new Error("视频续写缺少上一段成片文件名");
    const result: Record<string, unknown> = JSON.parse(JSON.stringify(workflow));
    const found = findV15Generator(result);
    if (!found) throw new Error("视频续写需要工作流恰好有一个 NanFeng V15 主节点");
    const inputs = inputsOf(found.node);
    const slot = ["视频1", "视频2", "视频3"].find((name) => isEmptySelection(inputs[name]));
    if (!slot) throw new Error("V15 视频参考槽位已满，无法载入上一段成片续写");
    inputs[slot] = videoFile;
    return { workflow: result, summary: { mode: "v15-reference", prevVideoFile: videoFile, targetNode: found.id, slot } };
}

const VIDEO_LOADER_INPUT: Record<string, string> = { VHS_LoadVideo: "video", LoadVideo: "file" };

/**
 * 原生 H3 参考节点流：定位喂 ref_videos/ref_video_audios 的视频加载器并载入成片。
 * 优先填空槽（按槽序号取最小）；无空槽时替换源视频加载器（优先喂 ref_video_audios 的）。
 */
export function applyVideoReferenceFallback(
    workflow: Record<string, unknown>,
    videoFile: string,
): { workflow: Record<string, unknown>; summary: VideoReferenceFallbackSummary } {
    if (!videoFile || !videoFile.trim()) throw new Error("视频续写缺少上一段成片文件名");
    const result: Record<string, unknown> = JSON.parse(JSON.stringify(workflow));
    const entries = entriesOf(result);
    const byId = new Map(entries);
    const h3 = entries.find(([, node]) => node.class_type === "MiniMaxH3ReferenceToVideo");
    if (!h3) throw new Error("当前工作流没有可载入上一段视频的位置（无 H3 参考节点），无法续写");
    const [h3Id, h3Node] = h3;
    const h3Inputs = inputsOf(h3Node);

    // 从某个参考槽输入向上回溯，找到第一个文件输入为字符串的视频加载器。
    const traceLoader = (start: unknown): string | null => {
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
            const inputName = VIDEO_LOADER_INPUT[String(node.class_type)];
            if (inputName && typeof inputsOf(node)[inputName] === "string") return id;
            for (const value of Object.values(inputsOf(node))) {
                const next = linkOf(value);
                if (next && !visited.has(next[0])) queue.push(next[0]);
            }
        }
        return null;
    };

    type Candidate = { loaderId: string; slotIndex: number; isAudio: boolean; empty: boolean };
    const candidates = new Map<string, Candidate>();
    for (const [name, value] of Object.entries(h3Inputs)) {
        const match = /^ref_(videos|video_audios)\.ref_(?:video|video_audio)_(\d+)$/.exec(name);
        if (!match) continue;
        const loaderId = traceLoader(value);
        if (!loaderId) continue;
        const loader = byId.get(loaderId)!;
        const inputName = VIDEO_LOADER_INPUT[String(loader.class_type)];
        const slotIndex = Number(match[2]);
        const isAudio = match[1] === "video_audios";
        const existing = candidates.get(loaderId);
        // 同一加载器可能同时喂画面与音频槽：保留更低槽序，音频标记取或。
        if (!existing || slotIndex < existing.slotIndex) {
            candidates.set(loaderId, { loaderId, slotIndex, isAudio, empty: isEmptySelection(inputsOf(loader)[inputName]) });
        } else if (isAudio) {
            existing.isAudio = true;
        }
    }
    if (!candidates.size) throw new Error("当前工作流的 H3 参考节点没有可载入的视频输入，无法续写");

    const all = [...candidates.values()];
    const empties = all.filter((c) => c.empty).sort((a, b) => a.slotIndex - b.slotIndex || Number(a.isAudio) - Number(b.isAudio));
    const target = empties[0]
        ?? all.sort((a, b) => Number(b.isAudio) - Number(a.isAudio) || a.slotIndex - b.slotIndex)[0];
    const loader = byId.get(target.loaderId)!;
    const inputName = VIDEO_LOADER_INPUT[String(loader.class_type)];
    inputsOf(loader)[inputName] = videoFile;

    // 填空槽时顺带把同序号参考视频音频接上加载器音频输出（VHS_LoadVideo 音频在 2 号槽），
    // 已有该槽接线则不动。替换源加载器时音频随同源自动更新，无需改线。
    let audioWired = false;
    if (target.empty && String(loader.class_type) === "VHS_LoadVideo") {
        const audioSlot = `ref_video_audios.ref_video_audio_${target.slotIndex}`;
        if (h3Inputs[audioSlot] === undefined) {
            h3Inputs[audioSlot] = [target.loaderId, 2];
            audioWired = true;
        }
    }
    return {
        workflow: result,
        summary: {
            mode: "reference-slot", prevVideoFile: videoFile, targetNode: target.loaderId,
            slot: `ref_video_${target.slotIndex}`, replaced: !target.empty, audioWired,
        },
    };
}