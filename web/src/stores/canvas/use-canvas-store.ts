import { create } from "zustand";
import localforage from "localforage";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import { normalizeViewportTransform } from "@/lib/canvas/canvas-viewport";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";
import { applyBackendCanvasOperations, backendMediaUrl, BackendApiError, createBackendGenerationLog, createBackendProject, deleteBackendCanvasFolder, deleteBackendProject, fetchBackendCanvasFolders, fetchBackendProject, fetchBackendProjects, upsertBackendCanvasFolder } from "@/services/backend-api";
import { useBackendStore } from "@/stores/use-backend-store";
import { getBackendUrl, getCanvasCollaborationClient, getCanvasDraftSessionId } from "@/services/backend-api";
import { CanvasCommandQueue, type CanvasCommand } from "@/lib/canvas/canvas-command-queue";
import { canvasDraftPersistence } from "@/lib/canvas/canvas-draft-persistence";
import { CANVAS_ACTIVE_TASK_NODE_FIELDS, H3_RUNTIME_NODE_FIELDS, H3_RUNTIME_SEGMENT_FIELDS, H3_LOCAL_VIEW_FIELDS } from "@basketikun/canvas-agent/runtime-fields";
import { flushCanvasTexts, onCanvasTextCommit, prepareCanvasTextWith, receiveCanvasTextEvent } from "@/services/api/canvas-text";

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

export type CanvasCollaborator = {
    clientId: string;
    kind: "browser" | "mcp" | "agent" | "task" | "system";
    label: string;
    lastActivityAt: string;
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    folders: CanvasFolder[];
    backendRevisions: Record<string, number>;
    collaborators: Record<string, CanvasCollaborator[]>;
    canvasConflicts: Record<string, CanvasConflictRecord>;
    clearCanvasConflict: (id: string) => void;
    /** 显式保留：用新命令 ID 替换已拒绝意图，再基于远端提交。 */
    keepPendingOpsOnCanvasConflict: (id: string) => Promise<void>;
    /** 弹窗"采用远端"：用缓存的 remoteProject 直接覆盖本地，syncBase = remote。 */
    adoptRemoteOnCanvasConflict: (id: string) => Promise<void>;
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
const projectLoads = new Map<string, Promise<CanvasProject>>();
const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let localSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
let pendingLocalSnapshot: { projects: CanvasProject[]; bases: Map<string, CanvasProject> } | null = null;
let localSnapshotWritePromise: Promise<boolean> | null = null;
let syncPromise: Promise<void> | null = null;
let syncRequested = false;
let syncGeneration = 0;
let knownProjectIds = new Set<string>();
let knownCanvasFolderIds = new Set<string>();
let folderSaveTimer: ReturnType<typeof setTimeout> | null = null;
const syncBases = new Map<string, CanvasProject>();
export function getCanvasAcknowledgedRevision(projectId: string) { return Number(syncBases.get(projectId)?.revision || 0); }
// 明确拒绝持久化在原命令上；刷新或无关编辑都不解除，必须由用户选择处理。
type LegacyCanvasCommand = { operationId: string; base: CanvasProject; submitted: CanvasProject; operations: Array<Record<string, unknown>> };
const commandOutbox = localforage.createInstance({ name: "infinite-canvas-command-outbox", storeName: "commands", description: "未确认的画布操作" });
const draftSessionId = getCanvasDraftSessionId();
const commandBackend = getBackendUrl();
const cacheKey = (id: string) => JSON.stringify([commandBackend, draftSessionId, id]);
const deletionCache = localforage.createInstance({ name: "infinite-canvas-project-deletions" });
let deletionWrite: Promise<unknown> = Promise.resolve();
const pendingCommands = new CanvasCommandQueue<CanvasProject>({
    save: (command) => canvasDraftPersistence.save({ key: `command:${command.operationId}`, projectId: command.projectId, label: "画布编辑命令", record: command, write: () => commandOutbox.setItem(command.operationId, command) }),
    remove: (id) => canvasDraftPersistence.save({ key: `command:${id}`, label: "清理已确认命令", record: null, write: () => commandOutbox.removeItem(id) }),
});
let commandOrder = Date.now();
function captureCanvasAction(before: CanvasProject, after: CanvasProject) {
    const operations = diffCanvasProject(before, after);
    if (!operations.length) return;
    if (getBackendUrl() !== commandBackend) throw new Error("后台地址已改变，请刷新后继续编辑；原后台草稿仍保留");
    pendingCommands.enqueue({ operationId: nanoid(), projectId: before.id, ownerId: draftSessionId, backend: commandBackend, source: getCanvasCollaborationClient(), order: ++commandOrder, base: before, operations });
}
function projectCanvasCommands(remote: CanvasProject) {
    let projection = remote;
    const conflicts: CanvasConflictTarget[] = [];
    for (const command of pendingCommands.list(remote.id)) {
        conflicts.push(...detectCanvasConflicts(command.operations, projection, command.base));
        projection = applyBackendCanvasDelta(projection, command.operations, Number(remote.revision || 0));
    }
    return { projection, conflicts };
}
const pendingCommandEvents = new Map<string, unknown[]>();
let deferredBackendEvents: unknown[] = [];
let deferredBackendEventsWaiter: Promise<void> | null = null;
let canvasHydrationPromise: Promise<void> | null = null;
let localCanvasHydrated = false;
let backendCanvasHydrated = false;
const canvasDeltaRecovery = new Set<string>();
const pendingDeletedProjectIds = new Set<string>();

function persistDeletedProjectIds() {
    const ids = [...pendingDeletedProjectIds];
    deletionWrite = deletionWrite.catch(() => {}).then(() => canvasDraftPersistence.save({ key: cacheKey("deletions"), label: "项目删除意图", record: { backend: commandBackend, ownerId: draftSessionId, ids }, write: () => deletionCache.setItem(cacheKey("deletions"), ids) }));
    void deletionWrite.catch((error) => console.error("画布删除意图保存失败，尚未提交后台", error));
    return deletionWrite;
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
//   - 窗口视图状态由插件 view 独立维护；此处同样禁止旧字段进入同步流。
const H3_BACKEND_NODE_METADATA_FIELDS = new Set<string>([...H3_RUNTIME_NODE_FIELDS, ...H3_LOCAL_VIEW_FIELDS]);
const H3_BACKEND_SEGMENT_FIELDS = new Set<string>(H3_RUNTIME_SEGMENT_FIELDS);
const ACTIVE_TASK_NODE_METADATA_FIELDS = new Set<string>(CANVAS_ACTIVE_TASK_NODE_FIELDS);

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
        let persisted = true;
        while (pendingLocalSnapshot) {
            const { projects: next, bases } = pendingLocalSnapshot;
            pendingLocalSnapshot = null;
            const ids = new Set(next.map((project) => project.id));
            const failed = (error: unknown) => { persisted = false; console.error("画布本地快照保存失败", error); };
            for (const project of next) {
                try {
                    const base = bases.get(project.id);
                    if (cachedProjects.get(project.id) === project && cachedBases.get(project.id) === base) continue;
                    const record = { project, base, queueVersion: 2 };
                    await canvasDraftPersistence.save({ key: cacheKey(project.id), projectId: project.id, label: base ? "画布本机缓存" : "新建画布草稿", record: { ...record, backend: commandBackend, ownerId: draftSessionId }, write: () => projectCache.setItem(cacheKey(project.id), record) });
                    cachedProjects.set(project.id, project);
                    cachedBases.set(project.id, base);
                } catch (error) { failed(error); }
            }
            for (const id of cachedProjects.keys()) {
                if (ids.has(id)) continue;
                try {
                    await canvasDraftPersistence.save({ key: cacheKey(id), label: "清理画布缓存", projectId: id, record: null, write: () => projectCache.removeItem(cacheKey(id)) });
                    cachedProjects.delete(id);
                    cachedBases.delete(id);
                } catch (error) { failed(error); }
            }
        }
        return persisted;
    })().finally(() => { localSnapshotWritePromise = null; });
    return localSnapshotWritePromise;
}

async function hydrateCanvasProjectsFromLocalStore() {
    try {
        for (const id of await deletionCache.getItem<string[]>(cacheKey("deletions")) || []) pendingDeletedProjectIds.add(id);
        const legacy: Array<{ key: string; command: LegacyCanvasCommand }> = [];
        await commandOutbox.iterate<CanvasCommand<CanvasProject> | LegacyCanvasCommand, void>((command, key) => {
            if ("ownerId" in command) {
                if (command.ownerId !== draftSessionId || command.backend !== commandBackend) return;
                pendingCommands.restore(command);
                commandOrder = Math.max(commandOrder, command.order);
            } else if (key.startsWith(draftSessionId + ":")) legacy.push({ key, command });
        });
        // 转存已有用户草稿，而非丢弃旧数据：请求 ID、原始操作和已发送基线保持不变。
        for (const { key, command } of legacy) {
            pendingCommands.restore({ operationId: command.operationId, projectId: command.submitted.id, ownerId: draftSessionId, backend: commandBackend, order: ++commandOrder, base: command.base, baseRevision: Number(command.base.revision || 0), operations: command.operations });
            await pendingCommands.prepare(command.operationId, Number(command.base.revision || 0));
            await commandOutbox.removeItem(key);
        }
        const projects: CanvasProject[] = [];
        await projectCache.iterate<{ project: CanvasProject; base?: CanvasProject; queueVersion?: number }, void>((entry, key) => {
            if (!entry?.project?.id || pendingDeletedProjectIds.has(entry.project.id)) return;
            const id = entry.project.id;
            // 无归属的旧共享缓存原样保留，不能静默当作本窗口草稿提交或清理。
            if (key !== cacheKey(id)) return;
            if (entry.base) syncBases.set(id, entry.base);
            if (entry.queueVersion !== 2 && entry.base) {
                const submitted = legacy.find((item) => item.command.submitted.id === id)?.command.submitted || entry.base;
                captureCanvasAction(submitted, entry.project);
            }
            // v2 缓存是可丢弃投影，只有明确的命令表示未提交编辑。
            const commandBase = pendingCommands.list(id)[0]?.base;
            const seed = entry.base && !entry.base.summary ? entry.base : commandBase || entry.project;
            if (entry.base?.summary && commandBase && !commandBase.summary) syncBases.set(id, commandBase);
            const projected = { ...projectCanvasCommands(seed).projection, viewport: entry.project.viewport };
            projects.push(projected);
            cachedProjects.set(id, projected);
            cachedBases.set(id, entry.base);
        });
        for (const command of pendingCommands.list()) {
            if (pendingDeletedProjectIds.has(command.projectId) || projects.some((project) => project.id === command.projectId)) continue;
            projects.push(projectCanvasCommands(command.base).projection);
            syncBases.set(command.projectId, command.base);
        }
        const normalizedProjects = projects.map(normalizeProjectMediaUrls);
        const currentProjects = useCanvasStore.getState().projects;
        const currentById = new Map(currentProjects.map((project) => [project.id, project]));
        const localById = new Map(normalizedProjects.map((project) => [project.id, project]));
        const mergedProjects = [...new Set([...localById.keys(), ...currentById.keys()])].map((id) => {
            const local = localById.get(id);
            const current = currentById.get(id);
            if (!local) return current!;
            if (!current) return local;
            // 列表索引只带标题/时间，不能凭较新的 updatedAt 覆盖队列恢复出的完整画布。
            if (current.summary && !local.summary) return local;
            return isLocalProjectNewer(current, local) ? current : local;
        });
        if (JSON.stringify(currentProjects) !== JSON.stringify(mergedProjects)) useCanvasStore.setState({ projects: mergedProjects });
    } catch (error) {
        console.error("画布草稿恢复失败，未删除未确认命令", error);
    }
}

async function syncCanvasProjects(projects: CanvasProject[], generation: number, forceBackend = false) {
    if (!backendCanvasHydrated || (!forceBackend && !useBackendStore.getState().connected)) return;
    if (getBackendUrl() !== commandBackend) throw new Error("后台地址已改变，请刷新后同步原后台草稿");
    for (const project of projects) {
        if (generation !== syncGeneration) return;
        if (useCanvasStore.getState().canvasConflicts[project.id]) continue;
        let active: CanvasCommand<CanvasProject> | undefined;
        try {
            let base = syncBases.get(project.id);
            if (!base) {
                try { base = normalizeProjectMediaUrls((await fetchBackendProject(project.id)).project as unknown as CanvasProject); }
                catch (error) { if (!(error instanceof BackendApiError && error.status === 404)) throw error; }
                if (!base) {
                    // 创建只写初始种子；其后编辑已经各自入队，不能把含这些编辑的整图重复创建。
                    const seed = pendingCommands.list(project.id)[0]?.base || project;
                    base = normalizeProjectMediaUrls((await createBackendProject(seed as unknown as Record<string, unknown>)).project as unknown as CanvasProject);
                }
                syncBases.set(project.id, base);
                knownProjectIds.add(project.id);
            }
            while ((active = pendingCommands.list(project.id)[0])) {
                if (!active.operations.length) { await pendingCommands.acknowledge(active.operationId); continue; }
                if (active.rejected) {
                    setCanvasCommandConflict(project.id, base, active.rejected);
                    break;
                }
                // 仅未发送的动作可以选择当前基线。已发请求只重放原信封，先取原回执。
                if (active.baseRevision === undefined) {
                    const conflicts = detectCanvasConflicts(active.operations, base, active.base);
                    if (conflicts.length) {
                        setCanvasCommandConflict(project.id, base, "本地操作的目标已被其他协作者修改", conflicts);
                        break;
                    }
                }
                const command = await pendingCommands.prepare(active.operationId, Number(base.revision || 0));
                const response = await applyBackendCanvasOperations(project.id, command.operations, command.baseRevision, command.operationId, command.source);
                const received = normalizeProjectMediaUrls(response.project as unknown as CanvasProject);
                // 重放旧请求的回执可能落后于已收到的远端文档；不能回退权威基线。
                base = Number(base.revision || 0) > response.revision ? base : received;
                syncBases.set(project.id, base);
                await pendingCommands.acknowledge(command.operationId);
                const current = useCanvasStore.getState().projects.find((item) => item.id === project.id);
                const { projection, conflicts } = projectCanvasCommands(base);
                if (conflicts.length) setCanvasCommandConflict(project.id, base, "后续编辑与远端改动冲突，已保留命令", conflicts);
                else if (current) useCanvasStore.setState((state) => ({
                    projects: state.projects.map((item) => item.id === project.id ? { ...projection, viewport: current.viewport } : item),
                    backendRevisions: { ...state.backendRevisions, [project.id]: Number(base!.revision || 0) },
                }));
                replayPendingCommandEvents(project.id);
                if (conflicts.length) break;
            }
        } catch (error) {
            if (active && error instanceof BackendApiError && [400, 401, 403, 404, 409].includes(error.status)) {
                // 拒绝也保留原命令，只有用户明确选择后才替换/丢弃，刷新不能解除熔断。
                await pendingCommands.reject(active.operationId, error.message).catch(() => {});
                const remote = error.details.project as CanvasProject | undefined || syncBases.get(project.id) || project;
                setCanvasCommandConflict(project.id, remote, error.message);
                replayPendingCommandEvents(project.id);
            } else console.error("画布命令尚未确认，已保留不可变请求和后续动作", error);
        }
    }
    // 删除必须来自显式动作；项目列表缺项不再隐式表示删除远端项目。
    // 与编辑命令一样：持久化失败时禁止发送删除，刷新后仍可恢复明确的意图。
    await deletionWrite;
    for (const id of [...pendingDeletedProjectIds]) {
        try {
            await deleteBackendProject(id);
            await pendingCommands.discard(id);
            pendingCommandEvents.delete(id);
            pendingDeletedProjectIds.delete(id);
            knownProjectIds.delete(id);
            syncBases.delete(id);
        } catch (error) { console.error("画布删除尚未确认", error); }
    }
    await persistDeletedProjectIds();
    persistCurrentCanvasSnapshot();
}

function setCanvasCommandConflict(id: string, remote: CanvasProject, message: string, targets?: CanvasConflictTarget[]) {
    const commands = pendingCommands.list(id);
    useCanvasStore.setState((state) => ({ canvasConflicts: { ...state.canvasConflicts, [id]: {
        message, revision: Number(remote.revision || 0),
        pendingOperations: commands.reduce((count, command) => count + command.operations.length, 0),
        conflictTargets: targets?.length ? targets : [{ id, kind: "update", detail: message }],
        remoteProject: remote,
    } } }));
}

function replayPendingCommandEvents(projectId: string) {
    const events = pendingCommandEvents.get(projectId) || [];
    pendingCommandEvents.delete(projectId);
    for (const event of events) applyBackendCanvasEvent(event, true);
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
    projects: [],
    folders: [],
    backendRevisions: {},
    collaborators: {},
    canvasConflicts: {},
    clearCanvasConflict: (id) => set((state) => { const next = { ...state.canvasConflicts }; delete next[id]; return { canvasConflicts: next }; }),
    keepPendingOpsOnCanvasConflict: async (id) => {
        const conflict = get().canvasConflicts[id];
        if (!conflict) return;
        const local = get().projects.find((project) => project.id === id);
        if (!local) return;
        try {
            const operations = pendingCommands.list(id).flatMap((command) => command.operations);
            const remote = conflict.remoteDeleted ? local : conflict.remoteProject;
            const replacement = { operationId: nanoid(), projectId: id, backend: commandBackend, ownerId: draftSessionId, source: getCanvasCollaborationClient(), order: ++commandOrder, base: remote, operations: conflict.remoteDeleted ? [] : operations };
            await pendingCommands.replace(replacement);
            if (conflict.remoteDeleted) {
                await pendingCommands.acknowledge(replacement.operationId);
                syncBases.delete(id);
                knownProjectIds.delete(id);
            } else {
                syncBases.set(id, remote);
                set((state) => ({ projects: state.projects.map((project) => project.id === id ? { ...projectCanvasCommands(remote).projection, viewport: project.viewport } : project) }));
            }
            get().clearCanvasConflict(id);
            persistCurrentCanvasSnapshot();
            scheduleCanvasSync();
        } catch (error) { console.error("未能持久化冲突选择，原操作仍保留", error); }
    },
    adoptRemoteOnCanvasConflict: async (id) => {
        const conflict = get().canvasConflicts[id];
        if (!conflict) return;
        try {
            const tombstone = { operationId: nanoid(), projectId: id, backend: commandBackend, ownerId: draftSessionId, order: ++commandOrder, base: conflict.remoteProject, operations: [] };
            await pendingCommands.replace(tombstone);
            await pendingCommands.acknowledge(tombstone.operationId);
            if (conflict.remoteDeleted) {
                syncBases.delete(id);
                knownProjectIds.delete(id);
                set((state) => ({ projects: state.projects.filter((project) => project.id !== id) }));
                persistCurrentCanvasSnapshot();
            } else adoptRemoteProject(conflict.remoteProject);
            get().clearCanvasConflict(id);
            replayPendingCommandEvents(id);
        } catch (error) { console.error("未能持久化冲突选择，原操作仍保留", error); }
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
        for (const project of get().projects) if (project.folderId === id) captureCanvasAction(project, { ...project, folderId: null });
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
        for (const project of get().projects) if (idSet.has(project.id)) captureCanvasAction(project, { ...project, folderId });
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
        const before = get().projects.find((project) => project.id === id);
        if (!before) return;
        captureCanvasAction(before, { ...before, title: title.trim() || before.title });
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
    replaceProjects: (projects) => {
        const previous = get().projects;
        for (const project of projects) {
            const before = previous.find((item) => item.id === project.id);
            if (before) captureCanvasAction(before, project);
        }
        for (const project of previous) if (!projects.some((item) => item.id === project.id)) pendingDeletedProjectIds.add(project.id);
        persistDeletedProjectIds();
        set({ projects: projects.map((project) => ({ ...project, viewport: normalizeViewportTransform(project.viewport) })) });
        persistCurrentCanvasSnapshot();
        scheduleCanvasSync();
    },
    updateProject: (id, patch) => {
        const normalizedPatch = patch.viewport ? { ...patch, viewport: normalizeViewportTransform(patch.viewport) } : patch;
        const before = get().projects.find((project) => project.id === id);
        if (!before) return;
        captureCanvasAction(before, { ...before, ...normalizedPatch });
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

/** 生成前必须确认目标画布已落库；后台自动同步仍允许保留草稿后静默重试。 */
export async function flushCanvasProjectBeforeGeneration(projectId: string) {
    if (!backendCanvasHydrated) throw new Error("画布尚未完成加载，请稍后再生成");
    await flushCanvasTexts(projectId);
    await flushCanvasSyncNow();
    const state = useCanvasStore.getState();
    const project = state.projects.find((item) => item.id === projectId);
    const base = syncBases.get(projectId);
    if (!project || !base) throw new Error("目标画布尚未保存，未提交生成任务");
    if (state.canvasConflicts[projectId]) throw new Error("请先处理此画布的同步冲突，再生成");
    if (pendingCommands.has(projectId)) {
        throw new Error("画布修改尚未得到 Backend 确认，已保留草稿；恢复连接并保存后再生成");
    }
}

/** 立即尝试提交当前画布投影；生成入口应调用带项目确认的版本。 */
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
        const backendTaskActive = !isH3 && Boolean(previousMetadata.runtimeTaskId || nextMetadata.runtimeTaskId);
        const metadataKeysToSkip = new Set<string>();
        if (isH3) metadataKeysToSkip.add("segments");
        for (const key of new Set([...Object.keys(previousMetadata), ...Object.keys(nextMetadata)])) {
            if (metadataKeysToSkip.has(key)) continue;
            if (isH3 && H3_BACKEND_NODE_METADATA_FIELDS.has(key)) continue;
            if (backendTaskActive && ACTIVE_TASK_NODE_METADATA_FIELDS.has(key)) continue;
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
 *  - update_project → 按实际修改字段检查并发 */
export function detectCanvasConflicts(pendingOps: Array<Record<string, unknown>>, remote: CanvasProject, base?: CanvasProject, options?: { guardLayout?: boolean }): CanvasConflictTarget[] {
    const remoteNodeIds = new Set(remote.nodes.map((node) => node.id));
    const remoteConnectionIds = new Set(remote.connections.map((connection) => connection.id));
    const baseNodes = new Map((base?.nodes || []).map((node) => [node.id, node]));
    const remoteNodes = new Map(remote.nodes.map((node) => [node.id, node]));
    const targets: CanvasConflictTarget[] = [];
    const removedConnectionIds = new Set(pendingOps.filter((op) => op.type === "delete_connections").flatMap((op) => Array.isArray(op.ids) ? op.ids.map(String) : []));
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
                const patchKeys = Object.keys((op.patch || {}) as Record<string, unknown>).filter((key) => options?.guardLayout || !["position", "width", "height"].includes(key));
                const metadataConflict = metadataKeys.some((key) => JSON.stringify(baseMetadata[key]) !== JSON.stringify(remoteMetadata[key]));
                const patchConflict = patchKeys.some((key) => JSON.stringify((baseNode as Record<string, unknown> | undefined)?.[key]) !== JSON.stringify((remoteNode as Record<string, unknown> | undefined)?.[key]));
                if (metadataConflict || patchConflict) targets.push({ id, kind: "update", detail: `节点「${id}」的字段已被远端更新，本地旧快照不会覆盖它` });
            }
        } else if (type === "delete_node") {
            const id = String(op.id || "");
            if (id && !remoteNodeIds.has(id)) continue; // no-op
        } else if (type === "connect_nodes") {
            const id = String(op.id || "");
            if (id && remoteConnectionIds.has(id) && !removedConnectionIds.has(id)) targets.push({ id, kind: "connect", detail: `连线「${id}」在远端已存在` });
        } else if (type === "delete_connections") {
            const ids = Array.isArray(op.ids) ? op.ids.map(String) : [];
            if (!ids.some((id) => remoteConnectionIds.has(id))) continue; // no-op
            if (base && ids.some((id) => remoteConnectionIds.has(id) && JSON.stringify(base.connections.find((item) => item.id === id)) !== JSON.stringify(remote.connections.find((item) => item.id === id)))) targets.push({ id: ids.join(","), kind: "disconnect", detail: "连线已被远端修改" });
        } else if (type === "update_project" && base) {
            for (const key of Object.keys((op.patch || {}) as object)) {
                if (JSON.stringify(base[key as keyof CanvasProject]) !== JSON.stringify(remote[key as keyof CanvasProject])) targets.push({ id: key, kind: "update", detail: `画布字段「${key}」已被远端修改` });
            }
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
        persistCurrentCanvasSnapshot();
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
    receiveCanvasTextEvent(event);
    const value = event as { type?: unknown; entityId?: unknown; revision?: unknown; payload?: unknown; source?: unknown; createdAt?: unknown };
    if (value.type === "canvas-folder.updated") {
        const entityId = typeof value.entityId === "string" ? value.entityId : "";
        const payload = value.payload && typeof value.payload === "object" ? value.payload as Record<string, unknown> : {};
        const deleted = Number(payload.deleted || 0) > 0;
        if (deleted && entityId) {
            useCanvasStore.setState((state) => ({
                folders: state.folders.filter((folder) => folder.id !== entityId),
                projects: state.projects.map((project) => project.folderId === entityId ? { ...project, folderId: null } : project),
            }));
            persistCurrentCanvasSnapshot();
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
    const unconfirmed = pendingCommands.list(entityId)[0];
    if (entityId && unconfirmed?.baseRevision !== undefined && !unconfirmed.rejected) {
        // 可能已提交但丢回执；先重放原请求取回执，不能把自己的提交误判为远端冲突。
        pendingCommandEvents.set(entityId, [...(pendingCommandEvents.get(entityId) || []), event]);
        scheduleCanvasSync();
        return;
    }
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
            const pendingOps = pendingCommands.list(remote.id).flatMap((command) => command.operations);
            if (local && pendingOps.length) {
                const { projection, conflicts } = projectCanvasCommands(remote);
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
                const rebased = { ...projection, updatedAt: local.updatedAt, viewport: local.viewport };
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
            const pendingOps = pendingCommands.list(entityId).flatMap((command) => command.operations);
            if (local && pendingOps.length && !pendingDeletedProjectIds.has(entityId)) {
                return { canvasConflicts: { ...state.canvasConflicts, [entityId]: {
                    message: "画布已在远端删除，本地仍有未提交修改",
                    revision: Number(base?.revision || 0), pendingOperations: pendingOps.length,
                    conflictTargets: [{ id: entityId, kind: "delete", detail: "保留我的将重新创建画布；采用远端将移除本地画布" }],
                    remoteProject: local, remoteDeleted: true,
                } } };
            }
            syncBases.delete(entityId);
            knownProjectIds.delete(entityId);
            pendingDeletedProjectIds.delete(entityId);
            persistDeletedProjectIds();
            if (!state.projects.some((project) => project.id === entityId)) return state;
            nextProjects = state.projects.filter((project) => project.id !== entityId);
            nextRevisions[entityId] = (nextRevisions[entityId] || 0) + 1;
        }
        persistCurrentCanvasSnapshot();
        return { projects: nextProjects, backendRevisions: nextRevisions };
    });
    persistCurrentCanvasSnapshot();
}

onCanvasTextCommit(applyBackendCanvasEvent);
prepareCanvasTextWith(flushCanvasSyncNow);

if (typeof window !== "undefined") {
    window.addEventListener("canvas-storage-recovered", () => {
        void persistDeletedProjectIds().then(() => scheduleCanvasSync()).catch(() => {});
        persistCurrentCanvasSnapshot();
    });
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
