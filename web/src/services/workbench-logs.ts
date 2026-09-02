import i18n from "@/i18n";
import { deleteBackendGenerationLogs, fetchBackendGenerationLogs, createBackendGenerationLog, updateBackendGenerationLog, type BackendGenerationLog } from "@/services/backend-api";
import { resolveImageUrl } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";

export type WorkbenchLogKind = "image" | "video";
type WorkbenchLog = Record<string, any> & { id: string };

const PROJECTS: Record<WorkbenchLogKind, string> = { image: "image-workbench", video: "video-workbench" };

export async function readWorkbenchLogs(kind: WorkbenchLogKind): Promise<WorkbenchLog[]> {
    const response = await fetchBackendGenerationLogs({ projectId: PROJECTS[kind], limit: 500 });
    const logs = (response.logs || []).filter((log) => isWorkbenchLog(log, kind));
    return Promise.all(logs.map((log) => fromBackendLog(log, kind)));
}

export async function saveWorkbenchLog(kind: WorkbenchLogKind, log: WorkbenchLog): Promise<void> {
    const existing = await fetchBackendGenerationLogs({ projectId: PROJECTS[kind], limit: 500 });
    const current = (existing.logs || []).find((item) => legacyId(item) === log.id);
    const input = toBackendInput(kind, log);
    if (current) {
        await updateBackendGenerationLog(current.id, input);
    } else {
        await createBackendGenerationLog(input);
    }
}

export async function deleteWorkbenchLogs(kind: WorkbenchLogKind, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const response = await fetchBackendGenerationLogs({ projectId: PROJECTS[kind], limit: 500 });
    const backendIds = (response.logs || []).filter((log) => ids.includes(legacyId(log))).map((log) => log.id);
    await Promise.all(backendIds.map((id) => deleteBackendGenerationLogs({ id })));
}

function isWorkbenchLog(log: BackendGenerationLog, kind: WorkbenchLogKind) {
    const params = log.params || {};
    return params.workbench === kind || log.projectId === PROJECTS[kind] || (kind === "image" && /image/i.test(log.platform)) || (kind === "video" && /video/i.test(log.platform));
}

function legacyId(log: BackendGenerationLog) {
    const value = log.params?.legacyLogId;
    return typeof value === "string" && value ? value : log.id;
}

async function fromBackendLog(log: BackendGenerationLog, kind: WorkbenchLogKind): Promise<WorkbenchLog> {
    const params = log.params || {};
    const legacy = (params.legacyLog as Record<string, any> | undefined) || {};
    const base = { ...legacy, id: legacyId(log), prompt: log.prompt || legacy.prompt || "", model: log.model || legacy.model || "", durationMs: log.durationMs || 0, status: log.status === "failed" ? "failed" : legacy.status || "success" };
    if (kind === "image") {
        const images = await Promise.all((Array.isArray(legacy.images) ? legacy.images : log.outputs).map(async (item: any) => ({ ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) })));
        const references = await Promise.all((Array.isArray(legacy.references) ? legacy.references : log.references).map(async (item: any) => ({ ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) })));
        return { ...base, createdAt: Date.parse(log.createdAt) || Date.now(), title: legacy.title || base.prompt.slice(0, 12) || i18n.t("workbench.untitled"), time: legacy.time || new Date(log.createdAt).toLocaleString(i18n.resolvedLanguage, { hour12: false }), config: legacy.config || { model: base.model, imageModel: base.model, quality: legacy.quality || "", size: legacy.size || "", count: String(legacy.imageCount || images.length || 1) }, references, successCount: legacy.successCount ?? images.length, failCount: legacy.failCount || 0, imageCount: legacy.imageCount || images.length, size: legacy.size || "", quality: legacy.quality || "", status: base.status, images, thumbnails: images.map((item: any) => item.dataUrl).filter(Boolean) };
    }
    const output = (Array.isArray(legacy.video ? [legacy.video] : log.outputs) ? (legacy.video ? [legacy.video] : log.outputs) : [])[0] as Record<string, any> | undefined;
    const video = output ? { ...output, url: await resolveMediaUrl(output.storageKey, output.url) } : undefined;
    const references = await Promise.all((Array.isArray(legacy.references) ? legacy.references : log.references).map(async (item: any) => ({ ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) })));
    return { ...base, createdAt: Date.parse(log.createdAt) || Date.now(), title: legacy.title || base.prompt.slice(0, 12) || i18n.t("workbench.untitled"), time: legacy.time || new Date(log.createdAt).toLocaleString(i18n.resolvedLanguage, { hour12: false }), config: legacy.config || { model: base.model, videoModel: base.model, size: legacy.size || "", vquality: "", videoSeconds: legacy.seconds || "", videoGenerateAudio: true, videoWatermark: false }, references, size: legacy.size || "", resolution: legacy.resolution || "", seconds: legacy.seconds || "", status: base.status, task: legacy.task, video, error: log.error };
}

function toBackendInput(kind: WorkbenchLogKind, log: WorkbenchLog) {
    const serialized = stripInlineMedia(log);
    const references = Array.isArray(serialized.references) ? serialized.references : [];
    const outputs = kind === "image" ? (Array.isArray(serialized.images) ? serialized.images : []) : (serialized.video ? [serialized.video] : []);
    return { projectId: PROJECTS[kind], status: serialized.status === "pending" ? "queued" : serialized.status || "success", platform: kind === "image" ? "Image Workbench" : "Video Workbench", model: serialized.model || serialized.config?.model || "", prompt: serialized.prompt || "", references, inputCounts: { image: references.length }, startedAt: new Date(serialized.createdAt || Date.now()).toISOString(), finishedAt: serialized.status === "pending" ? undefined : new Date().toISOString(), durationMs: Number(serialized.durationMs) || 0, outputs, error: serialized.error, params: { workbench: kind, legacyLogId: serialized.id, legacyLog: serialized } };
}

function stripInlineMedia(log: WorkbenchLog): WorkbenchLog {
    const copy = JSON.parse(JSON.stringify(log)) as WorkbenchLog;
    for (const key of ["references", "images"]) {
        if (Array.isArray(copy[key])) copy[key] = copy[key].map((item: Record<string, any>) => item.storageKey ? { ...item, dataUrl: "" } : item);
    }
    if (copy.video?.storageKey) copy.video = { ...copy.video, url: "" };
    copy.thumbnails = [];
    return copy;
}
