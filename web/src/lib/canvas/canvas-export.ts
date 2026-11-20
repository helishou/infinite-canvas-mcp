import { saveAs } from "file-saver";

import i18n from "@/i18n";
import { createZip } from "@/lib/zip";
import { readAllPages } from "@/lib/read-all-pages";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import { fetchBackendGenerationLogs, fetchBackendTasks } from "@/services/backend-api";
import type { CanvasExportAsset, CanvasExportFile } from "@/types/canvas-export";
import { ensureCanvasProjectLoaded, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export async function exportCanvasProjects(projects: CanvasProject[], fileName = i18n.t("canvas.export.defaultProjectName")) {
    async function* archiveFiles() {
        const exportedProjects: CanvasExportFile["projects"] = [];
        for (const item of projects) {
            const project = item.summary ? await ensureCanvasProjectLoaded(item.id) : item;
            const [logs, tasks] = await Promise.all([
                readAllPages(async (offset) => {
                    const response = await fetchBackendGenerationLogs({ projectId: project.id, limit: 500, offset });
                    if (!Array.isArray(response.logs)) throw new Error("导出失败：生成日志响应格式错误");
                    return response.logs;
                }),
                readAllPages(async (offset) => {
                    const response = await fetchBackendTasks({ projectId: project.id, limit: 500, offset });
                    if (!Array.isArray(response.tasks)) throw new Error("导出失败：任务响应格式错误");
                    return response.tasks;
                }),
            ]);
            const taskSummaries = tasks.filter((task) => ["succeeded", "failed", "cancelled"].includes(task.status));
            const files: CanvasExportAsset[] = [];
            const folder = useCanvasStore.getState().folders.find((item) => item.id === project.folderId);
            for (const storageKey of collectStorageKeys({ project, logs, taskSummaries, folder })) {
                const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
                if (!blob) throw new Error(`导出失败：媒体 ${storageKey} 缺失`);
                const path = `projects/${project.id}/files/${safeFileName(storageKey)}.${fileExtension(blob.type, storageKey)}`;
                files.push({ storageKey, path, mimeType: blob.type || "application/octet-stream", bytes: blob.size, sha256: await sha256(blob) });
                yield { name: path, data: blob };
            }
            exportedProjects.push({ project, files, logs: logs as Array<Record<string, unknown>>, taskSummaries: taskSummaries as Array<Record<string, unknown>> });
        }
        const folderIds = new Set(projects.map((project) => project.folderId).filter((id): id is string => Boolean(id)));
        const folders = useCanvasStore.getState().folders.filter((folder) => folderIds.has(folder.id));
        const data: CanvasExportFile = { app: "infinite-canvas", version: 3, exportedAt: new Date().toISOString(), projects: exportedProjects, folders };
        yield { name: "projects.json", data: JSON.stringify(data, null, 2) };
    }
    const zip = await createZip(archiveFiles());
    saveAs(zip, `${safeFileName(fileName)}.zip`);
}

async function sha256(blob: Blob) {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/** 批量导出结果：成功写进 ZIP 的节点数、跳过（媒体缺失/读取失败）的节点数、是否被取消。 */
export type ExportCanvasNodesResult = {
    success: number;
    failed: number;
    aborted: boolean;
};

/**
 * 把选中节点逐个写进一个 ZIP 并触发下载。
 * - 单个节点失败（storageKey 取不到 blob、data: 解析失败等）只跳过该节点，不影响其余节点。
 * - 传 options.signal 可在节点之间取消：取消后不再打包、也不触发下载。
 * - 兼容旧调用：第二个参数仍是文件名字符串；旧调用方忽略返回值即可。
 */
export async function exportCanvasNodes(
    nodes: CanvasNodeData[],
    fileName = i18n.t("canvas.export.defaultNodesName"),
    options: { signal?: AbortSignal } = {},
): Promise<ExportCanvasNodesResult> {
    const { signal } = options;
    const used = new Set<string>();
    const uniqueName = (base: string, ext: string) => {
        const safe = safeFileName(base) || i18n.t("canvas.export.item");
        let name = `${safe}.${ext}`;
        for (let i = 1; used.has(name); i += 1) name = `${safe}-${i}.${ext}`;
        used.add(name);
        return name;
    };
    let success = 0;
    let failed = 0;

    async function* files() {
        for (const node of nodes) {
            if (signal?.aborted) return;
            try {
                const title = node.title || node.type;
                const storageKey = node.metadata?.storageKey || "";
                let file: { name: string; data: BlobPart };
                if (storageKey) {
                    const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
                    if (!blob) throw new Error(`导出失败：媒体 ${storageKey} 缺失`);
                    file = { name: uniqueName(title, fileExtension(blob.type, storageKey)), data: blob };
                } else if (node.type === CanvasNodeType.Text) {
                    file = { name: uniqueName(title, "txt"), data: node.metadata?.content || node.metadata?.prompt || "" };
                } else if (node.metadata?.content?.startsWith("data:")) {
                    const blob = await (await fetch(node.metadata.content)).blob();
                    file = { name: uniqueName(title, fileExtension(blob.type, storageKey)), data: blob };
                } else {
                    file = { name: uniqueName(title, "json"), data: JSON.stringify(node, null, 2) };
                }
                if (signal?.aborted) return;
                success += 1;
                yield file;
            } catch (error) {
                console.error(`导出节点失败：${node.title || node.type}`, error);
                failed += 1;
            }
        }
    }
    const zip = await createZip(files());
    const aborted = Boolean(signal?.aborted);
    if (!aborted && success > 0) saveAs(zip, `${safeFileName(fileName)}.zip`);
    return { success, failed, aborted };
}

function collectStorageKeys(value: unknown) {
    const keys = new Set<string>();
    const visit = (value: unknown) => {
        if (!value || typeof value !== "object") return;
        for (const [key, item] of Object.entries(value)) {
            if ((key === "storageKey" || key.endsWith("StorageKey")) && typeof item === "string" && item.includes(":")) keys.add(item);
            else visit(item);
        }
    };
    visit(value);
    return [...keys];
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string, storageKey: string) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
    if (mimeType.includes("wav")) return "wav";
    if (mimeType.includes("ogg")) return "ogg";
    return storageKey.startsWith("image:") ? "png" : "bin";
}
