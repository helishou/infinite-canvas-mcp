import type { BackendGenerationLog, BackendRuntimeTask } from "@/services/backend-api";
import type { CanvasFolder, CanvasProject } from "@/stores/canvas/use-canvas-store";

export type WorkbenchMedia = { kind: "image" | "video" | "audio"; storageKey?: string; url?: string };
export type WorkbenchOutput = WorkbenchMedia & { id: string; log: BackendGenerationLog };

export function retainProjectCovers(current: Record<string, WorkbenchMedia>, candidates: Array<{ key: string; media: WorkbenchMedia | null }>) {
    let next = current;
    for (const candidate of candidates) {
        if (!candidate.media || Object.hasOwn(current, candidate.key)) continue;
        if (next === current) next = { ...current };
        next[candidate.key] = candidate.media;
    }
    return next;
}

export function outputMedia(value: Record<string, unknown>): WorkbenchMedia | null {
    const storageKey = typeof value.storageKey === "string" ? value.storageKey : undefined;
    const url = [value.url, value.localUrl, value.content].find((v): v is string => typeof v === "string" && /^(https?:|blob:|data:(image|video|audio)\/|\/)/.test(v));
    if (!storageKey && !url) return null;
    const type = String(value.mimeType || value.type || "").toLowerCase();
    const hint = `${storageKey || ""} ${url?.split(/[?#]/)[0] || ""}`;
    const kind = /^(video)(\/|$)/.test(type)
        ? "video"
        : /^(audio)(\/|$)/.test(type)
          ? "audio"
          : /^(image)(\/|$)/.test(type)
            ? "image"
            : /\.(mp4|webm|mov|m4v)(\s|$)/i.test(hint) || storageKey?.startsWith("video:")
              ? "video"
              : /\.(mp3|wav|m4a|ogg|flac)(\s|$)/i.test(hint) || storageKey?.startsWith("audio:")
                ? "audio"
                : /\.(png|jpe?g|webp|gif|avif)(\s|$)/i.test(hint) || storageKey?.startsWith("image:") || url?.startsWith("data:image/")
                  ? "image"
                  : null;
    return kind ? { kind, storageKey, url } : null;
}

export function collectOutputs(logs: BackendGenerationLog[]): WorkbenchOutput[] {
    return [...logs]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .flatMap((log) =>
            log.status === "success"
                ? log.outputs.flatMap((output, index) => {
                      const media = outputMedia(output);
                      return media ? [{ ...media, id: `${log.id}:${index}`, log }] : [];
                  })
                : [],
        );
}

export function projectCover(project: CanvasProject, outputs: WorkbenchOutput[], folder?: CanvasFolder): WorkbenchMedia | null {
    const result = outputs.find((output) => output.log.projectId === project.id && output.kind === "image") || outputs.find((output) => output.log.projectId === project.id && output.kind === "video");
    if (result) return result;
    if (folder?.coverStorageKey) return { kind: "image", storageKey: folder.coverStorageKey };
    // Only inspect already-loaded nodes. The home page must not hydrate every canvas for a cover.
    for (const node of project.nodes) {
        const metadata = node.metadata;
        if (!metadata) continue;
        if (metadata.sceneImage) return { kind: "image", ...metadata.sceneImage };
        if (metadata.propImage) return { kind: "image", ...metadata.propImage };
        const characterImages = metadata.characterImages || [];
        const character = characterImages[Math.min(Math.max(metadata.characterPrimaryIndex || 0, 0), Math.max(characterImages.length - 1, 0))];
        if (character) return { kind: "image", ...character };
        const imageMode = node.type === "image" || (node.type === "config" && metadata.smart && (metadata.generationMode || "image") === "image");
        const primaryImage = imageMode ? metadata.images?.find((image) => image.id === metadata.primaryImageId) || metadata.images?.find((image) => image.status === "success") : undefined;
        if (primaryImage) return { kind: "image", storageKey: primaryImage.storageKey, url: primaryImage.content };
        const media = outputMedia({ ...metadata, type: node.type });
        if (media && media.kind !== "audio") return media;
    }
    return null;
}

export function taskDestination(task: BackendRuntimeTask, projectIds: Set<string>): string | null {
    const projectId = task.projectId || (typeof task.input?.projectId === "string" ? task.input.projectId : "");
    if (projectIds.has(projectId)) return `/canvas/${encodeURIComponent(projectId)}`;
    // A deleted canvas must never send users into another project or an unrelated studio.
    if (projectId && !projectId.startsWith("__")) return null;
    const scope = task.input?.scope;
    if (scope === "image" || scope === "video") return `/${scope}`;
    return null;
}
