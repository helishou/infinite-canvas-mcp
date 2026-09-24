import { StateEffect } from "@codemirror/state";
import { Decoration, ViewPlugin, WidgetType, type DecorationSet, type EditorView } from "@codemirror/view";
import type { CollaborativeTextSession, CanvasTextTarget } from "@/lib/canvas/collaborative-text-session";
import { encodeCanvasTextSelection, getCanvasTextPresence, resolveCanvasTextSelection } from "@/lib/canvas/canvas-text-presence";

class PeerCaret extends WidgetType {
    constructor(readonly label: string, readonly color: string) { super(); }
    eq(other: PeerCaret) { return this.label === other.label && this.color === other.color; }
    toDOM() {
        const caret = document.createElement("span");
        caret.className = "cm-canvas-peer-caret";
        caret.style.borderColor = this.color;
        caret.setAttribute("aria-label", `${this.label} 的光标`);
        const label = document.createElement("span");
        label.className = "cm-canvas-peer-label";
        label.style.borderColor = this.color;
        label.textContent = this.label;
        caret.append(label);
        return caret;
    }
    ignoreEvent() { return true; }
}
const remoteChanged = StateEffect.define<void>();

export function canvasTextPresenceExtension(projectId: string, target: CanvasTextTarget, session: CollaborativeTextSession) {
    const presence = getCanvasTextPresence(projectId);
    return ViewPlugin.fromClass(class {
        decorations: DecorationSet = Decoration.none;
        private token = {};
        private queued = false;
        private destroyed = false;
        private unsubscribe: () => void;
        constructor(private view: EditorView) {
            this.unsubscribe = presence.onRemote(() => view.dispatch({ effects: remoteChanged.of() }));
            document.addEventListener("visibilitychange", this.schedule);
            this.draw(); this.schedule();
        }
        private schedule = () => {
            if (this.queued) return;
            this.queued = true;
            // 等 yCollab 将本次 CM 事务写入 Y.Text 后再编码位置，不能先读旧文档索引。
            queueMicrotask(() => {
                this.queued = false;
                if (this.destroyed) return;
                const { anchor, head } = this.view.state.selection.main;
                const active = this.view.hasFocus && document.visibilityState !== "hidden" && !session.getSnapshot().blocked;
                presence.publish(this.token, active ? encodeCanvasTextSelection(session.text, target, session.getDocumentId(), anchor, head) : null);
            });
        };
        private draw() {
            const ranges = [];
            if (!session.getSnapshot().blocked) for (const peer of presence.getPeers()) {
                const selection = resolveCanvasTextSelection(session.text, target, session.getDocumentId(), peer.textSelection);
                if (!selection) continue;
                const from = Math.min(selection.anchor, selection.head), to = Math.max(selection.anchor, selection.head);
                if (to > this.view.state.doc.length) continue;
                if (from < to) ranges.push(Decoration.mark({ class: "cm-canvas-peer-selection", attributes: { style: `background-color:${peer.color}33` } }).range(from, to));
                ranges.push(Decoration.widget({ widget: new PeerCaret(peer.label, peer.color), side: 1 }).range(selection.head));
            }
            this.decorations = Decoration.set(ranges, true);
        }
        update() { this.draw(); this.schedule(); }
        destroy() {
            this.destroyed = true;
            this.unsubscribe(); document.removeEventListener("visibilitychange", this.schedule);
            presence.publish(this.token, null);
        }
    }, { decorations: (plugin) => plugin.decorations });
}
