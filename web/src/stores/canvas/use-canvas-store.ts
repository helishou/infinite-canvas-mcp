import { create } from "zustand";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";
import { applyBackendCanvasOperations, backendMediaUrl, BackendApiError, createBackendGenerationLog, deleteBackendProject, fetchBackendProjects, upsertBackendProject } from "@/services/backend-api";
import { useBackendStore } from "@/stores/use-backend-store";

export type CanvasProject = {
    id: string;
    revision?: number;
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
    viewport: ViewportTransform;
};

type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    backendRevisions: Record<string, number>;
    canvasConflicts: Record<string, { message: string; revision: number; pendingOperations: number }>;
    clearCanvasConflict: (id: string) => void;
    createProject: (title?: string) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: CanvasProject[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "globalPrompt" | "viewport">>) => void;
};

const CANVAS_PROJECTS_KEY = "infinite-canvas-projects-v1";
const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let syncPromise: Promise<void> | null = null;
let syncRequested = false;
let syncGeneration = 0;
let knownProjectIds = new Set<string>();
const syncBases = new Map<string, CanvasProject>();
let deferredBackendEvents: unknown[] = [];
let deferredBackendEventsWaiter: Promise<void> | null = null;

function loadFromLocalStorage(): CanvasProject[] {
    try {
        const raw = localStorage.getItem(CANVAS_PROJECTS_KEY);
        if (!raw) return [];
        const val = JSON.parse(raw);
        return Array.isArray(val) ? (val as CanvasProject[]) : [];
    } catch { return []; }
}

function saveToLocalStorage(projects: CanvasProject[]) {
    try {
        // 精简：只存 meta，不存大节点内容（减少 localStorage 体积）
        const meta = projects.map(({ id, title, createdAt, updatedAt, nodes, connections, chatSessions, activeChatId, backgroundMode, showImageInfo, globalPrompt, viewport }) =>
            ({ id, title, createdAt, updatedAt, nodes, connections, chatSessions, activeChatId, backgroundMode, showImageInfo, globalPrompt, viewport }));
        localStorage.setItem(CANVAS_PROJECTS_KEY, JSON.stringify(meta));
    } catch { /* localStorage 满了就放弃 */ }
}

function persistCurrentCanvasSnapshot() {
    saveToLocalStorage(useCanvasStore.getState().projects);
}

async function syncCanvasProjects(projects: CanvasProject[], generation: number) {
    saveToLocalStorage(projects);
    if (!useBackendStore.getState().connected) return;
    let currentProjectId = "";
    try {
        const ids = new Set(projects.map((project) => project.id));
        for (const project of projects) {
            currentProjectId = project.id;
            if (generation !== syncGeneration) return;
            const base = syncBases.get(project.id);
            if (!base) {
                const response = await upsertBackendProject(project as unknown as Record<string, unknown>);
                const saved = response.project as unknown as CanvasProject | undefined;
                if (saved) syncBases.set(project.id, saved);
                continue;
            }
            const operations = diffCanvasProject(base, project);
            if (!operations.length) {
                syncBases.set(project.id, project);
                continue;
            }
            const response = await applyBackendCanvasOperations(project.id, operations, Number(base.revision || 0));
            const saved = response.project as unknown as CanvasProject | undefined;
            if (saved) {
                syncBases.set(project.id, saved);
                const current = useCanvasStore.getState().projects.find((item) => item.id === project.id);
                if (current?.updatedAt === project.updatedAt) {
                    useCanvasStore.setState((state) => ({ projects: state.projects.map((item) => item.id === project.id ? saved : item) }));
                }
            }
        }
        if (generation !== syncGeneration) return;
        await Promise.all([...knownProjectIds].filter((id) => !ids.has(id)).map((id) => deleteBackendProject(id)));
        knownProjectIds = ids;
    } catch (error) {
        if (error instanceof BackendApiError && error.status === 409 && currentProjectId) {
            const remote = error.details.project as CanvasProject | undefined;
            const revision = Number(error.details.revision || remote?.revision || 0);
            if (remote) syncBases.set(currentProjectId, remote);
            const pending = useCanvasStore.getState().projects.find((item) => item.id === currentProjectId);
            useCanvasStore.setState((state) => ({ canvasConflicts: { ...state.canvasConflicts, [currentProjectId]: { message: "画布已被其他窗口更新，待同步操作已保留", revision, pendingOperations: pending ? diffCanvasProject(remote || syncBases.get(currentProjectId) || pending, pending).length : 0 } } }));
            window.dispatchEvent(new CustomEvent("canvas-sync-conflict", { detail: { projectId: currentProjectId, revision } }));
        }
        // 保留本地投影和 syncBases，下一次显式修改会按新 revision 重试待提交操作。
    }
}

async function hydrateCanvasProjectsFromBackend() {
    const backendConnected = useBackendStore.getState().connected;
    if (!backendConnected) return false;
    try {
        const response = await fetchBackendProjects();
        const remoteProjects = Array.isArray(response.projects) ? response.projects.map((project) => normalizeProjectMediaUrls(project as unknown as CanvasProject)) : [];
        const localProjects = useCanvasStore.getState().projects;
        const localById = new Map(localProjects.map((project) => [project.id, project]));
        const normalizedRemoteProjects = remoteProjects.map(normalizeProjectMediaUrls);
        const remoteById = new Map(normalizedRemoteProjects.map((project) => [project.id, project]));
        const mergedProjects = [...new Set([...remoteById.keys(), ...localById.keys()])].map((id) => {
            const remote = remoteById.get(id);
            const local = localById.get(id);
            if (!remote) return local!;
            if (!local) return remote;
            // Backend 是唯一权威快照；本地同 id 的旧投影不能依据时间戳反向覆盖
            // MCP 或其它窗口刚提交的节点。只有 Backend 没有该项目时才保留本地项目。
            return remote;
        });
        knownProjectIds = new Set(normalizedRemoteProjects.map((project) => project.id));
        for (const project of normalizedRemoteProjects) syncBases.set(project.id, project);
        saveToLocalStorage(mergedProjects);
        useCanvasStore.setState({ projects: mergedProjects });
        if (mergedProjects.some((project) => !remoteById.has(project.id) || project.updatedAt !== remoteById.get(project.id)?.updatedAt)) scheduleCanvasSync();
        return true;
    } catch {
        return false;
    }
}

export async function hydrateCanvasProjects() {
    await hydrateCanvasProjectsFromBackend();
    useCanvasStore.setState({ hydrated: true });
}

export const useCanvasStore = create<CanvasStore>()((set, get) => ({
    hydrated: false,
    projects: loadFromLocalStorage().map(normalizeProjectMediaUrls),
    backendRevisions: {},
    canvasConflicts: {},
    clearCanvasConflict: (id) => set((state) => { const next = { ...state.canvasConflicts }; delete next[id]; return { canvasConflicts: next }; }),
    createProject: (Title = i18n.t("canvas.project.untitled")) => {
        const now = new Date().toISOString();
        const id = nanoid();
        const project: CanvasProject = {
            id,
            title: Title,
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
            createdAt: source.createdAt || now,
            updatedAt: now,
            nodes: source.nodes || [],
            connections: source.connections || [],
            chatSessions: source.chatSessions || [],
            activeChatId: source.activeChatId || null,
            backgroundMode: source.backgroundMode || "lines",
            showImageInfo: source.showImageInfo || false,
            globalPrompt: source.globalPrompt || "",
            viewport: source.viewport || initialViewport,
        };
        set((state) => ({ projects: [project, ...state.projects] }));
        persistCurrentCanvasSnapshot();
        scheduleCanvasSync();
        void importLegacyGenerationLogs(project.id, (source as Partial<CanvasProject> & { logs?: unknown[] }).logs);
        return project.id;
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
        set((state) => {
            const projects = state.projects.filter((project) => !ids.includes(project.id));
            return { projects };
        });
        persistCurrentCanvasSnapshot();
        scheduleCanvasSync();
    },
    replaceProjects: (projects) => { set({ projects }); persistCurrentCanvasSnapshot(); scheduleCanvasSync(); },
    updateProject: (id, patch) => {
        set((state) => ({
            projects: state.projects.map((project) => (project.id === id ? { ...project, ...patch, updatedAt: new Date().toISOString() } : project)),
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

async function flushCanvasSync() {
    while (syncRequested) {
        syncRequested = false;
        const generation = syncGeneration;
        await syncCanvasProjects(useCanvasStore.getState().projects, generation);
        if (generation !== syncGeneration) syncRequested = true;
    }
}

function diffCanvasProject(base: CanvasProject, next: CanvasProject): Array<Record<string, unknown>> {
    const operations: Array<Record<string, unknown>> = [];
    const baseNodes = new Map(base.nodes.map((node) => [node.id, node]));
    const nextNodes = new Map(next.nodes.map((node) => [node.id, node]));
    for (const node of next.nodes) {
        if (!baseNodes.has(node.id)) {
            operations.push({ type: "add_node", id: node.id, nodeType: node.type, title: node.title, position: node.position, width: node.width, height: node.height, metadata: node.metadata || {} });
            continue;
        }
        const previous = baseNodes.get(node.id)!;
        const patch: Record<string, unknown> = {};
        for (const key of ["type", "title", "position", "width", "height"] as const) {
            if (JSON.stringify(previous[key]) !== JSON.stringify(node[key])) patch[key] = node[key];
        }
        const previousMetadata = previous.metadata || {};
        if (JSON.stringify(previousMetadata) !== JSON.stringify(node.metadata || {})) operations.push({ type: "update_node", id: node.id, patch, metadata: node.metadata || {} });
        else if (Object.keys(patch).length) operations.push({ type: "update_node", id: node.id, patch });
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
    if (JSON.stringify(base.viewport) !== JSON.stringify(next.viewport)) operations.push({ type: "set_viewport", viewport: next.viewport });
    const projectPatch: Record<string, unknown> = {};
    for (const key of ["title", "chatSessions", "activeChatId", "backgroundMode", "showImageInfo", "globalPrompt"] as const) {
        if (JSON.stringify(base[key]) !== JSON.stringify(next[key])) projectPatch[key] = next[key];
    }
    if (Object.keys(projectPatch).length) operations.push({ type: "update_project", patch: projectPatch });
    return operations;
}

function applyBackendCanvasEvent(event: unknown, preservePendingLocalChanges = false) {
    if (!event || typeof event !== "object") return;
    const value = event as { type?: unknown; entityId?: unknown; revision?: unknown; payload?: unknown };
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
    const projects = isProjectList
        ? (payload as { projects: unknown[] }).projects.filter(isProject).map(normalizeProjectMediaUrls)
        : isProject(payload) ? [normalizeProjectMediaUrls(payload)] : [];
    const entityId = typeof value.entityId === "string" ? value.entityId : "";
    const deleted = payload && typeof payload === "object" && Number((payload as { deleted?: unknown }).deleted || 0) > 0;
    if (!isProjectList && !projects.length && !(deleted && entityId)) return;
    // 没有本页面正在提交时，远程写入才需要使旧的延迟快照失效；提交期间保留定时器，
    // 让本页面连续产生的后续修改排队等待前一个 revision 完成。
    if (saveTimer && !preservePendingLocalChanges) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    syncGeneration += 1;
    useCanvasStore.setState((state) => {
        let nextProjects = state.projects;
        const nextRevisions = { ...state.backendRevisions };
        if (isProjectList) {
            const changed = projects.some((project) => JSON.stringify(state.projects.find((item) => item.id === project.id)) !== JSON.stringify(project));
            if (!changed) return state;
            nextProjects = projects;
            for (const project of projects) { nextRevisions[project.id] = Number(project.revision || 0); syncBases.set(project.id, project); }
        } else if (projects.length) {
            const remote = projects[0];
            const local = state.projects.find((project) => project.id === remote.id);
            const remoteRevision = Number(remote.revision || value.revision || 0);
            const knownRevision = Number(local?.revision || nextRevisions[remote.id] || 0);
            if (remoteRevision && remoteRevision < knownRevision) return state;
            if (local && JSON.stringify(local) === JSON.stringify(remote)) return state;
            nextProjects = state.projects.some((project) => project.id === remote.id)
                ? state.projects.map((project) => project.id === remote.id ? remote : project)
                : [remote, ...state.projects];
            nextRevisions[remote.id] = remoteRevision || (nextRevisions[remote.id] || 0) + 1;
            syncBases.set(remote.id, remote);
        } else if (deleted) {
            if (!state.projects.some((project) => project.id === entityId)) return state;
            nextProjects = state.projects.filter((project) => project.id !== entityId);
            nextRevisions[entityId] = (nextRevisions[entityId] || 0) + 1;
        }
        saveToLocalStorage(nextProjects);
        return { projects: nextProjects, backendRevisions: nextRevisions };
    });
}

if (typeof window !== "undefined") {
    window.addEventListener("backend-connected", () => { void hydrateCanvasProjects(); });
    window.addEventListener("backend-event", (event) => applyBackendCanvasEvent((event as CustomEvent).detail));
    window.addEventListener("pagehide", persistCurrentCanvasSnapshot);
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
        nodes: project.nodes.map((node) => ({ ...node, metadata: normalizeMetadata(node.metadata) })),
    };
}
