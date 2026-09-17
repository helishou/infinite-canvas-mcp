import localforage from "localforage";
import { BackendApiError, getBackendUrl, getCanvasCollaborationClient, getCanvasDraftSessionId, request } from "@/services/backend-api";
import { canvasTextKey } from "@/lib/canvas/collaborative-text-session";
import { canvasDraftPersistence } from "@/lib/canvas/canvas-draft-persistence";
import { getCanvasTextSession, onCanvasTextEvent, publishCanvasTextCommit } from "./canvas-text";
import type { CanvasTextSuggestion, CanvasTextSuggestionInput, CanvasTextSuggestions, CanvasTextTarget } from "@/types/canvas-plugin";

type Draft = { ownerId: string; backend: string; projectId: string; suggestion: CanvasTextSuggestionInput; rejected?: string };
const outbox = localforage.createInstance({ name: "infinite-canvas-text-suggestions-outbox" });
const stores = new Map<string, { backend: string; projectId: string; store: CanvasTextSuggestions; receive: (item: CanvasTextSuggestion) => void }>();

export async function listBackendCanvasTextSuggestions(projectId: string) {
    const response = await request<{ suggestions: CanvasTextSuggestion[] }>("GET", `/canvas/projects/${encodeURIComponent(projectId)}/text-suggestions`);
    return response.suggestions;
}

export async function dismissBackendCanvasTextSuggestion(projectId: string, id: string) {
    const response = await request<{ revision: number; operations: unknown[]; project: Record<string, unknown> }>("POST", `/canvas/projects/${encodeURIComponent(projectId)}/ops`, {
        operationId: `suggestion-resolve:${projectId}:${id}:dismiss`,
        source: getCanvasCollaborationClient(),
        operations: [{ type: "resolve_text_suggestion", id, action: "dismiss" }],
    });
    publishCanvasTextCommit(projectId, response);
}

/** 候选正文以 Backend 为权威；仅未收到保存回执的结果作为不可变离线草稿留存。 */
export function getCanvasTextSuggestions(projectId: string, target: CanvasTextTarget): CanvasTextSuggestions {
    const backend = getBackendUrl();
    const ownerId = getCanvasDraftSessionId();
    const key = JSON.stringify([backend, projectId, canvasTextKey(target)]);
    const existing = stores.get(key);
    if (existing) return existing.store;
    const path = `/canvas/projects/${encodeURIComponent(projectId)}`;
    const listeners = new Set<() => void>();
    const items = new Map<string, CanvasTextSuggestion>();
    const drafts = new Map<string, Draft>();
    let snapshot: ReturnType<CanvasTextSuggestions["getSnapshot"]> = { items: [], pending: 0, error: "" };
    let refreshing: Promise<void> | undefined;
    const emit = (error = "") => {
        snapshot = { items: [...items.values()].sort((a, b) => b.revision - a.revision), pending: drafts.size, error };
        listeners.forEach((listener) => listener());
    };
    const receive = (item: CanvasTextSuggestion) => {
        if (canvasTextKey(item.target) !== canvasTextKey(target)) return;
        const previous = items.get(item.id);
        if (!previous || item.revision > previous.revision) { items.set(item.id, item); emit(snapshot.error); }
    };
    const assertBackend = () => { if (getBackendUrl() !== backend) throw new Error("后台已切换，候选仍保留在原后台"); };
    const draftKey = (id: string) => JSON.stringify([backend, ownerId, projectId, id]);
    const persist = (draft: Draft) => canvasDraftPersistence.save({ key: `suggestion:${draftKey(draft.suggestion.id)}`, label: "强化候选结果", projectId, record: draft, write: async () => {
        const previous = await outbox.getItem<Draft>(draftKey(draft.suggestion.id));
        if (previous && JSON.stringify(previous.suggestion) !== JSON.stringify(draft.suggestion)) throw new Error("候选 ID 已存在，不能覆盖未确认结果");
        return outbox.setItem(draftKey(draft.suggestion.id), draft);
    } });
    const commit = async (operationId: string, operation: Record<string, unknown>) => {
        assertBackend();
        const response = await request<{ revision: number; operations: unknown[]; project: Record<string, unknown> }>("POST", path + "/ops", {
            operationId, source: getCanvasCollaborationClient(), operations: [operation],
        });
        publishCanvasTextCommit(projectId, response);
    };
    const send = async (draft: Draft) => {
        // 包括曾经保存失败、仅存在内存的候选；先确认落盘再提交后台。
        await persist(draft);
        try { await commit(`suggestion-save:${projectId}:${draft.suggestion.id}`, { type: "save_text_suggestion", suggestion: draft.suggestion }); }
        catch (error) {
            if (error instanceof BackendApiError && [400, 401, 403, 404, 409].includes(error.status)) {
                const rejected = { ...draft, rejected: error.message };
                drafts.set(draft.suggestion.id, rejected);
                await persist(rejected);
            }
            throw error;
        }
        await canvasDraftPersistence.save({ key: `suggestion:${draftKey(draft.suggestion.id)}`, label: "清理已确认候选", projectId, record: null, write: () => outbox.removeItem(draftKey(draft.suggestion.id)) });
        drafts.delete(draft.suggestion.id);
        emit();
    };
    const resolve = async (operation: Record<string, unknown>) => {
        try {
            assertBackend();
            if (operation.action === "apply") await getCanvasTextSession(projectId, target).flush();
            // 每个候选只能终结一次；重试沿用 ID。若已提交后改变请求，后台拒绝 ID 复用。
            await commit(`suggestion-resolve:${projectId}:${String(operation.id)}:${String(operation.action)}`, operation);
        } catch (error) {
            if (error instanceof BackendApiError && error.status === 409) await store.refresh().catch(() => {});
            emit(error instanceof Error ? error.message : String(error));
            throw error;
        }
    };
    const store: CanvasTextSuggestions = {
        getSnapshot: () => snapshot,
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        refresh: (retryRejected = false) => {
            if (refreshing) return refreshing;
            refreshing = (async () => {
                assertBackend();
                await outbox.iterate<Draft, void>((draft) => {
                    if (draft.ownerId !== ownerId || draft.backend !== backend || draft.projectId !== projectId || canvasTextKey(draft.suggestion.target) !== canvasTextKey(target)) return;
                    if (!drafts.has(draft.suggestion.id)) drafts.set(draft.suggestion.id, draft);
                    receive({ ...draft.suggestion, status: "pending", revision: 0 });
                });
                emit();
                for (const draft of drafts.values()) {
                    if (draft.rejected && !retryRejected) continue;
                    await send(draft);
                }
                const response = await request<{ suggestions: CanvasTextSuggestion[] }>("GET", path + "/text-suggestions?" + new URLSearchParams(Object.entries(target).filter((entry): entry is [string, string] => typeof entry[1] === "string")));
                response.suggestions.forEach(receive);
                emit([...drafts.values()].find((draft) => draft.rejected)?.rejected || "");
            })().catch((error) => { emit(error instanceof Error ? error.message : String(error)); throw error; }).finally(() => { refreshing = undefined; });
            return refreshing;
        },
        save: async (input) => {
            const draft: Draft = { ownerId, backend, projectId, suggestion: structuredClone({ ...input, target }) };
            const previous = drafts.get(input.id);
            if (previous && JSON.stringify(previous.suggestion) !== JSON.stringify(draft.suggestion)) throw new Error("候选 ID 已存在，不能覆盖未确认结果");
            // 先落离线草稿，才请求后台；刷新/关闭页面后可原样重交同一 operationId。
            drafts.set(input.id, draft);
            receive({ ...draft.suggestion, status: "pending", revision: 0 });
            emit();
            try { await send(draft); }
            catch (error) { emit(error instanceof Error ? error.message : String(error)); throw error; }
        },
        apply: (id, documentId, expectedText) => resolve({ type: "resolve_text_suggestion", id, action: "apply", documentId, expectedText }),
        dismiss: (id) => resolve({ type: "resolve_text_suggestion", id, action: "dismiss" }),
    };
    stores.set(key, { backend, projectId, store, receive });
    void store.refresh().catch(() => {});
    return store;
}

onCanvasTextEvent((event) => {
    const value = event as { type?: string; entityId?: string; payload?: { operations?: Array<{ textSuggestion?: CanvasTextSuggestion }> } };
    if (value?.type !== "canvas.updated") return;
    for (const entry of stores.values()) {
        if (entry.backend !== getBackendUrl() || entry.projectId !== value.entityId) continue;
        if (!value.payload?.operations) { void entry.store.refresh().catch(() => {}); continue; }
        for (const operation of value.payload.operations) if (operation.textSuggestion) entry.receive(operation.textSuggestion);
    }
});

if (typeof window !== "undefined") window.addEventListener("canvas-storage-recovered", () => {
    for (const entry of stores.values()) if (entry.backend === getBackendUrl()) void entry.store.refresh().catch(() => {});
});
