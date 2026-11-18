import { compileReferenceSubmission } from "@basketikun/canvas-agent/reference-contract";

import { backendMediaUrl, fetchBackendProject } from "@/services/backend-api";

import type { DirectorPackRef } from "./director-pack";

/**
 * 导出侧：画布 H3 节点才是「这一集能不能生成」的权威。
 *
 * 制作稿 v2 的 `source.segments` 只剩 id/shot_ids，提示词由编译派生，真正的视频提示词
 * 写在画布 H3 段的 `prompt` 上（`productionClipProjection.targetId` 指回制作稿 Clip ID）。
 * 参考图同理：段上的 `referenceBindings` / 角色组实例才是实际提交给模型的图与顺序，
 * 资产库里带「导演包」标签的图片只是导入包的落脚点。所以导出必须回到画布读这两样，
 * 否则拿到的是分镜拼稿和 0 张参考图。
 */

export type PackClipImage = { storageKey: string; ordinal: number; role: string; label: string };
export type PackClipInput = { targetId: string; nodeId: string; segmentId: string; prompt: string; images: PackClipImage[] };

const rows = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value as Array<Record<string, unknown>> : []);
const str = (value: unknown) => String(value ?? "");

/**
 * 段上的图片按 `<Picture N>` 编号排好。
 *
 * 编号不能用绑定数组顺序猜：提交顺序经 `orderReferencesForSubmission`（分镜图在前、
 * 角色图在后，再按 `referenceOrder` 重排），提示词里的 `<Picture N>` 就是这个顺序。
 * 直接跑同一个编译函数，编号与实际提交、与提示词完全一致。
 */
function orderedImages(project: Record<string, unknown>, segment: Record<string, unknown>): PackClipImage[] {
    try {
        const compiled = compileReferenceSubmission(project, { ...segment, taskMode: segment.taskMode });
        return compiled.references
            .filter((reference) => reference.mediaType === "image" && str(reference.storageKey))
            .sort((left, right) => left.ordinal - right.ordinal)
            .map((reference) => ({
                storageKey: str(reference.storageKey),
                ordinal: reference.ordinal,
                role: str(reference.role),
                label: str(reference.label || reference.subjectId || reference.groupId),
            }));
    } catch {
        // 工程上下文不完整时退回已保存的绑定顺序：仍然是这一段的真实参考图，只是编号按 order。
        return rows(segment.referenceBindings)
            .filter((binding) => binding.enabled !== false && str(binding.mediaType || "image") === "image" && str(binding.storageKey))
            .sort((left, right) => Number(left.order ?? 0) - Number(right.order ?? 0))
            .map((binding, index) => ({
                storageKey: str(binding.storageKey),
                ordinal: index + 1,
                role: str(binding.role),
                label: str(binding.label || binding.subjectId),
            }));
    }
}

/** 画布工程 → 制作稿 Clip ID 对应的视频提示词与参考图（纯函数，导出与测试共用）。 */
export function packClipsFromProject(project: Record<string, unknown>): Map<string, PackClipInput> {
    const clips = new Map<string, PackClipInput>();
    for (const node of rows(project.nodes)) {
        const metadata = (node.metadata || {}) as Record<string, unknown>;
        for (const segment of rows(metadata.segments)) {
            const projection = (segment.productionClipProjection || {}) as Record<string, unknown>;
            const targetId = str(projection.targetId);
            if (!targetId) continue;
            const prompt = str(segment.prompt).trim();
            const previous = clips.get(targetId);
            // 同一 Clip 可能被多个 H3 节点投影：只有「已有投影没提示词、这段有」时才替换。
            if (previous && (previous.prompt || !prompt)) continue;
            clips.set(targetId, {
                targetId,
                nodeId: str(node.id),
                segmentId: str(segment.id),
                prompt,
                images: orderedImages(project, segment),
            });
        }
    }
    return clips;
}

/** 读这一集的画布工程（Backend 权威快照）。 */
export async function collectPackClips(canvasId: string): Promise<Map<string, PackClipInput>> {
    const { project } = await fetchBackendProject(canvasId);
    return packClipsFromProject(project as Record<string, unknown>);
}

/** 参考图字节 → 包内 `asset_groups/NN/PictureN.png` 与对应 refs。 */
export async function buildPackGroupMedia(input: { groupIndex: number; images: PackClipImage[] }): Promise<{
    images: Array<{ name: string; bytes: Uint8Array }>;
    refs: DirectorPackRef[];
    missing: number;
}> {
    const subfolder = `asset_groups/${String(input.groupIndex).padStart(2, "0")}`;
    const images: Array<{ name: string; bytes: Uint8Array }> = [];
    const refs: DirectorPackRef[] = [];
    let missing = 0;
    for (const image of [...input.images].sort((left, right) => left.ordinal - right.ordinal)) {
        try {
            const response = await fetch(backendMediaUrl(image.storageKey));
            if (!response.ok) { missing += 1; continue; }
            const bytes = new Uint8Array(await response.arrayBuffer());
            const name = `Picture${images.length + 1}.png`;
            images.push({ name, bytes });
            refs.push({ index: images.length - 1, fileName: name, type: "input", subfolder, imageFile: `${subfolder}/${name}` });
        } catch {
            missing += 1;
        }
    }
    return { images, refs, missing };
}
