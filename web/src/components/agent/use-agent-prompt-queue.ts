import { useCallback, useEffect, useRef, useState } from "react";

import i18n from "@/i18n";

import { claimNextAgentPrompt, moveAgentPromptToFront, removeAgentPrompt, updateAgentPrompt } from "@/lib/agent/agent-prompt-queue";
import { interruptCodexTurn } from "@/services/api/canvas-agent";
import { flushAgentPromptQueue, useAgentStore, type AgentQueuedPrompt } from "@/stores/use-agent-store";

export type AgentPromptSubmissionResult = { status: "sent" } | { status: "busy" } | { status: "failed"; error: string };

type UseAgentPromptQueueOptions = {
    endpoint: string;
    token: string;
    connected: boolean;
    activeThreadId: string;
    conversationId: string;
    conversationStatus: string;
    codexBusy: boolean;
    codexThreadId: string;
    codexTurnId: string;
    codexRevision: number;
    sending: boolean;
    loadingThreads: boolean;
    onSubmit: (item: AgentQueuedPrompt) => Promise<AgentPromptSubmissionResult>;
    onReconcile: () => void | Promise<void>;
};

export function useAgentPromptQueue(options: UseAgentPromptQueueOptions) {
    const {
        endpoint, token, connected, activeThreadId, conversationId, conversationStatus,
        codexBusy, codexThreadId, codexTurnId, codexRevision, sending, loadingThreads, onSubmit, onReconcile,
    } = options;
    const queue = useAgentStore((state) => state.queuedPrompts);
    const hydrated = useAgentStore((state) => state.promptQueueHydrated);
    const pausedScopes = useAgentStore((state) => state.pausedPromptQueueScopes);
    const [dispatchEpoch, setDispatchEpoch] = useState(0);
    const submitRef = useRef(onSubmit);
    const reconcileRef = useRef(onReconcile);
    const inFlightIdRef = useRef("");
    const insertionIdRef = useRef("");
    const insertionStartRevisionRef = useRef(0);
    const insertionAcknowledgedRef = useRef(false);
    const blockedRuntimeRevisionRef = useRef<{ scope: string; instanceId: string; revision: number } | null>(null);
    const acceptedTurnRuntimeRef = useRef<{ instanceId: string; revision: number } | null>(null);
    submitRef.current = onSubmit;
    reconcileRef.current = onReconcile;

    const scope = JSON.stringify([activeThreadId, conversationId]);
    const paused = pausedScopes.includes(scope);
    const currentItems = queue.filter((item) => item.threadId === activeThreadId && item.conversationId === conversationId);

    useEffect(() => {
        const current = useAgentStore.getState();
        const acceptedRuntime = acceptedTurnRuntimeRef.current;
        if (acceptedRuntime) {
            if (acceptedRuntime.instanceId !== current.codexRuntime.instanceId) {
                if (!current.codexRuntime.busy) acceptedTurnRuntimeRef.current = null;
                else {
                    acceptedTurnRuntimeRef.current = { instanceId: current.codexRuntime.instanceId, revision: current.codexRuntime.revision };
                    return;
                }
            } else if (current.codexRuntime.revision > acceptedRuntime.revision && !current.codexRuntime.busy) {
                acceptedTurnRuntimeRef.current = null;
            } else return;
        }
        const blocked = blockedRuntimeRevisionRef.current;
        if (blocked?.scope === scope) {
            if (blocked.instanceId !== current.codexRuntime.instanceId || current.codexRuntime.revision > blocked.revision) blockedRuntimeRevisionRef.current = null;
            else return;
        }
        if (!current.promptQueueHydrated || !connected || !activeThreadId || !conversationId || current.activeThreadId !== activeThreadId || current.conversation.conversationId !== conversationId || !["ready", "warning"].includes(current.conversation.status) || current.codexRuntime.busy || current.sending || current.waiting || current.loadingThreads || current.pausedPromptQueueScopes.includes(scope) || inFlightIdRef.current) return;

        const claimed = claimNextAgentPrompt(current.queuedPrompts, activeThreadId, conversationId);
        if (!claimed.item) return;
        const dispatchRuntime = { instanceId: current.codexRuntime.instanceId, revision: current.codexRuntime.revision };
        current.updatePromptQueue(() => claimed.queue);
        inFlightIdRef.current = claimed.item.id;
        void flushAgentPromptQueue().then(() => submitRef.current(claimed.item!)).then((result) => {
            const latest = useAgentStore.getState();
            if (inFlightIdRef.current !== claimed.item!.id) return;
            if (result.status === "sent") {
                acceptedTurnRuntimeRef.current = dispatchRuntime;
                latest.updatePromptQueue((items) => removeAgentPrompt(items, claimed.item!.id));
                void reconcileRef.current();
            } else if (result.status === "busy") {
                latest.updatePromptQueue((items) => updateAgentPrompt(items, claimed.item!.id, "queued"));
                blockedRuntimeRevisionRef.current = { scope, instanceId: latest.codexRuntime.instanceId, revision: latest.codexRuntime.revision };
                void reconcileRef.current();
            } else {
                latest.updatePromptQueue((items) => updateAgentPrompt(items, claimed.item!.id, "failed", result.error));
            }
        }).catch((error: unknown) => {
            const latest = useAgentStore.getState();
            if (inFlightIdRef.current !== claimed.item!.id) return;
            latest.updatePromptQueue((items) => updateAgentPrompt(items, claimed.item!.id, "failed", error instanceof Error ? error.message : String(error)));
        }).finally(() => {
            if (inFlightIdRef.current === claimed.item!.id) inFlightIdRef.current = "";
            setDispatchEpoch((epoch) => epoch + 1);
        });
    }, [activeThreadId, connected, conversationId, conversationStatus, codexBusy, codexRevision, dispatchEpoch, hydrated, loadingThreads, paused, queue, scope, sending]);

    useEffect(() => {
        const id = insertionIdRef.current;
        if (!id || !insertionAcknowledgedRef.current) return;
        const current = useAgentStore.getState();
        const item = current.queuedPrompts.find((candidate) => candidate.id === id);
        if (!item || item.status !== "interrupting") {
            insertionIdRef.current = "";
            insertionAcknowledgedRef.current = false;
            return;
        }
        if (current.activeThreadId !== item.threadId || current.conversation.conversationId !== item.conversationId) {
            current.updatePromptQueue((items) => updateAgentPrompt(items, id, "failed", i18n.t("agent.queue.conversationChanged")));
            insertionIdRef.current = "";
            insertionAcknowledgedRef.current = false;
            return;
        }
        if (current.codexRuntime.revision <= insertionStartRevisionRef.current || current.codexRuntime.busy || current.codexRuntime.threadId !== item.threadId || !["ready", "warning"].includes(current.conversation.status)) return;
        current.updatePromptQueue((items) => updateAgentPrompt(items, id, "queued"));
        insertionIdRef.current = "";
        insertionAcknowledgedRef.current = false;
    }, [activeThreadId, codexBusy, codexRevision, conversationId, conversationStatus, queue]);

    const remove = useCallback((id: string) => {
        useAgentStore.getState().updatePromptQueue((items) => removeAgentPrompt(items, id));
    }, []);

    const retry = useCallback((id: string) => {
        useAgentStore.getState().updatePromptQueue((items) => updateAgentPrompt(items, id, "queued"));
    }, []);

    const insert = useCallback(async (id: string) => {
        const current = useAgentStore.getState();
        const item = current.queuedPrompts.find((candidate) => candidate.id === id);
        if (!item || item.status !== "queued" || item.threadId !== current.activeThreadId || item.conversationId !== current.conversation.conversationId || insertionIdRef.current) return;
        const interruptsThisTurn = current.codexRuntime.busy && current.codexRuntime.threadId === item.threadId;
        if (!interruptsThisTurn) {
            current.updatePromptQueue((items) => moveAgentPromptToFront(items, id));
            return;
        }
        if (!current.codexRuntime.turnId) return;
        insertionIdRef.current = id;
        insertionStartRevisionRef.current = current.codexRuntime.revision;
        insertionAcknowledgedRef.current = false;
        current.updatePromptQueue((items) => moveAgentPromptToFront(items, id).map((candidate) => candidate.id === id ? { ...candidate, status: "interrupting", error: undefined } : candidate));
        try {
            await flushAgentPromptQueue();
            await interruptCodexTurn(endpoint, token, item.threadId);
            const afterAck = useAgentStore.getState();
            if (afterAck.activeThreadId !== item.threadId || afterAck.conversation.conversationId !== item.conversationId) {
                afterAck.updatePromptQueue((items) => updateAgentPrompt(items, id, "failed", i18n.t("agent.queue.conversationChanged")));
                insertionIdRef.current = "";
                return;
            }
            insertionAcknowledgedRef.current = true;
            await reconcileRef.current();
        } catch (error) {
            useAgentStore.getState().updatePromptQueue((items) => updateAgentPrompt(items, id, "failed", error instanceof Error ? error.message : "Interrupt failed"));
            insertionIdRef.current = "";
            insertionAcknowledgedRef.current = false;
        }
    }, [endpoint, token]);

    const resume = useCallback(() => {
        useAgentStore.getState().setPromptQueuePaused(activeThreadId, conversationId, false);
    }, [activeThreadId, conversationId]);

    return { items: currentItems, paused, remove, retry, insert, resume, canInsert: !insertionIdRef.current && (!codexBusy || codexThreadId !== activeThreadId || Boolean(codexTurnId)) };
}
