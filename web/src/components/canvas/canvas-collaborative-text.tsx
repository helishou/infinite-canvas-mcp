import { useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
import type { CanvasTextEditorProps, CanvasTextReference } from "@/types/canvas-plugin";
import { canvasTextPresenceExtension } from "./canvas-text-presence-extension";

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
        const kind = this.token.startsWith("{{subject:") ? "人物" : "素材";
        const id = this.token.slice(this.token.indexOf(":") + 1, -2);
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
    active.forEach((reference) => (reference.tokens?.length ? reference.tokens : [reference.label]).forEach((token) => { if (token) byToken.set(token, reference); }));
    const tokens = [...byToken.keys()].sort((a, b) => b.length - a.length);
    const pattern = tokens.length ? new RegExp(tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gu") : null;
    const semanticPattern = /\{\{(?:ref|subject):[^{}\s]+\}\}/gu;
    const unresolvedTokens = (text: string) => {
        semanticPattern.lastIndex = 0;
        return [...new Set([...text.matchAll(semanticPattern)].map((match) => match[0]).filter((token) => !byToken.has(token)))];
    };
    const decorations = (view: EditorView) => {
        if (!chips || view.composing) return Decoration.none;
        const ranges = [];
        for (const { from, to } of view.visibleRanges) {
            const visibleText = view.state.doc.sliceString(from, to);
            if (pattern) {
                pattern.lastIndex = 0;
                for (const match of visibleText.matchAll(pattern)) {
                    const reference = byToken.get(match[0]);
                    if (reference) ranges.push(Decoration.replace({ widget: new ReferenceChip(reference, preview) }).range(from + match.index!, from + match.index! + match[0].length));
                }
            }
            semanticPattern.lastIndex = 0;
            for (const match of visibleText.matchAll(semanticPattern)) {
                if (!byToken.has(match[0])) {
                    const token = match[0];
                    const tokenFrom = from + match.index!;
                    ranges.push(Decoration.replace({ widget: new UnresolvedReferenceChip(token, tokenFrom, () => {
                        if (!view.dom.isConnected) return;
                        view.dispatch({ selection: { anchor: tokenFrom + token.length } });
                        view.focus();
                        startCompletion(view);
                    }) }).range(tokenFrom, tokenFrom + token.length));
                }
            }
        }
        return Decoration.set(ranges, true);
    };
    return [
        autocompletion({ defaultKeymap: false, override: [(context) => {
            const unresolved = context.matchBefore(/\{\{(?:subject|ref):[^{}\s]+\}\}/u);
            if (unresolved && !byToken.has(unresolved.text)) {
                const isSubject = unresolved.text.startsWith("{{subject:");
                const candidates = suggestible.filter((item) => isSubject ? item.kind === "character" : item.kind !== "character");
                return { from: unresolved.from, to: unresolved.to, filter: false, options: candidates.map((item) => ({
                    label: item.label, detail: item.title, apply: item.insert || item.label,
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
    const { placeholder = "请输入文本", references = [], chips = false, editorRef, className, style, autoFocus = false } = props;
    const parent = useRef<HTMLDivElement>(null);
    const editor = useRef<EditorView | null>(null);
    const applyingValue = useRef(false);
    const callbacks = useRef(props);
    callbacks.current = props;
    const [imagePreview, setImagePreview] = useState<string | null>(null);
    const appearance = useMemo(() => new Compartment(), []);
    const mentions = useMemo(() => new Compartment(), []);
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
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
        ".cm-canvas-reference-label": { minWidth: "0", overflow: "hidden", textOverflow: "ellipsis" },
    }, { dark: colorTheme === "dark" }), [theme, colorTheme]);

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
                history(),
                keymap.of([...defaultKeymap, ...historyKeymap]),
                mentions.of(mentionExtensions(references, chips, setImagePreview)),
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

    return <div className={className} style={style} data-canvas-shortcuts-ignore onKeyDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
        <div ref={parent} style={{ height: "100%", minHeight: 80 }} />
        {imagePreview ? <Image style={{ display: "none" }} src={imagePreview} preview={{ visible: true, onVisibleChange: (visible) => { if (!visible) setImagePreview(null); } }} /> : null}
    </div>;
}

/** 不接受受控全文：Yjs binding 负责远端增量、输入法、光标与本地撤销。 */
function CanvasYjsText(props: CanvasTextEditorProps) {
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
        ".cm-canvas-reference": { display: "inline-flex", alignItems: "center", verticalAlign: "middle", gap: "4px", maxWidth: "220px", overflow: "hidden", whiteSpace: "nowrap", borderRadius: "6px", padding: "0 4px", backgroundColor: theme.toolbar.activeBg },
        ".cm-canvas-reference-character": { border: `1px solid ${theme.node.stroke}` },
        ".cm-canvas-reference-error": { border: `1px solid ${colorTheme === "dark" ? "#f87171" : "#dc2626"}`, color: colorTheme === "dark" ? "#fca5a5" : "#b91c1c", backgroundColor: colorTheme === "dark" ? "rgba(248,113,113,.12)" : "rgba(220,38,38,.08)" },
        ".cm-canvas-reference img": { width: "24px", height: "24px", objectFit: "cover", borderRadius: "4px", cursor: "pointer" },
        ".cm-canvas-reference-label": { minWidth: "0", overflow: "hidden", textOverflow: "ellipsis" },
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
