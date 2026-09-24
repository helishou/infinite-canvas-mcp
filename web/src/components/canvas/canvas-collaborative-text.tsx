import { useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Image } from "antd";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { Decoration, EditorView, keymap, placeholder as placeholderExtension, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import { autocompletion, completionKeymap, startCompletion } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { canvasThemes } from "@/lib/canvas-theme";
import { canvasTextKey } from "@/lib/canvas/collaborative-text-session";
import { getCanvasTextSession } from "@/services/api/canvas-text";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasSpeakerOption, CanvasTextEditorProps, CanvasTextReference } from "@/types/canvas-plugin";
import { canvasTextPresenceExtension } from "./canvas-text-presence-extension";

const DIALOGUE_PATTERN = /<d>(?:\[[^\]]+\])?[\s\S]*?<\/d>/g;
const SPEAKER_PATTERN = /\((S\d+)\)/gi;
const SPEAKER_OPTIONS = ["S1", "S2", "S3", "S4", "S5", "S6"];
const PROMPT_LINE_ACCENTS = ["#38bdf8", "#34d399", "#c084fc", "#fbbf24", "#fb7185", "#2dd4bf", "#a3e635", "#818cf8"];

function detectDialogueLanguage(text: string) {
    return /[\u4e00-\u9fff]/.test(text) ? "Chinese" : "English";
}

function wrapSelectionAsDialogue(view: EditorView) {
    const { from, to } = view.state.selection.main;
    const text = view.state.doc.sliceString(from, to).trim();
    if (!text) return;
    const insert = `<d>[${detectDialogueLanguage(text)}] ${text}</d>`;
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: "input" });
    view.focus();
}

function enclosingDialogueRange(doc: string, from: number, to: number) {
    DIALOGUE_PATTERN.lastIndex = 0;
    for (const match of doc.matchAll(DIALOGUE_PATTERN)) {
        const start = match.index!, end = start + match[0].length;
        const speaker = speakerBeforeDialogue(doc, start);
        const insideDialogue = from >= start && to <= end;
        const insideSpeaker = speaker && from >= speaker.from && to <= speaker.to;
        if (insideDialogue || insideSpeaker) {
            return {
                from: start, to: end,
                inner: match[0].slice(3, -4).replace(/^\[[^\]]+\]\s*/, ""),
                speaker,
            };
        }
    }
    return null;
}

/** 同一行（或上一段台词之后）离 <d> 最近的说话人编号属于这句台词。 */
function speakerBeforeDialogue(doc: string, dialogueStart: number) {
    const lineStart = doc.lastIndexOf("\n", dialogueStart - 1) + 1;
    const previousDialogueEnd = doc.lastIndexOf("</d>", dialogueStart - 1);
    const searchStart = Math.max(lineStart, previousDialogueEnd < 0 ? 0 : previousDialogueEnd + 4);
    const prefix = doc.slice(searchStart, dialogueStart);
    SPEAKER_PATTERN.lastIndex = 0;
    let found: RegExpExecArray | null = null;
    for (const match of prefix.matchAll(SPEAKER_PATTERN)) found = match;
    if (!found) return null;
    const from = searchStart + found.index!;
    return { from, to: from + found[0].length, id: found[1].toUpperCase() };
}

function unwrapDialogue(view: EditorView, range: { from: number; to: number; inner: string }) {
    view.dispatch({ changes: { from: range.from, to: range.to, insert: range.inner }, selection: { anchor: range.from + range.inner.length }, userEvent: "input" });
    view.focus();
}

function promptLineMapExtension(panelColor: string) {
    return ViewPlugin.fromClass(class {
        decorations: DecorationSet = Decoration.none;
        private readonly rail: HTMLDivElement;
        private readonly thumb: HTMLDivElement;
        private readonly resizeObserver: ResizeObserver | null;
        private layoutFrame = 0;
        private drag: { pointerId: number; mode: "thumb" | "jump"; startY: number; startScrollTop: number; maxScroll: number; travel: number; thumbHeight: number } | null = null;

        constructor(private readonly view: EditorView) {
            this.rail = document.createElement("div");
            this.rail.className = "cm-canvas-line-marker-rail";
            this.rail.setAttribute("aria-hidden", "true");
            this.thumb = document.createElement("div");
            this.thumb.className = "cm-canvas-line-scroll-thumb";
            this.thumb.setAttribute("aria-hidden", "true");
            this.rail.append(this.thumb);
            this.rail.addEventListener("pointerdown", this.handlePointerDown);
            this.rail.addEventListener("pointermove", this.handlePointerMove);
            this.rail.addEventListener("pointerup", this.handlePointerEnd);
            this.rail.addEventListener("pointercancel", this.handlePointerEnd);
            this.view.dom.classList.add("cm-canvas-line-map");
            this.view.dom.append(this.rail);
            this.resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(this.scheduleLayout);
            this.resizeObserver?.observe(view.dom);
            this.resizeObserver?.observe(view.scrollDOM);
            this.resizeObserver?.observe(view.contentDOM);
            this.view.scrollDOM.addEventListener("scroll", this.scheduleLayout, { passive: true });
            this.updateDecorations();
            this.scheduleLayout();
        }

        update(update: import("@codemirror/view").ViewUpdate) {
            if (update.docChanged) this.updateDecorations();
            if (update.docChanged || update.geometryChanged || update.viewportChanged) this.scheduleLayout();
        }

        docViewUpdate() { this.scheduleLayout(); }

        private updateDecorations() {
            const ranges = [];
            for (let number = 1; number <= this.view.state.doc.lines; number += 1) {
                const line = this.view.state.doc.line(number);
                if (!line.text.trim()) continue;
                const accent = PROMPT_LINE_ACCENTS[(number - 1) % PROMPT_LINE_ACCENTS.length];
                ranges.push(Decoration.line({
                    attributes: {
                        class: "cm-canvas-prompt-line",
                        style: `background-color:color-mix(in srgb,${panelColor} 87%,${accent} 13%)`,
                    },
                }).range(line.from));
            }
            this.decorations = Decoration.set(ranges, true);
        }

        private scheduleLayout = () => {
            if (this.layoutFrame) cancelAnimationFrame(this.layoutFrame);
            this.layoutFrame = requestAnimationFrame(() => {
                this.layoutFrame = 0;
                this.syncThumb();
            });
        };

        private get maxScroll() {
            return Math.max(0, this.view.scrollDOM.scrollHeight - this.view.scrollDOM.clientHeight);
        }

        /** 轨道按下：按在滑块上按比例拖动，按在轨道空白处则让滑块中心对齐指针并可接着拖动。 */
        private handlePointerDown = (event: PointerEvent) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            const thumbHeight = this.thumb.offsetHeight;
            const travel = Math.max(0, this.rail.clientHeight - thumbHeight);
            this.drag = {
                pointerId: event.pointerId,
                mode: event.target === this.thumb ? "thumb" : "jump",
                startY: event.clientY,
                startScrollTop: this.view.scrollDOM.scrollTop,
                maxScroll: this.maxScroll,
                travel,
                thumbHeight,
            };
            if (this.drag.mode === "jump") this.alignThumbToPointer(event.clientY);
            this.rail.setPointerCapture(event.pointerId);
        };

        private handlePointerMove = (event: PointerEvent) => {
            const drag = this.drag;
            if (!drag || drag.pointerId !== event.pointerId || !drag.travel) return;
            event.preventDefault();
            if (drag.mode === "thumb") {
                const delta = (event.clientY - drag.startY) / this.view.scaleY;
                this.view.scrollDOM.scrollTop = Math.max(0, Math.min(drag.maxScroll, drag.startScrollTop + delta / drag.travel * drag.maxScroll));
                return;
            }
            this.alignThumbToPointer(event.clientY);
        };

        private handlePointerEnd = (event: PointerEvent) => {
            if (!this.drag || this.drag.pointerId !== event.pointerId) return;
            if (this.rail.hasPointerCapture(event.pointerId)) this.rail.releasePointerCapture(event.pointerId);
            this.drag = null;
        };

        /** 让滑块中心对齐指针在轨道上的位置，点到哪就滚到哪。 */
        private alignThumbToPointer(clientY: number) {
            const drag = this.drag;
            if (!drag || !drag.travel) return;
            const y = (clientY - this.rail.getBoundingClientRect().top) / this.view.scaleY;
            this.view.scrollDOM.scrollTop = Math.max(0, Math.min(drag.travel, y - drag.thumbHeight / 2)) / drag.travel * drag.maxScroll;
        }

        private syncThumb() {
            const editorRect = this.view.dom.getBoundingClientRect();
            const scrollerRect = this.view.scrollDOM.getBoundingClientRect();
            const height = this.view.scrollDOM.clientHeight;
            this.rail.style.top = `${(scrollerRect.top - editorRect.top) / this.view.scaleY}px`;
            this.rail.style.height = `${height}px`;
            this.rail.style.bottom = "auto";
            const scrollHeight = Math.max(height, this.view.scrollDOM.scrollHeight);
            const maxScroll = Math.max(0, scrollHeight - height);
            const thumbHeight = Math.min(height, Math.max(32, height * height / scrollHeight));
            const thumbTravel = Math.max(0, height - thumbHeight);
            this.thumb.style.height = `${thumbHeight}px`;
            this.thumb.style.top = `${maxScroll ? this.view.scrollDOM.scrollTop / maxScroll * thumbTravel : 0}px`;
        }

        destroy() {
            this.resizeObserver?.disconnect();
            this.view.scrollDOM.removeEventListener("scroll", this.scheduleLayout);
            this.rail.removeEventListener("pointerdown", this.handlePointerDown);
            this.rail.removeEventListener("pointermove", this.handlePointerMove);
            this.rail.removeEventListener("pointerup", this.handlePointerEnd);
            this.rail.removeEventListener("pointercancel", this.handlePointerEnd);
            if (this.layoutFrame) cancelAnimationFrame(this.layoutFrame);
            this.rail.remove();
            this.view.dom.classList.remove("cm-canvas-line-map");
        }
    }, { decorations: (plugin) => plugin.decorations });
}

type DialogueMenuOption = { label: string; previewUrl?: string; selected?: boolean; apply: () => void };
type DialogueMenuState = { x: number; y: number; options: DialogueMenuOption[] };
type SpeakerRosterRef = { current: import("@/types/canvas-plugin").CanvasSpeakerOption[] };

/** 说话人菜单选项：名册优先（显示「Sx · 角色名」+ 头像），无名册时回退 S1–S6。 */
function speakerMenuOptions(
    view: EditorView,
    speakers: CanvasSpeakerOption[],
    insertAt: number,
    replaceRange: { from: number; to: number } | null,
    currentId: string | null,
): DialogueMenuOption[] {
    const selectedId = currentId?.toUpperCase() ?? null;
    const candidates: CanvasSpeakerOption[] = speakers.length ? speakers : SPEAKER_OPTIONS.map((id) => ({ id }));
    const roster = selectedId && !candidates.some((speaker) => speaker.id.toUpperCase() === selectedId)
        ? [...candidates, { id: selectedId }]
        : candidates;
    return roster.map((speaker) => ({
        label: speaker.name ? `${speaker.id} · ${speaker.name}` : speaker.id,
        previewUrl: speaker.previewUrl,
        selected: speaker.id.toUpperCase() === selectedId,
        apply: () => {
            const insert = `(${speaker.id}) `;
            if (replaceRange) view.dispatch({ changes: { from: replaceRange.from, to: replaceRange.to, insert }, userEvent: "input" });
            else view.dispatch({ changes: { from: insertAt, to: insertAt, insert }, userEvent: "input" });
            view.focus();
        },
    }));
}

class SpeakerBadge extends WidgetType {
    constructor(readonly id: string, readonly from: number, readonly to: number, readonly open: (x: number, y: number, from: number, to: number) => void) { super(); }
    eq(other: SpeakerBadge) { return other.id === this.id && other.from === this.from && other.to === this.to; }
    toDOM() {
        const span = document.createElement("span");
        span.className = "cm-canvas-speaker";
        span.textContent = this.id;
        span.title = "点击切换说话人";
        span.addEventListener("click", (event) => {
            event.preventDefault(); event.stopPropagation();
            const rect = span.getBoundingClientRect();
            this.open(rect.left, rect.bottom + 4, this.from, this.to);
        });
        return span;
    }
}

/** 无说话人台词前的占位徽标：不占文档文本，点击即可绑定说话人。 */
class SpeakerGhost extends WidgetType {
    constructor(readonly at: number, readonly open: (x: number, y: number) => void) { super(); }
    eq(other: SpeakerGhost) { return other.at === this.at; }
    toDOM() {
        const span = document.createElement("span");
        span.className = "cm-canvas-speaker cm-canvas-speaker-ghost";
        span.textContent = "说话人";
        span.title = "点击绑定说话人";
        span.addEventListener("click", (event) => {
            event.preventDefault(); event.stopPropagation();
            const rect = span.getBoundingClientRect();
            this.open(rect.left, rect.bottom + 4);
        });
        return span;
    }
}

function dialogueHighlightExtension(openMenu: (menu: DialogueMenuState) => void, speakersRef: SpeakerRosterRef) {
    const build = (view: EditorView) => {
        const ranges = [];
        const atomic = [];
        const doc = view.state.doc.toString();
        DIALOGUE_PATTERN.lastIndex = 0;
        for (const match of doc.matchAll(DIALOGUE_PATTERN)) {
            const start = match.index!, end = start + match[0].length;
            const speaker = speakerBeforeDialogue(doc, start);
            if (speaker) {
                const { from: badgeStart, to: badgeEnd, id } = speaker;
                const open = (x: number, y: number, bFrom: number, bTo: number) => openMenu({
                    x, y,
                    options: [
                        ...speakerMenuOptions(view, speakersRef.current, start, { from: bFrom, to: bTo }, id),
                        { label: "清除说话人", apply: () => { view.dispatch({ changes: { from: bFrom, to: bTo, insert: "" }, userEvent: "delete.forward" }); view.focus(); } },
                    ],
                });
                ranges.push(Decoration.replace({ widget: new SpeakerBadge(id, badgeStart, badgeEnd, open) }).range(badgeStart, badgeEnd));
                atomic.push(Decoration.replace({ widget: new SpeakerBadge(id, badgeStart, badgeEnd, open) }).range(badgeStart, badgeEnd));
            } else {
                const ghost = new SpeakerGhost(start, (x: number, y: number) => openMenu({
                    x, y,
                    options: speakerMenuOptions(view, speakersRef.current, start, null, null),
                }));
                // 零长度插入用 widget 装饰（replace 零长度会导致装饰构建失败、整段高亮消失）。
                ranges.push(Decoration.widget({ widget: ghost, side: -1 }).range(start));
            }
            ranges.push(Decoration.mark({ class: "cm-canvas-dialogue" }).range(start, end));
        }
        return { decorations: Decoration.set(ranges, true), atomic: Decoration.set(atomic, true) };
    };
    return ViewPlugin.fromClass(class {
        decorations: DecorationSet = Decoration.none;
        atomic: DecorationSet = Decoration.none;
        constructor(view: EditorView) { const built = build(view); this.decorations = built.decorations; this.atomic = built.atomic; }
        update(update: import("@codemirror/view").ViewUpdate) {
            if (update.docChanged) { const built = build(update.view); this.decorations = built.decorations; this.atomic = built.atomic; }
        }
    }, {
        decorations: (plugin) => plugin.decorations,
        provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic || Decoration.none),
    });
}

function dialogueContextMenuExtension(openMenu: (menu: DialogueMenuState) => void, speakersRef: SpeakerRosterRef) {
    return EditorView.domEventHandlers({
        contextmenu: (event, view) => {
            const selection = view.state.selection.main;
            const probeFrom = selection.empty ? selection.head : selection.from;
            const probeTo = selection.empty ? selection.head : selection.to;
            const inside = enclosingDialogueRange(view.state.doc.toString(), probeFrom, probeTo);
            if (!inside) {
                if (selection.empty) return false;
                event.preventDefault();
                // CodeMirror 的 domEventHandlers 返回 true 只 preventDefault，不会阻断冒泡；
                // 不 stopPropagation 会一路冒到节点 onContextMenu，弹出节点级 复制/删除 菜单。
                event.stopPropagation();
                openMenu({ x: event.clientX, y: event.clientY, options: [{ label: "转为台词", apply: () => wrapSelectionAsDialogue(view) }] });
                return true;
            }
            event.preventDefault();
            event.stopPropagation();
            const speaker = inside.speaker;
            openMenu({
                x: event.clientX, y: event.clientY,
                options: [
                    ...speakerMenuOptions(view, speakersRef.current, inside.from, speaker, speaker?.id ?? null),
                    ...(speaker ? [{ label: "清除说话人", apply: () => { view.dispatch({ changes: { from: speaker.from, to: speaker.to, insert: "" }, userEvent: "delete.forward" }); view.focus(); } }] : []),
                    { label: "取消台词", apply: () => unwrapDialogue(view, inside) },
                ],
            });
            return true;
        },
    });
}

function DialogueContextMenu({ menu, onClose, theme }: { menu: DialogueMenuState; onClose: () => void; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    // 画布节点容器带 transform（平移/缩放），祖先有 transform 时 position:fixed 会退化成相对该祖先定位，
    // 菜单会飞到左上角。portal 到 body 后 fixed 坐标恢复按视口解释。
    return createPortal(<>
        <div style={{ position: "fixed", inset: 0, zIndex: 1099 }} onMouseDown={onClose} onContextMenu={(event) => { event.preventDefault(); onClose(); }} />
        <div style={{ position: "fixed", left: menu.x, top: menu.y, zIndex: 1100, minWidth: 128, maxWidth: 260, padding: 4, borderRadius: 8, border: `1px solid ${theme.toolbar.border}`, background: theme.toolbar.panel, boxShadow: "0 4px 16px rgba(0,0,0,.18)" }}>
            {menu.options.map((option) => (
                <button key={option.label} type="button" onClick={() => { option.apply(); onClose(); }}
                    aria-pressed={option.selected || undefined}
                    style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "6px 10px", border: "none", borderRadius: 6, background: option.selected ? theme.toolbar.activeBg : "transparent", color: option.selected ? theme.toolbar.activeText : theme.node.text, font: "inherit", fontSize: 13, textAlign: "left", cursor: "pointer", whiteSpace: "nowrap" }}
                    onMouseEnter={(event) => { event.currentTarget.style.background = theme.toolbar.activeBg; }}
                    onMouseLeave={(event) => { event.currentTarget.style.background = option.selected ? theme.toolbar.activeBg : "transparent"; }}
                >
                    {option.previewUrl ? <img src={option.previewUrl} alt="" draggable={false} style={{ width: 22, height: 22, borderRadius: "50%", objectFit: "cover", flex: "0 0 auto" }} /> : null}
                    <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{option.label}</span>
                    {option.selected ? <span style={{ flex: "0 0 auto", fontSize: 11, color: theme.toolbar.activeText }}>✓ 当前</span> : null}
                </button>
            ))}
        </div>
    </>, document.body);
}

class ReferenceChip extends WidgetType {
    constructor(readonly reference: CanvasTextReference, readonly preview: (url: string) => void) { super(); }
    eq(other: ReferenceChip) { return this.reference === other.reference; }
    toDOM() {
        const span = document.createElement("span");
        if (this.reference.displayLabel === "") {
            span.style.display = "none";
            span.setAttribute("aria-hidden", "true");
            return span;
        }
        span.className = `cm-canvas-reference${this.reference.kind === "character" ? " cm-canvas-reference-character" : ""}`;
        span.title = this.reference.title || this.reference.label;
        if (this.reference.previewUrl && (this.reference.kind === "image" || this.reference.kind === "character")) {
            const img = document.createElement("img");
            img.src = this.reference.previewUrl;
            img.alt = ""; img.draggable = false;
            img.style.flex = "0 0 auto";
            span.append(img);
            span.addEventListener("click", (event) => { event.preventDefault(); this.preview(this.reference.previewUrl!); });
        }
        if (this.reference.kind === "audio") {
            const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            icon.setAttribute("viewBox", "0 0 24 24");
            icon.setAttribute("fill", "none");
            icon.setAttribute("stroke", "currentColor");
            icon.setAttribute("stroke-width", "2");
            icon.setAttribute("stroke-linecap", "round");
            icon.setAttribute("stroke-linejoin", "round");
            icon.setAttribute("aria-hidden", "true");
            icon.classList.add("cm-canvas-reference-audio-icon");
            icon.innerHTML = '<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>';
            span.append(icon);
        }
        const label = document.createElement("span");
        label.className = "cm-canvas-reference-label";
        label.textContent = this.reference.displayLabel || this.reference.label;
        span.append(label);
        return span;
    }
}

class UnresolvedReferenceChip extends WidgetType {
    constructor(readonly token: string, readonly position: number, readonly rebind: () => void) { super(); }
    eq(other: UnresolvedReferenceChip) { return this.token === other.token && this.position === other.position; }
    toDOM() {
        const span = document.createElement("span");
        const match = /^<(Subject|Picture|Video|Audio)\s+(\d+)>$/iu.exec(this.token);
        const kind = match?.[1].toLowerCase() === "subject" ? "人物" : match ? "图片/视频/音频" : "引用";
        const id = match ? `${match[1]} ${match[2]}` : this.token;
        span.className = "cm-canvas-reference cm-canvas-reference-error";
        span.title = `未找到对应的${kind}引用（${id}），点击后从当前 Clip 引用中重新选择，或删除此标记`;
        span.setAttribute("aria-label", span.title);
        span.setAttribute("role", "button");
        span.tabIndex = 0;
        span.style.cursor = "pointer";
        span.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); this.rebind(); });
        span.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault(); event.stopPropagation(); this.rebind();
        });
        const label = document.createElement("span");
        label.className = "cm-canvas-reference-label";
        label.textContent = `${kind}未找到 · ${id} · 点击修复`;
        span.append(label);
        return span;
    }
}

function removeAdjacentReference(view: EditorView, tokens: string[], direction: "backward" | "forward") {
    const selection = view.state.selection.main;
    const text = view.state.doc.toString();
    const ranges: Array<{ from: number; to: number }> = [];
    for (const token of tokens) {
        if (/^<(?:Subject|Picture|Video|Audio)\s+\d+>$/iu.test(token)) {
            const matcher = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
            for (const match of text.matchAll(matcher)) {
                const from = match.index!;
                const to = from + match[0].length;
                const overlapsSelection = !selection.empty && from < selection.to && to > selection.from;
                const touchesCursor = selection.empty && (from < selection.head && to > selection.head || direction === "backward" && to === selection.head || direction === "forward" && from === selection.head);
                if (overlapsSelection || touchesCursor) ranges.push({ from, to });
            }
            continue;
        }
        let from = text.indexOf(token);
        while (from >= 0) {
            const to = from + token.length;
            const overlapsSelection = !selection.empty && from < selection.to && to > selection.from;
            const touchesCursor = selection.empty && (from < selection.head && to > selection.head || direction === "backward" && to === selection.head || direction === "forward" && from === selection.head);
            if (overlapsSelection || touchesCursor) ranges.push({ from, to });
            from = text.indexOf(token, to);
        }
    }
    if (!ranges.length) return false;
    const from = Math.min(...ranges.map((range) => range.from), selection.from);
    const to = Math.max(...ranges.map((range) => range.to), selection.to);
    view.dispatch({ changes: { from, to }, selection: { anchor: from }, userEvent: direction === "backward" ? "delete.backward" : "delete.forward" });
    return true;
}

function mentionExtensions(references: CanvasTextReference[], chips: boolean, preview: (url: string) => void) {
    const active = references.filter((reference) => reference.active !== false && reference.label);
    const suggestible = active.filter((reference) => reference.suggestible !== false);
    const byToken = new Map<string, CanvasTextReference>();
    active.forEach((reference) => (reference.tokens?.length ? reference.tokens : [reference.label]).forEach((token) => { if (token) byToken.set(token.toLocaleLowerCase(), reference); }));
    const tokens = [...byToken.keys()].sort((a, b) => b.length - a.length);
    const pattern = tokens.length ? new RegExp(tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "giu") : null;
    const unresolvedTokens = (text: string) => {
        const referenceTag = /<(?:Subject|Picture|Video|Audio)\s+\d+>/giu;
        return [...new Set([...text.matchAll(referenceTag)].map((match) => match[0]).filter((token) => !byToken.has(token.toLocaleLowerCase())))];
    };
    const decorations = (view: EditorView) => {
        if (!chips || view.composing) return Decoration.none;
        const ranges = [];
        for (const { from, to } of view.visibleRanges) {
            const visibleText = view.state.doc.sliceString(from, to);
            if (pattern) {
                pattern.lastIndex = 0;
                for (const match of visibleText.matchAll(pattern)) {
                    const reference = byToken.get(match[0].toLocaleLowerCase());
                    if (reference) ranges.push(Decoration.replace({ widget: new ReferenceChip(reference, preview) }).range(from + match.index!, from + match.index! + match[0].length));
                }
            }
            for (const token of unresolvedTokens(visibleText)) {
                const tokenPattern = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
                for (const match of visibleText.matchAll(tokenPattern)) {
                    const tokenFrom = from + match.index!;
                    ranges.push(Decoration.replace({ widget: new UnresolvedReferenceChip(token, tokenFrom, () => {
                        if (!view.dom.isConnected) return;
                        view.dispatch({ selection: { anchor: tokenFrom + token.length } });
                        view.focus();
                        startCompletion(view);
                    }) }).range(tokenFrom, tokenFrom + match[0].length));
                }
            }
        }
        return Decoration.set(ranges, true);
    };
    return [
        autocompletion({ defaultKeymap: false, override: [(context) => {
            const unresolved = context.matchBefore(/<(Subject|Picture|Video|Audio)\s+\d+>?/iu);
            if (unresolved && !byToken.has(unresolved.text.toLocaleLowerCase())) {
                const expectedKind = unresolved.text.match(/^<(Subject|Picture|Video|Audio)/iu)?.[1].toLowerCase();
                const tagFor = (item: CanvasTextReference) => item.tokens?.find((token) => token.match(/^<(Subject|Picture|Video|Audio)/iu)?.[1].toLowerCase() === expectedKind);
                const candidates = suggestible.filter((item) => tagFor(item));
                return { from: unresolved.from, to: unresolved.to, filter: false, options: candidates.map((item) => ({
                    label: item.label, detail: item.title, apply: tagFor(item) || item.insert || item.label,
                })) };
            }
            const match = context.matchBefore(/@[^\s@]*/u);
            if (!match || context.view?.composing) return null;
            const query = match.text.slice(1).toLowerCase();
            return { from: match.from, filter: false, options: suggestible.filter((item) => [item.label, item.title, item.kind].join(" ").toLowerCase().includes(query)).map((item) => ({
                label: item.label, detail: item.title, apply: item.insert || item.label,
            })) };
        }] }),
        Prec.highest(keymap.of([
            ...completionKeymap,
            { key: "Backspace", run: (view) => chips && removeAdjacentReference(view, [...tokens, ...unresolvedTokens(view.state.doc.toString())], "backward") },
            { key: "Delete", run: (view) => chips && removeAdjacentReference(view, [...tokens, ...unresolvedTokens(view.state.doc.toString())], "forward") },
        ])),
        ViewPlugin.fromClass(class {
            decorations: DecorationSet;
            constructor(view: EditorView) { this.decorations = decorations(view); }
            update(update: import("@codemirror/view").ViewUpdate) { this.decorations = decorations(update.view); }
        }, { decorations: (plugin) => plugin.decorations, provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations || Decoration.none) }),
    ];
}

export function CanvasCollaborativeText(props: CanvasTextEditorProps) {
    return props.standalone ? <CanvasStandaloneText {...props} /> : <CanvasYjsText {...props} />;
}

function CanvasStandaloneText(props: CanvasTextEditorProps) {
    const { placeholder = "请输入文本", references = [], chips = false, dialogue = false, lineMap = false, editorRef, className, style, autoFocus = false, autoHeight = false } = props;
    const parent = useRef<HTMLDivElement>(null);
    const editor = useRef<EditorView | null>(null);
    const applyingValue = useRef(false);
    const callbacks = useRef(props);
    callbacks.current = props;
    const speakersRef = useRef<CanvasSpeakerOption[]>(props.speakers || []);
    speakersRef.current = props.speakers || [];
    const [imagePreview, setImagePreview] = useState<string | null>(null);
    const [dialogueMenu, setDialogueMenu] = useState<DialogueMenuState | null>(null);
    const appearance = useMemo(() => new Compartment(), []);
    const mentions = useMemo(() => new Compartment(), []);
    const lineMapCompartment = useMemo(() => new Compartment(), []);
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const lineMapExtension = useMemo(() => lineMap ? promptLineMapExtension(theme.node.fill) : [], [lineMap, theme.node.fill]);
    const themeExtension = useMemo(() => EditorView.theme({
        "&": { height: autoHeight ? "auto" : "100%", color: theme.node.text, backgroundColor: "transparent", fontSize: "inherit" },
        "&.cm-focused": { outline: "none" },
        ".cm-scroller": { fontFamily: "inherit", overflow: autoHeight ? "visible" : "auto" },
        ".cm-content": { minHeight: "80px", ...(autoHeight ? { height: "auto" } : {}), caretColor: theme.node.text },
        ".cm-placeholder": { color: theme.node.placeholder },
        ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: theme.canvas.selectionFill },
        ".cm-tooltip": { color: theme.node.text, backgroundColor: theme.toolbar.panel, borderColor: theme.toolbar.border },
        ".cm-tooltip-autocomplete ul li[aria-selected]": { color: theme.toolbar.activeText, backgroundColor: theme.toolbar.activeBg },
        ".cm-canvas-reference": { display: "inline-flex", alignItems: "center", verticalAlign: "middle", gap: "4px", maxWidth: "220px", overflow: "hidden", whiteSpace: "nowrap", borderRadius: "6px", padding: "0 4px", backgroundColor: theme.toolbar.activeBg },
        ".cm-canvas-reference-character": { border: `1px solid ${theme.node.stroke}` },
        ".cm-canvas-reference-error": { border: `1px solid ${colorTheme === "dark" ? "#f87171" : "#dc2626"}`, color: colorTheme === "dark" ? "#fca5a5" : "#b91c1c", backgroundColor: colorTheme === "dark" ? "rgba(248,113,113,.12)" : "rgba(220,38,38,.08)" },
        ".cm-canvas-reference img": { width: "24px", height: "24px", objectFit: "cover", borderRadius: "4px", cursor: "pointer" },
        ".cm-canvas-reference-audio-icon": { width: "16px", height: "16px", flex: "0 0 auto" },
        ".cm-canvas-reference-label": { minWidth: "0", overflow: "hidden", textOverflow: "ellipsis" },
        ".cm-canvas-dialogue": { backgroundColor: colorTheme === "dark" ? "rgba(168,85,247,.18)" : "rgba(147,51,234,.10)", borderRadius: "3px", boxDecorationBreak: "clone", textDecoration: "underline", textDecorationColor: colorTheme === "dark" ? "#a855f7" : "#9333ea", textDecorationThickness: "2px", textUnderlineOffset: "3px" },
        ".cm-canvas-speaker": { display: "inline-flex", alignItems: "center", padding: "0 6px", margin: "0 2px", borderRadius: "6px", backgroundColor: colorTheme === "dark" ? "rgba(168,85,247,.25)" : "rgba(147,51,234,.14)", color: colorTheme === "dark" ? "#d8b4fe" : "#7e22ce", fontWeight: "600", fontSize: "0.92em", cursor: "pointer", userSelect: "none" },
        ".cm-canvas-speaker-ghost": { backgroundColor: "transparent", border: `1px dashed ${colorTheme === "dark" ? "rgba(168,85,247,.5)" : "rgba(147,51,234,.45)"}`, color: colorTheme === "dark" ? "rgba(216,180,254,.75)" : "rgba(126,34,206,.65)", fontWeight: "500", fontSize: "0.82em" },
    }, { dark: colorTheme === "dark" }), [theme, colorTheme, autoHeight]);

    useImperativeHandle(editorRef, () => ({
        focus: () => editor.current?.focus(),
        insert: (text, options = {}) => {
            const view = editor.current;
            if (!view) return;
            const { from, to } = view.state.selection.main;
            const prefix = options.prefixNewline && from > 0 && view.state.doc.sliceString(from - 1, from) !== "\n" ? "\n" : "";
            const insert = prefix + text;
            view.dispatch({ changes: { from, to, insert }, selection: { anchor: options.select ? from : from + insert.length, head: from + insert.length }, userEvent: "input" });
            view.focus();
        },
        replace: (text) => {
            const view = editor.current;
            if (!view) return;
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: "input" });
            view.focus();
        },
    }), []);

    useEffect(() => {
        if (!parent.current) return;
        const view = new EditorView({
            parent: parent.current,
            state: EditorState.create({ doc: props.value || "", extensions: [
                EditorView.lineWrapping,
                placeholderExtension(placeholder),
                appearance.of(themeExtension),
                lineMapCompartment.of(lineMapExtension),
                history(),
                keymap.of([...defaultKeymap, ...historyKeymap]),
                mentions.of(mentionExtensions(references, chips, setImagePreview)),
                ...(dialogue ? [dialogueHighlightExtension(setDialogueMenu, speakersRef), dialogueContextMenuExtension(setDialogueMenu, speakersRef)] : []),
                EditorView.updateListener.of((update) => {
                    if (update.docChanged && !applyingValue.current) callbacks.current.onChange?.(update.state.doc.toString());
                }),
                EditorView.contentAttributes.of({ "aria-label": placeholder }),
                EditorView.domEventHandlers({ blur: () => { callbacks.current.onBlur?.(); } }),
            ] }),
        });
        editor.current = view;
        if (autoFocus) view.focus();
        return () => { editor.current = null; view.destroy(); };
    }, [placeholder, appearance, mentions]);
    useEffect(() => {
        const view = editor.current;
        const value = props.value || "";
        if (view && view.state.doc.toString() !== value) {
            applyingValue.current = true;
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
            applyingValue.current = false;
        }
    }, [props.value]);
    useEffect(() => { editor.current?.dispatch({ effects: appearance.reconfigure(themeExtension) }); }, [appearance, themeExtension]);
    useEffect(() => { editor.current?.dispatch({ effects: mentions.reconfigure(mentionExtensions(references, chips, setImagePreview)) }); }, [mentions, references, chips]);
    useEffect(() => { editor.current?.dispatch({ effects: lineMapCompartment.reconfigure(lineMapExtension) }); }, [lineMapCompartment, lineMapExtension]);

    return <div className={className} style={style} data-canvas-shortcuts-ignore onKeyDown={(event) => {
        // Ctrl/Cmd+C 且编辑器内未选中文字时放行事件冒泡：画布全局快捷键会回落为「复制节点」，
        // 否则焦点落在编辑器里按 Ctrl+C 毫无反应。其余按键照旧拦截，避免触发画布快捷键。
        const copyIntent = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "c" && !window.getSelection()?.toString();
        if (!copyIntent) event.stopPropagation();
    }} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
        <div ref={parent} style={{ height: autoHeight ? "auto" : "100%", minHeight: 80 }} />
        {dialogueMenu ? <DialogueContextMenu menu={dialogueMenu} onClose={() => setDialogueMenu(null)} theme={theme} /> : null}
        {imagePreview ? <Image style={{ display: "none" }} src={imagePreview} preview={{ visible: true, onVisibleChange: (visible) => { if (!visible) setImagePreview(null); } }} /> : null}
    </div>;
}

/** 不接受受控全文：Yjs binding 负责远端增量、输入法、光标与本地撤销。 */
function CanvasYjsText(props: CanvasTextEditorProps) {
    const { projectId, target, placeholder = "请输入文本", references = [], chips = false, dialogue = false, lineMap = false, editorRef, className, style, autoFocus = false } = props;
    const targetKey = canvasTextKey(target);
    const session = useMemo(() => getCanvasTextSession(projectId, target), [projectId, targetKey]);
    const status = useSyncExternalStore(session.subscribe, session.getSnapshot);
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const parent = useRef<HTMLDivElement>(null);
    const editor = useRef<EditorView | null>(null);
    const callbacks = useRef(props);
    callbacks.current = props;
    const speakersRef = useRef<CanvasSpeakerOption[]>(props.speakers || []);
    speakersRef.current = props.speakers || [];
    const [imagePreview, setImagePreview] = useState<string | null>(null);
    const [dialogueMenu, setDialogueMenu] = useState<DialogueMenuState | null>(null);
    const appearance = useMemo(() => new Compartment(), []);
    const editable = useMemo(() => new Compartment(), []);
    const mentions = useMemo(() => new Compartment(), []);
    const lineMapCompartment = useMemo(() => new Compartment(), []);
    const themeExtension = useMemo(() => EditorView.theme({
        "&": { height: "100%", color: theme.node.text, backgroundColor: "transparent", fontSize: "inherit" },
        "&.cm-focused": { outline: "none" },
        ".cm-scroller": { fontFamily: "inherit", overflow: "auto" },
        ".cm-content": { minHeight: "80px", caretColor: theme.node.text },
        ".cm-placeholder": { color: theme.node.placeholder },
        ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: theme.canvas.selectionFill },
        ".cm-tooltip": { color: theme.node.text, backgroundColor: theme.toolbar.panel, borderColor: theme.toolbar.border },
        ".cm-tooltip-autocomplete ul li[aria-selected]": { color: theme.toolbar.activeText, backgroundColor: theme.toolbar.activeBg },
        ".cm-canvas-reference": { display: "inline-flex", alignItems: "center", verticalAlign: "middle", gap: "4px", maxWidth: "220px", overflow: "hidden", whiteSpace: "nowrap", borderRadius: "6px", padding: "0 4px", backgroundColor: theme.toolbar.activeBg },
        ".cm-canvas-reference-character": { border: `1px solid ${theme.node.stroke}` },
        ".cm-canvas-reference-error": { border: `1px solid ${colorTheme === "dark" ? "#f87171" : "#dc2626"}`, color: colorTheme === "dark" ? "#fca5a5" : "#b91c1c", backgroundColor: colorTheme === "dark" ? "rgba(248,113,113,.12)" : "rgba(220,38,38,.08)" },
        ".cm-canvas-reference img": { width: "24px", height: "24px", objectFit: "cover", borderRadius: "4px", cursor: "pointer" },
        ".cm-canvas-reference-audio-icon": { width: "16px", height: "16px", flex: "0 0 auto" },
        ".cm-canvas-reference-label": { minWidth: "0", overflow: "hidden", textOverflow: "ellipsis" },
        ".cm-canvas-peer-caret": { position: "relative", display: "inline", borderLeft: "2px solid", marginLeft: "-1px", marginRight: "-1px", pointerEvents: "none" },
        ".cm-canvas-peer-label": { position: "absolute", bottom: "1em", left: "-1px", whiteSpace: "nowrap", fontSize: "10px", lineHeight: "14px", padding: "0 3px", border: "1px solid", borderRadius: "3px", backgroundColor: theme.toolbar.panel, color: theme.node.text, zIndex: "2" },
        ".cm-canvas-dialogue": { backgroundColor: colorTheme === "dark" ? "rgba(168,85,247,.18)" : "rgba(147,51,234,.10)", borderRadius: "3px", boxDecorationBreak: "clone", textDecoration: "underline", textDecorationColor: colorTheme === "dark" ? "#a855f7" : "#9333ea", textDecorationThickness: "2px", textUnderlineOffset: "3px" },
        ".cm-canvas-speaker": { display: "inline-flex", alignItems: "center", padding: "0 6px", margin: "0 2px", borderRadius: "6px", backgroundColor: colorTheme === "dark" ? "rgba(168,85,247,.25)" : "rgba(147,51,234,.14)", color: colorTheme === "dark" ? "#d8b4fe" : "#7e22ce", fontWeight: "600", fontSize: "0.92em", cursor: "pointer", userSelect: "none" },
        ".cm-canvas-speaker-ghost": { backgroundColor: "transparent", border: `1px dashed ${colorTheme === "dark" ? "rgba(168,85,247,.5)" : "rgba(147,51,234,.45)"}`, color: colorTheme === "dark" ? "rgba(216,180,254,.75)" : "rgba(126,34,206,.65)", fontWeight: "500", fontSize: "0.82em" },
    }, { dark: colorTheme === "dark" }), [theme, colorTheme]);
    const lineMapExtension = useMemo(() => lineMap ? promptLineMapExtension(theme.node.fill) : [], [lineMap, theme.node.fill]);

    useImperativeHandle(editorRef, () => ({
        focus: () => editor.current?.focus(),
        insert: (text, options = {}) => {
            const view = editor.current;
            if (!view || status.blocked) return;
            const { from, to } = view.state.selection.main;
            const prefix = options.prefixNewline && from > 0 && view.state.doc.sliceString(from - 1, from) !== "\n" ? "\n" : "";
            const insert = prefix + text;
            view.dispatch({ changes: { from, to, insert }, selection: { anchor: options.select ? from : from + insert.length, head: from + insert.length }, userEvent: "input" });
            view.focus();
        },
        replace: (text) => {
            const view = editor.current;
            if (!view || status.blocked) return;
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: "input" });
            view.focus();
        },
    }), [session, status.blocked]);

    useEffect(() => {
        if (!parent.current || !status.ready) return;
        const view = new EditorView({
            parent: parent.current,
            state: EditorState.create({ doc: session.text.toString(), extensions: [
                yCollab(session.text, undefined, { undoManager: session.undo }),
                canvasTextPresenceExtension(projectId, target, session),
                lineMapCompartment.of(lineMapExtension),
                keymap.of([...yUndoManagerKeymap, { key: "Enter", run: (view) => {
                    if (!callbacks.current.onSubmit || view.composing) return false;
                    callbacks.current.onSubmit(); return true;
                } }, { key: "Escape", run: () => { callbacks.current.onEscape?.(); return Boolean(callbacks.current.onEscape); } }]),
                EditorView.lineWrapping, placeholderExtension(placeholder), appearance.of(themeExtension),
                keymap.of(defaultKeymap),
                editable.of(EditorView.editable.of(!status.blocked)),
                mentions.of(mentionExtensions(references, chips, setImagePreview)),
                ...(dialogue ? [dialogueHighlightExtension(setDialogueMenu, speakersRef), dialogueContextMenuExtension(setDialogueMenu, speakersRef)] : []),
                EditorView.contentAttributes.of({ "aria-label": placeholder }),
                EditorView.domEventHandlers({ blur: () => { callbacks.current.onBlur?.(); } }),
            ] }),
        });
        editor.current = view;
        if (autoFocus) view.focus();
        return () => { editor.current = null; view.destroy(); };
    }, [session, status.ready, placeholder, appearance, editable, mentions]);
    useEffect(() => { editor.current?.dispatch({ effects: appearance.reconfigure(themeExtension) }); }, [appearance, themeExtension]);
    useEffect(() => { editor.current?.dispatch({ effects: editable.reconfigure(EditorView.editable.of(!status.blocked)) }); }, [editable, status.blocked]);
    useEffect(() => { editor.current?.dispatch({ effects: mentions.reconfigure(mentionExtensions(references, chips, setImagePreview)) }); }, [mentions, references, chips]);
    useEffect(() => { editor.current?.dispatch({ effects: lineMapCompartment.reconfigure(lineMapExtension) }); }, [lineMapCompartment, lineMapExtension]);

    return <div className={className} style={style} data-canvas-shortcuts-ignore onKeyDown={(event) => {
        // 同 CanvasStandaloneText：Ctrl/Cmd+C 未选中文字时放行冒泡，回落为「复制节点」
        const copyIntent = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "c" && !window.getSelection()?.toString();
        if (!copyIntent) event.stopPropagation();
    }} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
        <div ref={parent} style={{ height: "100%", minHeight: 80 }} />
        {!status.ready && !status.error ? <small style={{ color: theme.node.muted }}>正在读取协作文档…</small> : null}
        {dialogueMenu ? <DialogueContextMenu menu={dialogueMenu} onClose={() => setDialogueMenu(null)} theme={theme} /> : null}
        {status.error ? <div role="status" className="mt-1 text-xs" style={{ color: theme.node.muted }}>
            文本尚未同步：{status.error}
            <button type="button" className="ml-2 hover:underline" onClick={() => void session.reconnect(true)}>重试同步</button>
            {status.blocked ? <details><summary>查看保留的草稿</summary><textarea readOnly value={status.text} aria-label="未同步文本草稿" /></details> : null}
        </div> : status.pending ? <small style={{ color: theme.node.muted }}>正在保存文字…</small> : null}
        {imagePreview ? <Image style={{ display: "none" }} src={imagePreview} preview={{ visible: true, onVisibleChange: (visible) => { if (!visible) setImagePreview(null); } }} /> : null}
    </div>;
}
