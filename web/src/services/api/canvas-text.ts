import localforage from "localforage";
import { nanoid } from "nanoid";
import { BackendApiError, getBackendUrl, getCanvasCollaborationClient, getCanvasDraftSessionId, request } from "@/services/backend-api";
import { canvasTextKey, CollaborativeTextSession, type CanvasTextTarget, type TextDraft } from "@/lib/canvas/collaborative-text-session";
import { canvasDraftPersistence } from "@/lib/canvas/canvas-draft-persistence";

type StoredDraft = TextDraft & { ownerId: string; backend: string; projectId: string; target: CanvasTextTarget; source: ReturnType<typeof getCanvasCollaborationClient> };
const outbox = localforage.createInstance({ name: "infinite-canvas-text-outbox" });
const sessions = new Map<string, { backend: string; projectId: string; target: CanvasTextTarget; session: CollaborativeTextSession }>();
const commitListeners = new Set<(event: unknown) => void>();
const eventListeners = new Set<(event: unknown) => void>();

export const onCanvasTextEvent = (listener: (event: unknown) => void) => { eventListeners.add(listener); return () => eventListeners.delete(listener); };
export function publishCanvasTextCommit(projectId: string, response: { revision: number; operations: unknown[]; project: Record<string, unknown> }) {
    receiveCanvasTextEvent({ type: "canvas.updated", entityId: projectId, revision: response.revision, payload: { operations: response.operations } });
    commitListeners.forEach((listener) => listener({ type: "canvas.updated", entityId: projectId, revision: response.revision, payload: response.project }));
}
let prepareDocument: () => Promise<void> = async () => {};
export const prepareCanvasTextWith = (prepare: () => Promise<void>) => { prepareDocument = prepare; };
export const onCanvasTextCommit = (listener: (event: unknown) => void) => { commitListeners.add(listener); return () => commitListeners.delete(listener); };

export function getCanvasTextSession(projectId: string, target: CanvasTextTarget) {
    const backend = getBackendUrl();
    const ownerId = getCanvasDraftSessionId();
    const key = JSON.stringify([backend, projectId, canvasTextKey(target)]);
    const existing = sessions.get(key);
    if (existing) return existing.session;
    const records = new Map<string, StoredDraft>();
    const source = getCanvasCollaborationClient();
    const path = `/canvas/projects/${encodeURIComponent(projectId)}`;
    const assertBackend = () => { if (getBackendUrl() !== backend) throw new Error("后台地址已切换，旧文本草稿仍保留在原后台名下"); };
    const readState = async () => {
        assertBackend();
        await prepareDocument();
        return request<{ state: string; documentId: string }>("GET", `${path}/text?${new URLSearchParams(Object.entries(target).filter((entry): entry is [string, string] => typeof entry[1] === "string"))}`);
    };
    const session = new CollaborativeTextSession({
        nextId: nanoid,
        read: readState,
        load: async () => {
            await outbox.iterate<StoredDraft, void>((draft) => { if (draft.ownerId === ownerId && draft.backend === backend && draft.projectId === projectId && canvasTextKey(draft.target) === canvasTextKey(target)) records.set(draft.operationId, draft); });
            return [...records.values()];
        },
        save: (draft) => {
            const record = records.get(draft.operationId) || { ...draft, ownerId, backend, projectId, target, source };
            records.set(draft.operationId, record);
            return canvasDraftPersistence.save({ key: `text:${draft.operationId}`, label: "协作文本", projectId, record, write: () => outbox.setItem(draft.operationId, record) });
        },
        remove: async (draft) => {
            await canvasDraftPersistence.save({ key: `text:${draft.operationId}`, label: "清理已确认文本", projectId, record: null, write: () => outbox.removeItem(draft.operationId) });
            records.delete(draft.operationId);
        },
        send: async (draft) => {
            assertBackend();
            const record = records.get(draft.operationId);
            if (!record) throw new Error("协作文本草稿不存在");
            const response = await request<{ revision: number; project: Record<string, unknown> }>("POST", `${path}/ops`, { operationId: draft.operationId, source: record.source, operations: [{ type: "text_update", target, documentId: draft.documentId, update: draft.update }] });
            session.receive(await readState());
            commitListeners.forEach((listener) => listener({ type: "canvas.updated", entityId: projectId, revision: response.revision, payload: response.project }));
        },
        isPermanentError: (error) => error instanceof BackendApiError && [400, 401, 403, 404, 409].includes(error.status),
    });
    sessions.set(key, { backend, projectId, target, session });
    void session.initialize().then(() => session.flush()).catch(() => {});
    return session;
}

export function receiveCanvasTextEvent(event: unknown) {
    eventListeners.forEach((listener) => listener(event));
    const value = event as { type?: string; entityId?: string; payload?: { operations?: Array<Record<string, any>> } | Record<string, any> };
    if (value?.type !== "canvas.updated" || !value.entityId) return;
    if (!value.payload || !Array.isArray(value.payload.operations)) {
        const project = value.payload as Record<string, any> | undefined;
        if (project?.id === value.entityId) for (const entry of sessions.values()) {
            if (entry.backend !== getBackendUrl() || entry.projectId !== value.entityId) continue;
            const { target, session } = entry;
            const node = project.nodes?.find((item: Record<string, any>) => item.id === target.nodeId);
            const record = target.textItemId ? node?.metadata?.texts?.find((item: Record<string, any>) => item.id === target.textItemId) : target.segmentId ? node?.metadata?.segments?.find((item: Record<string, any>) => item.id === target.segmentId) : target.nodeId ? node?.metadata : project;
            if (!record || String(record[target.field] || "") !== session.text.toString()) void session.reconnect();
        }
        return;
    }
    for (const operation of value.payload.operations) for (const update of [...(operation.textUpdates || []), ...(operation.textUpdate ? [operation.textUpdate] : [])]) {
        const target = update.target as CanvasTextTarget | undefined;
        if (!target) continue;
        const key = JSON.stringify([getBackendUrl(), value.entityId, canvasTextKey(target)]);
        try { sessions.get(key)?.session.receive({ state: update.update, documentId: update.documentId }); } catch { /* session records the blocking state */ }
    }
    if (value.payload.operations.some((operation) => ["delete_node", "delete_h3_segment", "replace_h3_segments"].includes(String(operation.type)) || !operation.textUpdate && operation.type === "update_node" && ["texts", "segments"].some((key) => Object.hasOwn(operation.metadata || {}, key) || (operation.metadataDelete || []).includes(key)))) for (const entry of sessions.values()) if (entry.backend === getBackendUrl() && entry.projectId === value.entityId) void entry.session.reconnect();
}

export async function reconnectCanvasTexts(projectId: string) {
    await Promise.all([...sessions.values()].filter((entry) => entry.backend === getBackendUrl() && entry.projectId === projectId).map(({ session }) => session.reconnect()));
}

export async function replaceCanvasText(projectId: string, target: CanvasTextTarget, documentId: string, expectedText: string, text: string) {
    const session = getCanvasTextSession(projectId, target);
    await session.flush();
    if (session.getDocumentId() !== documentId || session.text.toString() !== expectedText) return false;
    try {
        const response = await request<{ operations: Array<Record<string, any>>; revision: number; project: Record<string, unknown> }>("POST", `/canvas/projects/${encodeURIComponent(projectId)}/ops`, { operationId: nanoid(), source: getCanvasCollaborationClient(), operations: [{ type: "text_replace", target, documentId, expectedText, text }] });
        for (const operation of response.operations) if (operation.textUpdate) session.receive({ state: operation.textUpdate.update, documentId: operation.textUpdate.documentId });
        commitListeners.forEach((listener) => listener({ type: "canvas.updated", entityId: projectId, revision: response.revision, payload: response.project }));
        return true;
    } catch (error) { if (error instanceof BackendApiError && error.status === 409) return false; throw error; }
}

export async function flushCanvasTexts(projectId: string) {
    const targets = new Map<string, CanvasTextTarget>();
    await outbox.iterate<StoredDraft, void>((draft) => { if (draft.ownerId === getCanvasDraftSessionId() && draft.backend === getBackendUrl() && draft.projectId === projectId) targets.set(canvasTextKey(draft.target), draft.target); });
    targets.forEach((target) => getCanvasTextSession(projectId, target));
    await Promise.all([...sessions.values()].filter((entry) => entry.backend === getBackendUrl() && entry.projectId === projectId).map(async ({ session }) => { await session.initialize(); if (session.getSnapshot().pending) await session.flush(); }));
}

if (typeof window !== "undefined") window.addEventListener("canvas-storage-recovered", () => { for (const entry of sessions.values()) if (entry.backend === getBackendUrl() && entry.session.getSnapshot().pending) void entry.session.flush().catch(() => {}); });
