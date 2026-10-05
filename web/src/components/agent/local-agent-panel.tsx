import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { App, Button, Tooltip } from "antd";
import dayjs from "dayjs";
import { Bot, History, LocateFixed, MessageSquare, Minus, PanelRightClose, PlugZap, Plus, Sparkles, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { readAgentUrlBootstrap } from "@/lib/agent/agent-url-bootstrap";
import { ACHENG_DIRECTOR_SKILL_NAME, findProjectAchengDirectorSkill, creativeLaunchPrompt } from "@/lib/agent/creative-launch";
import { selectAvailableAgentModel } from "@/lib/agent/agent-model-selection";
import { enqueueAgentPrompt } from "@/lib/agent/agent-prompt-queue";
import { canvasThemes } from "@/lib/canvas-theme";
import { upscaleDataUrl } from "@/lib/canvas/canvas-image-data";
import { imageMetadata } from "@/lib/canvas/canvas-node-factory";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { resolveCanvasReferenceImages } from "@/lib/canvas/canvas-resource-references";
import { readImageMeta } from "@/lib/image-utils";
import { randomId } from "@/lib/utils";
import { uploadImage } from "@/services/image-storage";
import { useThemeStore } from "@/stores/use-theme-store";
import { useAgentSkillStore } from "@/stores/use-agent-skill-store";
import { useShallow } from "zustand/react/shallow";
import { useAgentStore, type AgentAttachment, type AgentBootstrapStatus, type AgentCanvasContext, type AgentCanvasReference, type AgentChatItem, type AgentConversationState, type AgentCreativeLaunch, type AgentModel, type AgentPendingApproval, type AgentPendingToolCall, type AgentPermissionMode, type AgentQueuedPrompt, type AgentQueuedPromptPayload, type AgentReasoningEffort, type AgentScopedTask, type AgentThreadSummary } from "@/stores/use-agent-store";
import { useBackendStore } from "@/stores/use-backend-store";
import { discoverBackendToken, editEpisodeProduction, fetchEpisodeProduction, fetchProductionReadiness } from "@/services/backend-api";
import { productionPresentationPath, productionTarget } from "@/lib/production-navigation";
import { useProductionFollowStore } from "@/stores/use-production-follow-store";
import { useProductionWorkspaceStore } from "@/stores/use-production-workspace-store";
import { productionObjectForPresentation, productionObjectPath, productionObjectPrompt } from "@/lib/production-object";
import { type CanvasAgentOp, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { isSiteTool, runSiteTool } from "@/lib/agent/agent-site-tools";
import { acknowledgeCodexHistory, activateAgentClient, AgentApiError, fetchAgentJson, interruptCodexTurn, postCodexApproval, postState, postToolResult } from "@/services/api/canvas-agent";
import { AgentChatTimeline, AgentTaskProgress, AgentUsageBar } from "./agent-chat";
import { AgentChatComposer } from "./agent-chat-composer";
import { AgentChatQueue } from "./agent-chat-queue";
import { useAgentPromptQueue, type AgentPromptSubmissionResult } from "./use-agent-prompt-queue";
import { AgentConnectView } from "./agent-connect-view";
import {
    activityDeltaFallback,
    activityDetail,
    activityKind,
    activityPlaceholder,
    agentAttachmentToChatAttachment,
    agentErrorView,
    attachmentPayloadBytes,
    compactText,
    eventUsage,
    formatAgentActivity,
    formatAgentEvent,
    formatAgentEventLog,
    formatAgentPlan,
    formatBytes,
    bindPendingTurnMessages,
    isCanvasWriteTool,
    isConnectionErrorMessage,
    isCurrentThreadEvent,
    isReasoningSummary,
    mergeAgentMessages,
    mergeStreamText,
    normalizeHistoryMessages,
    normalizeText,
    parseEventData,
    promptWithAttachments,
    promptWithCanvasReferences,
    reasoningActivityText,
    registerLiveAgentTurn,
    scopeChatItem,
    stringText,
    toolName,
    turnPlanStatus,
    upsertAgentMessage,
    type AgentEventItem,
    type AgentEventPayload,
} from "./agent-event-formatters";
import { AgentHistoryView } from "./agent-history-view";
import { AgentLogView } from "./agent-log-view";
import { AgentPanelTabs } from "./agent-panel-tabs";
import { AgentSkillsView } from "./agent-skills-view";

const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_PAYLOAD_BYTES = 28 * 1024 * 1024;
const MESSAGE_PREVIEW_LONG_EDGE = 192;
const MESSAGE_PREVIEW_MAX_LENGTH = 500_000;
const AGENT_PROTOCOL_VERSION = 6;
const HISTORY_RETRY_DELAYS_MS = [0, 150, 350, 700, 1200];
const rt = (key: string, options?: Record<string, unknown>) => i18n.t(`agent.runtime.${key}`, options);

type AgentWorkspace = { workspacePath: string; activeThreadId?: string };
type AgentThreadsResponse = { ok?: boolean; workspace?: AgentWorkspace; conversation?: AgentConversationState; data?: AgentThreadSummary[] };
type AgentThreadResponse = { ok?: boolean; workspace?: AgentWorkspace; conversation?: AgentConversationState; thread?: AgentThreadSummary; messages?: AgentChatItem[]; settledTurnIds?: string[]; historyReady?: boolean };
type AgentWorkspaceResponse = { ok?: boolean; workspace?: AgentWorkspace; conversation?: AgentConversationState };
type AgentTurnResponse = { ok?: boolean; threadId?: string };
type AgentCodexState = { busy?: boolean; threadId?: string; turnId?: string };
type AgentRuntimeState = { instanceId: string; revision: number; heartbeatIntervalMs?: number; conversation: AgentConversationState; codex: AgentCodexState; pendingApprovals: AgentPendingApproval[] };

type AgentHelloEvent = { ok?: boolean; protocolVersion?: number; clientId?: string; workspace?: { activeThreadId?: string }; conversation?: AgentConversationState; codex?: AgentCodexState; pendingApprovals?: AgentPendingApproval[]; runtime?: AgentRuntimeState };
type AgentWorkspaceEvent = { activeThreadId?: string; threadId?: string; sourceClientId?: string; emptyThread?: boolean; draftThread?: boolean; conversation?: AgentConversationState };
type AgentChatEvent = { threadId?: string; turnId?: string; sourceClientId?: string; replayed?: boolean; message?: AgentChatItem };
type AgentBootstrapEvent = { type?: "codex.preparing" | "codex.prepare_failed" | "mcp.startup" | "mcp.complete"; phase?: "preheat" | "runtime"; threadId?: string; name?: string; status?: "starting" | "ready" | "failed" | "cancelled"; error?: string | null; failureReason?: string | null };
type AgentClientGlobal = typeof globalThis & { __infiniteCanvasAgentClientIdPromise?: Promise<string> };

function authoritativeHistoryTurnKeys(threadId: string, settledTurnIds: string[]) {
    return new Set(settledTurnIds.map((turnId) => `${threadId}\0${turnId}`));
}

function agentErrorState(error: unknown) {
    return error instanceof AgentApiError ? (error.response as { state?: AgentConversationState }).state : undefined;
}

function conversationBootstrapView(conversation: AgentConversationState) {
    const mcpStartupStatuses: Record<string, AgentBootstrapStatus> = Object.fromEntries(Object.entries(conversation.mcpStatuses).map(([name, item]) => {
        const view: AgentBootstrapStatus = item.status === "starting"
            ? { key: `mcp:${name}:starting`, text: rt("mcpStarting", { name }), detail: rt("mcpConnecting"), status: "running" }
            : item.status === "ready"
                ? { key: `mcp:${name}:ready`, text: rt("mcpReadyNamed", { name }), detail: rt("toolsReady"), status: "ready" }
                : { key: `mcp:${name}:${item.status}`, text: rt(item.status === "failed" ? "mcpFailedNamed" : "mcpCanceledNamed", { name }), detail: item.error || rt("toolInitFailed"), status: "error" };
        return [name, view];
    }));
    const services = Object.values(mcpStartupStatuses);
    const pending = services.filter((item) => item.status === "running").length;
    const bootstrapStatus: AgentBootstrapStatus | null = conversation.status === "idle" || conversation.status === "preparing"
        ? services.length
            ? { key: "mcp:starting", text: rt("mcpServicesStarting"), detail: pending ? rt("toolServicesPending", { count: pending }) : rt("checkingToolServices"), status: "running" }
            : { key: "codex:preparing", text: rt("conversationInitializing"), detail: rt("conversationCreating"), status: "running" }
        : conversation.status === "warning"
            ? { key: "mcp:warning", text: rt("someMcpFailed"), detail: rt("remainingToolsReady"), status: "error" }
            : conversation.status === "failed"
                ? { key: "codex:prepare_failed", text: rt("conversationInitFailed"), detail: conversation.error || rt("conversationCreateFailed"), status: "error" }
                : conversation.status === "ready"
                    ? { key: "mcp:ready", text: rt("mcpServicesReady", { count: services.length }), detail: rt("toolsReady"), status: "ready" }
                    : null;
    return { bootstrapStatus, mcpStartupStatuses };
}

export function LocalAgentPanel({ embedded, headless, autoConnect, compact, headerAction }: { embedded?: boolean; headless?: boolean; autoConnect?: boolean; compact?: boolean; headerAction?: ReactNode }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { message, modal } = App.useApp();
    const { hash } = useLocation();
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    // Field-level selectors with useShallow rerender only when these fields change.
    // canvasContext is intentionally excluded because project updates it every frame during dragging and resizing.
    // The panel uses it only for ref synchronization and debounced postState calls, never during rendering.
    // Subscribing here would rerender the panel every frame and amplify the #185 crash, so it is observed imperatively below.
    const { width, url, token, connected, enabled, prompt, attachments, sending, waiting, tokenUsage, eventLogs, threads, activeThreadId, workspacePath, loadingThreads, activeTab, confirmTools, permissionMode, models, model, reasoningEffort, activity, conversation, connectError, pendingTool, pendingApprovals, creativeLaunch, scopedTask, queuedPrompts, pausedPromptQueueScopes, codexRuntime } = useAgentStore(
        useShallow((state) => ({
            width: state.width,
            url: state.url,
            token: state.token,
            connected: state.connected,
            enabled: state.enabled,
            prompt: state.prompt,
            attachments: state.attachments,
            sending: state.sending,
            waiting: state.waiting,
            tokenUsage: state.tokenUsage,
            eventLogs: state.eventLogs,
            threads: state.threads,
            activeThreadId: state.activeThreadId,
            workspacePath: state.workspacePath,
            loadingThreads: state.loadingThreads,
            activeTab: state.activeTab,
            confirmTools: state.confirmTools,
            permissionMode: state.permissionMode,
            models: state.models,
            model: state.model,
            reasoningEffort: state.reasoningEffort,
            activity: state.activity,
            conversation: state.conversation,
            connectError: state.connectError,
            pendingTool: state.pendingTool,
            pendingApprovals: state.pendingApprovals,
            creativeLaunch: state.creativeLaunch,
            scopedTask: state.scopedTask,
            queuedPrompts: state.queuedPrompts,
            pausedPromptQueueScopes: state.pausedPromptQueueScopes,
            codexRuntime: state.codexRuntime,
        })),
    );
    const setAgentState = useAgentStore((state) => state.setAgentState);
    const setCodexRuntime = useAgentStore((state) => state.setCodexRuntime);
    const productionFollow = useProductionFollowStore(state => state.target);
    const productionPresentation = useProductionFollowStore(state => state.presentation);
    const followingProduction = useProductionFollowStore(state => state.following);
    const draftObject = useAgentStore(state => state.productionDraftObject);
    const turnObject = useAgentStore(state => state.productionTurnObject);
    const unscopedDraft = useAgentStore(state => !state.productionDraftObject && Boolean(state.prompt.trim() || state.attachments.length || state.canvasReferences.length));
    const hasCanvasSelection = useAgentStore(state => Boolean(state.canvasContext?.snapshot.selectedNodeIds.length));
    const selectedObject = useProductionWorkspaceStore(state => state.selectedObject);
    const workspacePresentation = useProductionWorkspaceStore(state => state.readiness?.presentation);
    const workspaceProduction = useProductionWorkspaceStore(state => state.production);
    const chatObject = draftObject || ((sending || waiting) ? turnObject : null) || (!unscopedDraft ? selectedObject || (!hasCanvasSelection && workspacePresentation ? productionObjectForPresentation(workspacePresentation, workspaceProduction) : null) : null);
    const conversationReady = conversation.status === "ready" || conversation.status === "warning";
    const queueBusy = codexRuntime.busy || waiting || conversation.status === "running";
    const queueWaiting = waiting || (codexRuntime.busy && codexRuntime.threadId === activeThreadId);
    const conversationCanAcceptInput = conversationReady || conversation.status === "running";
    const conversationBusy = conversation.status === "preparing" || conversation.status === "running";
    const closePanel = useAgentStore((state) => state.closePanel);
    const pushMessage = useAgentStore((state) => state.addMessage);
    const pushEventLog = useAgentStore((state) => state.addEventLog);
    const clearEventLogs = useAgentStore((state) => state.clearEventLogs);
    const loadSkills = useAgentSkillStore((state) => state.loadSkills);
    const clearSkillSelection = useAgentSkillStore((state) => state.clearSelection);
    const skillCount = useAgentSkillStore((state) => state.skills.length);
    const skillsLoaded = useAgentSkillStore((state) => state.loaded);
    const messageCount = useAgentStore((state) => state.messages.length);
    const canvasContextRef = useRef<AgentCanvasContext | null>(useAgentStore.getState().canvasContext);
    const confirmToolsRef = useRef(confirmTools);
    const pendingToolRef = useRef<AgentPendingToolCall | null>(null);
    const autoConnectRef = useRef(false);
    const urlAutoConnectRef = useRef(false);
    const connectionPendingRef = useRef(false);
    const connectedRef = useRef(false);
    const errorLoggedRef = useRef(false);
    const attachmentUrlsRef = useRef(new Set<string>());
    const clientIdRef = useRef("");
    const [clientReady, setClientReady] = useState(false);
    const loadThreadsSequenceRef = useRef(0);
    const threadMessagesRef = useRef(new Map<string, AgentChatItem[]>());
    const authoritativeHistoryTurnsRef = useRef(new Set<string>());
    const liveTurnKeysRef = useRef(new Set<string>());
    const runtimeCursorRef = useRef<{ instanceId: string; revision: number } | null>(null);
    const runtimeRequestSequenceRef = useRef(0);
    const [runtimeHeartbeatMs, setRuntimeHeartbeatMs] = useState(0);
    const threadOperationRef = useRef(0);
    const scopedTaskOperationRef = useRef("");
    const threadOperationSequenceRef = useRef(0);
    const endpoint = useMemo(() => url.trim().replace(/\/$/, ""), [url]);
    const backendUrl = useBackendStore((state) => state.url);
    const backendAgentUrl = useMemo(() => backendUrl.replace(/\/$/, "") + "/agent", [backendUrl]);
    const urlAgentAutoConnect = searchParams.has("agentUrl") && searchParams.has("agentToken");
    useEffect(() => {
        let disposed = false;
        void acquireAgentClientId().then((clientId) => {
            if (!disposed) {
                clientIdRef.current = clientId;
                setClientReady(true);
            }
        });
        return () => { disposed = true; };
    }, []);
    const loadThreadSnapshot = useCallback(async (threadId: string, sequence: number, response?: AgentThreadResponse, expectedTurnId = "") => {
        let thread = response;
        let lastError: unknown;
        for (const delayMs of HISTORY_RETRY_DELAYS_MS) {
            if (delayMs) await delay(delayMs);
            if (sequence !== loadThreadsSequenceRef.current || useAgentStore.getState().activeThreadId !== threadId) return false;
            try {
                thread ||= await fetchAgentJson<AgentThreadResponse>(endpoint, token, `/codex/threads/${encodeURIComponent(threadId)}`);
                lastError = undefined;
            } catch (error) {
                lastError = error;
                thread = undefined;
                continue;
            }
            const history = normalizeHistoryMessages(thread.messages || []);
            const latest = useAgentStore.getState();
            if (sequence !== loadThreadsSequenceRef.current || latest.activeThreadId !== threadId) return false;
            const historyTurns = authoritativeHistoryTurnKeys(threadId, thread.settledTurnIds || []);
            const hasExpectedTurn = !expectedTurnId || historyTurns.has(`${threadId}\0${expectedTurnId}`);
            const activeTurnSettled = Boolean(latest.activeTurnId && historyTurns.has(`${threadId}\0${latest.activeTurnId}`));
            historyTurns.forEach((key) => liveTurnKeysRef.current.delete(key));
            if (latest.activeTurnId && !activeTurnSettled) liveTurnKeysRef.current.add(`${threadId}\0${latest.activeTurnId}`);
            authoritativeHistoryTurnsRef.current = historyTurns;
            const messages = mergeAgentMessages(history, latest.messages, threadId, liveTurnKeysRef.current);
            threadMessagesRef.current.set(threadId, messages);
            setAgentState({ messages, connectError: "", ...(activeTurnSettled ? { waiting: false, sending: false, activeTurnId: "", pendingTool: null, pendingApprovals: [], activity: history.some(item => item.turnId === latest.activeTurnId && item.role === "error") ? rt("processingFailed") : rt("completed") } : {}) });
            const coveredTurnIds = [...historyTurns].map((key) => key.slice(threadId.length + 1));
            if (coveredTurnIds.length) void acknowledgeCodexHistory(endpoint, token, threadId, coveredTurnIds).catch(() => undefined);
            if (hasExpectedTurn && (thread.historyReady !== false || Boolean(expectedTurnId))) return true;
            thread = undefined;
        }
        if (lastError) throw lastError;
        return false;
    }, [endpoint, setAgentState, token]);
    const applyWorkspaceChange = useCallback((data: AgentWorkspaceEvent) => {
        const nextThreadId = data.activeThreadId ?? data.threadId ?? "";
        const current = useAgentStore.getState();
        const threadChanged = current.activeThreadId !== nextThreadId;
        const emptyThread = Boolean(data.emptyThread || data.draftThread);
        const pendingMessage = [...current.messages].reverse().find((item) => item.role === "user" && !item.turnId);
        const keepPendingMessage = Boolean(
            data.emptyThread
            && pendingMessage
            && (current.sending || current.waiting)
            && (!data.sourceClientId || data.sourceClientId === clientIdRef.current),
        );
        if (threadChanged && current.activeThreadId) {
            const messages = keepPendingMessage ? current.messages.filter((item) => item.id !== pendingMessage!.id) : current.messages;
            threadMessagesRef.current.set(current.activeThreadId, messages);
        }
        if (emptyThread && nextThreadId) threadMessagesRef.current.delete(nextThreadId);
        if (threadChanged || emptyThread) {
            loadThreadsSequenceRef.current += 1;
            authoritativeHistoryTurnsRef.current.clear();
            liveTurnKeysRef.current.clear();
        }
        const messages = keepPendingMessage
            ? [scopeChatItem(pendingMessage!, nextThreadId, "")]
            : emptyThread ? []
                : threadChanged ? threadMessagesRef.current.get(nextThreadId) || []
                    : current.messages;
        pendingToolRef.current = null;
        setAgentState({
            activeThreadId: nextThreadId,
            activeTurnId: threadChanged || emptyThread ? "" : current.activeTurnId,
            messages,
            tokenUsage: threadChanged || emptyThread ? null : current.tokenUsage,
            pendingTool: null,
            pendingApprovals: threadChanged || emptyThread ? [] : current.pendingApprovals,
        });
        return loadThreadsSequenceRef.current;
    }, [setAgentState]);
    const applyConversationState = useCallback((next: AgentConversationState, force = false) => {
        const current = useAgentStore.getState();
        if (!next?.revision || !force && next.revision <= current.conversation.revision) return false;
        const conversationChanged = next.conversationId !== current.conversation.conversationId;
        if (conversationChanged || next.threadId !== current.activeThreadId) {
            applyWorkspaceChange({
                activeThreadId: next.threadId,
                emptyThread: conversationChanged || !current.activeThreadId,
                draftThread: next.status === "preparing",
                sourceClientId: next.sourceClientId,
            });
        }
        setAgentState({ conversation: next, ...conversationBootstrapView(next) });
        return true;
    }, [applyWorkspaceChange, setAgentState]);
    const loadThreads = useCallback(async (skipHistory = false, expectedTurnId = "") => {
        if (!connectedRef.current && !useAgentStore.getState().connected) return;
        let sequence = ++loadThreadsSequenceRef.current;
        setAgentState({ loadingThreads: true });
        try {
            const data = await fetchAgentJson<AgentThreadsResponse>(endpoint, token, `/codex/threads`);
            if (sequence !== loadThreadsSequenceRef.current) return;
            if (data.conversation) {
                applyConversationState(data.conversation);
                sequence = loadThreadsSequenceRef.current;
            }
            const current = useAgentStore.getState();
            const currentThreadId = current.activeThreadId || data.workspace?.activeThreadId || "";
            if (!data.conversation && currentThreadId !== current.activeThreadId) sequence = applyWorkspaceChange({ activeThreadId: currentThreadId });
            if (sequence !== loadThreadsSequenceRef.current || useAgentStore.getState().activeThreadId !== currentThreadId) return;
            setAgentState({ threads: data.data || [], workspacePath: data.workspace?.workspacePath || "" });
            if (currentThreadId && !skipHistory) {
                await loadThreadSnapshot(currentThreadId, sequence, undefined, expectedTurnId);
            } else {
                authoritativeHistoryTurnsRef.current.clear();
                liveTurnKeysRef.current.clear();
            }
        } catch (error) {
            addEventLog(rt("historyReadFailed"), error);
        } finally {
            if (sequence === loadThreadsSequenceRef.current && !threadOperationRef.current) setAgentState({ loadingThreads: false });
        }
    }, [applyConversationState, applyWorkspaceChange, endpoint, loadThreadSnapshot, setAgentState, token]);

    const applyRuntimeState = useCallback((snapshot: AgentRuntimeState, allowNewInstance = false) => {
        if (!snapshot?.instanceId || !Number.isInteger(snapshot.revision) || snapshot.revision < 1 || !snapshot.conversation || !snapshot.codex) return;
        const cursor = runtimeCursorRef.current;
        const newInstance = cursor?.instanceId !== snapshot.instanceId;
        if (cursor && (newInstance && !allowNewInstance || !newInstance && snapshot.revision < cursor.revision)) return;
        const before = useAgentStore.getState();
        if (!newInstance && !snapshot.codex.busy && snapshot.codex.threadId === before.activeThreadId && snapshot.codex.turnId && before.activeTurnId && snapshot.codex.turnId !== before.activeTurnId) return;
        runtimeCursorRef.current = { instanceId: snapshot.instanceId, revision: snapshot.revision };
        setCodexRuntime({ instanceId: snapshot.instanceId, revision: snapshot.revision, busy: Boolean(snapshot.codex.busy), threadId: String(snapshot.codex.threadId || ""), turnId: String(snapshot.codex.turnId || "") });
        if (Number.isInteger(snapshot.heartbeatIntervalMs) && snapshot.heartbeatIntervalMs! > 0) setRuntimeHeartbeatMs(snapshot.heartbeatIntervalMs!);
        applyConversationState(snapshot.conversation, newInstance);
        const current = useAgentStore.getState();
        const busy = Boolean(snapshot.codex.busy && snapshot.codex.threadId === current.activeThreadId);
        const activeTurnId = busy ? snapshot.codex.turnId || "" : "";
        if (activeTurnId) liveTurnKeysRef.current.add(`${current.activeThreadId}\0${activeTurnId}`);
        const pendingApprovals = busy ? (snapshot.pendingApprovals || []).filter(item => !item.threadId || item.threadId === current.activeThreadId) : [];
        const keepSending = current.sending && !busy && !newInstance;
        if (!busy) pendingToolRef.current = null;
        setAgentState({ waiting: busy, sending: keepSending, activeTurnId, pendingApprovals, connectError: "", ...(!busy ? { pendingTool: null } : {}),
            activity: pendingApprovals.length ? rt("awaitingApproval") : busy ? rt("codexRunning") : current.activity === rt("processingFailed") ? current.activity : rt("connected") });
        if (!busy && before.activeThreadId === current.activeThreadId && (before.waiting || before.activeTurnId)) void loadThreads(false, before.activeTurnId);
    }, [applyConversationState, loadThreads, setAgentState, setCodexRuntime]);

    const reconcileRuntimeState = useCallback(async () => {
        const sequence = ++runtimeRequestSequenceRef.current;
        const cursor = runtimeCursorRef.current;
        const state = useAgentStore.getState();
        try {
            const response = await fetchAgentJson<{ runtime?: AgentRuntimeState; codexBusy?: boolean; conversation?: AgentConversationState }>(endpoint, token, cursor ? "/codex/state" : "/health");
            if (sequence !== runtimeRequestSequenceRef.current || useAgentStore.getState().activeThreadId !== state.activeThreadId) return;
            if (response.runtime) applyRuntimeState(response.runtime, cursor === runtimeCursorRef.current);
            else if (response.conversation?.threadId === state.activeThreadId && typeof response.codexBusy === "boolean") {
                const latest = useAgentStore.getState();
                if (latest.activeTurnId !== state.activeTurnId || latest.sending || response.conversation.revision < latest.conversation.revision) return;
                applyConversationState(response.conversation);
                setCodexRuntime({ instanceId: latest.codexRuntime.instanceId || "legacy", revision: Math.max(latest.codexRuntime.revision + 1, response.conversation.revision), busy: response.codexBusy, threadId: response.conversation.threadId, turnId: latest.codexRuntime.turnId || latest.activeTurnId });
                if (response.codexBusy && response.conversation.status === "running") setAgentState({ waiting: true });
                else if (!response.codexBusy && response.conversation.status !== "running") {
                    if (state.activeTurnId) await loadThreads(false, state.activeTurnId);
                    else setAgentState({ waiting: false });
                }
            } else if (state.activeTurnId) await loadThreads(false, state.activeTurnId);
        } catch {
            // Older servers still support history reconciliation; failures never imply completion.
            if (sequence !== runtimeRequestSequenceRef.current) return;
            setAgentState({ activity: rt("conversationSyncFailed"), connectError: rt("conversationSyncFailed") });
        }
    }, [applyConversationState, applyRuntimeState, endpoint, loadThreads, setAgentState, setCodexRuntime, token]);
    // Imperatively subscribe to canvasContext to keep the ref current and debounce snapshot reports without rerendering the panel.
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const unsubscribe = useAgentStore.subscribe((state) => {
            if (state.canvasContext === canvasContextRef.current) return;
            canvasContextRef.current = state.canvasContext;
            if (!useAgentStore.getState().connected) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => void postState(endpoint, token, clientIdRef.current, canvasContextRef.current?.snapshot || null), 300);
        });
        return () => {
            unsubscribe();
            if (timer) clearTimeout(timer);
        };
    }, [endpoint, token]);
    useEffect(() => {
        confirmToolsRef.current = confirmTools;
    }, [confirmTools]);
    useEffect(() => {
        pendingToolRef.current = pendingTool;
    }, [pendingTool]);
    useEffect(() => () => attachmentUrlsRef.current.forEach((url) => URL.revokeObjectURL(url)), []);

    useEffect(() => {
        if (!clientReady || !enabled || !token.trim()) return;
        const clientId = clientIdRef.current;
        let disposed = false;
        let protocolRejected = false;
        let eventQueue = Promise.resolve();
        runtimeCursorRef.current = null;
        setRuntimeHeartbeatMs(0);
        runtimeRequestSequenceRef.current++;
        const isCurrentConnection = () => !disposed && clientIdRef.current === clientId;
        const enqueueEvent = (task: () => void | Promise<void>) => {
            eventQueue = eventQueue.then(async () => {
                if (isCurrentConnection()) await task();
            }).catch((error) => {
                if (isCurrentConnection()) addEventLog(rt("conversationSyncFailed"), error);
            });
        };
        const source = (() => {
            try {
                const u = new URL(endpoint);
                if ((u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port === "17370" && typeof window !== "undefined") {
                    // 本地总后台：走同源相对路径，经 Vite 代理转发，绕开浏览器系统代理对 SSE 长连接的截断
                    return new EventSource(`/agent/events?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`);
                }
            } catch { /* 解析失败则回退绝对地址 */ }
            return new EventSource(`${endpoint}/events?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`);
        })();
        source.addEventListener("hello", (event) => {
            if (!isCurrentConnection()) return;
            const hello = parseEventData<AgentHelloEvent>(event);
            if (hello?.protocolVersion !== AGENT_PROTOCOL_VERSION) {
                const text = rt("agentOutdated");
                protocolRejected = true;
                source.close();
                connectedRef.current = false;
                setAgentState({ enabled: false, connected: false, waiting: false, sending: false, activity: rt("restartRequired"), connectError: text, silentConnect: false, fragmentBootstrap: false, pendingTool: null, pendingApprovals: [] });
                useAgentSkillStore.getState().reset();
                addEventLog(rt("versionMismatch"), text, hello);
                if (!headless) message.error(text);
                return;
            }
            const previousRuntime = useAgentStore.getState();
            const codex = hello?.codex;
            const busy = Boolean(codex?.busy);
            const nextThreadId = hello?.conversation?.threadId ?? hello?.workspace?.activeThreadId ?? useAgentStore.getState().activeThreadId;
            const previousCodex = useAgentStore.getState().codexRuntime;
            setCodexRuntime({
                instanceId: hello?.runtime?.instanceId || previousCodex.instanceId || "legacy",
                revision: hello?.runtime?.revision || previousCodex.revision + 1,
                busy,
                threadId: codex?.threadId || nextThreadId,
                turnId: codex?.turnId || "",
            });
            if (hello?.conversation) applyConversationState(hello.conversation, true);
            else applyWorkspaceChange({ activeThreadId: nextThreadId });
            const current = useAgentStore.getState();
            const nextTurnId = codex?.threadId === nextThreadId ? codex.turnId ?? "" : "";
            if (nextTurnId) liveTurnKeysRef.current.add(`${nextThreadId}\0${nextTurnId}`);
            const activeTurnId = busy ? nextTurnId : "";
            const pendingApprovals = busy ? (hello?.pendingApprovals || []).filter((item) => !item.threadId || item.threadId === nextThreadId) : [];
            const messages = activeTurnId
                ? bindPendingTurnMessages(current.messages.filter((item) => !isConnectionErrorMessage(item)), nextThreadId, activeTurnId)
                : current.messages.filter((item) => !isConnectionErrorMessage(item));
            errorLoggedRef.current = false;
            connectedRef.current = true;
            setAgentState({
                connected: true,
                activity: pendingApprovals.length ? rt("awaitingApproval") : busy ? rt("codexRunning") : rt("connected"),
                waiting: busy,
                sending: false,
                connectError: "",
                silentConnect: false,
                fragmentBootstrap: false,
                activeThreadId: nextThreadId,
                activeTurnId,
                messages,
                pendingApprovals,
            });
            if (!headless) message.success(rt("localAgentConnected"));
            if (hello?.runtime) applyRuntimeState(hello.runtime, true);
            if (!busy && previousRuntime.activeThreadId === nextThreadId && previousRuntime.activeTurnId) void loadThreads(false, previousRuntime.activeTurnId);
            void postState(endpoint, token, clientId, canvasContextRef.current?.snapshot || null);
            if (document.visibilityState === "visible" && document.hasFocus()) void activateAgentClient(endpoint, token, clientId);
            if (!busy && !nextThreadId && (!hello?.conversation || hello.conversation.status === "idle")) {
                void fetchAgentJson<AgentWorkspaceResponse>(endpoint, token, "/codex/threads/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId, permissionMode }) })
                    .then((result) => result.conversation && applyConversationState(result.conversation))
                    .catch((error) => {
                        const state = agentErrorState(error);
                        if (state) applyConversationState(state);
                        addEventLog(rt("conversationInitFailed"), error);
                    });
            }
        });
        source.addEventListener("codex_state", (event) => {
            if (runtimeCursorRef.current) return; // Modern servers send a versioned, complete runtime snapshot.
            const data = parseEventData<AgentCodexState>(event);
            if (!data) return;
            enqueueEvent(async () => {
                const busy = Boolean(data.busy);
                const current = useAgentStore.getState();
                const appliesToCurrentThread = !data.threadId || data.threadId === current.activeThreadId;
                if (!appliesToCurrentThread) return;
                if (data.turnId && current.activeTurnId && data.turnId !== current.activeTurnId && !busy) return;
                const turnId = data.turnId || current.activeTurnId;
                if (turnId) liveTurnKeysRef.current.add(`${current.activeThreadId}\0${turnId}`);
                const activeTurnId = busy ? turnId : "";
                setCodexRuntime({ instanceId: current.codexRuntime.instanceId || "legacy", revision: current.codexRuntime.revision + 1, busy, threadId: data.threadId || current.activeThreadId, turnId });
                const messages = activeTurnId ? bindPendingTurnMessages(current.messages, current.activeThreadId, activeTurnId) : current.messages;
                setAgentState({
                    activity: busy ? rt("codexRunning") : current.activity === rt("processingFailed") ? rt("processingFailed") : rt("completed"),
                    waiting: busy,
                    sending: false,
                    activeTurnId,
                    messages,
                });
                if (!busy && current.waiting) void loadThreads(false, turnId);
            });
        });
        source.addEventListener("runtime_state", event => {
            const snapshot = parseEventData<AgentRuntimeState>(event);
            if (snapshot) enqueueEvent(() => applyRuntimeState(snapshot));
        });
        source.addEventListener("ping", event => {
            const ping = parseEventData<{ runtime?: AgentRuntimeState }>(event);
            if (ping?.runtime) enqueueEvent(() => applyRuntimeState(ping.runtime!));
            else if (isCurrentConnection() && useAgentStore.getState().waiting) void reconcileRuntimeState();
        });
        source.addEventListener("tool_call", (event) => {
            if (!isCurrentConnection()) return;
            const data = parseEventData<AgentPendingToolCall>(event);
            if (data) void handleToolCall(endpoint, token, data);
        });
        source.addEventListener("codex_approval", (event) => {
            if (!isCurrentConnection()) return;
            const data = parseEventData<AgentPendingApproval>(event);
            if (!data || !isCurrentThreadEvent(data)) return;
            setAgentState({ pendingApprovals: [...useAgentStore.getState().pendingApprovals.filter((item) => item.requestId !== data.requestId), data], activity: rt("awaitingApproval") });
            addEventLog(rt("awaitingApproval"), data.reason || data.method, data);
        });
        source.addEventListener("codex_approval_resolved", (event) => {
            if (!isCurrentConnection()) return;
            const data = parseEventData<{ requestId?: string; decision?: "accept" | "acceptForSession" | "decline" | "cancel" }>(event);
            if (!data?.requestId) return;
            const current = useAgentStore.getState();
            const approval = current.pendingApprovals.find((item) => item.requestId === data.requestId);
            const pendingApprovals = current.pendingApprovals.filter((item) => item.requestId !== data.requestId);
            setAgentState({ pendingApprovals, activity: approvalActivity(pendingApprovals, current.waiting, current.activity) });
            const decision = data.decision || approval?.deciding;
            if (approval && decision) addEventLog(rt(decision === "accept" || decision === "acceptForSession" ? "approvalGranted" : "approvalCanceled"), approval.reason || approval.method, approval);
        });
        source.addEventListener("agent_event", (event) => {
            const data = parseEventData<AgentEventPayload>(event);
            if (data) enqueueEvent(() => {
                if (!isCurrentThreadEvent(data)) return;
                const shouldProcess = registerLiveAgentTurn(data, authoritativeHistoryTurnsRef.current, liveTurnKeysRef.current);
                if (data.type !== "usage.updated" && !shouldProcess) return;
                return handleAgentEvent(data);
            });
        });
        source.addEventListener("agent_bootstrap", (event) => {
            const data = parseEventData<AgentBootstrapEvent>(event);
            if (!data?.type) return;
            if (data.type === "codex.preparing") {
                addEventLog(rt("conversationInitializing"), rt("conversationCreating"), data);
                return;
            }
            if (data.type === "codex.prepare_failed") {
                addEventLog(rt("conversationInitFailed"), data.error, data);
                return;
            }
            if (data.type === "mcp.complete") {
                addEventLog(rt("mcpStatusComplete"), rt("mcpListRead"), data);
                return;
            }
            if (!data.name || !data.status) return;
            const label = data.name;
            const status = data.status === "starting"
                ? { text: rt("mcpStarting", { name: label }), detail: rt("mcpConnecting"), status: "running" as const }
                : data.status === "ready"
                    ? { text: rt("mcpReadyNamed", { name: label }), detail: rt("toolsReady"), status: "ready" as const }
                    : data.status === "failed"
                        ? { text: rt("mcpFailedNamed", { name: label }), detail: data.error || rt("toolInitFailed"), status: "error" as const }
                        : { text: rt("mcpCanceledNamed", { name: label }), detail: rt("toolInitCanceled"), status: "error" as const };
            addEventLog(status.text, status.detail, data);
        });
        source.addEventListener("conversation_changed", (event) => {
            const data = parseEventData<AgentConversationState>(event);
            if (data) enqueueEvent(() => { applyConversationState(data); });
        });
        source.addEventListener("workspace_changed", (event) => {
            const data = parseEventData<AgentWorkspaceEvent>(event);
            if (!data) return;
            enqueueEvent(() => {
                if (data.conversation) applyConversationState(data.conversation);
                else applyWorkspaceChange(data);
                if (!data.draftThread) void loadThreads(Boolean(data.emptyThread));
            });
        });
        source.addEventListener("chat_message", (event) => {
            const data = parseEventData<AgentChatEvent>(event);
            if (!data?.message) return;
            enqueueEvent(() => {
                if (!isCurrentThreadEvent(data)) return;
                if (!registerLiveAgentTurn(data, authoritativeHistoryTurnsRef.current, liveTurnKeysRef.current)) return;
                const current = useAgentStore.getState();
                const threadId = data.threadId || data.message!.threadId || current.activeThreadId;
                const turnId = data.turnId ?? data.message!.turnId ?? "";
                const clientMessageId = data.message!.clientMessageId || data.message!.itemId || data.message!.id;
                if (current.activeThreadId !== threadId) return;
                const next = scopeChatItem(data.message!, threadId, turnId);
                const currentMessages = data.message!.role === "user" && clientMessageId
                    ? current.messages.filter((item) => item.role !== "user" || item.clientMessageId !== clientMessageId || item.id === next.id)
                    : current.messages;
                const messages = upsertAgentMessage(currentMessages, next);
                setAgentState({ messages });
            });
        });
        source.addEventListener("agent_log", (event) => {
            if (!isCurrentConnection()) return;
            const text = parseEventData<{ text?: unknown }>(event)?.text;
            addEventLog(rt("log"), text, text);
        });
        source.addEventListener("skills_changed", (event) => {
            if (!isCurrentConnection()) return;
            const data = parseEventData<{ forceReload?: boolean }>(event);
            void loadSkills(endpoint, token, Boolean(data?.forceReload));
        });
        source.addEventListener("agent_error", (event) => {
            const data = parseEventData<AgentEventPayload>(event);
            if (!data) return;
            enqueueEvent(() => {
                if (!isCurrentThreadEvent(data)) return;
                if (!registerLiveAgentTurn(data, authoritativeHistoryTurnsRef.current, liveTurnKeysRef.current)) return;
                showAgentError(data.message, data, !data.replayed);
            });
        });
        source.onerror = () => {
            if (disposed || protocolRejected) return;
            const wasConnected = connectedRef.current;
            const silent = useAgentStore.getState().silentConnect && !wasConnected;
            const text = rt(wasConnected ? "connectionLostDescription" : "connectionFailedDescription");
            if (!errorLoggedRef.current || wasConnected) {
                addEventLog(rt(wasConnected ? "connectionLost" : "connectionFailed"), text);
                if (!headless && !silent) message.warning(text);
            }
            errorLoggedRef.current = true;
            connectedRef.current = false;
            pendingToolRef.current = null;
            setAgentState({
                activity: rt(wasConnected ? "connectionLost" : "connectionFailed"),
                connected: false,
                waiting: false,
                sending: false,
                connectError: silent ? "" : text,
                silentConnect: false,
                fragmentBootstrap: false,
                pendingTool: null,
                pendingApprovals: [],
            });
            useAgentSkillStore.getState().reset();
            if (!wasConnected) {
                source.close();
                setAgentState({ enabled: false });
            }
        };
        return () => {
            disposed = true;
            runtimeRequestSequenceRef.current++;
            source.close();
            connectedRef.current = false;
            loadThreadsSequenceRef.current += 1;
            useAgentSkillStore.getState().reset();
        };
    }, [applyConversationState, applyRuntimeState, applyWorkspaceChange, clientReady, enabled, endpoint, loadSkills, loadThreads, message, reconcileRuntimeState, setAgentState, token]);

    useEffect(() => {
        if (connected) void loadThreads();
    }, [connected, loadThreads]);

    useEffect(() => {
        if (connected) void loadSkills(endpoint, token);
    }, [connected, endpoint, loadSkills, token]);

    useEffect(() => {
        if (!connected) return;
        let disposed = false;
        void fetchAgentJson<{ data?: AgentModel[] }>(endpoint, token, "/codex/models")
            .then((response) => {
                if (disposed) return;
                const state = useAgentStore.getState();
                setAgentState(selectAvailableAgentModel(response.data || [], state.model, state.reasoningEffort));
            })
            .catch((error) => {
                if (disposed) return;
                setAgentState({ models: [], model: "", reasoningEffort: "" });
                addEventLog(rt("modelListFailed"), error);
            });
        return () => { disposed = true; };
    }, [connected, endpoint, setAgentState, token]);

    useEffect(() => {
        if (!connected) return;
        const reconcileIfRunning = () => {
            const current = useAgentStore.getState();
            if (current.waiting || current.conversation.status === "running" || current.queuedPrompts.length || current.codexRuntime.busy) void reconcileRuntimeState();
        };
        const activate = () => {
            void activateAgentClient(endpoint, token, clientIdRef.current);
            reconcileIfRunning();
        };
        const activateVisible = () => {
            if (document.visibilityState === "visible") activate();
        };
        window.addEventListener("focus", activate);
        document.addEventListener("visibilitychange", activateVisible);
        const timer = runtimeHeartbeatMs ? window.setInterval(reconcileIfRunning, runtimeHeartbeatMs) : null;
        return () => {
            if (timer) window.clearInterval(timer);
            window.removeEventListener("focus", activate);
            document.removeEventListener("visibilitychange", activateVisible);
        };
    }, [connected, endpoint, reconcileRuntimeState, runtimeHeartbeatMs, token]);
    const sendPromptSource = async (launch?: AgentCreativeLaunch, scopedTaskInput?: AgentScopedTask, queuedItem?: AgentQueuedPrompt): Promise<boolean | AgentPromptSubmissionResult> => {
        const queuedPayload = queuedItem?.payload;
        const text = queuedPayload ? queuedPayload.text.trim() : scopedTaskInput?.text.trim() || launch?.text.trim() || prompt.trim();
        const files = queuedPayload?.attachments || (scopedTaskInput ? [] : attachments);
        const skillState = useAgentSkillStore.getState();
        const inheritedSkill = useAgentStore.getState().messages.some((item) => item.role === "user" && item.skill?.name === ACHENG_DIRECTOR_SKILL_NAME)
            ? findProjectAchengDirectorSkill(skillState.skills)
            : null;
        const selectedSkill = queuedPayload?.skill ? { name: queuedPayload.skill.name, path: queuedPayload.skill.path, interface: { displayName: queuedPayload.skill.displayName } } : queuedItem ? null : scopedTaskInput
            ? findProjectAchengDirectorSkill(skillState.skills)
            : launch
                ? findProjectAchengDirectorSkill(skillState.skills)
                : skillState.selectedSkill || inheritedSkill;
        const selectedSkillRevision = skillState.selectionRevision;
        const currentState = useAgentStore.getState();
        const canvasNodeIds = new Set(currentState.canvasContext?.snapshot.nodes.map((node) => node.id) || []);
        const canvasReferenceCandidates = queuedPayload?.canvasReferences || (scopedTaskInput ? [] : currentState.canvasReferences);
        const canvasReferences = canvasReferenceCandidates.filter((item) => canvasNodeIds.has(item.nodeId));
        if (queuedPayload && canvasReferences.length !== canvasReferenceCandidates.length) return { status: "failed", error: t("agent.queue.contextChanged") };
        if (!queuedItem && !scopedTaskInput && canvasReferences.length !== currentState.canvasReferences.length) {
            setAgentState({ canvasReferences });
            message.warning(rt(canvasReferences.length ? "someCanvasReferencesMissing" : "canvasReferencesMissing"));
        }
        const workspace = useProductionWorkspaceStore.getState();
        const hasDraft = Boolean(currentState.prompt.trim() || currentState.attachments.length || currentState.canvasReferences.length);
        const object = queuedPayload ? queuedPayload.productionObject : !scopedTaskInput && !launch ? currentState.productionDraftObject || (!hasDraft ? workspace.selectedObject || (workspace.readiness?.presentation ? productionObjectForPresentation(workspace.readiness.presentation, workspace.production) : null) : null) : null;
        if (queuedPayload && queuedPayload.canvasProjectId !== (currentState.canvasContext?.snapshot.projectId || "")) return { status: "failed", error: t("agent.queue.contextChanged") };
        if (object && object.canvasId !== currentState.canvasContext?.snapshot.projectId) {
            message.warning(t("productionCanvas.returnToDraft"));
            return queuedItem ? { status: "failed", error: t("agent.queue.contextChanged") } : false;
        }
        const basePrompt = queuedPayload
            ? promptWithCanvasReferences(promptWithAttachments(text, files), canvasReferences)
            : scopedTaskInput ? text : promptWithCanvasReferences(promptWithAttachments(launch ? creativeLaunchPrompt(launch) : text, files), canvasReferences);
        const requestPrompt = object ? `${basePrompt}\n\n${productionObjectPrompt(object)}` : basePrompt;
        const canSend = currentState.connected && Boolean(requestPrompt) && !currentState.sending && !currentState.waiting && !currentState.codexRuntime.busy && !currentState.loadingThreads && ["ready", "warning"].includes(currentState.conversation.status) && !((launch || scopedTaskInput) && !selectedSkill);
        if (!canSend) return queuedItem ? currentState.codexRuntime.busy || currentState.waiting || currentState.conversation.status === "running" ? { status: "busy" } : { status: "failed", error: t("agent.queue.sendFailed") } : false;
        let referenceImages: AgentAttachment[] = [];
        if (canvasReferences.some((item) => item.kind === "image")) {
            setAgentState({ sending: true, activity: rt("readingCanvasImages") });
            try {
                referenceImages = await resolveCanvasReferenceImages(canvasReferences, currentState.canvasContext?.snapshot.nodes || []);
            } catch (error) {
                setAgentState({ sending: false, activity: rt("canvasImageReadFailed") });
                const errorText = error instanceof Error ? error.message : rt("canvasImageReadFailed");
                if (!queuedItem) addMessage({ role: "error", title: rt("canvasImageReadFailed"), text: errorText });
                return queuedItem ? { status: "failed", error: errorText } : false;
            }
        }
        const requestFiles = [...files, ...referenceImages.filter((reference) => !files.some((file) => file.dataUrl === reference.dataUrl))];
        if (requestFiles.length > MAX_ATTACHMENTS) {
            setAgentState({ sending: false, activity: rt("tooManyImages") });
            if (!queuedItem) addMessage({ role: "error", title: rt("tooManyImages"), text: rt("imageCountLimit", { count: MAX_ATTACHMENTS }) });
            return queuedItem ? { status: "failed", error: rt("imageCountLimit", { count: MAX_ATTACHMENTS }) } : false;
        }
        if (attachmentPayloadBytes(requestFiles) > MAX_ATTACHMENT_PAYLOAD_BYTES) {
            setAgentState({ sending: false, activity: rt("imageTooLarge") });
            if (!queuedItem) addMessage({ role: "error", title: rt("imageTooLarge"), text: rt("imagePayloadTooLarge") });
            return queuedItem ? { status: "failed", error: rt("imagePayloadTooLarge") } : false;
        }
        const messageId = queuedItem?.id || createId();
        const userText = queuedPayload?.messageText || text || rt(files.length ? "imagesSent" : "canvasReferencesSent", { count: files.length || canvasReferences.length });
        const messageReferences: AgentCanvasReference[] = await Promise.all(canvasReferences.map(async ({ nodeId, label, title, kind, previewUrl, text }) => {
            const image = referenceImages.find((item) => item.id === `canvas:${nodeId}`);
            return { nodeId, label, title, kind, previewUrl: image ? (await createMessageAttachmentMetadata(image)).url : previewUrl, text };
        }));
        const messageSkill = selectedSkill ? { name: selectedSkill.name, path: selectedSkill.path, displayName: selectedSkill.interface?.displayName || undefined } : undefined;
        const messageAttachments = await Promise.all(files.map(createMessageAttachmentMetadata));
        const messageMetadata = {
            ...(messageAttachments.length ? { attachments: messageAttachments } : {}),
            ...(messageReferences.length ? { canvasReferences: messageReferences } : {}),
            ...(messageSkill ? { skill: messageSkill } : {}),
        };
        const currentBeforeSend = useAgentStore.getState();
        const expectedThreadId = queuedItem?.threadId || scopedTaskInput?.threadId || currentBeforeSend.activeThreadId;
        const expectedConversationId = queuedItem?.conversationId || currentBeforeSend.conversation.conversationId;
        const sameTarget = currentBeforeSend.activeThreadId === expectedThreadId && currentBeforeSend.conversation.conversationId === expectedConversationId;
        if (queuedItem && !sameTarget) {
            setAgentState({ sending: false });
            return { status: "failed", error: t("agent.queue.conversationChanged") };
        }
        const isBusyNow = currentBeforeSend.codexRuntime.busy || currentBeforeSend.waiting || currentBeforeSend.conversation.status === "running";
        if (isBusyNow || currentBeforeSend.loadingThreads || !["ready", "warning"].includes(currentBeforeSend.conversation.status)) {
            if (queuedItem) setAgentState({ sending: false });
            return queuedItem && isBusyNow ? { status: "busy" } : queuedItem ? { status: "failed", error: t("agent.queue.sendFailed") } : false;
        }
        const availableModel = currentBeforeSend.models.find((item) => item.model === currentBeforeSend.model);
        const requestedEffort = availableModel?.supportedReasoningEfforts.some((item) => item.reasoningEffort === currentBeforeSend.reasoningEffort) ? currentBeforeSend.reasoningEffort : undefined;
        loadThreadsSequenceRef.current += 1;
        const requestThreadId = expectedThreadId;
        setAgentState({ ...(!queuedItem && !scopedTaskInput ? { prompt: "", attachments: [], canvasReferences: [] } : {}), productionTurnObject: object, activity: rt("sending"), sending: true, loadingThreads: false, activeTurnId: "", messages: currentBeforeSend.messages });
        addMessage({ id: messageId, itemId: "synthetic:user", clientMessageId: messageId, threadId: requestThreadId, turnId: "", role: "user", text: userText, attachments: files, canvasReferences: messageReferences, skill: messageSkill });
        let threadId = requestThreadId;
        try {
            const modelName = availableModel?.displayName || rt("defaultModel");
            const effortName = requestedEffort ? i18n.t(`agent.composer.effort.${requestedEffort}`) : rt("defaultEffort");
            addEventLog(rt("sendTask"), `${modelName} · ${effortName}${selectedSkill ? ` · Skill ${selectedSkill.name}` : ""}${files.length ? ` · ${rt("attachmentCount", { count: files.length })}` : ""}${canvasReferences.length ? ` · ${rt("canvasReferenceCount", { count: canvasReferences.length })}` : ""} · ${compactText(text) || rt(canvasReferences.length ? "canvasReferencesOnly" : "attachmentsOnly")}`);
            const accepted = await fetchAgentJson<AgentTurnResponse>(endpoint, token, "/codex/turn", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    prompt: requestPrompt,
                    messageText: userText,
                    messageId,
                    clientId: clientIdRef.current,
                    threadId,
                    conversationId: currentBeforeSend.conversation.conversationId,
                    expectedRevision: currentBeforeSend.conversation.revision,
                    permissionMode: queuedPayload?.permissionMode || currentBeforeSend.permissionMode,
                    model: availableModel?.model,
                    effort: requestedEffort,
                    skill: selectedSkill ? { name: selectedSkill.name, path: selectedSkill.path } : undefined,
                    attachments: requestFiles.map(({ id, name, type, size, width, height, dataUrl }) => ({ id, name, type, size, width, height, dataUrl })),
                    messageMetadata,
                }),
            });
            threadId = accepted.threadId || threadId;
            if (!threadId) throw new Error(rt("startConversationFailed"));
            if (!queuedItem && !scopedTaskInput && skillState.selectedSkill) clearSkillSelection(selectedSkillRevision);
            if (scopedTaskInput) setAgentState({ scopedTask: null, scopedTaskResult: { id: scopedTaskInput.id, status: "sent", threadId } });
            files.forEach((item) => {
                if (item.url.startsWith("blob:")) URL.revokeObjectURL(item.url);
                attachmentUrlsRef.current.delete(item.url);
            });
            return queuedItem ? { status: "sent" } : true;
        } catch (error) {
            const text = error instanceof Error ? error.message : rt("sendFailed");
            const response = error instanceof AgentApiError ? error.response as { code?: string; state?: AgentConversationState } : undefined;
            if (response?.state && response.state.threadId === requestThreadId) applyConversationState(response.state);
            const stale = response?.code === "CONVERSATION_STALE";
            const busy = response?.code === "CONVERSATION_BUSY" || text.includes("Codex 正在运行");
            const state = useAgentStore.getState();
            const removeFailedPending = (messages: AgentChatItem[]) => messages.filter((item) => item.clientMessageId !== messageId || Boolean(item.turnId));
            threadMessagesRef.current.forEach((messages, cachedThreadId) => {
                const next = removeFailedPending(messages);
                if (next.length !== messages.length) threadMessagesRef.current.set(cachedThreadId, next);
            });
            const ownsCurrentThread = state.activeThreadId === requestThreadId;
            if (queuedItem) {
                if (ownsCurrentThread) setAgentState({ activity: rt(busy ? "codexRunning" : "sendFailed"), sending: false, messages: removeFailedPending(state.messages) });
                addEventLog(rt("sendFailed"), error);
                return busy ? { status: "busy" } : { status: "failed", error: text };
            }
            const restoreDraft = scopedTaskInput || state.prompt || state.attachments.length || state.canvasReferences.length ? {} : { prompt, attachments: files, canvasReferences, productionDraftObject: object };
            if (scopedTaskInput) setAgentState({ scopedTask: null, scopedTaskResult: { id: scopedTaskInput.id, status: "failed", threadId: threadId || undefined, error: text } });
            if (ownsCurrentThread) {
                setAgentState({ activity: rt(stale ? "conversationSynced" : busy ? "codexRunning" : "sendFailed"), sending: false, messages: removeFailedPending(state.messages), ...restoreDraft });
                addMessage({ threadId: state.activeThreadId, turnId: "", role: "error", title: rt(stale ? "conversationSynced" : busy ? "taskStillRunning" : "sendFailed"), text });
            } else {
                setAgentState({ sending: false, messages: removeFailedPending(state.messages), ...restoreDraft });
            }
            addEventLog(rt("sendFailed"), error);
            return false;
        }
    };
    const sendPrompt = async (launch?: AgentCreativeLaunch, scopedTaskInput?: AgentScopedTask): Promise<boolean> => {
        const result = await sendPromptSource(launch, scopedTaskInput);
        return typeof result === "boolean" ? result : result.status === "sent";
    };
    const submitQueuedPrompt = async (item: AgentQueuedPrompt): Promise<AgentPromptSubmissionResult> => {
        const result = await sendPromptSource(undefined, undefined, item);
        return typeof result === "boolean" ? result ? { status: "sent" } : { status: "failed", error: t("agent.queue.sendFailed") } : result;
    };

    useEffect(() => {
        if (!creativeLaunch || !connected || !clientReady) return;
        if (creativeLaunch.phase === "reset") {
            if (useAgentStore.getState().creativeLaunch?.phase !== "reset") return;
            if (!conversationReady || loadingThreads || sending || waiting) return;
            setAgentState({ creativeLaunch: { ...creativeLaunch, phase: "resetting" }, activeTab: "chat", loadingThreads: true });
            void fetchAgentJson<AgentWorkspaceResponse>(endpoint, token, "/codex/threads/reset", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ clientId: clientIdRef.current, permissionMode }),
            }).then((result) => {
                if (useAgentStore.getState().creativeLaunch?.id !== creativeLaunch.id) return;
                if (result.conversation) applyConversationState(result.conversation);
                clearSkillSelection();
                setAgentState({ creativeLaunch: { ...creativeLaunch, phase: "send" }, loadingThreads: false });
            }).catch((error) => {
                if (useAgentStore.getState().creativeLaunch?.id !== creativeLaunch.id) return;
                setAgentState({ creativeLaunch: null, loadingThreads: false, prompt: creativeLaunch.text, activity: rt("newConversationFailed") });
                message.error(error instanceof Error ? error.message : rt("newConversationFailed"));
            });
            return;
        }
        if (creativeLaunch.phase === "send" && !skillsLoaded) return;
        if (creativeLaunch.phase === "send" && skillsLoaded && !findProjectAchengDirectorSkill(useAgentSkillStore.getState().skills)) {
            setAgentState({ creativeLaunch: null, loadingThreads: false, prompt: useAgentStore.getState().prompt || creativeLaunch.text });
            message.warning(i18n.t("productionHub.creative.skillUnavailable"));
            return;
        }
        if (creativeLaunch.phase === "send" && conversationReady && !loadingThreads && !sending && !waiting) {
            if (useAgentStore.getState().creativeLaunch?.phase !== "send") return;
            setAgentState({ creativeLaunch: { ...creativeLaunch, phase: "sending" } });
            void sendPrompt(creativeLaunch).then((sent) => {
                if (useAgentStore.getState().creativeLaunch?.id !== creativeLaunch.id) return;
                setAgentState({ creativeLaunch: null, ...(sent ? {} : { prompt: useAgentStore.getState().prompt || creativeLaunch.text }) });
            }).catch((error) => {
                if (useAgentStore.getState().creativeLaunch?.id !== creativeLaunch.id) return;
                setAgentState({ creativeLaunch: null, sending: false, prompt: useAgentStore.getState().prompt || creativeLaunch.text });
                message.error(error instanceof Error ? error.message : rt("sendFailed"));
            });
        }
    }, [applyConversationState, clearSkillSelection, clientReady, connected, conversationReady, creativeLaunch, endpoint, loadingThreads, message, permissionMode, sending, setAgentState, skillsLoaded, token, waiting]);

    useEffect(() => {
        if (connected || enabled || !creativeLaunch || creativeLaunch.phase === "sending") return;
        setAgentState({ creativeLaunch: null, loadingThreads: false, prompt: useAgentStore.getState().prompt || creativeLaunch.text });
    }, [connected, enabled, creativeLaunch, setAgentState]);

    const stopTurn = async () => {
        const current = useAgentStore.getState();
        const activeRuntimeTurn = current.codexRuntime.busy && current.codexRuntime.threadId === current.activeThreadId;
        if (!current.connected || (!current.sending && !current.waiting && !activeRuntimeTurn)) return;
        const queueWasPaused = current.pausedPromptQueueScopes.includes(JSON.stringify([current.activeThreadId, current.conversation.conversationId]));
        current.setPromptQueuePaused(current.activeThreadId, current.conversation.conversationId, true);
        setAgentState({ activity: rt("stopping") });
        try {
            await interruptCodexTurn(endpoint, token, current.activeThreadId || undefined);
            addEventLog(rt("stopTask"), rt("taskStopped"));
            void reconcileRuntimeState();
        } catch (error) {
            if (!queueWasPaused) useAgentStore.getState().setPromptQueuePaused(current.activeThreadId, current.conversation.conversationId, false);
            setAgentState({ activity: rt("stopFailed") });
            addEventLog(rt("stopFailed"), error);
        }
    };

    const addAttachments = async (files: FileList | File[] | null) => {
        if (!files) return;
        const images = Array.from(files).filter((file) => file.type.startsWith("image/"));
        const prev = useAgentStore.getState().attachments;
        try {
            const next = await Promise.all(
                images.slice(0, Math.max(0, MAX_ATTACHMENTS - prev.length)).map(async (file) => {
                    const dataUrl = await readDataUrl(file);
                    const meta = await readImageMeta(dataUrl);
                    const url = URL.createObjectURL(file);
                    attachmentUrlsRef.current.add(url);
                    return { id: createId(), name: file.name, type: file.type, size: file.size, width: meta.width, height: meta.height, url, dataUrl };
                }),
            );
            const merged = [...prev, ...next];
            if (attachmentPayloadBytes(merged) > MAX_ATTACHMENT_PAYLOAD_BYTES) {
                next.forEach((item) => {
                    URL.revokeObjectURL(item.url);
                    attachmentUrlsRef.current.delete(item.url);
                });
                addMessage({ role: "error", title: rt("imageTooLarge"), text: rt("imageLimit") });
                return;
            }
            if (next.length) setAgentState({ attachments: merged });
        } catch (error) {
            addMessage({ role: "error", title: rt("imageReadFailed"), text: error instanceof Error ? error.message : rt("imageReadFailed") });
        }
    };

    const removeAttachment = (id: string) => {
        const removed = attachments.find((item) => item.id === id);
        if (removed) {
            URL.revokeObjectURL(removed.url);
            attachmentUrlsRef.current.delete(removed.url);
        }
        setAgentState({ attachments: attachments.filter((item) => item.id !== id) });
    };

    const enqueueCurrentPrompt = () => {
        const current = useAgentStore.getState();
        if (!current.connected || !current.activeThreadId || !current.conversation.conversationId) return;
        const text = current.prompt.trim();
        const files = current.attachments;
        const nodeIds = new Set(current.canvasContext?.snapshot.nodes.map((node) => node.id) || []);
        const canvasReferences = current.canvasReferences.filter((item) => nodeIds.has(item.nodeId));
        if (canvasReferences.length !== current.canvasReferences.length) {
            setAgentState({ canvasReferences });
            message.warning(rt(canvasReferences.length ? "someCanvasReferencesMissing" : "canvasReferencesMissing"));
        }
        if (!text && !files.length && !canvasReferences.length) return;
        const skillState = useAgentSkillStore.getState();
        const inheritedSkill = current.messages.some((item) => item.role === "user" && item.skill?.name === ACHENG_DIRECTOR_SKILL_NAME)
            ? findProjectAchengDirectorSkill(skillState.skills)
            : null;
        const selectedSkill = skillState.selectedSkill || inheritedSkill;
        const workspace = useProductionWorkspaceStore.getState();
        const hasDraft = Boolean(text || files.length || current.canvasReferences.length);
        const productionObject = current.productionDraftObject || (!hasDraft ? workspace.selectedObject || (workspace.readiness?.presentation ? productionObjectForPresentation(workspace.readiness.presentation, workspace.production) : null) : null);
        const canvasProjectId = current.canvasContext?.snapshot.projectId || "";
        if (productionObject && productionObject.canvasId !== canvasProjectId) {
            message.warning(t("productionCanvas.returnToDraft"));
            return;
        }
        const payload: AgentQueuedPromptPayload = {
            text,
            messageText: text || rt(files.length ? "imagesSent" : "canvasReferencesSent", { count: files.length || canvasReferences.length }),
            attachments: files.map((item) => ({ ...item, url: item.dataUrl })),
            canvasReferences: canvasReferences.map((item) => ({ ...item })),
            canvasProjectId,
            skill: selectedSkill ? { name: selectedSkill.name, path: selectedSkill.path, displayName: selectedSkill.interface?.displayName || undefined } : undefined,
            model: current.model,
            reasoningEffort: current.reasoningEffort,
            permissionMode: current.permissionMode,
            productionObject,
        };
        const queued = { id: createId(), threadId: current.activeThreadId, conversationId: current.conversation.conversationId, payload, status: "queued" as const };
        useAgentStore.getState().updatePromptQueue((items) => enqueueAgentPrompt(items, queued));
        files.forEach((item) => {
            if (item.url.startsWith("blob:")) URL.revokeObjectURL(item.url);
            attachmentUrlsRef.current.delete(item.url);
        });
        setAgentState({ prompt: "", attachments: [], canvasReferences: [] });
    };

    const promptQueue = useAgentPromptQueue({
        endpoint,
        token,
        connected,
        activeThreadId,
        conversationId: conversation.conversationId,
        conversationStatus: conversation.status,
        codexBusy: codexRuntime.busy,
        codexThreadId: codexRuntime.threadId,
        codexTurnId: codexRuntime.turnId,
        codexRevision: codexRuntime.revision,
        sending,
        loadingThreads,
        onSubmit: submitQueuedPrompt,
        onReconcile: reconcileRuntimeState,
    });

    const handleToolCall = async (endpoint: string, token: string, payload: AgentPendingToolCall) => {
        if (confirmToolsRef.current && isCanvasWriteTool(payload.name)) {
            if (pendingToolRef.current) {
                await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, error: rt("pendingCanvasTool") });
                return;
            }
            pendingToolRef.current = payload;
            setAgentState({ pendingTool: payload });
            addEventLog(rt("awaitingConfirmation"), payload, payload);
            return;
        }
        await runToolCall(endpoint, token, payload);
    };

    const runToolCall = async (endpoint: string, token: string, payload: AgentPendingToolCall) => {
        if (isSiteTool(payload.name)) {
            try {
                addEventLog(toolName(payload.name), payload, payload);
                const result = await runSiteTool(payload.name, payload.input || {}, navigate, { canvasSnapshot: canvasContextRef.current?.snapshot || null });
                await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, result });
                addEventLog(rt("toolCompleted", { tool: toolName(payload.name) }), result, result);
            } catch (error) {
                const message = error instanceof Error ? error.message : rt("toolExecutionFailed");
                await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, error: message });
            }
            return;
        }
        try {
            const input: { ops?: CanvasAgentOp[]; path?: string; production?: { kind?: "canvas" | "episode" | "scene"; id?: string; workId?: string; runId?: string } } = payload.input || {};
            addEventLog(toolName(payload.name), payload, payload);
            let result: unknown;
            let appliedOps = input.ops || [];
            if (payload.name === "site_navigate") {
                if (input.production) {
                    const { kind, id, workId, runId } = input.production;
                    if (!kind || !id || !workId) throw new Error("制作导航需要真实对象 ID 和当前 workId");
                    const owner = { kind, id } as const;
                    const productionOwner = productionTarget(owner);
                    const [{ readiness }, { production }] = await Promise.all([fetchProductionReadiness(productionOwner, { runId }), fetchEpisodeProduction(productionOwner)]);
                    const presentation = readiness.presentation;
                    if (!presentation || presentation.owner.kind !== kind || presentation.owner.id !== id || presentation.workId !== workId) {
                        throw new Error("Backend 当前制作目标与导航请求不一致；请回读正式工作状态后再导航");
                    }
                    const follow = useProductionFollowStore.getState();
                    const activeThreadId = useAgentStore.getState().activeThreadId;
                    if (activeThreadId && production.draft.director?.workflow.agentThreadId !== activeThreadId) {
                        try { await editEpisodeProduction(productionOwner, production.revision, [{ type: "set_director_workflow", patch: { agentThreadId: activeThreadId } }], randomId()); }
                        catch { /* Navigation remains useful if session association raced with a newer edit. */ }
                    }
                    follow.setTarget({ ...owner, workId, runId: presentation.runId || runId, threadId: activeThreadId });
                    follow.setPresentation(presentation);
                    const path = productionPresentationPath(presentation);
                    if (follow.guardReason) follow.setPendingPresentation(presentation);
                    else {
                        follow.expectPath(path);
                        navigate(path, { replace: true });
                    }
                    result = { ok: true, owner, workId, presentation, navigated: follow.guardReason ? false : path };
                } else {
                    const path = input.path || "/";
                    useProductionFollowStore.getState().pause("Agent 已导航到其他页面；自动跟随已暂停");
                    navigate(path);
                    result = { ok: true, path };
                }
            } else if (payload.name === "canvas_apply_ops") {
                const context = canvasContextRef.current;
                if (!context) throw new Error(rt("openCanvasFirst"));
                result = context.applyOps(appliedOps);
                // 等待最新快照写回请求完成，再返回工具结果；否则连续 MCP 生成会用到上一轮位置。
                await postState(endpoint, token, clientIdRef.current, result as CanvasAgentSnapshot);
            } else if (payload.name === "canvas_create_attachment_nodes") {
                const context = canvasContextRef.current;
                if (!context) throw new Error(rt("openCanvasFirst"));
                appliedOps = await attachmentNodeOps(endpoint, token, clientIdRef.current, payload.input?.nodes);
                result = context.applyOps(appliedOps);
                await postState(endpoint, token, clientIdRef.current, result as CanvasAgentSnapshot);
            } else {
                const snapshot = canvasContextRef.current?.snapshot;
                if (!snapshot) throw new Error(rt("openCanvasFirst"));
                result = snapshot;
            }
            await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, result });
            addEventLog(rt("toolCompleted", { tool: toolName(payload.name) }), result, result);
        } catch (error) {
            const message = error instanceof Error ? error.message : rt("canvasOperationFailed");
            await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, error: message });
        }
    };

    const rejectPendingTool = async () => {
        if (!pendingTool) return;
        await postToolResult(endpoint, token, clientIdRef.current, { requestId: pendingTool.requestId, error: rt("canvasToolCanceled") });
        pendingToolRef.current = null;
        setAgentState({ pendingTool: null });
    };

    const approvePendingTool = async () => {
        if (!pendingTool) return;
        const tool = pendingTool;
        pendingToolRef.current = null;
        setAgentState({ pendingTool: null });
        await runToolCall(endpoint, token, tool);
    };

    const decideApproval = async (approval: AgentPendingApproval, decision: "accept" | "acceptForSession" | "decline") => {
        const current = useAgentStore.getState();
        const pending = current.pendingApprovals.find((item) => item.requestId === approval.requestId);
        if (!pending || pending.deciding) return;
        setAgentState({ pendingApprovals: current.pendingApprovals.map((item) => item.requestId === approval.requestId ? { ...item, deciding: decision } : item), activity: rt("submittingApproval") });
        try {
            await postCodexApproval(endpoint, token, approval.requestId, decision);
            const latest = useAgentStore.getState();
            if (latest.pendingApprovals.some((item) => item.requestId === approval.requestId)) setAgentState({ activity: rt("waitingCodexApproval") });
        } catch (error) {
            const latest = useAgentStore.getState();
            const expired = error instanceof Error && error.message.includes("审批请求已失效");
            const resolved = expired || !latest.pendingApprovals.some((item) => item.requestId === approval.requestId);
            const pendingApprovals = resolved
                ? latest.pendingApprovals.filter((item) => item.requestId !== approval.requestId)
                : latest.pendingApprovals.map((item) => item.requestId === approval.requestId ? { ...item, deciding: undefined } : item);
            setAgentState({ pendingApprovals, activity: approvalActivity(pendingApprovals, latest.waiting, latest.activity) });
            if (resolved) return;
            addEventLog(rt("approvalFailed"), error);
            message.error(error instanceof Error ? error.message : rt("approvalFailed"));
        }
    };

    const changePermissionMode = (nextMode: AgentPermissionMode) => {
        const apply = () => {
            setAgentState({ permissionMode: nextMode });
        };
        if (nextMode !== "full") return apply();
        modal.confirm({
            title: rt("enableFullAccess"),
            content: rt("fullAccessDescription"),
            okText: rt("enableFullAccessAction"),
            okType: "danger",
            cancelText: t("common.cancel"),
            onOk: apply,
        });
    };

    const connectLocalAgent = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
        const current = useAgentStore.getState();
        if (current.enabled || current.connected || connectionPendingRef.current) return;
        connectionPendingRef.current = true;
        try {
            const urlToken = searchParams.get("agentToken") || "";
            const urlEndpoint = searchParams.get("agentUrl") || "";
            const nextEndpoint = (urlEndpoint || backendAgentUrl).trim().replace(/\/$/, "");
            const nextToken = (urlToken || current.token.trim() || (await discoverBackendToken()).token || "").trim();
            if (!nextEndpoint) {
                const text = rt("addressRequired");
                if (!silent) {
                    setAgentState({ connectError: text });
                    if (!headless) message.warning(text);
                }
                return;
            }
            if (!nextToken) {
                const text = rt("agentNotFound");
                if (!silent) {
                    setAgentState({ connectError: text });
                    if (!headless) message.warning(text);
                }
                return;
            }
            try {
                const parsed = new URL(nextEndpoint);
                if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("invalid protocol");
            } catch {
                const text = rt("invalidAddress");
                if (!silent) {
                    setAgentState({ connectError: text });
                    if (!headless) message.warning(text);
                }
                return;
            }
            // Token discovery may finish after another entry point has already connected.
            const latest = useAgentStore.getState();
            if (latest.enabled || latest.connected) return;
            errorLoggedRef.current = false;
            setAgentState({ url: nextEndpoint, token: nextToken, enabled: true, connected: false, silentConnect: silent, fragmentBootstrap: false, activity: rt("connecting"), connectError: "", activeTab: "setup" });
        } finally {
            connectionPendingRef.current = false;
        }
    }, [backendAgentUrl, headless, message, searchParams, setAgentState]);

    const toggleAgentConnection = async () => {
        if (useAgentStore.getState().enabled) {
            clearAgentSession({ enabled: false, connected: false, activity: rt("offline"), connectError: "" });
            return;
        }
        await connectLocalAgent();
    };

    useLayoutEffect(() => {
        const bootstrap = readAgentUrlBootstrap(hash);
        if (!bootstrap) return;
        navigate(`${window.location.pathname}${window.location.search}${bootstrap.remainingHash}`, { replace: true });
        if (!bootstrap.url || !bootstrap.token) {
            setAgentState({ fragmentBootstrap: false, activeTab: "setup", connectError: rt(!bootstrap.url ? "addressRequired" : "agentNotFound") });
            useAgentStore.getState().openPanel();
            return;
        }
        try {
            const parsed = new URL(bootstrap.url);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("invalid protocol");
        } catch {
            setAgentState({ fragmentBootstrap: false, activeTab: "setup", connectError: rt("invalidAddress") });
            useAgentStore.getState().openPanel();
            return;
        }
        errorLoggedRef.current = false;
        setAgentState({ url: bootstrap.url.replace(/\/$/, ""), token: bootstrap.token, enabled: true, connected: false, silentConnect: true, fragmentBootstrap: true, confirmTools: false, activity: rt("connecting"), connectError: "", activeTab: "setup" });
    }, [hash, navigate, setAgentState]);

    useEffect(() => {
        if (urlAgentAutoConnect && confirmTools) setAgentState({ confirmTools: false });
    }, [confirmTools, setAgentState, urlAgentAutoConnect]);

    useEffect(() => {
        if (!autoConnect) {
            autoConnectRef.current = false;
            return;
        }
        if (autoConnectRef.current) return;
        autoConnectRef.current = true;
        void connectLocalAgent({ silent: true });
    }, [autoConnect, connectLocalAgent]);

    useEffect(() => {
        if (!urlAgentAutoConnect || urlAutoConnectRef.current) return;
        urlAutoConnectRef.current = true;
        void connectLocalAgent({ silent: true });
    }, [connectLocalAgent, urlAgentAutoConnect]);

    function clearAgentSession(patch: Parameters<typeof setAgentState>[0] = {}) {
        loadThreadsSequenceRef.current += 1;
        threadMessagesRef.current.clear();
        authoritativeHistoryTurnsRef.current.clear();
        liveTurnKeysRef.current.clear();
        threadOperationRef.current = 0;
        setAgentState({
            messages: [],
            tokenUsage: null,
            threads: [],
            activeThreadId: "",
            activeTurnId: "",
            workspacePath: "",
            loadingThreads: false,
            waiting: false,
            sending: false,
            fragmentBootstrap: false,
            pendingTool: null,
            pendingApprovals: [],
            conversation: { revision: 0, conversationId: "", threadId: "", status: "idle", mcpStatuses: {} },
            bootstrapStatus: null,
            mcpStartupStatuses: {},
            ...patch,
        });
        useAgentSkillStore.getState().reset();
        pendingToolRef.current = null;
    }

    const beginThreadOperation = () => {
        const operation = ++threadOperationSequenceRef.current;
        threadOperationRef.current = operation;
        setAgentState({ loadingThreads: true });
        return operation;
    };

    const finishThreadOperation = (operation: number) => {
        if (threadOperationRef.current !== operation) return;
        threadOperationRef.current = 0;
        setAgentState({ loadingThreads: false });
    };

    const startNewThread = async () => {
        const current = useAgentStore.getState();
        if (!current.connected || current.sending || current.waiting || current.loadingThreads || ["preparing", "running"].includes(current.conversation.status)) return;
        const operation = beginThreadOperation();
        clearSkillSelection();
        setAgentState({ activeTab: "chat", activity: rt("creatingConversation") });
        try {
            const result = await fetchAgentJson<AgentWorkspaceResponse>(endpoint, token, "/codex/threads/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: clientIdRef.current, permissionMode }) });
            if (threadOperationRef.current !== operation) return;
            if (result.conversation) applyConversationState(result.conversation);
            setAgentState({ activeTab: "chat", activity: rt("newConversation") });
        } catch (error) {
            const state = agentErrorState(error);
            if (state) applyConversationState(state);
            addEventLog(rt("newConversationFailed"), error);
            message.error(error instanceof Error ? error.message : rt("newConversationFailed"));
            await loadThreads();
        } finally {
            finishThreadOperation(operation);
        }
    };

    const resumeThread = async (threadId: string) => {
        const current = useAgentStore.getState();
        if (!current.connected || !threadId || current.sending || current.waiting || current.loadingThreads || ["preparing", "running"].includes(current.conversation.status)) return;
        const operation = beginThreadOperation();
        try {
            const result = await fetchAgentJson<AgentThreadResponse>(endpoint, token, `/codex/threads/${encodeURIComponent(threadId)}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ permissionMode, clientId: clientIdRef.current }) });
            if (result.conversation) applyConversationState(result.conversation);
            await loadThreads();
            if (useAgentStore.getState().activeThreadId === threadId) setAgentState({ activeTab: "chat", activity: rt("conversationResumed") });
        } catch (error) {
            const state = agentErrorState(error);
            if (state) applyConversationState(state);
            addEventLog(rt("resumeConversationFailed"), error);
            message.error(error instanceof Error ? error.message : rt("resumeConversationFailed"));
            await loadThreads();
        } finally {
            finishThreadOperation(operation);
        }
    };

    useEffect(() => {
        if (!scopedTask) { scopedTaskOperationRef.current = ""; return; }
        if (scopedTaskOperationRef.current === scopedTask.id) return;
        const current = useAgentStore.getState();
        const reject = (error: string) => setAgentState({ scopedTask: null, scopedTaskResult: { id: scopedTask.id, status: "failed", error } });
        if (!current.enabled || !current.connected) { reject(current.connectError || rt("connectionRequired")); return; }
        if (!clientReady || !useAgentSkillStore.getState().loaded) return;
        if (!findProjectAchengDirectorSkill(useAgentSkillStore.getState().skills)) { reject(i18n.t("productionHub.creative.skillUnavailable")); return; }
        if (current.sending || current.waiting || current.loadingThreads || !["ready", "warning"].includes(current.conversation.status)) { reject(rt("codexRunning")); return; }
        scopedTaskOperationRef.current = scopedTask.id;
        void (async () => {
            if (scopedTask.threadId && scopedTask.threadId !== useAgentStore.getState().activeThreadId) {
                await resumeThread(scopedTask.threadId);
                const afterResume = useAgentStore.getState();
                if (afterResume.activeThreadId !== scopedTask.threadId || !["ready", "warning"].includes(afterResume.conversation.status)) {
                    reject(afterResume.connectError || rt("conversationSynced"));
                    return;
                }
            }
            const sent = await sendPrompt(undefined, scopedTask);
            if (!sent && useAgentStore.getState().scopedTask?.id === scopedTask.id) reject(rt("sendFailed"));
        })().catch(error => reject(error instanceof Error ? error.message : rt("sendFailed")));
    }, [scopedTask, enabled, connected, clientReady, skillsLoaded, skillCount, sending, waiting, loadingThreads, conversation.status]);

    const deleteThreads = async (threadIds: string[]) => {
        if (!connected || !threadIds.length || sending || waiting || loadingThreads) return;
        const operation = beginThreadOperation();
        let deletedCount = 0;
        try {
            for (const threadId of new Set(threadIds)) {
                await fetchAgentJson(endpoint, token, `/codex/threads/${encodeURIComponent(threadId)}/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: clientIdRef.current }) });
                threadMessagesRef.current.delete(threadId);
                useAgentStore.getState().clearPromptQueueForThread(threadId);
                deletedCount += 1;
            }
            await loadThreads();
            message.success(rt("recordsDeleted", { count: deletedCount }));
        } catch (error) {
            await loadThreads();
            addEventLog(rt("deleteConversationFailed"), error);
            message.error(error instanceof Error ? error.message : rt("deleteConversationFailed"));
        } finally {
            finishThreadOperation(operation);
        }
    };

    const confirmDeleteThreads = (threadIds: string[]) => {
        modal.confirm({
            title: rt("deleteConversations", { count: threadIds.length }),
            content: rt("deleteConversationsDescription"),
            okText: t("common.delete"),
            okType: "danger",
            cancelText: t("common.cancel"),
            onOk: () => deleteThreads(threadIds),
        });
    };

    const addMessage = (item: Omit<AgentChatItem, "id"> & { id?: string }) => {
        const text = normalizeText(item.text);
        if (!text && !item.attachments?.length) return;
        const current = useAgentStore.getState();
        const itemId = item.itemId || item.id || createId();
        const next = scopeChatItem({ ...item, id: item.id || itemId, itemId, text } as AgentChatItem, item.threadId ?? current.activeThreadId, item.turnId ?? current.activeTurnId);
        setAgentState({ messages: upsertAgentMessage(current.messages, next) });
    };

    const addEventLog = (title: string, text: unknown, raw?: unknown) => {
        const value = normalizeText(text) || title;
        const last = useAgentStore.getState().eventLogs.at(-1);
        if (last?.title === title && last.text === value) return;
        pushEventLog({ id: `${Date.now()}-${Math.random()}`, time: dayjs().format("YYYY-MM-DD HH:mm:ss"), title, text: value, raw });
    };

    const upsertActivityMessage = (item: AgentChatItem) => {
        setAgentState({ messages: upsertAgentMessage(useAgentStore.getState().messages, item) });
    };

    const appendActivityDelta = (event: AgentEventPayload) => {
        const item = event.item;
        if (!item?.id) return;
        const text = stringText(item.text) || stringText(item.delta);
        const isDelta = Boolean(stringText(item.delta));
        if (!text) return;
        if (item.type === "reasoning") {
            const scoped = scopeEventChatItem(event, activityDeltaFallback(item, text), "synthetic:reasoning");
            const current = useAgentStore.getState().messages.find((message) => message.id === scoped.id);
            const activityItems = { ...(current?.activityItems || {}) };
            const previous = activityItems[item.id] || "";
            activityItems[item.id] = isDelta ? `${previous === activityPlaceholder("reasoning") ? "" : previous}${text}` : text;
            upsertActivityMessage({ ...scoped, title: i18n.t("agent.events.reasoning"), text: reasoningActivityText(activityItems), activityItems, detail: activityDetail(current?.detail || scoped.detail, "reasoning", "inProgress") });
            return;
        }
        const scoped = scopeEventChatItem(event, activityDeltaFallback(item, text), item.id);
        const currentMessages = useAgentStore.getState().messages;
        const index = currentMessages.findIndex((message) => message.id === scoped.id);
        if (index < 0) {
            if (!text.trim()) return;
            upsertActivityMessage(scoped);
            return;
        }
        const current = currentMessages[index];
        if (item.type === "command_execution") {
            const detail = activityDetail(current.detail, "command", "inProgress");
            detail.output = isDelta ? `${stringText(detail.output)}${text}` : text;
            setAgentState({ messages: currentMessages.map((message, itemIndex) => itemIndex === index ? { ...message, detail } : message) });
            return;
        }
        const placeholder = activityPlaceholder(item.type);
        if (!text.trim() && current.text === placeholder) return;
        const nextText = isDelta ? `${current.text === placeholder ? "" : current.text}${text}` : mergeStreamText(current.text, text);
        setAgentState({ messages: currentMessages.map((message, itemIndex) => itemIndex === index ? { ...message, text: nextText, detail: { ...activityDetail(message.detail, activityKind(item.type), "inProgress") } } : message) });
    };

    const upsertEventActivity = (event: AgentEventPayload, item: Omit<AgentChatItem, "id">) => {
        const itemId = event.item?.id;
        if (!itemId) return;
        if (event.item?.type === "reasoning") {
            const scoped = scopeEventChatItem(event, { ...item, id: "synthetic:reasoning" }, "synthetic:reasoning");
            const current = useAgentStore.getState().messages.find((message) => message.id === scoped.id);
            const activityItems = { ...(current?.activityItems || {}) };
            const previous = activityItems[itemId] || "";
            const incoming = normalizeText(item.text);
            activityItems[itemId] = incoming === "已完成分析" && previous && previous !== activityPlaceholder("reasoning") ? previous : incoming;
            upsertActivityMessage({ ...scoped, title: i18n.t("agent.events.reasoning"), text: reasoningActivityText(activityItems, incoming), activityItems });
            return;
        }
        upsertActivityMessage(scopeEventChatItem(event, { ...item, id: itemId }, itemId));
    };

    const finishEmptyReasoningActivity = (event: AgentEventPayload) => {
        const itemId = event.item?.id;
        if (!itemId) return;
        const scopedId = scopeEventChatItem(event, { id: "synthetic:reasoning", role: "tool", text: "" }, "synthetic:reasoning").id;
        const currentMessages = useAgentStore.getState().messages;
        const index = currentMessages.findIndex((message) => message.id === scopedId);
        if (index < 0) return;
        const current = currentMessages[index];
        const activityItems = { ...(current.activityItems || {}) };
        delete activityItems[itemId];
        if (!Object.values(activityItems).some(isReasoningSummary)) {
            setAgentState({ messages: currentMessages.filter((_, itemIndex) => itemIndex !== index) });
            return;
        }
        setAgentState({ messages: currentMessages.map((message, itemIndex) => itemIndex === index ? { ...message, text: reasoningActivityText(activityItems), activityItems, detail: activityDetail(message.detail, "reasoning", "completed") } : message) });
    };

    const finishPlanActivity = (event: AgentEventPayload) => {
        const id = scopeEventChatItem(event, { id: "synthetic:plan", role: "tool", text: "" }, "synthetic:plan").id;
        const currentMessages = useAgentStore.getState().messages;
        const index = currentMessages.findIndex((message) => message.id === id);
        if (index < 0) return;
        const current = currentMessages[index];
        const detail = activityDetail(current.detail, "todo", turnPlanStatus(current.detail, event.status));
        setAgentState({ messages: currentMessages.map((message, itemIndex) => itemIndex === index ? { ...message, detail } : message) });
    };

    const showAgentError = (value: unknown, event?: AgentEventPayload, log = true) => {
        const error = agentErrorView(value);
        const item = event
            ? scopeEventChatItem(event, { id: "synthetic:error", role: "error", title: error.title, text: error.text }, "synthetic:error")
            : scopeChatItem({ id: createId(), role: "error", title: error.title, text: error.text }, useAgentStore.getState().activeThreadId, useAgentStore.getState().activeTurnId);
        const state = useAgentStore.getState();
        const current = state.messages.find((message) => message.id === item.id);
        if (current && !normalizeText(value)) return;
        upsertActivityMessage(item);
        setAgentState({ activity: rt("processingFailed"), pendingApprovals: [] });
        if (log) addEventLog(rt("processingFailed"), error.text, value);
    };

    const handleAgentEvent = async (event: AgentEventPayload) => {
        if (event.type === "usage.updated") setAgentState({ tokenUsage: eventUsage(event) });
        const log = event.replayed ? null : formatAgentEventLog(event);
        const activity = formatAgentActivity(event);
        if (log) addEventLog(log.title, log.text);
        if (event.type === "turn.started" && (event.turnId || event.turn_id)) {
            const scope = eventScope(event);
            const current = useAgentStore.getState();
            if (!scope.threadId || !scope.turnId) return;
            liveTurnKeysRef.current.add(`${scope.threadId}\0${scope.turnId}`);
            setAgentState({ activeTurnId: scope.turnId, bootstrapStatus: null, mcpStartupStatuses: {}, messages: bindPendingTurnMessages(current.messages, scope.threadId, scope.turnId) });
        }
        if (event.type === "item.updated" && event.item?.type === "agent_message" && event.item.id) {
            const delta = stringText(event.item.delta);
            appendStreamText(event, delta || stringText(event.item.text), Boolean(delta));
            return;
        }
        if (event.type === "item.updated" && event.item) {
            appendActivityDelta(event);
            return;
        }
        if (event.type === "plan.updated" && event.turn_id) {
            const plan = formatAgentPlan(event);
            if (plan) upsertActivityMessage(scopeEventChatItem(event, { ...plan, id: "synthetic:plan" }, "synthetic:plan"));
            return;
        }
        if (event.type === "item.completed" && event.item?.type === "error") {
            showAgentError(event.item.message, event, !event.replayed);
            return;
        }
        if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.id) {
            const scoped = scopeEventChatItem(event, { id: event.item.id, role: "assistant", title: "Codex", text: stringText(event.item.text) }, event.item.id);
            const currentMessages = useAgentStore.getState().messages;
            const index = currentMessages.findIndex((message) => message.id === scoped.id);
            if (index >= 0) {
                const text = stringText(event.item.text);
                setAgentState({ messages: currentMessages.map((message, itemIndex) => itemIndex === index ? { ...message, text: text || message.text, streamId: undefined } : message) });
                return;
            }
            addMessage(scoped);
            return;
        }
        if (event.type === "item.completed" && event.item?.type === "reasoning" && !activity) {
            finishEmptyReasoningActivity(event);
            return;
        }
        if (event.type === "item.completed" && !activity && event.item?.id && event.item.type === "plan") {
            const id = scopeEventChatItem(event, { id: event.item.id, role: "tool", text: "" }, event.item.id).id;
            setAgentState({ messages: useAgentStore.getState().messages.filter((item) => item.id !== id) });
            return;
        }
        if (!event.replayed && event.type === "item.completed" && event.item?.type === "image_generation" && event.item.id && event.sourceClientId === clientIdRef.current) {
            const generated = await importGeneratedImages(endpoint, token, event.item);
            if (generated.length) {
                const context = canvasContextRef.current;
                if (context) {
                    const right = Math.max(0, ...context.snapshot.nodes.map((node) => node.position.x + node.width)) + 80;
                    const ops = generated.map<CanvasAgentOp>((image, index) => {
                        const size = fitNodeSize(image.upload.width, image.upload.height);
                        return {
                            type: "add_node",
                            id: `image-${createId()}`,
                            nodeType: "image",
                            title: image.name,
                            position: { x: right + index * 40, y: index * 40 },
                            ...size,
                            metadata: imageMetadata(image.upload),
                        };
                    });
                    const result = context.applyOps(ops);
                    void postState(endpoint, token, clientIdRef.current, result);
                }
                addEventLog(rt("importGeneratedImages"), rt(context ? "addedToSourceCanvas" : "imageGenerated"));
            }
        }
        if (activity && event.item?.id) {
            upsertEventActivity(event, activity);
            return;
        }
        if (event.type === "turn.completed") {
            const scope = eventScope(event);
            if (scope.turnId) {
                finishPlanActivity(event);
                liveTurnKeysRef.current.add(`${scope.threadId}\0${scope.turnId}`);
            }
            const current = useAgentStore.getState();
            setAgentState({
                activeTurnId: current.activeTurnId === scope.turnId ? "" : current.activeTurnId,
                messages: current.messages.map((message) => message.threadId === scope.threadId && message.turnId === scope.turnId && message.streamId ? { ...message, streamId: undefined } : message),
            });
            if (event.status === "failed") showAgentError(event.error?.message, event, !event.replayed);
        }
        const item = formatAgentEvent(event);
        if (item) addMessage(scopeEventChatItem(event, { ...item, id: event.item?.id || createId() }, event.item?.id || createId()));
    };

    const appendStreamText = (event: AgentEventPayload, text: string, isDelta = false) => {
        if (!text) return;
        const itemId = event.item?.id;
        if (!itemId) return;
        const scoped = scopeEventChatItem(event, { id: itemId, role: "assistant", title: "Codex", text, streamId: itemId }, itemId);
        const currentMessages = useAgentStore.getState().messages;
        const index = currentMessages.findIndex((message) => message.id === scoped.id);
        if (index < 0) {
            pushMessage(scoped);
            return;
        }
        setAgentState({ messages: currentMessages.map((message, itemIndex) => itemIndex === index ? { ...message, text: isDelta ? `${message.text}${text}` : mergeStreamText(message.text, text) } : message) });
    };

    const connectionStatus = t(connectError ? "agent.status.failed" : connected ? "agent.status.connected" : enabled ? "agent.status.connecting" : "agent.status.disconnected");
    const connectionStatusColor = connectError ? "#dc2626" : connected ? "#16a34a" : enabled ? "#d97706" : theme.node.muted;
    const content = (
        <>
            {!compact && productionFollow && <div className="flex min-w-0 items-center justify-between gap-2 border-b px-3 py-2 text-xs" style={{ borderColor: theme.node.stroke, background: theme.node.panel }}>
                <div className="min-w-0"><p className="font-medium">{t("productionHub.follow.current")}</p><p className="truncate text-[11px] opacity-75">{productionPresentation?.reason || productionPresentation?.targetId || productionFollow.id || productionFollow.workId}</p></div>
                <Button size="small" type="text" onClick={() => followingProduction ? useProductionFollowStore.getState().pause("用户手动暂停自动跟随") : useProductionFollowStore.getState().resume()}>{followingProduction ? t("productionHub.follow.pause") : t("productionHub.follow.return")}</Button>
            </div>}
            <AgentPanelTabs
                value={activeTab}
                theme={theme}
                leading={
                    <div className="flex items-center gap-1">
                        {headerAction || <span className="grid size-8 place-items-center">
                            <Bot className="size-4" />
                        </span>}
                        <div className={compact ? "text-sm font-medium" : "hidden text-base font-semibold leading-5 @min-[560px]:block"}>{compact ? t("productionCanvas.director") : "Agent"}</div>
                        <Tooltip title={t("agent.panel.connectionSettings", { status: connectionStatus })} placement="bottom">
                            <Button size="small" type="text" className="!h-8 !w-8 !min-w-8 !px-0 @min-[560px]:!w-auto @min-[560px]:!min-w-0 @min-[560px]:!px-[7px]" aria-label={t("agent.panel.connectionSettingsLabel", { status: connectionStatus })} icon={<PlugZap className="size-3.5" style={{ color: connectionStatusColor }} />} onClick={() => setAgentState({ activeTab: "setup" })}>
                                <span className="hidden @min-[560px]:inline">{connectionStatus}</span>
                            </Button>
                        </Tooltip>
                    </div>
                }
                items={[
                    { value: "chat", label: t("agent.panel.chat"), icon: <MessageSquare className="size-3.5" /> },
                    { value: "history", label: t("agent.panel.history"), icon: <History className="size-3.5" />, count: threads.length },
                    { value: "skills", label: t("agent.panel.skills"), icon: <Sparkles className="size-3.5" />, count: skillCount },
                    { value: "log", label: t("agent.panel.logs"), icon: <Terminal className="size-3.5" />, count: eventLogs.length },
                ]}
                onChange={(activeTab) => {
                    setAgentState({ activeTab });
                    if (activeTab === "history") void loadThreads();
                }}
                right={
                    <>
                        <Tooltip title={t("agent.history.newThread")} placement="bottom">
                            <Button size="small" type="text" className="!h-8 !w-8 !min-w-8 !px-0 @min-[560px]:!w-auto @min-[560px]:!min-w-0 @min-[560px]:!px-[7px]" aria-label={t("agent.history.newThread")} disabled={!connected || loadingThreads || sending || waiting || conversationBusy || Boolean(creativeLaunch)} icon={<Plus className="size-3.5" />} onClick={startNewThread}>
                                <span className="hidden @min-[560px]:inline">{t("agent.history.newThread")}</span>
                            </Button>
                        </Tooltip>
                        <Tooltip title={t("agent.panel.collapse")}>
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" aria-label={t("agent.panel.collapseLabel")} style={{ color: theme.node.muted }} icon={compact ? <Minus className="size-4" /> : <PanelRightClose className="size-4" />} onClick={closePanel} />
                        </Tooltip>
                    </>
                }
            />

            {compact && chatObject && <div className="shrink-0 px-3 pt-3"><button type="button" className="inline-flex max-w-full items-center gap-2 rounded-md border px-2 py-1.5 text-xs" style={{ color: theme.node.text, borderColor: theme.node.stroke, background: theme.toolbar.panel }} aria-label={t("productionCanvas.locateChatObject")} onClick={() => {
                const path = productionObjectPath(chatObject);
                useProductionFollowStore.getState().pause(t("productionCanvas.manualPause"));
                navigate(path);
                closePanel();
            }}><span className="min-w-0 truncate">{chatObject.targetKind === "segment" ? chatObject.clipIndex ? t("productionCanvas.h3Context", { number: chatObject.clipIndex }) : t("productionCanvas.videoTarget") : chatObject.title || t("productionCanvas.object")}</span><LocateFixed className="size-3.5 shrink-0" /></button></div>}

            {activeTab === "setup" ? (
                <AgentConnectView
                    theme={theme}
                    url={url}
                    token={token}
                    enabled={enabled}
                    connected={connected}
                    activity={activity}
                    connectError={connectError}
                    onUrlChange={(url) => setAgentState({ url, connectError: "" })}
                    onTokenChange={(token) => setAgentState({ token, connectError: "" })}
                    onToggleEnabled={toggleAgentConnection}
                />
            ) : activeTab === "skills" ? (
                <AgentSkillsView clientId={clientIdRef.current} />
            ) : activeTab === "history" ? (
                <AgentHistoryView
                    theme={theme}
                    threads={threads}
                    activeThreadId={activeThreadId}
                    workspacePath={workspacePath}
                    loading={loadingThreads}
                    busy={sending || waiting || conversationBusy}
                    connected={connected}
                    onRefresh={() => void loadThreads()}
                    onNewThread={() => void startNewThread()}
                    onResumeThread={(threadId) => void resumeThread(threadId)}
                    onDeleteThreads={confirmDeleteThreads}
                />
            ) : activeTab === "log" ? (
                <AgentLogView
                    logs={eventLogs}
                    theme={theme}
                    context={{ endpoint, connected, enabled, activity, waiting, sending, messages: messageCount, pendingTool: pendingTool?.name }}
                    onClear={clearEventLogs}
                    onCopied={(text) => message.success(text)}
                    onCopyBlocked={(text) => message.warning(text)}
                />
            ) : (
                <>
                    <AgentChatTimeline theme={theme} pendingTool={pendingTool} pendingApprovals={pendingApprovals} sending={sending} waiting={waiting} onRejectTool={rejectPendingTool} onApproveTool={approvePendingTool} onApprovalDecision={decideApproval} />
                    <AgentTaskProgress theme={theme} busy={sending || waiting} />
                    {tokenUsage ? <AgentUsageBar usage={tokenUsage} theme={theme} /> : null}
                    <AgentChatQueue items={promptQueue.items} paused={promptQueue.paused} canInsert={promptQueue.canInsert} theme={theme} onRemove={promptQueue.remove} onInsert={(id) => void promptQueue.insert(id)} onRetry={promptQueue.retry} onResume={promptQueue.resume} />
                    <AgentChatComposer
                        prompt={prompt}
                        attachments={attachments.map((attachment) => agentAttachmentToChatAttachment(attachment, endpoint, token))}
                        disabled={!connected || !conversationCanAcceptInput || loadingThreads || Boolean(creativeLaunch)}
                        sending={sending || Boolean(creativeLaunch)}
                        waiting={queueWaiting}
                        queueBusy={queueBusy || Boolean(creativeLaunch)}
                        placeholder={conversation.status === "idle" || conversation.status === "preparing"
                            ? t("agent.panel.mcpInitializing")
                            : conversation.status === "failed"
                                ? t("agent.panel.initFailed")
                                : t(compact ? "productionCanvas.chatPlaceholder" : "agent.panel.placeholder")}
                        theme={theme}
                        onPromptChange={(prompt) => setAgentState({ prompt })}
                        onSubmit={sendPrompt}
                        onQueue={enqueueCurrentPrompt}
                        onStop={stopTurn}
                        onAddFiles={addAttachments}
                        onRemoveAttachment={removeAttachment}
                        confirmTools={confirmTools}
                        onConfirmToolsChange={(confirmTools) => setAgentState({ confirmTools })}
                        permissionMode={permissionMode}
                        onPermissionModeChange={changePermissionMode}
                        models={models}
                        model={model}
                        reasoningEffort={reasoningEffort}
                        onModelChange={(model) => {
                            const selected = models.find((item) => item.model === model);
                            if (!selected) return;
                            const effort = selected.defaultReasoningEffort || selected.supportedReasoningEfforts[0]?.reasoningEffort;
                            setAgentState({ model, ...(effort ? { reasoningEffort: effort } : {}) });
                        }}
                        onReasoningEffortChange={(reasoningEffort) => {
                            setAgentState({ reasoningEffort });
                        }}
                        left={
                            attachments.length ? (
                                <span className="hidden text-[11px] @min-[660px]:inline" style={{ color: theme.node.muted }}>
                                    {formatBytes(attachmentPayloadBytes(attachments))} / 30MB
                                </span>
                            ) : null
                        }
                    />
                </>
            )}
        </>
    );

    if (headless) return null;
    return embedded ? content : null;
}

function acquireAgentClientId() {
    const scope = globalThis as AgentClientGlobal;
    scope.__infiniteCanvasAgentClientIdPromise ||= (async () => {
        const storedClientId = readAgentClientId();
        let clientId = storedClientId || randomId();
        if (!navigator.locks) {
            if (!storedClientId) saveAgentClientId(clientId);
            return clientId;
        }
        while (true) {
            const acquired = await new Promise<boolean>((resolve, reject) => {
                void navigator.locks.request(`infinite-canvas-agent:${clientId}`, { ifAvailable: true }, async (lock) => {
                    if (!lock) return resolve(false);
                    resolve(true);
                    await new Promise<void>(() => undefined);
                }).catch(reject);
            });
            if (acquired) {
                saveAgentClientId(clientId);
                return clientId;
            }
            clientId = randomId();
        }
    })().catch(() => {
        const clientId = randomId();
        saveAgentClientId(clientId);
        return clientId;
    });
    return scope.__infiniteCanvasAgentClientIdPromise;
}

function readAgentClientId() {
    try {
        return sessionStorage.getItem("canvas-agent-client-id") || "";
    } catch {
        return "";
    }
}

function saveAgentClientId(clientId: string) {
    try {
        sessionStorage.setItem("canvas-agent-client-id", clientId);
    } catch {
        // The in-memory identity still keeps request ownership consistent within the current page session.
    }
}

function eventScope(event: AgentEventPayload) {
    return {
        threadId: event.threadId || event.thread_id || "",
        turnId: event.turnId || event.turn_id || "",
    };
}

function scopeEventChatItem(event: AgentEventPayload, item: AgentChatItem, itemId: string) {
    const scope = eventScope(event);
    return scopeChatItem({ ...item, itemId }, scope.threadId, scope.turnId);
}

function approvalActivity(pendingApprovals: AgentPendingApproval[], waiting: boolean, fallback: string) {
    if (pendingApprovals.length) return rt("awaitingApproval");
    return waiting ? rt("codexRunning") : fallback;
}

async function attachmentNodeOps(endpoint: string, token: string, clientId: string, value: unknown): Promise<CanvasAgentOp[]> {
    const nodes = Array.isArray(value) ? value : [];
    if (!nodes.length) throw new Error(rt("noImageAttachments"));
    return await Promise.all(
        nodes.map(async (value) => {
            const item = value as { id?: unknown; attachmentId?: unknown; title?: unknown; position?: unknown };
            const id = String(item.id || "");
            const attachmentId = String(item.attachmentId || "");
            if (!id || !attachmentId) throw new Error(rt("invalidAttachmentNode"));
            const res = await fetch(`${endpoint}/attachments/${encodeURIComponent(attachmentId)}?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`);
            if (!res.ok) {
                const body = (await res.json().catch(() => null)) as { error?: string } | null;
                throw new Error(body?.error || rt("attachmentReadFailed"));
            }
            const image = await uploadImage(await res.blob());
            const size = fitNodeSize(image.width, image.height);
            const position = item.position && typeof item.position === "object" ? (item.position as { x?: unknown; y?: unknown }) : {};
            return {
                type: "add_node" as const,
                id,
                nodeType: "image" as const,
                title: String(item.title || rt("referenceImage")),
                position: { x: Number(position.x) || 0, y: Number(position.y) || 0 },
                width: size.width,
                height: size.height,
                metadata: imageMetadata(image),
            };
        }),
    );
}

function createId() {
    return randomId();
}

async function createMessageAttachmentMetadata(item: AgentAttachment) {
    const url = Math.max(item.width, item.height) > MESSAGE_PREVIEW_LONG_EDGE || item.dataUrl.length > MESSAGE_PREVIEW_MAX_LENGTH
        ? await upscaleDataUrl(item.dataUrl, { targetLongEdge: MESSAGE_PREVIEW_LONG_EDGE, algorithm: "high" })
        : item.dataUrl;
    return { id: item.id, name: item.name, type: item.type, size: item.size, width: item.width, height: item.height, url };
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

async function importGeneratedImages(endpoint: string, token: string, item: AgentEventItem) {
    const sources = Array.from(generatedImageSources(item));
    return await Promise.all(
        sources.map(async (source, index) => {
            const response = source.startsWith("data:image/")
                ? await fetch(source)
                : await fetch(`${endpoint}/local-image?token=${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: source }) });
            if (!response.ok) throw new Error(rt("generatedImageReadFailed"));
            const blob = await response.blob();
            const upload = await uploadImage(blob);
            const dataUrl = await readDataUrl(blob);
            const name = source.startsWith("/") ? source.split("/").at(-1) || rt("generatedImageName", { index: index + 1 }) : rt("generatedImageName", { index: index + 1 });
            return { upload, name, attachment: { id: createId(), name, type: blob.type || upload.mimeType, size: blob.size, width: upload.width, height: upload.height, url: upload.url, dataUrl } };
        }),
    );
}

function generatedImageSources(value: unknown, result = new Set<string>()) {
    if (typeof value === "string") {
        if (value.startsWith("data:image/") || (/^\/.+\.(?:avif|gif|jpe?g|png|webp)$/i.test(value) && !value.includes("\n"))) result.add(value);
        return result;
    }
    if (Array.isArray(value)) value.forEach((item) => generatedImageSources(item, result));
    else if (value && typeof value === "object") Object.values(value).forEach((item) => generatedImageSources(item, result));
    return result;
}

function readDataUrl(file: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error(rt("imageReadFailed")));
        reader.readAsDataURL(file);
    });
}

function delay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
