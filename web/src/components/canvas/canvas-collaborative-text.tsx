import { useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Image } from "antd";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { Decoration, EditorView, keymap, placeholder as placeholderExtension, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap } from "@codemirror/commands";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { canvasThemes } from "@/lib/canvas-theme";
import { canvasTextKey } from "@/lib/canvas/collaborative-text-session";
import { getCanvasTextSession } from "@/services/api/canvas-text";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasTextEditorProps, CanvasTextReference } from "@/types/canvas-plugin";
import { canvasTextPresenceExtension } from "./canvas-text-presence-extension";

class ReferenceChip extends WidgetType {
    constructor(readonly reference: CanvasTextReference, readonly preview: (url: string) => void) { super(); }
    eq(other: ReferenceChip) { return this.reference === other.reference; }
    toDOM() {
        const span = document.createElement("span");
        span.className = "cm-canvas-reference";
        span.title = this.reference.title || this.reference.label;
        if (this.reference.previewUrl && this.reference.kind === "image") {
            const img = document.createElement("img");
            img.src = this.reference.previewUrl;
            img.alt = ""; img.draggable = false;
            span.append(img);
            span.addEventListener("click", (event) => { event.preventDefault(); this.preview(this.reference.previewUrl!); });
        }
        span.append(document.createTextNode(this.reference.label));
        return span;
    }
}

function mentionExtensions(references: CanvasTextReference[], chips: boolean, preview: (url: string) => void) {
    const active = references.filter((reference) => reference.active !== false && reference.label);
    const byLabel = new Map(active.map((reference) => [reference.label, reference]));
    const labels = [...byLabel.keys()].sort((a, b) => b.length - a.length);
    const pattern = labels.length ? new RegExp(labels.map((label) => label.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&")).join("|"), "gu") : null;
    const decorations = (view: EditorView) => {
        if (!chips || !pattern || view.composing) return Decoration.none;
        const ranges = [];
        for (const { from, to } of view.visibleRanges) {
            pattern.lastIndex = 0;
            for (const match of view.state.doc.sliceString(from, to).matchAll(pattern)) {
                ranges.push(Decoration.replace({ widget: new ReferenceChip(byLabel.get(match[0])!, preview) }).range(from + match.index!, from + match.index! + match[0].length));
            }
        }
        return Decoration.set(ranges, true);
    };
    return [
        autocompletion({ defaultKeymap: false, override: [(context) => {
            const match = context.matchBefore(/@[^\s@]*/u);
            if (!match || context.view?.composing) return null;
            const query = match.text.slice(1).toLowerCase();
            return { from: match.from, filter: false, options: active.filter((item) => [item.label, item.title, item.kind].join(" ").toLowerCase().includes(query)).map((item) => ({
                label: item.label, detail: item.title, apply: item.insert || item.label,
            })) };
        }] }),
        Prec.highest(keymap.of(completionKeymap)),
        ViewPlugin.fromClass(class {
            decorations: DecorationSet;
            constructor(view: EditorView) { this.decorations = decorations(view); }
            update(update: import("@codemirror/view").ViewUpdate) { this.decorations = decorations(update.view); }
        }, { decorations: (plugin) => plugin.decorations, provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations || Decoration.none) }),
    ];
}

/** 不接受受控全文：Yjs binding 负责远端增量、输入法、光标与本地撤销。 */
export function CanvasCollaborativeText(props: CanvasTextEditorProps) {
    const { projectId, target, placeholder = "请输入文本", references = [], chips = false, editorRef, className, style, autoFocus = false } = props;
    const targetKey = canvasTextKey(target);
    const session = useMemo(() => getCanvasTextSession(projectId, target), [projectId, targetKey]);
    const status = useSyncExternalStore(session.subscribe, session.getSnapshot);
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const parent = useRef<HTMLDivElement>(null);
    const editor = useRef<EditorView | null>(null);
    const callbacks = useRef(props);
    callbacks.current = props;
    const [imagePreview, setImagePreview] = useState<string | null>(null);
    const appearance = useMemo(() => new Compartment(), []);
    const editable = useMemo(() => new Compartment(), []);
    const mentions = useMemo(() => new Compartment(), []);
    const themeExtension = useMemo(() => EditorView.theme({
        "&": { height: "100%", color: theme.node.text, backgroundColor: "transparent", fontSize: "inherit" },
        "&.cm-focused": { outline: "none" },
        ".cm-scroller": { fontFamily: "inherit", overflow: "auto" },
        ".cm-content": { minHeight: "80px", caretColor: theme.node.text },
        ".cm-placeholder": { color: theme.node.placeholder },
        ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: theme.canvas.selectionFill },
        ".cm-tooltip": { color: theme.node.text, backgroundColor: theme.toolbar.panel, borderColor: theme.toolbar.border },
        ".cm-tooltip-autocomplete ul li[aria-selected]": { color: theme.toolbar.activeText, backgroundColor: theme.toolbar.activeBg },
        ".cm-canvas-reference": { display: "inline-flex", alignItems: "center", verticalAlign: "middle", gap: "4px", borderRadius: "6px", padding: "0 4px", backgroundColor: theme.toolbar.activeBg },
        ".cm-canvas-reference img": { width: "24px", height: "24px", objectFit: "cover", borderRadius: "4px", cursor: "pointer" },
        ".cm-canvas-peer-caret": { position: "relative", display: "inline", borderLeft: "2px solid", marginLeft: "-1px", marginRight: "-1px", pointerEvents: "none" },
        ".cm-canvas-peer-label": { position: "absolute", bottom: "1em", left: "-1px", whiteSpace: "nowrap", fontSize: "10px", lineHeight: "14px", padding: "0 3px", border: "1px solid", borderRadius: "3px", backgroundColor: theme.toolbar.panel, color: theme.node.text, zIndex: "2" },
    }, { dark: colorTheme === "dark" }), [theme, colorTheme]);

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
                keymap.of([...yUndoManagerKeymap, { key: "Enter", run: (view) => {
                    if (!callbacks.current.onSubmit || view.composing) return false;
                    callbacks.current.onSubmit(); return true;
                } }, { key: "Escape", run: () => { callbacks.current.onEscape?.(); return Boolean(callbacks.current.onEscape); } }]),
                EditorView.lineWrapping, placeholderExtension(placeholder), appearance.of(themeExtension),
                keymap.of(defaultKeymap),
                editable.of(EditorView.editable.of(!status.blocked)),
                mentions.of(mentionExtensions(references, chips, setImagePreview)),
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

    return <div className={className} style={style} data-canvas-shortcuts-ignore onKeyDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
        <div ref={parent} style={{ height: "100%", minHeight: 80 }} />
        {!status.ready && !status.error ? <small style={{ color: theme.node.muted }}>正在读取协作文档…</small> : null}
        {status.error ? <div role="status" className="mt-1 text-xs" style={{ color: theme.node.muted }}>
            文本尚未同步：{status.error}
            <button type="button" className="ml-2 hover:underline" onClick={() => void session.reconnect(true)}>重试同步</button>
            {status.blocked ? <details><summary>查看保留的草稿</summary><textarea readOnly value={status.text} aria-label="未同步文本草稿" /></details> : null}
        </div> : status.pending ? <small style={{ color: theme.node.muted }}>正在保存文字…</small> : null}
        {imagePreview ? <Image style={{ display: "none" }} src={imagePreview} preview={{ visible: true, onVisibleChange: (visible) => { if (!visible) setImagePreview(null); } }} /> : null}
    </div>;
}
