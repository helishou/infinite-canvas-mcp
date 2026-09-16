import { create } from "zustand";
import localforage from "localforage";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import { normalizeViewportTransform } from "@/lib/canvas/canvas-viewport";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";
import { applyBackendCanvasOperations, backendMediaUrl, BackendApiError, createBackendGenerationLog, deleteBackendCanvasFolder, deleteBackendProject, fetchBackendCanvasFolders, fetchBackendProject, fetchBackendProjects, upsertBackendCanvasFolder, upsertBackendProject } from "@/services/backend-api";
import { useBackendStore } from "@/stores/use-backend-store";

export type CanvasProject = {
    id: string;
    revision?: number;
    /** 存在时仅为列表摘要，打开/导出前必须加载详情。 */
    summary?: { nodeCount: number; connectionCount: number };
    folderId?: string | null;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    globalPrompt: string;
    referenceCatalog?: Array<Record<string, unknown>>;
    viewport: ViewportTransform;
};

type CanvasConflictTarget = {
    /** 冲突对应的节点 / 连线 id（视具体类型而定）。 */
    id: string;
    /** 冲突类型：add=远端已存在同 id、update=远端已无此 id、delete=本端早已删、connect=远端已有同 id connection。 */
    kind: "add" | "update" | "delete" | "connect" | "disconnect";
    /** 一句话说明，给弹窗用。 */
    detail: string;
};

type CanvasConflictRecord = {
    remoteDeleted?: boolean;
    message: string;
    /** 后端最新 revision（采纳 / 保留后都要把这个写进 syncBase）。 */
    revision: number;
    pendingOperations: number;
    conflictTargets: CanvasConflictTarget[];
    /** 缓存的远端项目本体；点击"采用远端"时直接拿来覆盖本地。 */
    remoteProject: CanvasProject;
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    folders: CanvasFolder[];
    backendRevisions: Record<string, number>;
    canvasConflicts: Record<string, CanvasConflictRecord>;
    clearCanvasConflict: (id: string) => void;
    /** 弹窗"保留我的 N 个操作"：syncBase 推进到远端 revision，本地不动，
     *  下一次显式编辑会基于新 revision 重新提交 pendingOps，达成自动 rebase。 */
    keepPendingOpsOnCanvasConflict: (id: string) => void;
    /** 弹窗"采用远端"：用缓存的 remoteProject 直接覆盖本地，syncBase = remote。 */
    adoptRemoteOnCanvasConflict: (id: string) => void;
    createProject: (title?: string) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    createFolder: (name?: string) => string;
    renameFolder: (id: string, name: string) => void;
    updateFolder: (id: string, patch: Partial<Pick<CanvasFolder, "name" | "outline" | "description" | "coverStorageKey" | "tags">>) => void;
    deleteFolder: (id: string) => void;
    moveProjectsToFolder: (ids: string[], folderId: string | null) => void;
    replaceFolders: (folders: CanvasFolder[]) => void;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: CanvasProject[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "globalPrompt" | "viewport">>) => void;
};

export type CanvasFolder = {
    id: string; name: string; createdAt: string; updatedAt?: string;
    outline?: string; description?: string; coverStorageKey?: string | null; tags?: string[];
};

const projectCache = localforage.createInstance({ name: "infinite-canvas-project-cache" });
const cachedProjects = new Map<string, CanvasProject>();
const cachedBases = new Map<string, CanvasProject | undefined>();
const comparedProjects = new Map<string, CanvasProject>();
const projectLoads = new Map<string, Promise<CanvasProject>>();
const CANVAS_PROJECT_INDEX_KEY = "infinite-canvas-project-index-v3";
const CANVAS_PROJECT_DELETIONS_KEY = "infinite-canvas-project-deletions-v1";
const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let localSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
let pendingLocalSnapshot: { projects: CanvasProject[]; bases: Map<string, CanvasProject> } | null = null;
let localSnapshotWritePromise: Promise<void> | null = null;
let syncPromise: Promise<void> | null = null;
let syncRequested = false;
let syncGeneration = 0;
let knownProjectIds = new Set<string>();
let knownCanvasFolderIds = new Set<string>();
let folderSaveTimer: ReturnType<typeof setTimeout> | null = null;
const syncBases = new Map<string, CanvasProject>();
// Backend 已明确拒绝的同一批操作不再自动重试。签名包含基线 revision 与完整 op
// 内容的短哈希，因此无关的 store/SSE 对象重建不会解除熔断，用户真正修改内容后会。
const rejectedSyncSignatures = new Map<string, string>();
let deferredBackendEvents: unknown[] = [];
let deferredBackendEventsWaiter: Promise<void> | null = null;
let canvasHydrationPromise: Promise<void> | null = null;
let localCanvasHydrated = false;
let backendCanvasHydrated = false;
const canvasDeltaRecovery = new Set<string>();
const pendingDeletedProjectIds = loadDeletedProjectIds();

function loadDeletedProjectIds(): Set<string> {
    try {
        const raw = localStorage.getItem(CANVAS_PROJECT_DELETIONS_KEY);
        const ids = raw ? JSON.parse(raw) : [];
        return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && id.length > 0) : []);
    } catch {
        return new Set();
    }
}

function persistDeletedProjectIds() {
    try {
        localStorage.setItem(CANVAS_PROJECT_DELETIONS_KEY, JSON.stringify([...pendingDeletedProjectIds]));
    } catch {
        // 删除意图只作为刷新期间的同步标记，浏览器存储不可用时继续走 Backend 同步。
    }
}

async function syncCanvasFolders(folders: CanvasFolder[]) {
    if (!useBackendStore.getState().connected) return;
    const folderIds = new Set(folders.map((folder) => folder.id));
    await Promise.all([
        ...folders.map((folder) => upsertBackendCanvasFolder(folder as unknown as Record<string, unknown>)),
        ...[...knownCanvasFolderIds].filter((id) => !folderIds.has(id)).map((id) => deleteBackendCanvasFolder(id)),
    ]);
    knownCanvasFolderIds = folderIds;
}

function scheduleCanvasFolderSync() {
    if (folderSaveTimer) clearTimeout(folderSaveTimer);
    folderSaveTimer = setTimeout(() => {
        folderSaveTimer = null;
        void syncCanvasFolders(useCanvasStore.getState().folders).catch((error) => console.error("画布文件夹同步失败", error));
    }, 400);
}

// H3 节点 metadata 里"不进本地 diff 提交"的字段集合：
//   - backend 独占：status / runProgress / runtimeTaskId / runtimeRunId / runRequestId / runRequestConsumedId
//                  / cancelRequested / errorDetails / content / storageKey
//     → 页面只读，绝不能把"页面恢复时的旧快照"重新提交，否则会覆盖任务回写。
//     → 注意：H3 的"运行历史"已从 node.metadata 迁出（v4），落到 generation_logs.outputs_json。
//       由 /canvas/projects/:id/nodes/:nodeId/materials 与 MCP h3_get_node_materials 按需返回。
//   - 页面 UI 瞬态：playhead
//     → H3 工作台 rAF tick 每帧都在改它（onPlayheadTick → updateMetadata），属于"看见/听见"的本地状态。
//       不应该走主同步流，否则用户拖一下窗口 / 滚一下视图就会被弹冲突。
//     → 其它 tab 看自己 video.currentTime 即可，不需要靠 sync 同步这个值。
const H3_BACKEND_NODE_METADATA_FIELDS = new Set([
    "status", "runProgress", "runtimeTaskId", "runtimeRunId", "runRequestId", "runRequestConsumedId",
    "cancelRequested", "errorDetails", "content", "storageKey",
    "playhead",
]);
const H3_BACKEND_SEGMENT_FIELDS = new Set([
    "status", "progress", "runtimeTaskId", "result", "resultStorageKey", "results", "errorDetails",
]);

function loadFromLocalStorage(): CanvasProject[] {
    try {
        const raw = localStorage.getItem(CANVAS_PROJECT_INDEX_KEY);
        if (!raw) return [];
        const val = JSON.parse(raw);
        return Array.isArray(val) ? val.filter((item) => !pendingDeletedProjectIds.has(String(item?.id || ""))).map((item) => ({
            ...item,
            summary: item.summary || { nodeCount: 0, connectionCount: 0 },
            nodes: [],
            connections: [],
            chatSessions: [],
            activeChatId: null,
            backgroundMode: "lines" as const,
            showImageInfo: false,
            globalPrompt: "",
            viewport: normalizeViewportTransform(item.viewport),
        })) as CanvasProject[] : [];
    } catch { return []; }
}

function saveToLocalStorage(projects: CanvasProject[]) {
    try {
        const index = projects.map(({ id, title, folderId, revision, createdAt, updatedAt, nodes, connections, summary, viewport }) => ({ id, title, folderId, revision, createdAt, updatedAt, viewport, summary: summary || { nodeCount: nodes.length, connectionCount: connections.length } }));
        localStorage.setItem(CANVAS_PROJECT_INDEX_KEY, JSON.stringify(index));
    } catch { /* localStorage 满了就放弃 */ }
}

function persistCurrentCanvasSnapshot() {
    if (localSnapshotTimer) clearTimeout(localSnapshotTimer);
    localSnapshotTimer = setTimeout(() => {
        localSnapshotTimer = null;
        void persistCanvasSnapshot(useCanvasStore.getState().projects);
    }, 250);
}

function persistCanvasSnapshot(projects: CanvasProject[]) {
    // IndexedDB 写入是异步的；不能让较早的快照在较新的快照之后完成并覆盖它。
    pendingLocalSnapshot = { projects, bases: new Map(syncBases) };
    if (localSnapshotWritePromise) return localSnapshotWritePromise;
    localSnapshotWritePromise = (async () => {
        while (pendingLocalSnapshot) {
            const { projects: next, bases } = pendingLocalSnapshot;
            pendingLocalSnapshot = null;
            try {
                const ids = new Set(next.map((project) => project.id));
                for (const project of next) {
                    const base = bases.get(project.id);
                    if (cachedProjects.get(project.id) === project && cachedBases.get(project.id) === base) continue;
                    await projectCache.setItem(project.id, { project, base });
                    cachedProjects.set(project.id, project);
                    cachedBases.set(project.id, base);
                }
                for (const id of cachedProjects.keys()) {
                    if (ids.has(id)) continue;
                    await projectCache.removeItem(id);
                    cachedProjects.delete(id);
                    cachedBases.delete(id);
                }
                saveToLocalStorage(next);
            } catch (error) {
                console.error("画布本地快照保存失败", error);
            }
        }
    })().finally(() => { localSnapshotWritePromise = null; });
    return localSnapshotWritePromise;
}

async function hydrateCanvasProjectsFromLocalStore() {
    try {
        const projects: CanvasProject[] = [];
        await projectCache.iterate<{ project: CanvasProject; base?: CanvasProject }, void>((entry) => {
            if (!entry?.project?.id || pendingDeletedProjectIds.has(entry.project.id)) return;
            projects.push(entry.project);
            cachedProjects.set(entry.project.id, entry.project);
            cachedBases.set(entry.project.id, entry.base);
            if (entry.base) syncBases.set(entry.project.id, entry.base);
        });
        const normalizedProjects = projects.filter((project) => !pendingDeletedProjectIds.has(project.id)).map(normalizeProjectMediaUrls);
        const currentProjects = useCanvasStore.getState().projects;
        const currentById = new Map(currentProjects.map((project) => [project.id, project]));
        const localById = new Map(normalizedProjects.map((project) => [project.id, project]));
        const mergedProjects = [...new Set([...localById.keys(), ...currentById.keys()])].map((id) => {
            const local = localById.get(id);
            const current = currentById.get(id);
            if (!local) return current!;
            if (!current) return local;
            return isLocalProjectNewer(current, local) ? current : local;
        });
        saveToLocalStorage(mergedProjects);
        if (JSON.stringify(currentProjects) !== JSON.stringify(mergedProjects)) useCanvasStore.setState({ projects: mergedProjects });
    } catch {
        // IndexedDB 不可用时保持当前内存状态，错误不会阻塞 Backend hydration。
    }
}

/**
 * 最近一次成功同步里"用户刚提交的字段值"快照，path-based。
 * 用途：syncCanvasProjects 把本地改动写进 Backend 之后，pendingOps 清空；
 * 这时若 MCP / 另一窗口在更晚时刻提交了冲突的字段，applyBackendCanvasEvent
 * 不会因为 pendingOps 为空而漏报——可以拿这份快照去跟 remote 比对，发现"刚同步的
 * 字段被远端覆盖"就当作冲突弹窗。
 *
 * path 形如 ["title"] / ["metadata", "status"] / ["metadata", "segments", "s1", "result"]。
 */
type SyncedChange = { nodeId: string; path: string[]; value: unknown; label: string };
const recentlySyncedChanges: Map<string, Array<SyncedChange>> = new Map();

function getValueAtPath(root: unknown, path: string[]): unknown {
    let current: any = root;
    for (const key of path) {
        if (current == null || typeof current !== "object") return undefined;
        current = current[key];
    }
    return current;
}

function recordSyncedChanges(projectId: string, operations: Array<Record<string, unknown>>) {
    const changes: Array<SyncedChange> = [];
    for (const op of operations) {
        if (op.type === "update_node") {
            const nodeId = String(op.id || "");
            if (!nodeId) continue;
            if (op.patch && typeof op.patch === "object") {
                for (const [key, value] of Object.entries(op.patch as Record<string, unknown>)) {
                    changes.push({ nodeId, path: [key], value, label: `节点「${nodeId}」的「${key}」` });
                }
            }
            if (op.metadata && typeof op.metadata === "object" && !Array.isArray(op.metadata)) {
                for (const [key, value] of Object.entries(op.metadata as Record<string, unknown>)) {
                    // segments 在 H3 走细粒度 op；update_node.metadata.segments 只可能是 replace
                    if (key === "segments") continue;
                    changes.push({ nodeId, path: ["metadata", key], value, label: `节点「${nodeId}」的 metadata.${key}` });
                }
            }
        } else if (op.type === "update_h3_segment") {
            const nodeId = String(op.nodeId || "");
            const segmentId = String(op.segmentId || "");
            if (!nodeId || !segmentId) continue;
            if (op.patch && typeof op.patch === "object") {
                for (const [key, value] of Object.entries(op.patch as Record<string, unknown>)) {
                    if (key === "id") continue;
                    changes.push({ nodeId, path: ["metadata", "segments", segmentId, key], value, label: `H3 段「${segmentId}」的「${key}」` });
                }
            }
        } else if (op.type === "add_h3_segment") {
            const nodeId = String(op.nodeId || "");
            const segment = (op.segment || {}) as Record<string, unknown>;
            const segmentId = String(segment.id || "");
            if (!nodeId || !segmentId) continue;
            for (const [key, value] of Object.entries(segment)) {
                if (key === "id") continue;
                changes.push({ nodeId, path: ["metadata", "segments", segmentId, key], value, label: `H3 段「${segmentId}」的「${key}」` });
            }
        } else if (op.type === "replace_h3_segments") {
            const nodeId = String(op.nodeId || "");
            const segments = Array.isArray(op.segments) ? op.segments as Array<Record<string, unknown>> : [];
            for (const segment of segments) {
                const segmentId = String(segment.id || "");
                if (!segmentId) continue;
                for (const [key, value] of Object.entries(segment)) {
                    if (key === "id") continue;
                    changes.push({ nodeId, path: ["metadata", "segments", segmentId, key], value, label: `H3 段「${segmentId}」的「${key}」` });
                }
            }
        }
        // delete_h3_segment / add_node / delete_node / connect_nodes / update_project
        // 都不进快照：删除是 no-op 语义，连线和项目级字段现有 conflict 检测已经覆盖。
    }
    if (changes.length) recentlySyncedChanges.set(projectId, changes);
    else recentlySyncedChanges.delete(projectId);
}

function detectRecentlySyncedOverwrites(remote: CanvasProject): CanvasConflictTarget[] {
    const changes = recentlySyncedChanges.get(remote.id);
    if (!changes || !changes.length) return [];
    const targets: CanvasConflictTarget[] = [];
    for (const change of changes) {
        if (!change.nodeId || !change.path.length) continue;
        const remoteNode = remote.nodes.find((n) => n.id === change.nodeId);
        if (!remoteNode) {
            targets.push({ id: `${change.nodeId}:${change.path.join(".")}`, kind: "update", detail: `${change.label} 所属节点已被删除/重排` });
            continue;
        }
        const remoteVal = getValueAtPath(remoteNode, change.path);
        if (JSON.stringify(remoteVal) !== JSON.stringify(change.value)) {
            targets.push({ id: `${change.nodeId}:${change.path.join(".")}`, kind: "update", detail: `${change.label} 被远端覆盖（你的值：${JSON.stringify(change.value).slice(0, 60)}；远端：${JSON.stringify(remoteVal).slice(0, 60)}）` });
        }
    }
    return targets;
}

async function syncCanvasProjects(projects: CanvasProject[], generation: number, forceBackend = false) {
    saveToLocalStorage(projects);
    // 本地首屏快照可能只有项目索引（节点数组为空），在 Backend 共同基线读取完成前
    // 禁止把它当成真实画布提交；否则刷新/关闭页面会把远端节点误判为用户删除并清空项目。
    if (!backendCanvasHydrated) return;
    if (!forceBackend && !useBackendStore.getState().connected) return;
    let currentProjectId = "";
    let currentOperationSignature = "";
    try {
        const ids = new Set(projects.map((project) => project.id));
        for (const project of projects) {
            if (comparedProjects.get(project.id) === project || useCanvasStore.getState().canvasConflicts[project.id]) continue;
            currentProjectId = project.id;
            if (generation !== syncGeneration) return;
            const base = syncBases.get(project.id);
            if (!base) {
                // syncBase 丢失（首次连接、热更新或恢复竞态）时，不能把本地旧快照
                // 直接 upsert 到 Backend；该快照可能已经落后于 MCP / 任务回写。
                // 先读取远端作为共同基线：已有项目走同一套细粒度 diff，只有远端确实
                // 没有该项目时才创建。
                let remote: CanvasProject | undefined;
                try { remote = (await fetchBackendProject(project.id)).project as unknown as CanvasProject; }
                catch (error) { if (!(error instanceof BackendApiError && error.status === 404)) throw error; }
                if (!remote) {
                    const response = await upsertBackendProject(project as unknown as Record<string, unknown>);
                    const saved = response.project as unknown as CanvasProject | undefined;
                    if (saved) syncBases.set(project.id, saved);
                    continue;
                }
                syncBases.set(project.id, remote);
                const operations = diffCanvasProject(remote, project);
                if (!operations.length) {
                    useCanvasStore.setState((state) => ({ projects: state.projects.map((item) => item.id === project.id ? { ...remote, viewport: item.viewport } : item) }));
                    continue;
                }
                currentOperationSignature = canvasOperationSignature(Number(remote.revision || 0), operations);
                if (rejectedSyncSignatures.get(project.id) === currentOperationSignature) continue;
                const response = await applyBackendCanvasOperations(project.id, operations, Number(remote.revision || 0));
                rejectedSyncSignatures.delete(project.id);
                const saved = applyBackendCanvasDelta(remote, response.operations, response.revision, response.updatedAt);
                if (saved) {
                    syncBases.set(project.id, saved);
                    const current = useCanvasStore.getState().projects.find((item) => item.id === project.id);
                    if (current?.updatedAt === project.updatedAt) {
                        useCanvasStore.setState((state) => ({ projects: state.projects.map((item) => item.id === project.id ? { ...saved, viewport: item.viewport } : item) }));
                    } else {
                        syncRequested = true;
                    }
                }
                continue;
            }
            const operations = diffCanvasProject(base, project);
            if (!operations.length) {
                comparedProjects.set(project.id, project);
                // syncBase 是 Backend 的权威基线，不能用本地投影替换它。
                // H3 的运行状态/结果字段刻意不进入 diff；若这里写入本地快照，
                // 过期的 loading/result 就会伪装成最新远端基线。
                continue;
            }
            recordSyncedChanges(project.id, operations);
            currentOperationSignature = canvasOperationSignature(Number(base.revision || 0), operations);
            if (rejectedSyncSignatures.get(project.id) === currentOperationSignature) continue;
            const response = await applyBackendCanvasOperations(project.id, operations, Number(base.revision || 0));
            rejectedSyncSignatures.delete(project.id);
            const saved = applyBackendCanvasDelta(base, response.operations, response.revision, response.updatedAt);
            if (saved) {
                syncBases.set(project.id, saved);
                const current = useCanvasStore.getState().projects.find((item) => item.id === project.id);
                if (current === project) {
                    const projection = { ...saved, viewport: project.viewport };
                    useCanvasStore.setState((state) => ({ projects: state.projects.map((item) => item.id === project.id ? projection : item) }));
                    comparedProjects.set(project.id, projection);
                    persistCurrentCanvasSnapshot();
                } else syncRequested = true;
            }
        }
        if (generation !== syncGeneration) return;
        const idsToDelete = new Set([
            ...[...knownProjectIds].filter((id) => !ids.has(id)),
            ...pendingDeletedProjectIds,
        ]);
        await Promise.all([...idsToDelete].map(async (id) => {
            await deleteBackendProject(id);
            pendingDeletedProjectIds.delete(id);
            knownProjectIds.delete(id);
            syncBases.delete(id);
        }));
        persistDeletedProjectIds();
        knownProjectIds = ids;
    } catch (error) {
        if (error instanceof BackendApiError && error.status === 409 && currentProjectId) {
            const remote = error.details.project as CanvasProject | undefined;
            const revision = Number(error.details.revision || remote?.revision || 0);
            const pending = useCanvasStore.getState().projects.find((item) => item.id === currentProjectId);
            if (!pending) return;
            // 冲突判断必须基于本次提交前的共同基线。若先把 syncBase 改成 remote，
            // detectCanvasConflicts 会拿 remote 和自身比较，永远得出“无冲突”，随后
            // 自动重提整份本地旧 metadata，把 MCP / 生成任务刚写入的 segments 覆盖掉。
            const base = syncBases.get(currentProjectId);
            const pendingOps = base ? diffCanvasProject(base, pending) : [];
            const conflicts = remote ? detectCanvasConflicts(pendingOps, remote, base) : [];
            // 与 applyBackendCanvasEvent 对齐：无真正冲突的 ops（update_project /
            // delete 已经在远端没的节点 / disconnect 已经在远端没的连线）走自动 rebase，
            // 不要再弹窗——否则用户拖动一下画布也会看到冲突提示。
            if (conflicts.length === 0) {
                if (remote) {
                    const rebased = { ...applyBackendCanvasDelta(remote, pendingOps, revision, pending.updatedAt), viewport: pending.viewport };
                    syncBases.set(currentProjectId, remote);
                    useCanvasStore.setState((state) => ({ projects: state.projects.map((item) => item.id === currentProjectId ? rebased : item) }));
                    scheduleCanvasSync();
                }
                return;
            }
            useCanvasStore.setState((state) => ({
                canvasConflicts: {
                    ...state.canvasConflicts,
                    [currentProjectId]: {
                        message: "画布已被其他窗口更新，你的操作与远端改动冲突",
                        revision,
                        pendingOperations: pendingOps.length,
                        conflictTargets: conflicts,
                        remoteProject: remote || pending,
                    },
                },
            }));
            window.dispatchEvent(new CustomEvent("canvas-sync-conflict", { detail: { projectId: currentProjectId, revision } }));
        } else if (error instanceof BackendApiError && error.status === 400 && currentProjectId) {
            if (currentOperationSignature) rejectedSyncSignatures.set(currentProjectId, currentOperationSignature);
            console.error(`画布 ${currentProjectId} 的增量同步被 Backend 拒绝，已停止自动重试；下一次编辑后会重新提交。`, error);
        }
        // 保留本地投影和 syncBases，下一次显式修改会按新 revision 重试待提交操作。
    }
}

function canvasOperationSignature(revision: number, operations: Array<Record<string, unknown>>): string {
    const value = JSON.stringify([revision, operations]);
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `${revision}:${value.length}:${hash >>> 0}`;
}

function fromProjectSummary(value: Record<string, unknown>): CanvasProject {
    return {
        id: String(value.id), title: String(value.title || ""), folderId: value.folderId as string | null,
        revision: Number(value.revision || 0), createdAt: String(value.createdAt || ""), updatedAt: String(value.updatedAt || ""),
        summary: { nodeCount: Number(value.nodeCount || 0), connectionCount: Number(value.connectionCount || 0) },
        nodes: [], connections: [], chatSessions: [], activeChatId: null,
        backgroundMode: "lines", showImageInfo: false, globalPrompt: "", viewport: initialViewport,
    };
}

/** 列表摘要不参与节点编辑；只有打开、导出、同步副本或清理媒体时才加载完整详情。 */
export async function ensureCanvasProjectLoaded(id: string): Promise<CanvasProject> {
    const current = useCanvasStore.getState().projects.find((project) => project.id === id);
    if (current && !current.summary) return current;
    const pending = projectLoads.get(id);
    if (pending) return pending;
    const request = (async () => {
        const remote = normalizeProjectMediaUrls((await fetchBackendProject(id)).project as unknown as CanvasProject);
        if (syncPromise) await syncPromise;
        applyBackendCanvasEvent({ type: "canvas.updated", entityId: id, revision: remote.revision, payload: remote }, true);
        const project = useCanvasStore.getState().projects.find((item) => item.id === id);
        if (!project || project.summary) throw new Error("画布详情加载失败，请重试");
        return project;
    })().finally(() => projectLoads.delete(id));
    projectLoads.set(id, request);
    return request;
}

export async function loadAllCanvasProjects() {
    return Promise.all(useCanvasStore.getState().projects.map((project) => ensureCanvasProjectLoaded(project.id)));
}

async function hydrateCanvasProjectsFromBackend() {
    if (!useBackendStore.getState().connected) return false;
    try {
        const previouslyKnownIds = new Set([...knownProjectIds, ...syncBases.keys()]);
        const [response, foldersResponse] = await Promise.all([fetchBackendProjects(true), fetchBackendCanvasFolders()]);
        const summaries = (response.projects || []).map(fromProjectSummary);
        const remoteIds = new Set(summaries.map((project) => project.id));
        for (const summary of summaries) {
            if (pendingDeletedProjectIds.has(summary.id)) continue;
            const local = useCanvasStore.getState().projects.find((project) => project.id === summary.id);
            const base = syncBases.get(summary.id);
            if (base && base.revision === summary.revision && base.updatedAt === summary.updatedAt) continue;
            const remote = local && !local.summary
                ? normalizeProjectMediaUrls((await fetchBackendProject(summary.id)).project as unknown as CanvasProject)
                : summary;
            applyBackendCanvasEvent({ type: "canvas.updated", entityId: remote.id, revision: remote.revision, payload: remote }, true);
        }
        for (const id of previouslyKnownIds) {
            if (remoteIds.has(id)) continue;
            try {
                // 列表读取后可能刚创建/恢复同一项目；确认 404 后才应用远端删除。
                await fetchBackendProject(id, true);
                remoteIds.add(id);
            } catch (error) {
                if (!(error instanceof BackendApiError && error.status === 404)) throw error;
                applyBackendCanvasEvent({ type: "canvas.updated", entityId: id, payload: { deleted: 1 } }, true);
            }
        }
        knownProjectIds = remoteIds;
        const folders = (foldersResponse.folders || []) as unknown as CanvasFolder[];
        knownCanvasFolderIds = new Set(folders.map((folder) => folder.id));
        useCanvasStore.setState({ folders });
        backendCanvasHydrated = true;
        persistCurrentCanvasSnapshot();
        scheduleCanvasSync();
        return true;
    } catch (error) {
        console.error("画布同步恢复失败", error);
        return false;
    }
}

export function isLocalProjectNewer(local: CanvasProject, remote: CanvasProject) {
    if (JSON.stringify(local) === JSON.stringify(remote)) return false;
    const localRevision = Number(local.revision || 0);
    const remoteRevision = Number(remote.revision || 0);
    const localTime = Date.parse(String(local.updatedAt || ""));
    const remoteTime = Date.parse(String(remote.updatedAt || ""));
    // revision 先判断远端是否已经推进；只有本地编辑时间明确晚于远端时，
    // 才把 revision 落后的本地投影视为未提交网页编辑而保留。
    if (remoteRevision > localRevision) {
        return Number.isFinite(localTime) && Number.isFinite(remoteTime) && localTime > remoteTime;
    }
    if (localRevision > remoteRevision) return true;
    return Number.isFinite(localTime) && localTime > remoteTime;
}

export async function hydrateCanvasProjects() {
    if (canvasHydrationPromise) return canvasHydrationPromise;
    canvasHydrationPromise = (async () => {
        // 本地快照是首屏渲染所需的最小数据；Backend 合并放在后面，避免网络连接拖住画布出现。
        if (!localCanvasHydrated) {
            await hydrateCanvasProjectsFromLocalStore();
            localCanvasHydrated = true;
            useCanvasStore.setState({ hydrated: true });
        }
        await hydrateCanvasProjectsFromBackend();
    })().finally(() => { canvasHydrationPromise = null; });
    return canvasHydrationPromise;
}

export const useCanvasStore = create<CanvasStore>()((set, get) => ({
    hydrated: false,
    projects: loadFromLocalStorage().map(normalizeProjectMediaUrls),
    folders: [],
    backendRevisions: {},
    canvasConflicts: {},
    clearCanvasConflict: (id) => set((state) => { const next = { ...state.canvasConflicts }; delete next[id]; return { canvasConflicts: next }; }),
    keepPendingOpsOnCanvasConflict: (id) => {
        const conflict = get().canvasConflicts[id];
        if (!conflict) return;
        const base = syncBases.get(id);
        const local = get().projects.find((project) => project.id === id);
        if (conflict.remoteDeleted) {
            syncBases.delete(id);
            comparedProjects.delete(id);
            knownProjectIds.delete(id);
        } else if (base && local) {
            const rebased = { ...applyBackendCanvasDelta(conflict.remoteProject, diffCanvasProject(base, local), conflict.revision, local.updatedAt), viewport: local.viewport };
            syncBases.set(id, conflict.remoteProject);
            set((state) => ({ projects: state.projects.map((project) => project.id === id ? rebased : project) }));
        }
        set((state) => {
            const next = { ...state.canvasConflicts };
            delete next[id];
            return { canvasConflicts: next, backendRevisions: { ...state.backendRevisions, [id]: conflict.revision } };
        });
        // 同步关闭弹窗后立即按新 revision 主动重提 pendingOps。
        // 否则只能等下一次显式编辑触发 scheduleCanvasSync，pendingOps 一直留在本地，
        // 下一次远端事件 / sync 又会算出冲突并再次弹窗。
        scheduleCanvasSync();
    },
    adoptRemoteOnCanvasConflict: (id) => {
        const conflict = get().canvasConflicts[id];
        if (!conflict) return;
        if (conflict.remoteDeleted) {
            syncBases.delete(id);
            comparedProjects.delete(id);
            knownProjectIds.delete(id);
            set((state) => ({ projects: state.projects.filter((project) => project.id !== id) }));
            persistCurrentCanvasSnapshot();
        } else adoptRemoteProject(conflict.remoteProject);
        set((state) => {
            const next = { ...state.canvasConflicts };
            delete next[id];
            return { canvasConflicts: next };
        });
    },
    createProject: (Title = i18n.t("canvas.project.untitled")) => {
        const now = new Date().toISOString();
        const id = nanoid();
        const project: CanvasProject = {
            id,
            title: Title,
            folderId: null,
            createdAt: now,
            updatedAt: now,
            nodes: [],
            connections: [],
            chatSessions: [],
            activeChatId: null,
            backgroundMode: "lines",
            showImageInfo: false,
            globalPrompt: "",
            viewport: initialViewport,
        };
        set((state) => ({ projects: [project, ...state.projects] }));
        persistCurrentCanvasSnapshot();
        scheduleCanvasSync();
        return id;
    },
    importProject: (source) => {
        const now = new Date().toISOString();
        const project: CanvasProject = {
            id: nanoid(),
            title: source.title || i18n.t("canvas.project.imported"),
            folderId: source.folderId ?? null,
            createdAt: source.createdAt || now,
            updatedAt: now,
            nodes: source.nodes || [],
            connections: source.connections || [],
            chatSessions: source.chatSessions || [],
            activeChatId: source.activeChatId || null,
            backgroundMode: source.backgroundMode || "lines",
            showImageInfo: source.showImageInfo || false,
            globalPrompt: source.globalPrompt || "",
            viewport: normalizeViewportTransform(source.viewport),
        };
        set((state) => ({ projects: [project, ...state.projects] }));
        persistCurrentCanvasSnapshot();
        scheduleCanvasSync();
        void importLegacyGenerationLogs(project.id, (source as Partial<CanvasProject> & { logs?: unknown[] }).logs);
        return project.id;
    },
    createFolder: (name = "新文件夹") => {
        const now = new Date().toISOString();
        const folder = { id: nanoid(), name: name.trim() || "新文件夹", createdAt: now, updatedAt: now, outline: "", description: "", coverStorageKey: null, tags: [] };
        set((state) => ({ folders: [...state.folders, folder] }));
        scheduleCanvasFolderSync();
        return folder.id;
    },
    renameFolder: (id, name) => {
        const updatedAt = new Date().toISOString();
        set((state) => ({ folders: state.folders.map((folder) => folder.id === id ? { ...folder, name: name.trim() || folder.name, updatedAt } : folder) }));
        scheduleCanvasFolderSync();
    },
    updateFolder: (id, patch) => {
        const updatedAt = new Date().toISOString();
        set((state) => ({ folders: state.folders.map((folder) => folder.id === id ? { ...folder, ...patch, updatedAt } : folder) }));
        scheduleCanvasFolderSync();
    },
    deleteFolder: (id) => {
        set((state) => ({
            folders: state.folders.filter((folder) => folder.id !== id),
            projects: state.projects.map((project) => project.folderId === id ? { ...project, folderId: null, updatedAt: new Date().toISOString() } : project),
        }));
        persistCurrentCanvasSnapshot();
        scheduleCanvasFolderSync();
        scheduleCanvasSync();
    },
    moveProjectsToFolder: (ids, folderId) => {
        const idSet = new Set(ids);
        set((state) => ({ projects: state.projects.map((project) => idSet.has(project.id) ? { ...project, folderId, updatedAt: new Date().toISOString() } : project) }));
        persistCurrentCanvasSnapshot();
        scheduleCanvasSync();
    },
    replaceFolders: (folders) => {
        set({ folders });
        scheduleCanvasFolderSync();
    },
    openProject: (id) => {
        return get().projects.find((item) => item.id === id) || null;
    },
    renameProject: (id, title) => {
        set((state) => ({
            projects: state.projects.map((project) => (project.id === id ? { ...project, title: title.trim() || project.title, updatedAt: new Date().toISOString() } : project)),
        }));
        persistCurrentCanvasSnapshot();
        scheduleCanvasSync();
    },
    deleteProjects: (ids) => {
        for (const id of ids) pendingDeletedProjectIds.add(id);
        persistDeletedProjectIds();
        set((state) => {
            const projects = state.projects.filter((project) => !ids.includes(project.id));
            return { projects };
        });
        persistCurrentCanvasSnapshot();
        scheduleCanvasSync();
        // 治本:删除意图一旦产生,立即强制同步到后端(绕过 connected 门禁,只要已 hydrate)。
        // 删除几乎实时落到后端,而不是被动等下一次 sync;标记已持久化,即使本次未连上,
        // 重连后 syncCanvasProjects 仍会兜底补删。
        if (useBackendStore.getState().connected) void flushCanvasSyncNow();
    },
    replaceProjects: (projects) => { set({ projects: projects.map((project) => ({ ...project, viewport: normalizeViewportTransform(project.viewport) })) }); persistCurrentCanvasSnapshot(); scheduleCanvasSync(); },
    updateProject: (id, patch) => {
        const normalizedPatch = patch.viewport ? { ...patch, viewport: normalizeViewportTransform(patch.viewport) } : patch;
        set((state) => ({
            projects: state.projects.map((project) => (project.id === id ? { ...project, ...normalizedPatch, updatedAt: new Date().toISOString() } : project)),
        }));
        persistCurrentCanvasSnapshot();
        scheduleCanvasSync();
    },
}));

function scheduleCanvasSync() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        syncRequested = true;
        if (!syncPromise) {
            syncPromise = flushCanvasSync().finally(() => {
                syncPromise = null;
                if (syncRequested) scheduleCanvasSync();
            });
        }
    }, 400);
}

/** 立即提交当前画布投影；生成任务绑定节点时用它建立落库时序。 */
export async function flushCanvasSyncNow() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    while (true) {
        syncRequested = true;
        if (!syncPromise) {
                syncPromise = flushCanvasSync(true).finally(() => {
                syncPromise = null;
                if (syncRequested) scheduleCanvasSync();
            });
        }
        await syncPromise;
        if (!syncRequested && !syncPromise) return;
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
    }
}

async function flushCanvasSync(forceBackend = false) {
    while (syncRequested) {
        syncRequested = false;
        const generation = syncGeneration;
        await syncCanvasProjects(useCanvasStore.getState().projects, generation, forceBackend);
        if (generation !== syncGeneration) syncRequested = true;
    }
}

export function diffCanvasProject(base: CanvasProject, next: CanvasProject): Array<Record<string, unknown>> {
    if (base === next) return [];
    const operations: Array<Record<string, unknown>> = [];
    if (base.summary || next.summary) {
        const patch: Record<string, unknown> = {};
        for (const key of ["title", "folderId"] as const) if (base[key] !== next[key]) patch[key] = next[key];
        return Object.keys(patch).length ? [{ type: "update_project", patch }] : [];
    }
    const baseNodes = new Map(base.nodes.map((node) => [node.id, node]));
    const nextNodes = new Map(next.nodes.map((node) => [node.id, node]));
    for (const node of next.nodes) {
        if (!baseNodes.has(node.id)) {
            operations.push({ type: "add_node", id: node.id, nodeType: node.type, title: node.title, position: node.position, width: node.width, height: node.height, metadata: node.metadata || {} });
            continue;
        }
        const previous = baseNodes.get(node.id)!;
        if (previous === node) continue;
        const patch: Record<string, unknown> = {};
        for (const key of ["type", "title", "position", "width", "height"] as const) {
            if (JSON.stringify(previous[key]) !== JSON.stringify(node[key])) patch[key] = node[key];
        }
        const previousMetadata = (previous.metadata || {}) as Record<string, unknown>;
        const nextMetadata = (node.metadata || {}) as Record<string, unknown>;
        const metadataPatch: Record<string, unknown> = {};
        const metadataDelete: string[] = [];
        // H3 节点：metadata.segments 走细粒度 op（add/update/delete_h3_segment），从 metadataPatch 中剥离，
        // 这样同一节点下「编辑 segment A」与「更新节点级字段」就不会互相阻塞。
        const isH3 = isH3NodeType(String(previous.type || node.type || ""));
        const previousSegments = isH3 && Array.isArray(previousMetadata.segments) ? previousMetadata.segments as Array<Record<string, unknown>> : [];
        const nextSegments = isH3 && Array.isArray(nextMetadata.segments) ? nextMetadata.segments as Array<Record<string, unknown>> : [];
        const metadataKeysToSkip = new Set<string>();
        if (isH3) metadataKeysToSkip.add("segments");
        for (const key of new Set([...Object.keys(previousMetadata), ...Object.keys(nextMetadata)])) {
            if (metadataKeysToSkip.has(key)) continue;
            if (isH3 && H3_BACKEND_NODE_METADATA_FIELDS.has(key)) continue;
            if (JSON.stringify(previousMetadata[key]) === JSON.stringify(nextMetadata[key])) continue;
            if (key in nextMetadata && nextMetadata[key] !== undefined) metadataPatch[key] = nextMetadata[key];
            else metadataDelete.push(key);
        }
        if (Object.keys(metadataPatch).length || metadataDelete.length) operations.push({ type: "update_node", id: node.id, patch, ...(Object.keys(metadataPatch).length ? { metadata: metadataPatch } : {}), ...(metadataDelete.length ? { metadataDelete } : {}) });
        else if (Object.keys(patch).length) operations.push({ type: "update_node", id: node.id, patch });
        // H3 segments 差异 → 细粒度 op
        if (isH3) {
            const baseById = new Map(previousSegments.map((segment) => [String(segment.id || ""), segment]));
            const nextById = new Map(nextSegments.map((segment) => [String(segment.id || ""), segment]));
            for (const segment of nextSegments) {
                const id = String(segment.id || "");
                if (!id) continue;
                if (!baseById.has(id)) {
                    operations.push({ type: "add_h3_segment", nodeId: node.id, segment: segment });
                } else if (JSON.stringify(baseById.get(id)) !== JSON.stringify(segment)) {
                    // 字段级 patch：只把真正变化的字段放进 patch，减少带宽 / 减少冲突面
                    const baseSegment = baseById.get(id)!;
                    const segmentPatch: Record<string, unknown> = {};
                    const segmentDelete: string[] = [];
                    for (const field of new Set([...Object.keys(baseSegment), ...Object.keys(segment)])) {
                        if (field === "id") continue;
                        if (H3_BACKEND_SEGMENT_FIELDS.has(field)) continue;
                        if (JSON.stringify((baseSegment as Record<string, unknown>)[field]) === JSON.stringify((segment as Record<string, unknown>)[field])) continue;
                        if (field in segment && (segment as Record<string, unknown>)[field] !== undefined) segmentPatch[field] = (segment as Record<string, unknown>)[field];
                        else segmentDelete.push(field);
                    }
                    if (Object.keys(segmentPatch).length || segmentDelete.length) {
                        operations.push({
                            type: "update_h3_segment",
                            nodeId: node.id,
                            segmentId: id,
                            patch: segmentPatch,
                            ...(segmentDelete.length ? { patchDelete: segmentDelete } : {}),
                        });
                    }
                }
            }
            for (const segment of previousSegments) {
                const id = String(segment.id || "");
                if (!id) continue;
                if (!nextById.has(id)) operations.push({ type: "delete_h3_segment", nodeId: node.id, segmentId: id });
            }
        }
    }
    for (const node of base.nodes) if (!nextNodes.has(node.id)) operations.push({ type: "delete_node", id: node.id });

    const baseConnections = new Map(base.connections.map((connection) => [connection.id, connection]));
    const nextConnections = new Map(next.connections.map((connection) => [connection.id, connection]));
    const removedConnections = base.connections.filter((connection) => !nextConnections.has(connection.id)).map((connection) => connection.id);
    if (removedConnections.length) operations.push({ type: "delete_connections", ids: removedConnections });
    for (const connection of next.connections) {
        const previous = baseConnections.get(connection.id);
        if (!previous || JSON.stringify(previous) !== JSON.stringify(connection)) {
            if (previous) operations.push({ type: "delete_connections", ids: [connection.id] });
            operations.push({ type: "connect_nodes", id: connection.id, fromNodeId: connection.fromNodeId, toNodeId: connection.toNodeId, role: connection.role, order: connection.order });
        }
    }
    const projectPatch: Record<string, unknown> = {};
    for (const key of ["title", "folderId", "chatSessions", "activeChatId", "backgroundMode", "showImageInfo", "globalPrompt"] as const) {
        if (JSON.stringify(base[key]) !== JSON.stringify(next[key])) projectPatch[key] = next[key];
    }
    if (Object.keys(projectPatch).length) operations.push({ type: "update_project", patch: projectPatch });
    return operations;
}

function isH3NodeType(type: string): boolean {
    return /^minimax|^smart-minimax/.test(type);
}

/** 检查 pendingOps 在 remote 上是否仍然合法：每条 op 的目标必须和 remote 一致才视为无冲突。
 *  - add_node        → 远端已存在同 id = 冲突（会被 update 覆盖或重命名丢失）
 *  - update_node     → 节点被删，或同一字段已被远端改动 = 冲突（避免旧快照覆盖 MCP/其它窗口的更新）
 *  - delete_node     → 远端已无此 id = no-op（不算冲突）
 *  - connect_nodes   → 远端已有同 id connection = 冲突（重复 connect）
 *  - delete_connections → 远端已无此 id = no-op
 *  - update_project → 不算冲突（覆盖语义安全） */
export function detectCanvasConflicts(pendingOps: Array<Record<string, unknown>>, remote: CanvasProject, base?: CanvasProject): CanvasConflictTarget[] {
    const remoteNodeIds = new Set(remote.nodes.map((node) => node.id));
    const remoteConnectionIds = new Set(remote.connections.map((connection) => connection.id));
    const baseNodes = new Map((base?.nodes || []).map((node) => [node.id, node]));
    const remoteNodes = new Map(remote.nodes.map((node) => [node.id, node]));
    const targets: CanvasConflictTarget[] = [];
    for (const op of pendingOps) {
        const type = op.type as string;
        if (type === "add_node") {
            const id = String(op.id || "");
            if (id && remoteNodeIds.has(id)) targets.push({ id, kind: "add", detail: `节点「${String(op.title || id)}」在远端已存在，重复添加会被覆盖` });
        } else if (type === "update_node") {
            const id = String(op.id || "");
            if (id && !remoteNodeIds.has(id)) targets.push({ id, kind: "update", detail: `要更新的节点「${id}」在远端已被删除` });
            else if (id && base) {
                const baseNode = baseNodes.get(id);
                const remoteNode = remote.nodes.find((node) => node.id === id);
                const baseMetadata = (baseNode?.metadata || {}) as Record<string, unknown>;
                const remoteMetadata = (remoteNode?.metadata || {}) as Record<string, unknown>;
                const opMetadata = (op.metadata || {}) as Record<string, unknown>;
                // segments 字段在 H3 上由细粒度 op 处理；update_node 上不应再携带 segments。
                if (Object.prototype.hasOwnProperty.call(opMetadata, "segments")) {
                    targets.push({ id, kind: "update", detail: `节点「${id}」上的 segments 必须走细粒度 op（update/add/delete_h3_segment），不能直接 update_node.metadata.segments` });
                }
                const metadataKeys = [
                    ...Object.keys(opMetadata).filter((key) => key !== "segments"),
                    ...(Array.isArray(op.metadataDelete) ? op.metadataDelete.map(String).filter((key) => key !== "segments") : []),
                ];
                const patchKeys = Object.keys((op.patch || {}) as Record<string, unknown>);
                const metadataConflict = metadataKeys.some((key) => JSON.stringify(baseMetadata[key]) !== JSON.stringify(remoteMetadata[key]));
                const patchConflict = patchKeys.some((key) => JSON.stringify((baseNode as Record<string, unknown> | undefined)?.[key]) !== JSON.stringify((remoteNode as Record<string, unknown> | undefined)?.[key]));
                if (metadataConflict || patchConflict) targets.push({ id, kind: "update", detail: `节点「${id}」的字段已被远端更新，本地旧快照不会覆盖它` });
            }
        } else if (type === "delete_node") {
            const id = String(op.id || "");
            if (id && !remoteNodeIds.has(id)) continue; // no-op
        } else if (type === "connect_nodes") {
            const id = String(op.id || "");
            if (id && remoteConnectionIds.has(id)) targets.push({ id, kind: "connect", detail: `连线「${id}」在远端已存在` });
        } else if (type === "delete_connections") {
            const ids = Array.isArray(op.ids) ? op.ids.map(String) : [];
            if (!ids.some((id) => remoteConnectionIds.has(id))) continue; // no-op
        } else if (type === "add_h3_segment" || type === "update_h3_segment" || type === "delete_h3_segment") {
            // H3 细粒度 op 的冲突检测：节点 + 段 + 字段三元组。
            const nodeId = String(op.nodeId || "");
            const segmentId = type === "add_h3_segment" ? String((op.segment as Record<string, unknown> | undefined)?.id || "") : String(op.segmentId || "");
            if (!nodeId) continue;
            const remoteNode = remoteNodes.get(nodeId);
            if (!remoteNode) { targets.push({ id: `${nodeId}:${segmentId}`, kind: "update", detail: `H3 段「${segmentId}」所属节点「${nodeId}」在远端已被删除` }); continue; }
            const remoteMetadata = (remoteNode.metadata || {}) as Record<string, unknown>;
            const remoteSegments = Array.isArray(remoteMetadata.segments) ? remoteMetadata.segments as Array<Record<string, unknown>> : [];
            const baseNode = baseNodes.get(nodeId);
            const baseMetadata = (baseNode?.metadata || {}) as Record<string, unknown>;
            const baseSegments = Array.isArray(baseMetadata.segments) ? baseMetadata.segments as Array<Record<string, unknown>> : [];
            const remoteSeg = remoteSegments.find((s) => String(s.id || "") === segmentId);
            const baseSeg = baseSegments.find((s) => String(s.id || "") === segmentId);
            if (type === "add_h3_segment") {
                if (remoteSeg) targets.push({ id: `${nodeId}:${segmentId}`, kind: "update", detail: `H3 段「${segmentId}」在远端已存在，重复添加会被覆盖` });
            } else if (type === "delete_h3_segment") {
                if (!remoteSeg) continue; // no-op：远端已删
            } else if (type === "update_h3_segment") {
                if (!remoteSeg) { targets.push({ id: `${nodeId}:${segmentId}`, kind: "update", detail: `H3 段「${segmentId}」在远端已被删除，本地无法更新` }); continue; }
                if (!baseSeg) { targets.push({ id: `${nodeId}:${segmentId}`, kind: "update", detail: `H3 段「${segmentId}」本地无基准，疑似新建与并发更新并存` }); continue; }
                // 字段级冲突：本地 patch 中的字段如果 base==remote（未被远端改）则安全；否则冲突
                const patch = (op.patch || {}) as Record<string, unknown>;
                const fields = new Set([...Object.keys(patch), ...(Array.isArray(op.patchDelete) ? op.patchDelete.map(String) : [])]);
                const conflictFields: string[] = [];
                for (const field of fields) {
                    const baseVal = (baseSeg as Record<string, unknown>)[field];
                    const remoteVal = (remoteSeg as Record<string, unknown>)[field];
                    if (JSON.stringify(baseVal) !== JSON.stringify(remoteVal)) conflictFields.push(field);
                }
                if (conflictFields.length) targets.push({ id: `${nodeId}:${segmentId}`, kind: "update", detail: `H3 段「${segmentId}」的字段 ${conflictFields.slice(0, 3).join("、")}${conflictFields.length > 3 ? " 等" : ""} 在远端已被更新` });
            }
        }
        // update_project / delete_node(no-op) 都不算冲突
    }
    return targets;
}

/** 把后端远端项目合并进本地 store（不会修改任何用户字段）并推进 syncBase，
 *  用于"采用远端"决策：直接拿远端覆盖本地，等价于丢弃本地未提交 ops。 */
function adoptRemoteProject(remote: CanvasProject) {
    useCanvasStore.setState((state) => {
        const nextProjects = state.projects.some((p) => p.id === remote.id)
            ? state.projects.map((p) => p.id === remote.id ? { ...remote, viewport: p.viewport } : p)
            : [remote, ...state.projects];
        saveToLocalStorage(nextProjects);
        return { projects: nextProjects, backendRevisions: { ...state.backendRevisions, [remote.id]: Number(remote.revision || 0) } };
    });
    syncBases.set(remote.id, remote);
    persistCurrentCanvasSnapshot();
}

/** 将 Backend 的 canvas.updated 差量应用到一个远端基线；视口始终不在操作集合内。 */
export function applyBackendCanvasDelta(base: CanvasProject, operations: Array<Record<string, unknown>>, revision: number, updatedAt?: string): CanvasProject {
    const changedIds = new Set(operations.filter((operation) => operation.type === "update_node" || String(operation.type).includes("h3_segment")).map((operation) => String(operation.nodeId || operation.id || "")));
    const nodes = base.nodes.map((node) => changedIds.has(node.id) ? { ...node, metadata: node.metadata ? { ...node.metadata } : node.metadata } : node);
    const connections = [...base.connections];
    const projectPatch: Record<string, unknown> = {};
    for (const operation of operations) {
        const type = String(operation.type || "");
        if (type === "add_node") {
            const id = String(operation.id || "");
            if (!id || nodes.some((node) => node.id === id)) continue;
            nodes.push({
                id,
                type: String(operation.nodeType || "text") as CanvasNodeData["type"],
                title: String(operation.title || ""),
                position: (operation.position && typeof operation.position === "object" ? operation.position : { x: Number(operation.x || 0), y: Number(operation.y || 0) }) as CanvasNodeData["position"],
                width: Number(operation.width || 320),
                height: Number(operation.height || 240),
                metadata: (operation.metadata && typeof operation.metadata === "object" ? operation.metadata : {}) as CanvasNodeData["metadata"],
            });
        } else if (type === "update_node") {
            const node = nodes.find((item) => item.id === String(operation.id || ""));
            if (!node) continue;
            Object.assign(node, operation.patch || {});
            if (operation.metadata && typeof operation.metadata === "object" && !Array.isArray(operation.metadata)) node.metadata = { ...((node.metadata || {}) as Record<string, unknown>), ...(operation.metadata as Record<string, unknown>) } as CanvasNodeData["metadata"];
            if (Array.isArray(operation.metadataDelete)) {
                const metadata = { ...((node.metadata || {}) as Record<string, unknown>) };
                for (const key of operation.metadataDelete.map(String)) delete metadata[key];
                node.metadata = metadata as CanvasNodeData["metadata"];
            }
        } else if (type === "delete_node") {
            const ids = new Set((Array.isArray(operation.ids) ? operation.ids : [operation.id]).filter(Boolean).map(String));
            for (let index = nodes.length - 1; index >= 0; index--) if (ids.has(nodes[index].id)) nodes.splice(index, 1);
            for (let index = connections.length - 1; index >= 0; index--) if (ids.has(connections[index].fromNodeId) || ids.has(connections[index].toNodeId)) connections.splice(index, 1);
        } else if (type === "delete_connections") {
            if (operation.all) connections.splice(0, connections.length);
            else {
                const ids = new Set((Array.isArray(operation.ids) ? operation.ids : [operation.id]).filter(Boolean).map(String));
                for (let index = connections.length - 1; index >= 0; index--) if (ids.has(connections[index].id)) connections.splice(index, 1);
            }
        } else if (type === "connect_nodes") {
            const id = String(operation.id || "");
            if (id && !connections.some((connection) => connection.id === id)) connections.push({ id, fromNodeId: String(operation.fromNodeId || ""), toNodeId: String(operation.toNodeId || ""), ...(operation.role ? { role: String(operation.role) } : {}), ...(operation.order === undefined ? {} : { order: Number(operation.order) }) });
        } else if (type === "update_h3_segment" || type === "add_h3_segment" || type === "delete_h3_segment" || type === "replace_h3_segments") {
            const node = nodes.find((item) => item.id === String(operation.nodeId || ""));
            if (!node) continue;
            const metadata = { ...((node.metadata || {}) as Record<string, unknown>) };
            const segments = Array.isArray(metadata.segments) ? metadata.segments.map((segment) => ({ ...segment })) as Array<Record<string, unknown>> : [];
            if (type === "replace_h3_segments") metadata.segments = Array.isArray(operation.segments) ? operation.segments : [];
            else if (type === "add_h3_segment" && operation.segment && typeof operation.segment === "object") segments.push({ ...(operation.segment as Record<string, unknown>) });
            else if (type === "delete_h3_segment") metadata.segments = segments.filter((segment) => String(segment.id || "") !== String(operation.segmentId || ""));
            else if (type === "update_h3_segment") {
                const segment = segments.find((item) => String(item.id || "") === String(operation.segmentId || ""));
                if (segment) {
                    Object.assign(segment, operation.patch || {});
                    for (const key of Array.isArray(operation.patchDelete) ? operation.patchDelete.map(String) : []) delete segment[key];
                }
                metadata.segments = segments;
            }
            node.metadata = metadata as CanvasNodeData["metadata"];
        } else if (type === "update_project" && operation.patch && typeof operation.patch === "object") {
            Object.assign(projectPatch, operation.patch);
        } else if (type === "upsert_reference_asset" && operation.asset && typeof operation.asset === "object") {
            const catalog = Array.isArray(projectPatch.referenceCatalog) ? [...projectPatch.referenceCatalog as Array<Record<string, unknown>>] : [...(base.referenceCatalog || [])];
            const asset = operation.asset as Record<string, unknown>;
            const index = catalog.findIndex((item) => String(item.id || "") === String(asset.id || ""));
            if (index >= 0) catalog[index] = { ...catalog[index], ...asset };
            else catalog.push({ ...asset });
            projectPatch.referenceCatalog = catalog;
        } else if (type === "delete_reference_asset") {
            projectPatch.referenceCatalog = (Array.isArray(projectPatch.referenceCatalog) ? projectPatch.referenceCatalog as Array<Record<string, unknown>> : base.referenceCatalog || []).filter((item) => String(item.id || "") !== String(operation.assetId || ""));
        }
    }
    return { ...base, ...projectPatch, nodes, connections, revision, ...(updatedAt ? { updatedAt } : {}) };
}

async function recoverCanvasProjectSnapshot(projectId: string) {
    if (canvasDeltaRecovery.has(projectId)) return;
    canvasDeltaRecovery.add(projectId);
    try {
        const summaryOnly = Boolean(useCanvasStore.getState().projects.find((project) => project.id === projectId)?.summary);
        const response = await fetchBackendProject(projectId, summaryOnly);
        const project = summaryOnly ? fromProjectSummary(response.project) : response.project as unknown as CanvasProject;
        if (project) applyBackendCanvasEvent({ type: "canvas.updated", entityId: projectId, revision: project.revision, payload: project });
    } finally {
        canvasDeltaRecovery.delete(projectId);
    }
}

export function applyBackendCanvasEvent(event: unknown, preservePendingLocalChanges = false) {
    if (!event || typeof event !== "object") return;
    const value = event as { type?: unknown; entityId?: unknown; revision?: unknown; payload?: unknown };
    if (value.type === "canvas-folder.updated") {
        const entityId = typeof value.entityId === "string" ? value.entityId : "";
        const payload = value.payload && typeof value.payload === "object" ? value.payload as Record<string, unknown> : {};
        const deleted = Number(payload.deleted || 0) > 0;
        if (deleted && entityId) {
            useCanvasStore.setState((state) => ({
                folders: state.folders.filter((folder) => folder.id !== entityId),
                projects: state.projects.map((project) => project.folderId === entityId ? { ...project, folderId: null } : project),
            }));
            saveToLocalStorage(useCanvasStore.getState().projects);
            return;
        }
        if (typeof payload.id === "string" && typeof payload.name === "string" && typeof payload.createdAt === "string") {
            const folder = payload as unknown as CanvasFolder;
            useCanvasStore.setState((state) => ({ folders: state.folders.some((item) => item.id === folder.id) ? state.folders.map((item) => item.id === folder.id ? folder : item) : [...state.folders, folder] }));
            knownCanvasFolderIds.add(folder.id);
        }
        return;
    }
    if (value.type !== "canvas.updated") return;
    if (syncPromise) {
        deferredBackendEvents.push(event);
        if (!deferredBackendEventsWaiter) {
            const currentSync = syncPromise;
            deferredBackendEventsWaiter = currentSync.finally(() => {
                deferredBackendEventsWaiter = null;
                const pending = deferredBackendEvents;
                deferredBackendEvents = [];
                pending.forEach((item) => applyBackendCanvasEvent(item, true));
            });
        }
        return;
    }
    const payload = value.payload;
    const isProject = (item: unknown): item is CanvasProject => Boolean(
        item && typeof item === "object"
        && typeof (item as { id?: unknown }).id === "string"
        && Array.isArray((item as { nodes?: unknown }).nodes)
        && Array.isArray((item as { connections?: unknown }).connections),
    );
    const isProjectList = payload && typeof payload === "object" && Array.isArray((payload as { projects?: unknown }).projects);
    const entityId = typeof value.entityId === "string" ? value.entityId : "";
    const isDelta = Boolean(payload && typeof payload === "object" && Array.isArray((payload as { operations?: unknown }).operations));
    if (isDelta && entityId) {
        const base = syncBases.get(entityId);
        const revision = Number(value.revision || 0);
        const baseRevision = Number(base?.revision || 0);
        if (!base || base.summary || revision > baseRevision + 1) {
            void recoverCanvasProjectSnapshot(entityId).catch((error) => console.error("画布差量恢复失败", error));
            return;
        }
        if (revision <= baseRevision) return;
    }
    const projects = isDelta && entityId
        ? [applyBackendCanvasDelta(syncBases.get(entityId)!, (payload as { operations: Array<Record<string, unknown>> }).operations, Number(value.revision || 0), String((payload as { updatedAt?: unknown }).updatedAt || ""))]
        : isProjectList
        ? (payload as { projects: unknown[] }).projects.filter(isProject).map(normalizeProjectMediaUrls)
        : isProject(payload) ? [normalizeProjectMediaUrls(payload)] : [];
    const deleted = payload && typeof payload === "object" && Number((payload as { deleted?: unknown }).deleted || 0) > 0;
    if (!isProjectList && !projects.length && !(deleted && entityId)) return;
    if (isProjectList) {
        for (const project of projects) applyBackendCanvasEvent({ type: "canvas.updated", entityId: project.id, revision: project.revision, payload: project }, true);
        return;
    }
    if (projects[0]?.summary) {
        const local = useCanvasStore.getState().projects.find((project) => project.id === projects[0].id);
        if (local && !local.summary) {
            if (Number(projects[0].revision || 0) > Number(syncBases.get(local.id)?.revision || 0)) {
                void recoverCanvasProjectSnapshot(local.id).catch((error) => console.error("画布详情恢复失败", error));
            }
            return;
        }
    }
    syncGeneration += 1;
    useCanvasStore.setState((state) => {
        let nextProjects = state.projects;
        const nextRevisions = { ...state.backendRevisions };
        if (projects.length) {
            const remote = projects[0];
            // 治本:已标记删除的画布,任何来自后端的单画布推送都忽略,避免复活。
            if (pendingDeletedProjectIds.has(remote.id)) {
                scheduleCanvasSync(); // 后端仍残留则补删
                return state;
            }
            const local = state.projects.find((project) => project.id === remote.id);
            const remoteForStore = local ? { ...remote, viewport: local.viewport } : remote;
            const remoteRevision = Number(remote.revision || value.revision || 0);
            const knownRevision = Number(local?.revision ?? nextRevisions[remote.id] ?? 0);
            if (remoteRevision < knownRevision) return state;
            if (local && JSON.stringify(local) === JSON.stringify(remoteForStore)) return state;
            // 关键：本地还有未提交 ops 时，不能直接用 remote 覆盖本地（会丢用户操作）。
            // 算出本地相对于 syncBase 的 pendingOps，检测其中是否有目标已经在 remote 里
            // 被别人改 / 删的目标，命中就写入冲突状态、由用户决定"保留 / 采用远端"；
            // 没冲突就推进 syncBase + 接受 remote，pendingOps 在新 base 上自然 rebase。
            const base = syncBases.get(remote.id);
            const pendingOps = base && local ? diffCanvasProject(base, local) : [];
            // 不论 pendingOps 是不是空，先把刚同步的"用户提交值快照"跟远端对一遍——
            // 之前「pendingOps 为空 → 直接拿 remote 覆盖 local」会把你刚 sync 的字段悄悄
            // 抹掉，这里把任何刚同步的字段被覆盖都升级成冲突弹窗。
            const recentOverwrites = detectRecentlySyncedOverwrites(remote);
            if (recentOverwrites.length) {
                recentlySyncedChanges.delete(remote.id);
                return {
                    projects: state.projects,
                    backendRevisions: { ...state.backendRevisions, [remote.id]: remoteRevision },
                    canvasConflicts: {
                        ...state.canvasConflicts,
                        [remote.id]: {
                            message: "你刚才改的字段被 MCP / 任务回写覆盖",
                            revision: remoteRevision,
                            pendingOperations: pendingOps.length,
                            conflictTargets: recentOverwrites,
                            remoteProject: remote,
                        },
                    },
                };
            }
            if (local && pendingOps.length) {
                const conflicts = detectCanvasConflicts(pendingOps, remote, base);
                if (conflicts.length) {
                    return {
                        projects: state.projects,
                        backendRevisions: { ...state.backendRevisions, [remote.id]: remoteRevision },
                        canvasConflicts: {
                            ...state.canvasConflicts,
                            [remote.id]: {
                                message: "画布已被其他窗口更新，你的操作与远端改动冲突",
                                revision: remoteRevision,
                                pendingOperations: pendingOps.length,
                                conflictTargets: conflicts,
                                remoteProject: remote,
                            },
                        },
                    };
                }
                const rebased = { ...applyBackendCanvasDelta(remote, pendingOps, remoteRevision, local.updatedAt), viewport: local.viewport };
                syncBases.set(remote.id, remote);
                setTimeout(scheduleCanvasSync, 0);
                return {
                    projects: state.projects.map((item) => item.id === remote.id ? rebased : item),
                    backendRevisions: { ...state.backendRevisions, [remote.id]: remoteRevision },
                };
            }
            nextProjects = state.projects.some((project) => project.id === remote.id)
                ? state.projects.map((project) => project.id === remote.id ? remoteForStore : project)
                : [remoteForStore, ...state.projects];
            nextRevisions[remote.id] = remoteRevision || (nextRevisions[remote.id] || 0) + 1;
            syncBases.set(remote.id, remote);
        } else if (deleted) {
            const local = state.projects.find((project) => project.id === entityId);
            const base = syncBases.get(entityId);
            const pendingOps = local && base ? diffCanvasProject(base, local) : [];
            if (local && pendingOps.length && !pendingDeletedProjectIds.has(entityId)) {
                return { canvasConflicts: { ...state.canvasConflicts, [entityId]: {
                    message: "画布已在远端删除，本地仍有未提交修改",
                    revision: Number(base?.revision || 0), pendingOperations: pendingOps.length,
                    conflictTargets: [{ id: entityId, kind: "delete", detail: "保留我的将重新创建画布；采用远端将移除本地画布" }],
                    remoteProject: local, remoteDeleted: true,
                } } };
            }
            syncBases.delete(entityId);
            comparedProjects.delete(entityId);
            knownProjectIds.delete(entityId);
            pendingDeletedProjectIds.delete(entityId);
            persistDeletedProjectIds();
            if (!state.projects.some((project) => project.id === entityId)) return state;
            nextProjects = state.projects.filter((project) => project.id !== entityId);
            nextRevisions[entityId] = (nextRevisions[entityId] || 0) + 1;
        }
        saveToLocalStorage(nextProjects);
        return { projects: nextProjects, backendRevisions: nextRevisions };
    });
    persistCurrentCanvasSnapshot();
}

if (typeof window !== "undefined") {
    void hydrateCanvasProjects();
    window.addEventListener("backend-connected", () => {
        void hydrateCanvasProjects();
        // 治本:重连后若有尚未落后端的删除标记,强制补删(双保险)。
        if (pendingDeletedProjectIds.size) scheduleCanvasSync();
    });
    window.addEventListener("backend-event", (event) => applyBackendCanvasEvent((event as CustomEvent).detail));
    const flushCanvasPersistence = () => {
        if (localSnapshotTimer) {
            clearTimeout(localSnapshotTimer);
            localSnapshotTimer = null;
        }
        void persistCanvasSnapshot(useCanvasStore.getState().projects);
        void flushCanvasSyncNow();
    };
    window.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flushCanvasPersistence();
    });
    window.addEventListener("pagehide", flushCanvasPersistence);
}

async function importLegacyGenerationLogs(projectId: string, value: unknown) {
    if (!Array.isArray(value) || !useBackendStore.getState().connected) return;
    for (const item of value.slice(0, 500)) {
        if (!item || typeof item !== "object") continue;
        const log = item as Record<string, unknown>;
        const request = log.request && typeof log.request === "object" ? log.request as Record<string, unknown> : {};
        const media = (input: unknown) => Array.isArray(input) ? input.filter((entry) => entry && typeof entry === "object").map((entry) => {
            const copy = { ...(entry as Record<string, unknown>) };
            if (typeof copy.dataUrl === "string" && copy.dataUrl.startsWith("data:")) delete copy.dataUrl;
            return copy;
        }) : [];
        try {
            await createBackendGenerationLog({
                projectId, nodeId: typeof log.nodeId === "string" ? log.nodeId : undefined, status: log.status === "failed" ? "failed" : "success",
                platform: String(log.platform || "Generate"), workflow: typeof request.workflow_json === "string" ? request.workflow_json : undefined,
                model: typeof log.model === "string" ? log.model : undefined, prompt: typeof log.prompt === "string" ? log.prompt : "",
                references: media(log.refs), inputCounts: {}, runtimeTaskId: String(request.task_id || request.taskId || "") || undefined,
                startedAt: new Date(Number(log.createdAt) || Date.now()).toISOString(), durationMs: Number(log.runMs || 0), outputs: media(log.outputs),
                error: typeof log.error === "string" ? log.error : undefined, params: { ...request, legacyLogId: typeof log.id === "string" ? log.id : undefined },
            });
        } catch { /* imported logs are best-effort and must not block project import */ }
    }
}

/** Backend 只保存 storageKey/相对媒体路径；浏览器投影统一展开成 Backend 可读 URL。 */
function normalizeProjectMediaUrls(project: CanvasProject): CanvasProject {
    const normalizeMetadata = (metadata: Record<string, unknown> | undefined) => {
        if (!metadata) return metadata;
        const next = { ...metadata };
        const normalizeMedia = (value: unknown) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) return value;
            const media = { ...(value as Record<string, unknown>) };
            if (typeof media.storageKey === "string" && media.storageKey) media.url = backendMediaUrl(media.storageKey);
            return media;
        };
        const storageKey = typeof next.storageKey === "string" ? next.storageKey : "";
        if (storageKey) {
            next.content = backendMediaUrl(storageKey);
            next.url = backendMediaUrl(storageKey);
        }
        if (Array.isArray(next.segments)) {
            next.segments = next.segments.map((value) => {
                if (!value || typeof value !== "object") return value;
                const segment = { ...(value as Record<string, unknown>) };
                if (typeof segment.resultStorageKey === "string" && segment.resultStorageKey) segment.result = backendMediaUrl(segment.resultStorageKey);
                if (Array.isArray(segment.refItems)) segment.refItems = segment.refItems.map(normalizeMedia);
                if (Array.isArray(segment.results)) segment.results = segment.results.map(normalizeMedia);
                if (segment.refs && typeof segment.refs === "object" && !Array.isArray(segment.refs)) {
                    segment.refs = Object.fromEntries(Object.entries(segment.refs as Record<string, unknown>).map(([key, value]) => [key, Array.isArray(value) ? value.map(normalizeMedia) : normalizeMedia(value)]));
                }
                return segment;
            });
        }
        if (Array.isArray(next.images)) {
            next.images = next.images.map((value) => {
                if (!value || typeof value !== "object") return value;
                const image = { ...(value as Record<string, unknown>) };
                if (typeof image.storageKey === "string" && image.storageKey) image.content = backendMediaUrl(image.storageKey);
                return image;
            });
        }
        return next;
    };
    return {
        ...project,
        viewport: normalizeViewportTransform(project.viewport),
        nodes: project.nodes.map((node) => ({ ...node, metadata: normalizeMetadata(node.metadata) })),
    };
}
