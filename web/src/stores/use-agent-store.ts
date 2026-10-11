import { create } from "zustand";
import localforage from "localforage";
import i18n from "@/i18n";

import { getBackendUrl } from "@/services/backend-api";
import { fetchSettings, saveSettings, type FrontendSettings } from "@/services/settings-api";
import type { CanvasAgentOp, CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { productionObjectForPresentation, type ProductionObject } from "@/lib/production-object";
import type { AgentPromptQueueItem } from "@/lib/agent/agent-prompt-queue";
import { useProductionWorkspaceStore } from "@/stores/use-production-workspace-store";

export type AgentChatRole = "user" | "assistant" | "system" | "tool" | "error";
export type AgentAttachment = { id: string; name: string; type: string; size: number; width: number; height: number; url: string; dataUrl: string };
export type AgentMessageAttachment = Pick<AgentAttachment, "id" | "name" | "url"> & Partial<Pick<AgentAttachment, "type" | "size" | "width" | "height" | "dataUrl">>;
export type AgentCanvasReference = Pick<CanvasResourceReference, "nodeId" | "label" | "title" | "kind" | "previewUrl" | "text">;
export type AgentSkillReference = { name: string; path: string; displayName?: string };
export type AgentChatItem = { id: string; itemId?: string; clientMessageId?: string; threadId?: string; turnId?: string; role: AgentChatRole; title?: string; text: string; meta?: string; detail?: unknown; attachments?: AgentMessageAttachment[]; canvasReferences?: AgentCanvasReference[]; skill?: AgentSkillReference; streamId?: string; activityItems?: Record<string, string> };
export type AgentEventLog = { id: string; time: string; title: string; text: string; raw?: unknown };
export type AgentPendingToolCall = { requestId: string; name: string; input?: { ops?: CanvasAgentOp[]; path?: string } & Record<string, unknown> };
export type AgentPermissionMode = "request" | "automatic" | "full";
export type AgentReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type AgentModel = {
    runtime?: "llm" | "codex";
    id: string;
    model: string;
    displayName: string;
    defaultReasoningEffort: AgentReasoningEffort | "";
    supportedReasoningEfforts: Array<{ reasoningEffort: AgentReasoningEffort; description?: string }>;
    isDefault?: boolean;
    hidden?: boolean;
};
export type AgentApprovalDecision = "accept" | "acceptForSession" | "decline";
export type AgentPendingApproval = { requestId: string; method: string; threadId?: string; turnId?: string; itemId?: string; reason?: string; command?: unknown; cwd?: string; grantRoot?: string; networkApprovalContext?: unknown; permissions?: unknown; deciding?: AgentApprovalDecision };
export type AgentCanvasContext = { snapshot: CanvasAgentSnapshot; applyOps: (ops?: CanvasAgentOp[]) => CanvasAgentSnapshot; undoOps: () => CanvasAgentSnapshot | null; canUndo: boolean };
export type AgentThreadSummary = { id: string; preview: string; name?: string | null; cwd?: string; status?: string; source?: unknown; createdAt?: number; updatedAt?: number };
export type AgentTokenUsage = { input: number; cached: number; output: number };
export type AgentBootstrapStatus = { key: string; text: string; detail: string; status: "running" | "ready" | "error" };
export type AgentConversationState = {
    revision: number;
    conversationId: string;
    threadId: string;
    status: "idle" | "preparing" | "ready" | "warning" | "running" | "failed";
    mcpStatuses: Record<string, { status: "starting" | "ready" | "failed" | "cancelled"; error?: string | null; failureReason?: string | null }>;
    sourceClientId?: string;
    error?: string;
};
export type AgentPanelTab = "chat" | "setup" | "history" | "skills" | "log";
export type AgentCreativeLaunch = { id: string; mode: "asset" | "drama"; text: string; phase: "reset" | "resetting" | "send" | "sending" };
export type AgentScopedTask = { id: string; text: string; threadId?: string; productionId: string; revision: number };
export type AgentScopedTaskResult = { id: string; status: "sent" | "failed"; threadId?: string; error?: string };
export type AgentQueuedPromptPayload = {
    text: string;
    messageText: string;
    attachments: AgentAttachment[];
    canvasReferences: CanvasResourceReference[];
    canvasProjectId: string;
    skill?: AgentSkillReference;
    model: string;
    reasoningEffort: AgentReasoningEffort | "";
    permissionMode: AgentPermissionMode;
    productionObject: ProductionObject | null;
};
export type AgentQueuedPrompt = AgentPromptQueueItem<AgentQueuedPromptPayload>;
export type AgentCodexRuntime = { instanceId: string; revision: number; busy: boolean; threadId: string; turnId: string };

let agentSource: EventSource | null = null;

type AgentStore = {
    width: number;
    panelOpen: boolean;
    panelMounted: boolean;
    panelClosing: boolean;
    creativeLaunch: AgentCreativeLaunch | null;
    scopedTask: AgentScopedTask | null;
    scopedTaskResult: AgentScopedTaskResult | null;
    canvasContext: AgentCanvasContext | null;
    url: string;
    token: string;
    connected: boolean;
    enabled: boolean;
    silentConnect: boolean;
    fragmentBootstrap: boolean;
    prompt: string;
    productionDraftObject: ProductionObject | null;
    productionTurnObject: ProductionObject | null;
    attachments: AgentAttachment[];
    canvasReferences: CanvasResourceReference[];
    sending: boolean;
    waiting: boolean;
    messages: AgentChatItem[];
    queuedPrompts: AgentQueuedPrompt[];
    promptQueueHydrated: boolean;
    pausedPromptQueueScopes: string[];
    codexRuntime: AgentCodexRuntime;
    tokenUsage: AgentTokenUsage | null;
    eventLogs: AgentEventLog[];
    threads: AgentThreadSummary[];
    activeThreadId: string;
    activeTurnId: string;
    workspacePath: string;
    loadingThreads: boolean;
    activeTab: AgentPanelTab;
    confirmTools: boolean;
    permissionMode: AgentPermissionMode;
    models: AgentModel[];
    model: string;
    reasoningEffort: AgentReasoningEffort | "";
    activity: string;
    conversation: AgentConversationState;
    bootstrapStatus: AgentBootstrapStatus | null;
    mcpStartupStatuses: Record<string, AgentBootstrapStatus>;
    connectError: string;
    pendingTool: AgentPendingToolCall | null;
    pendingApprovals: AgentPendingApproval[];
    setAgentState: (patch: Partial<Omit<AgentStore, "setAgentState" | "connectAgent" | "disconnectAgent" | "addMessage" | "addEventLog" | "clearEventLogs" | "openPanel" | "closePanel" | "togglePanel" | "setCanvasContext" | "updatePromptQueue" | "setPromptQueuePaused" | "clearPromptQueueForThread" | "setCodexRuntime">>) => void;
    openPanel: () => void;
    closePanel: () => void;
    togglePanel: () => void;
    setCanvasContext: (context: AgentCanvasContext | null) => void;
    updatePromptQueue: (update: (queue: AgentQueuedPrompt[]) => AgentQueuedPrompt[]) => void;
    setPromptQueuePaused: (threadId: string, conversationId: string, paused: boolean) => void;
    clearPromptQueueForThread: (threadId: string) => void;
    setCodexRuntime: (codexRuntime: AgentCodexRuntime) => void;
    connectAgent: (options?: { silent?: boolean }) => void;
    disconnectAgent: (patch?: Partial<Omit<AgentStore, "setAgentState" | "connectAgent" | "disconnectAgent" | "addMessage" | "addEventLog" | "clearEventLogs" | "openPanel" | "closePanel" | "togglePanel" | "setCanvasContext" | "updatePromptQueue" | "setPromptQueuePaused" | "clearPromptQueueForThread" | "setCodexRuntime">>) => void;
    addMessage: (item: AgentChatItem) => void;
    addEventLog: (item: AgentEventLog) => void;
    clearEventLogs: () => void;
};

export const CANVAS_AGENT_PANEL_MOTION_MS = 500;

let saveSettingsTimer: ReturnType<typeof setTimeout> | null = null;

function debouncedSaveAgentSettings(patch: Partial<AgentStore>) {
    if (saveSettingsTimer) clearTimeout(saveSettingsTimer);
    saveSettingsTimer = setTimeout(() => {
        saveSettingsTimer = null;
        const s: Partial<FrontendSettings> = {};
        if (patch.width !== undefined) s.agentPanelWidth = patch.width;
        if ((patch as Partial<AgentStore>).permissionMode !== undefined) s.agentPermissionMode = (patch as Partial<AgentStore>).permissionMode;
        if (patch.model !== undefined) s.agentModel = patch.model;
        if (patch.reasoningEffort !== undefined) s.agentReasoningEffort = patch.reasoningEffort;
        if (Object.keys(s).length > 0) void saveSettings(s);
    }, 500);
}

export const useAgentStore = create<AgentStore>((set, get) => ({
    width: 440,
    panelOpen: false,
    panelMounted: true,
    panelClosing: false,
    creativeLaunch: null,
    scopedTask: null,
    scopedTaskResult: null,
    canvasContext: null,
    url: getBackendUrl().replace(/\/$/, "") + "/agent",
    token: "",
    connected: false,
    enabled: false,
    silentConnect: false,
    fragmentBootstrap: false,
    prompt: "",
    productionDraftObject: null,
    productionTurnObject: null,
    attachments: [],
    canvasReferences: [],
    sending: false,
    waiting: false,
    messages: [],
    queuedPrompts: [],
    promptQueueHydrated: false,
    pausedPromptQueueScopes: [],
    codexRuntime: { instanceId: "", revision: 0, busy: false, threadId: "", turnId: "" },
    tokenUsage: null,
    eventLogs: [],
    threads: [],
    activeThreadId: "",
    activeTurnId: "",
    workspacePath: "",
    loadingThreads: false,
    activeTab: "setup",
    confirmTools: false,
    permissionMode: "request",
    models: [],
    model: "",
    reasoningEffort: "",
    activity: i18n.t("agent.state.ready"),
    conversation: { revision: 0, conversationId: "", threadId: "", status: "idle", mcpStatuses: {} },
    bootstrapStatus: null,
    mcpStartupStatuses: {},
    connectError: "",
    pendingTool: null,
    pendingApprovals: [],
    setAgentState: (patch) => {
        const before = get(), after = { ...before, ...patch };
        const draft = after.prompt.trim() || after.attachments.length || after.canvasReferences.length;
        const hadDraft = before.prompt.trim() || before.attachments.length || before.canvasReferences.length;
        let object = after.productionDraftObject;
        if (!draft) object = null;
        else if (!hadDraft && !object && !after.creativeLaunch && !after.scopedTask) {
            const workspace = useProductionWorkspaceStore.getState();
            object = workspace.selectedObject || (!after.canvasContext?.snapshot.selectedNodeIds.length && workspace.readiness?.presentation ? productionObjectForPresentation(workspace.readiness.presentation, workspace.production) : null);
        }
        set({ ...patch, productionDraftObject: object });
        // Debounced 持久化到 backend settings
        debouncedSaveAgentSettings(patch);
    },
    openPanel: () => set((state) => ({
        panelOpen: true,
        panelMounted: true,
        panelClosing: false,
        ...(state.connected || state.activeThreadId ? { activeTab: "chat" as const } : {}),
    })),
    closePanel: () => {
        if (!get().panelMounted || get().panelClosing) return;
        set({ panelOpen: false, panelClosing: true });
        setTimeout(() => {
            if (get().panelClosing) set({ panelClosing: false });
        }, CANVAS_AGENT_PANEL_MOTION_MS);
    },
    togglePanel: () => (get().panelOpen ? get().closePanel() : get().openPanel()),
    setCanvasContext: (canvasContext) => set({ canvasContext }),
    updatePromptQueue: (update) => set((state) => ({ queuedPrompts: update(state.queuedPrompts) })),
    setPromptQueuePaused: (threadId, conversationId, paused) => set((state) => {
        const key = JSON.stringify([threadId, conversationId]);
        const alreadyPaused = state.pausedPromptQueueScopes.includes(key);
        if (alreadyPaused === paused) return state;
        return { pausedPromptQueueScopes: paused ? [...state.pausedPromptQueueScopes, key] : state.pausedPromptQueueScopes.filter((item) => item !== key) };
    }),
    clearPromptQueueForThread: (threadId) => set((state) => {
        const queuedPrompts = state.queuedPrompts.filter((item) => item.threadId !== threadId);
        const pausedPromptQueueScopes = state.pausedPromptQueueScopes.filter((scope) => {
            try {
                return JSON.parse(scope)[0] !== threadId;
            } catch {
                return true;
            }
        });
        if (queuedPrompts.length === state.queuedPrompts.length && pausedPromptQueueScopes.length === state.pausedPromptQueueScopes.length) return state;
        return { queuedPrompts, pausedPromptQueueScopes };
    }),
    setCodexRuntime: (codexRuntime) => set({ codexRuntime }),
    connectAgent: (options) => {
        const silent = options?.silent ?? false;
        const endpoint = get().url.trim().replace(/\/$/, "");
        const token = get().token.trim();
        if (!endpoint || !token) return set({ connectError: silent ? "" : i18n.t("agent.state.connectionRequired") });
        try {
            const parsed = new URL(endpoint);
            if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
        } catch {
            return set({ connectError: silent ? "" : i18n.t("agent.state.invalidUrl") });
        }
        // Only set enabled here; LocalAgentPanel's effect owns SSE initialization.
        set({ enabled: true, silentConnect: silent, fragmentBootstrap: false, activity: i18n.t("agent.status.connecting"), connectError: "" });
    },
    disconnectAgent: (patch = {}) => {
        agentSource?.close();
        agentSource = null;
        set({ enabled: false, connected: false, silentConnect: false, fragmentBootstrap: false, activity: i18n.t("agent.state.offline"), conversation: { revision: 0, conversationId: "", threadId: "", status: "idle", mcpStatuses: {} }, bootstrapStatus: null, mcpStartupStatuses: {}, ...patch });
    },
    addMessage: (item) => set((state) => ({ messages: [...state.messages, item] })),
    addEventLog: (item) => set((state) => ({ eventLogs: [...state.eventLogs.slice(-160), item] })),
    clearEventLogs: () => set({ eventLogs: [] }),
}));

type PromptQueueSnapshot = { version: 1; queuedPrompts: AgentQueuedPrompt[]; pausedPromptQueueScopes: string[] };
const promptQueueStorage = localforage.createInstance({ name: "infinite-canvas-agent-prompt-queues" });
let promptQueueScope = "";
let promptQueueInitialization: Promise<void> | null = null;
let unsubscribePromptQueue: (() => void) | undefined;
let promptQueueWrite: Promise<unknown> = Promise.resolve();
let promptQueueStorageError: unknown;

/** The client ID is acquired with a Web Lock before loading: duplicated tabs cannot dispatch this queue. */
export function hydrateAgentPromptQueue(endpoint: string, clientId: string): Promise<void> {
    const scope = JSON.stringify([endpoint.replace(/\/$/, ""), clientId]);
    if (scope === promptQueueScope && promptQueueInitialization) return promptQueueInitialization;
    unsubscribePromptQueue?.();
    unsubscribePromptQueue = undefined;
    promptQueueScope = scope;
    useAgentStore.setState({ promptQueueHydrated: false });
    promptQueueInitialization = (async () => {
        await promptQueueWrite;
        const saved = await promptQueueStorage.getItem<PromptQueueSnapshot>(scope);
        if (scope !== promptQueueScope) return;
        if (saved && (saved.version !== 1 || !Array.isArray(saved.queuedPrompts) || !Array.isArray(saved.pausedPromptQueueScopes))) {
            throw new Error(i18n.t("agent.queue.storageFailed"));
        }
        const interruptedScopes = (saved?.queuedPrompts || []).filter((item) => item.status === "sending" || item.status === "interrupting").map((item) => JSON.stringify([item.threadId, item.conversationId]));
        useAgentStore.setState({
            queuedPrompts: (saved?.queuedPrompts || []).map((item) => item.status === "sending" || item.status === "interrupting"
                ? { ...item, status: "failed" as const, error: i18n.t("agent.queue.deliveryUncertain") }
                : item),
            pausedPromptQueueScopes: [...new Set([...(saved?.pausedPromptQueueScopes || []), ...interruptedScopes])],
            promptQueueHydrated: true,
        });
        promptQueueStorageError = undefined;
        unsubscribePromptQueue = useAgentStore.subscribe((state, before) => {
            if (state.queuedPrompts === before.queuedPrompts && state.pausedPromptQueueScopes === before.pausedPromptQueueScopes) return;
            const snapshot: PromptQueueSnapshot = { version: 1, queuedPrompts: state.queuedPrompts, pausedPromptQueueScopes: state.pausedPromptQueueScopes };
            promptQueueWrite = promptQueueWrite.then(() => promptQueueStorage.setItem(scope, snapshot)).then(() => {
                promptQueueStorageError = undefined;
            }).catch((error: unknown) => {
                promptQueueStorageError = error;
                console.warn("Agent prompt queue could not be saved", error);
            });
        });
    })().catch((error: unknown) => {
        promptQueueStorageError = error;
        throw error;
    });
    return promptQueueInitialization;
}

/** Do not clear the composer until the queued payload (including images) has reached IndexedDB. */
export async function flushAgentPromptQueue() {
    if (!unsubscribePromptQueue) throw new Error(i18n.t("agent.queue.storageFailed"));
    await promptQueueWrite;
    if (promptQueueStorageError) throw promptQueueStorageError;
}

/** 从 backend settings 同步 agent 相关配置 */
async function hydrateAgentSettings() {
    const settings = await fetchSettings();
    const patch: Partial<AgentStore> = {};
    if (settings.agentPanelWidth) patch.width = settings.agentPanelWidth;
    if (settings.agentPermissionMode) patch.permissionMode = settings.agentPermissionMode as AgentPermissionMode;
    if (settings.agentModel) patch.model = settings.agentModel;
    if (settings.agentReasoningEffort) patch.reasoningEffort = settings.agentReasoningEffort as AgentReasoningEffort;
    if (Object.keys(patch).length > 0) useAgentStore.setState(patch);
}

if (typeof window !== "undefined") {
    window.addEventListener("backend-connected", () => {
        void hydrateAgentSettings();
    });
}
