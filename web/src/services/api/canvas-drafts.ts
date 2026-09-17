import localforage from "localforage";
import { getBackendUrl } from "@/services/backend-api";
import { canvasDraftOwnerActive, getCanvasDraftSessionId } from "@/lib/canvas/canvas-draft-session";
import { draftImports, type DraftImport } from "@/lib/canvas/canvas-draft-import-state";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

type SavedProject = Partial<CanvasProject> & { id: string; title?: string; summary?: unknown };
type RecordValue = {
    ownerId?: string; backend?: string; projectId?: string; project?: SavedProject; base?: SavedProject;
    submitted?: SavedProject; operations?: unknown[]; suggestion?: { text?: string }; rejected?: string;
};
export type CanvasDraftBundle = {
    key: string; ownerId?: string; backend?: string; current: boolean; active: boolean | null;
    projects: string[]; pending: number; rejected: number;
    importPending?: boolean;
    recoverableProjects: SavedProject[];
    records: Array<{ store: string; key: string; value: unknown }>;
};
const stores = [
    { name: "infinite-canvas-command-outbox", storeName: "commands" },
    { name: "infinite-canvas-text-outbox" },
    { name: "infinite-canvas-text-suggestions-outbox" },
    { name: "infinite-canvas-project-cache" },
    { name: "infinite-canvas-project-deletions" },
];

/** 只读盘点。没有 owner/后台归属的旧记录只供检查和导出，绝不猜测归属后自动提交。 */
export async function listCanvasDrafts(): Promise<CanvasDraftBundle[]> {
    const backend = getBackendUrl();
    const owner = getCanvasDraftSessionId();
    const bundles = new Map<string, CanvasDraftBundle>();
    for (const options of stores) {
        const values: Array<{ key: string; value: RecordValue | string[] }> = [];
        await localforage.createInstance(options).iterate<RecordValue | string[], void>((value, key) => { values.push({ key, value }); });
        for (const { key, value } of values) {
            if (!value || typeof value !== "object") continue;
            const record = value as RecordValue;
            let recordBackend = record.backend;
            let recordOwner = record.ownerId;
            const cache = options.name === "infinite-canvas-project-cache";
            const deletion = options.name === "infinite-canvas-project-deletions";
            if (cache || deletion) {
                try {
                    const scope = JSON.parse(key);
                    if (Array.isArray(scope) && scope.length === 3 && scope.every((part) => typeof part === "string")) [recordBackend, recordOwner] = scope;
                } catch { /* 未分区旧缓存保留未知归属。 */ }
            }
            if (recordBackend && recordBackend !== backend) continue;
            const groupKey = JSON.stringify([recordBackend || "", recordOwner || ""]);
            const bundle: CanvasDraftBundle = bundles.get(groupKey) || { key: groupKey, ownerId: recordOwner, backend: recordBackend, current: recordOwner === owner, active: null, projects: [], pending: 0, rejected: 0, recoverableProjects: [], records: [] };
            bundle.records.push({ store: options.name, key, value });
            if (!recordOwner && cache && record.project?.id && Array.isArray(record.project.nodes) && Array.isArray(record.project.connections)) bundle.recoverableProjects.push(record.project);
            // 已同步的有归属投影不是草稿；新项目种子和无归属旧缓存需保留人工找回入口。
            if (cache ? (!recordOwner || (!record.base && !record.project?.summary)) : deletion ? Array.isArray(value) && value.length > 0 : true) bundle.pending++;
            if (record.rejected) bundle.rejected++;
            bundles.set(groupKey, bundle);
        }
    }
    await draftImports.iterate<DraftImport, void>((archive) => {
        if (archive.backend !== backend) return;
        const key = JSON.stringify([archive.backend, archive.ownerId]);
        const bundle: CanvasDraftBundle = bundles.get(key) || { key, ownerId: archive.ownerId, backend, current: archive.ownerId === owner, active: null, projects: [], pending: 0, rejected: 0, recoverableProjects: [], records: [] };
        bundle.importPending = true;
        // 中断后展示完整档案，不把已经写入的前半份误当成全部内容。
        bundle.records = archive.records;
        bundle.pending = Math.max(bundle.pending, archive.records.length);
        bundles.set(key, bundle);
    });
    // 旧版本的共享删除列表没有后台/窗口归属，只加入导出档案，绝不恢复成删除操作。
    if (typeof localStorage !== "undefined") {
        const key = "infinite-canvas-project-deletions-v1";
        const raw = localStorage.getItem(key);
        if (raw) {
            let value: unknown = raw;
            try { value = JSON.parse(raw); } catch { /* 损坏内容也原样保留。 */ }
            if (!Array.isArray(value) || value.length) {
                const groupKey = JSON.stringify(["", ""]);
                const bundle: CanvasDraftBundle = bundles.get(groupKey) || { key: groupKey, current: false, active: null, projects: [], pending: 0, rejected: 0, recoverableProjects: [], records: [] };
                bundle.records.push({ store: "legacy-localStorage", key, value });
                bundle.pending++;
                bundles.set(groupKey, bundle);
            }
        }
    }
    const result = [...bundles.values()].filter((bundle) => bundle.pending);
    for (const bundle of result) {
        const titles = new Map<string, string>();
        const ids = new Set<string>();
        for (const { store, value } of bundle.records) {
            const record = value as RecordValue;
            const project = record.project || record.base || record.submitted;
            if (project?.id && project.title) titles.set(project.id, project.title);
            if (store === "infinite-canvas-project-cache" && bundle.ownerId && record.base) continue;
            if (Array.isArray(value)) value.forEach((id) => { if (typeof id === "string") ids.add(id); });
            else if (record.projectId || project?.id) ids.add(record.projectId || project!.id);
        }
        bundle.projects = [...ids].map((id) => titles.get(id) || id);
    }
    await Promise.all(result.map(async (bundle) => { if (bundle.ownerId) bundle.active = await canvasDraftOwnerActive(bundle.ownerId); }));
    return result.sort((a, b) => Number(b.current) - Number(a.current));
}
