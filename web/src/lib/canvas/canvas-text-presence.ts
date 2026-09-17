import * as Y from "yjs";
import { canvasTextKey, decodeTextUpdate, encodeTextUpdate, type CanvasTextTarget } from "./collaborative-text-session";

export type CanvasTextSelection = { target: CanvasTextTarget; documentId: string; anchor: string; head: string };
export type TextPresencePeer = { connectionId: string; label: string; color: string; textSelection?: CanvasTextSelection | null };
export function encodeCanvasTextSelection(text: Y.Text, target: CanvasTextTarget, documentId: string, anchor: number, head: number): CanvasTextSelection {
    const encode = (index: number) => encodeTextUpdate(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, index)));
    return { target, documentId, anchor: encode(anchor), head: encode(head) };
}
export function resolveCanvasTextSelection(text: Y.Text, target: CanvasTextTarget, documentId: string, value?: CanvasTextSelection | null) {
    if (!text.doc || !value || value.documentId !== documentId || canvasTextKey(value.target) !== canvasTextKey(target)) return null;
    try {
        const resolve = (encoded: string) => Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(decodeTextUpdate(encoded)), text.doc!);
        const anchor = resolve(value.anchor), head = resolve(value.head);
        return anchor?.type === text && head?.type === text ? { anchor: anchor.index, head: head.index } : null;
    } catch { return null; }
}

/** 编辑器和项目唯一 WS 之间的临时桥；不存储、不创建第二条连接、不经过 React state。 */
export class CanvasTextPresence {
    private editor?: object;
    private local: CanvasTextSelection | null = null;
    private peers: TextPresencePeer[] = [];
    private localListeners = new Set<() => void>();
    private remoteListeners = new Set<() => void>();
    getLocal = () => this.local;
    getPeers = () => this.peers;
    onLocal = (listener: () => void) => { this.localListeners.add(listener); return () => { this.localListeners.delete(listener); }; };
    onRemote = (listener: () => void) => { this.remoteListeners.add(listener); return () => { this.remoteListeners.delete(listener); }; };
    publish(editor: object, selection: CanvasTextSelection | null) {
        // 切换编辑器后旧编辑器的迟到 blur/destroy 不能清掉新编辑器的位置。
        if (!selection && editor !== this.editor) return;
        this.editor = selection ? editor : undefined;
        if (JSON.stringify(selection) === JSON.stringify(this.local)) return;
        this.local = selection;
        this.localListeners.forEach((listener) => listener());
    }
    receive(peers: TextPresencePeer[]) {
        const next = peers.filter((peer) => peer.textSelection).map(({ connectionId, label, color, textSelection }) => ({ connectionId, label, color, textSelection }));
        if (JSON.stringify(next) === JSON.stringify(this.peers)) return;
        this.peers = next;
        this.remoteListeners.forEach((listener) => listener());
    }
}
const projects = new Map<string, CanvasTextPresence>();
export function getCanvasTextPresence(projectId: string) {
    let value = projects.get(projectId);
    if (!value) { value = new CanvasTextPresence(); projects.set(projectId, value); }
    return value;
}
