import * as Y from "yjs";

export type CanvasTextTarget = { nodeId?: string; segmentId?: string; textItemId?: string; field: "prompt" | "content" | "composerContent" | "globalPrompt" };
export const canvasTextKey = (target: CanvasTextTarget) => JSON.stringify([target.nodeId || "", target.segmentId || "", target.field, ...(target.textItemId ? [target.textItemId] : [])]);
export const encodeTextUpdate = (bytes: Uint8Array) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
export const decodeTextUpdate = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
export type TextState = { state: string; documentId: string };
export type TextDraft = TextState & { operationId: string; update: string; order: number };
type SessionStatus = { ready: boolean; pending: number; error: string; blocked: boolean; text: string };
type Transport = {
    read: () => Promise<TextState>;
    load: () => Promise<TextDraft[]>;
    save: (draft: TextDraft) => Promise<unknown>;
    remove: (draft: TextDraft) => Promise<unknown>;
    send: (draft: TextDraft) => Promise<void>;
    isPermanentError: (error: unknown) => boolean;
    nextId: () => string;
};
const REMOTE = Symbol("remote-text");

/** 编辑器只改 Y.Text。整图 Store 只接收已确认投影，禁止再次把本地全文作为 ops 提交。 */
export class CollaborativeTextSession {
    readonly doc = new Y.Doc();
    readonly text = this.doc.getText("text");
    readonly undo = new Y.UndoManager(this.text, { trackedOrigins: new Set() });
    private status: SessionStatus = { ready: false, pending: 0, error: "", blocked: false, text: "" };
    private documentId = "";
    private listeners = new Set<() => void>();
    private drafts: TextDraft[] = [];
    private initialized?: Promise<void>;
    private sending?: Promise<void>;
    private sequence = 0;

    constructor(private transport: Transport) {
        this.doc.on("update", (update: Uint8Array, origin: unknown) => {
            this.setStatus({ text: this.text.toString() });
            if (origin === REMOTE) return;
            const draft = { documentId: this.documentId, operationId: transport.nextId(), update: encodeTextUpdate(update), state: encodeTextUpdate(Y.encodeStateAsUpdate(this.doc)), order: this.sequence = Math.max(Date.now(), this.sequence + 1) };
            this.drafts.push(draft);
            this.setStatus({ pending: this.drafts.length });
            // 网络请求可能一直等待；新输入的落盘不能被发送队列阻塞。
            void transport.save(draft).then(() => this.flush()).catch((error) => this.failed(error));
        });
    }

    getSnapshot = () => this.status;
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    private setStatus(patch: Partial<SessionStatus>) {
        const next = { ...this.status, ...patch };
        if (Object.keys(next).every((key) => next[key as keyof SessionStatus] === this.status[key as keyof SessionStatus])) return;
        this.status = next;
        this.listeners.forEach((listener) => listener());
    }
    private failed(error: unknown) {
        this.setStatus({ error: error instanceof Error ? error.message : String(error), blocked: this.status.blocked || this.transport.isPermanentError(error) });
    }
    getDocumentId = () => this.documentId;
    receive({ state, documentId }: TextState) {
        if (!documentId || (this.documentId && this.documentId !== documentId)) {
            this.setStatus({ blocked: true, error: "目标文本已被替换；旧草稿已保留，不能自动写入新对象" });
            throw new Error(this.status.error);
        }
        this.documentId = documentId;
        Y.applyUpdate(this.doc, decodeTextUpdate(state), REMOTE);
    }

    initialize() {
        return this.initialized ||= this.restore();
    }
    private async restore() {
        try {
            this.drafts = (await this.transport.load()).sort((a, b) => a.order - b.order);
            this.setStatus({ pending: this.drafts.length });
            for (const draft of this.drafts) this.receive(draft);
            try { this.receive(await this.transport.read()); }
            catch (error) {
                this.failed(error);
                if (!this.drafts.length || this.status.blocked) return;
            }
            this.setStatus({ ready: true });
        } catch (error) { this.failed(error); }
    }

    /** 重连时读取 Yjs 状态，不从项目快照重建文档，因此离线输入/选区不会被整段替换。 */
    async reconnect(explicit = false) {
        await this.initialize();
        if (this.status.blocked && !explicit) return;
        try {
            this.receive(await this.transport.read());
            this.setStatus({ ready: true, blocked: false, error: "" });
            await this.flush();
        } catch (error) { this.failed(error); }
    }

    flush(): Promise<void> {
        if (this.sending) return this.sending;
        this.sending = this.submit().finally(() => { this.sending = undefined; });
        return this.sending;
    }
    private async submit() {
        await this.initialize();
        try {
            // 先落盘全部待确认文本，再尝试网络；断网时也不能只保存队首。
            for (const draft of this.drafts) await this.transport.save(draft);
            if (!this.status.ready || this.status.blocked) throw new Error(this.status.error || "协作文本尚未加载");
            while (this.drafts.length) {
                const draft = this.drafts[0];
                await this.transport.save(draft);
                await this.transport.send(draft);
                await this.transport.remove(draft);
                this.drafts.shift();
                this.setStatus({ pending: this.drafts.length, error: "" });
            }
        } catch (error) {
            // 请求进行中仍可输入；即便请求失败，新输入也必须独立保存。
            try { for (const draft of this.drafts) await this.transport.save(draft); }
            catch (storageError) { this.failed(storageError); throw storageError; }
            const blocked = this.status.blocked;
            this.failed(error);
            if (blocked) this.setStatus({ blocked: true });
            throw error;
        }
    }
}
