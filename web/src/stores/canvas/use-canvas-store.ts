import { create } from "zustand";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";
import { createBackendGenerationLog, deleteBackendProject, fetchBackendProjects, upsertBackendProject } from "@/services/backend-api";
import { useBackendStore } from "@/stores/use-backend-store";

export type CanvasProject = {
    id: string;
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
let knownProjectIds = new Set<string>();

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

async function syncCanvasProjects(projects: CanvasProject[]) {
    saveToLocalStorage(projects);
    if (!useBackendStore.getState().connected) return;
    try {
        const ids = new Set(projects.map((project) => project.id));
        await Promise.all(projects.map((project) => upsertBackendProject(project as unknown as Record<string, unknown>)));
        await Promise.all([...knownProjectIds].filter((id) => !ids.has(id)).map((id) => deleteBackendProject(id)));
        knownProjectIds = ids;
    } catch { /* Backend 失败由下一次同步重试 */ }
}

async function hydrateCanvasProjectsFromBackend() {
    const backendConnected = useBackendStore.getState().connected;
    if (!backendConnected) return false;
    try {
        const response = await fetchBackendProjects();
        const remoteProjects = Array.isArray(response.projects) ? response.projects as unknown as CanvasProject[] : [];
        const localProjects = useCanvasStore.getState().projects;
        const localById = new Map(localProjects.map((project) => [project.id, project]));
        const remoteById = new Map(remoteProjects.map((project) => [project.id, project]));
        const mergedProjects = [...new Set([...remoteById.keys(), ...localById.keys()])].map((id) => {
            const remote = remoteById.get(id);
            const local = localById.get(id);
            if (!remote) return local!;
            if (!local) return remote;
            // 启动恢复期间可能先拿到空画布快照；不能让它覆盖已有节点。
            if (local.nodes.length > 0 && remote.nodes.length === 0) return local;
            return Date.parse(local.updatedAt || "") > Date.parse(remote.updatedAt || "") ? local : remote;
        });
        knownProjectIds = new Set(remoteProjects.map((project) => project.id));
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
    projects: loadFromLocalStorage(),
    backendRevisions: {},
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
        void syncCanvasProjects(useCanvasStore.getState().projects);
    }, 400);
}

function applyBackendCanvasEvent(event: unknown) {
    if (!event || typeof event !== "object") return;
    const value = event as { type?: unknown; entityId?: unknown; payload?: unknown };
    if (value.type !== "canvas.updated") return;
    const payload = value.payload;
    const isProject = (item: unknown): item is CanvasProject => Boolean(
        item && typeof item === "object"
        && typeof (item as { id?: unknown }).id === "string"
        && Array.isArray((item as { nodes?: unknown }).nodes)
        && Array.isArray((item as { connections?: unknown }).connections),
    );
    const isProjectList = payload && typeof payload === "object" && Array.isArray((payload as { projects?: unknown }).projects);
    const projects = isProjectList
        ? (payload as { projects: unknown[] }).projects.filter(isProject)
        : isProject(payload) ? [payload] : [];
    const entityId = typeof value.entityId === "string" ? value.entityId : "";
    const deleted = payload && typeof payload === "object" && Number((payload as { deleted?: unknown }).deleted || 0) > 0;
    if (!isProjectList && !projects.length && !(deleted && entityId)) return;
    useCanvasStore.setState((state) => {
        let nextProjects = state.projects;
        const nextRevisions = { ...state.backendRevisions };
        if (isProjectList) {
            const changed = projects.some((project) => JSON.stringify(state.projects.find((item) => item.id === project.id)) !== JSON.stringify(project));
            if (!changed) return state;
            nextProjects = projects;
            for (const project of projects) nextRevisions[project.id] = (nextRevisions[project.id] || 0) + 1;
        } else if (projects.length) {
            const remote = projects[0];
            const local = state.projects.find((project) => project.id === remote.id);
            if (local && JSON.stringify(local) === JSON.stringify(remote)) return state;
            nextProjects = state.projects.some((project) => project.id === remote.id)
                ? state.projects.map((project) => project.id === remote.id ? remote : project)
                : [remote, ...state.projects];
            nextRevisions[remote.id] = (nextRevisions[remote.id] || 0) + 1;
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
