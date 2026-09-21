import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { inferReferenceMediaType, referenceBindingsOf, type ReferenceBinding } from "@basketikun/canvas-agent/reference-contract";

export type StoryboardCompositePanel = { bindingId: string; index: number; row: number; column: number; shotNumbers: number[] };
export type StoryboardCompositePlan = { representativeBindingId: string; sourceBindingIds: string[]; panels: StoryboardCompositePanel[]; rows: number; columns: number; fingerprint: string; bindings: ReferenceBinding[] };

const LAYOUTS: Record<number, { rows: number; columns: number }> = {
    2: { rows: 1, columns: 2 }, 3: { rows: 1, columns: 3 }, 4: { rows: 2, columns: 2 },
    5: { rows: 1, columns: 5 }, 6: { rows: 2, columns: 3 }, 7: { rows: 2, columns: 4 },
    8: { rows: 2, columns: 4 }, 9: { rows: 3, columns: 3 },
};

export function storyboardCompositePlan(segment: Record<string, unknown>): StoryboardCompositePlan | null {
    if (segment.storyboardCompositeEnabled !== true || String(segment.taskMode || segment.mode || "ref2va").toLowerCase() !== "ref2va") return null;
    const bindings = referenceBindingsOf(segment).bindings;
    const available = new Map(bindings.filter((binding) => binding.enabled && (binding.mediaType || inferReferenceMediaType(binding)) === "image" && binding.role === "storyboard" && (binding.storageKey || binding.url)).map((binding) => [binding.id, binding]));
    const pictureBindings = bindings.filter((binding) => binding.enabled && (binding.mediaType || inferReferenceMediaType(binding)) === "image" && (binding.storageKey || binding.url));
    const uses = new Map<string, number[]>();
    const prompt = String(segment.prompt || "");
    const shotMatches = [...prompt.matchAll(/\[Shot\s+(\d+)\]([\s\S]*?)(?=\[Shot\s+\d+\]|$)/giu)];
    for (const match of shotMatches) {
        const shot = Number(match[1]);
        const ids = [...String(match[2]).matchAll(/<Picture\s+(\d+)>/giu)].map((item) => pictureBindings[Number(item[1]) - 1]?.id).filter((id): id is string => Boolean(id));
        for (const id of ids) if (available.has(id)) uses.set(id, [...(uses.get(id) || []), shot]);
    }
    const sourceBindingIds = [...uses.keys()];
    if (sourceBindingIds.length < 2) return null;
    const layout = LAYOUTS[sourceBindingIds.length];
    if (!layout) throw new Error("合并分镜图最多支持 9 张已绑定分镜图");
    const hashInput = sourceBindingIds.map((id) => {
        const binding = available.get(id)!;
        return [id, binding.assetId, binding.storageKey || "", binding.storageKey ? "" : binding.url || "", uses.get(id)];
    });
    const fingerprint = createHash("sha256").update(JSON.stringify({ version: 1, layout, sources: hashInput })).digest("hex");
    const panels = sourceBindingIds.map((bindingId, index) => ({
        bindingId, index: index + 1, row: Math.floor(index / layout.columns) + 1, column: index % layout.columns + 1,
        shotNumbers: [...new Set(uses.get(bindingId) || [])].sort((a, b) => a - b),
    }));
    const representativeBindingId = sourceBindingIds[0];
    const sourceBindings = new Set(sourceBindingIds);
    const firstRefIndex = bindings.findIndex((binding) => binding.id === representativeBindingId);
    const subjectIds = [...new Set(sourceBindingIds.flatMap((id) => {
        const binding = available.get(id)!;
        return [binding.subjectId, binding.groupId, ...(binding.storyboardSubjectIds || [])].filter((value): value is string => Boolean(value));
    }))];
    const compositeBinding: ReferenceBinding = {
        ...available.get(representativeBindingId)!, id: representativeBindingId,
        assetId: `storyboard-composite-${fingerprint.slice(0, 20)}`, label: "合成分镜图", role: "storyboard",
        storyboardSubjectIds: subjectIds, mediaType: "image", storageKey: undefined,
        url: `storyboard-composite://${fingerprint}`,
    };
    const nextBindings = bindings.flatMap((binding, index) => {
        if (!sourceBindings.has(binding.id)) return [binding];
        return index === firstRefIndex ? [compositeBinding] : [];
    });
    return { representativeBindingId, sourceBindingIds, panels, ...layout, fingerprint, bindings: nextBindings };
}

export async function createStoryboardComposite(plan: StoryboardCompositePlan, sourcePaths: string[]) {
    if (sourcePaths.length !== plan.panels.length) throw new Error("合成分镜图的源图片数量不匹配");
    const directory = await mkdtemp(path.join(os.tmpdir(), "infinite-canvas-h3-storyboard-"));
    try {
        const images = await Promise.all(sourcePaths.map(async (filePath) => {
            const metadata = await sharp(filePath).metadata();
            if (!metadata.width || !metadata.height) throw new Error(`无法读取分镜图片尺寸: ${path.basename(filePath)}`);
            return { filePath, width: metadata.width, height: metadata.height, shortEdge: Math.min(metadata.width, metadata.height) };
        }));
        const targetShortEdge = Math.min(...images.map((image) => image.shortEdge));
        const sized = images.map((image) => {
            const scale = Math.min(1, targetShortEdge / image.shortEdge);
            return { ...image, width: Math.max(1, Math.round(image.width * scale)), height: Math.max(1, Math.round(image.height * scale)) };
        });
        const cellWidth = Math.max(...sized.map((image) => image.width));
        const cellHeight = Math.max(...sized.map((image) => image.height));
        const composites = await Promise.all(sized.map(async (image, index) => {
            const panel = plan.panels[index];
            const left = (panel.column - 1) * cellWidth + Math.floor((cellWidth - image.width) / 2);
            const top = (panel.row - 1) * cellHeight + Math.floor((cellHeight - image.height) / 2);
            const input = await sharp(image.filePath).resize({ width: image.width, height: image.height, fit: "inside", withoutEnlargement: true }).png().toBuffer();
            return { input, left, top };
        }));
        const filePath = path.join(directory, "storyboard-composite.png");
        await sharp({ create: { width: plan.columns * cellWidth, height: plan.rows * cellHeight, channels: 3, background: "white" } })
            .composite(composites).png().toFile(filePath);
        return { filePath, directory };
    } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
    }
}

export async function cleanupStoryboardCompositeDirectory(value: unknown) {
    const directory = String(value || "");
    const root = path.resolve(os.tmpdir());
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith("infinite-canvas-h3-storyboard-")) return;
    await rm(resolved, { recursive: true, force: true });
}

export function storyboardCompositeDirective(plan: StoryboardCompositePlan) {
    const positions = plan.panels.map((panel) => `Panel ${panel.index} (row ${panel.row}, column ${panel.column}) corresponds to ${panel.shotNumbers.map((number) => `[Shot ${number}]`).join(", ") || "no assigned shot"}.`).join(" ");
    return `A single submitted image is a composite storyboard sheet arranged in a ${plan.rows}-row by ${plan.columns}-column grid, numbered from left to right and top to bottom. ${positions}`;
}

export function remapCompositePrompt(prompt: string, plan: StoryboardCompositePlan, beforeReferences: Array<{ id: string; ordinal: number; mediaType: string }>, afterReferences: Array<{ id: string; ordinal: number; mediaType: string }>) {
    const sourceIds = new Set(plan.sourceBindingIds);
    const pictureOrdinals = new Map<number, number>();
    const finalOrdinalById = new Map(afterReferences.filter((reference) => reference.mediaType === "image").map((reference) => [reference.id, reference.ordinal]));
    for (const reference of beforeReferences) {
        if (reference.mediaType !== "image") continue;
        const id = sourceIds.has(reference.id) ? plan.representativeBindingId : reference.id;
        const ordinal = finalOrdinalById.get(id);
        if (ordinal) pictureOrdinals.set(reference.ordinal, ordinal);
    }
    const next = prompt.replace(/<Picture\s+(\d+)>(?![\d])/giu, (marker, ordinal: string) => `<Picture ${pictureOrdinals.get(Number(ordinal)) || Number(ordinal)}>`);
    return next;
}
