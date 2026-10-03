import { useMemo, useRef, useState } from "react";
import { Input, Modal, type InputRef } from "antd";
import { Search } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { getNodeDefinition, useNodeRegistryVersion } from "@/lib/canvas/node-registry";
import { canvasNodeSearchText } from "@/lib/canvas/canvas-navigation";
import type { CanvasNodeData } from "@/types/canvas";

export function CanvasNodeFinder({ nodes, onClose, onFocusNode }: { nodes: CanvasNodeData[]; onClose: () => void; onFocusNode: (id: string) => void }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const registryVersion = useNodeRegistryVersion((state) => state.version);
    const input = useRef<InputRef>(null), list = useRef<HTMLDivElement>(null);
    const [query, setQuery] = useState("");
    const [active, setActive] = useState(0);
    const entries = useMemo(() => nodes.map((node) => {
        const typeLabel = t(`canvas.sidePanel.filter.${node.type}`, { defaultValue: getNodeDefinition(node.type)?.title || node.type });
        return { node, typeLabel, search: canvasNodeSearchText(node, typeLabel) };
    }), [nodes, registryVersion, t]);
    const filtered = useMemo(() => {
        const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
        return entries.filter((entry) => words.every((word) => entry.search.includes(word)));
    }, [entries, query]);
    const selected = Math.min(active, Math.max(0, filtered.length - 1));
    const virtualizer = useVirtualizer({ count: filtered.length, getScrollElement: () => list.current, estimateSize: () => 52, overscan: 8 });
    const choose = (id: string) => { onClose(); onFocusNode(id); };
    return <Modal open title={t("canvas.navigation.find")} footer={null} onCancel={onClose} width={560} modalRender={(content) => <div data-canvas-shortcuts-ignore>{content}</div>} afterOpenChange={(open) => { if (open) { input.current?.focus(); virtualizer.measure(); } }}>
        <div data-canvas-shortcuts-ignore onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (!filtered.length) return;
                const next = Math.max(0, Math.min(filtered.length - 1, selected + (event.key === "ArrowDown" ? 1 : -1)));
                setActive(next); virtualizer.scrollToIndex(next);
            } else if (event.key === "Enter" && filtered[selected]) { event.preventDefault(); choose(filtered[selected].node.id); }
        }}>
            <Input ref={input} autoFocus allowClear prefix={<Search className="size-4" />} aria-label={t("canvas.navigation.searchLabel")} placeholder={t("canvas.navigation.searchPlaceholder")} value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); list.current?.scrollTo({ top: 0 }); }} />
            <div className="mt-2 flex justify-between text-xs opacity-60"><span role="status">{t("canvas.navigation.resultCount", { count: filtered.length })}</span><span>{t("canvas.navigation.keyboardHint")}</span></div>
            <div ref={list} role="listbox" aria-label={t("canvas.navigation.results")} className="mt-2 max-h-[45vh] overflow-y-auto" style={{ height: Math.min(312, Math.max(96, filtered.length * 52)) }}>
                {filtered.length ? <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
                    {virtualizer.getVirtualItems().map((row) => {
                        const { node, typeLabel } = filtered[row.index];
                        return <button key={node.id} type="button" role="option" aria-selected={row.index === selected} className="absolute left-0 top-0 flex w-full items-center justify-between gap-3 rounded-md px-3 text-left hover:bg-black/5 dark:hover:bg-white/10" style={{ height: row.size, transform: `translateY(${row.start}px)`, background: row.index === selected ? theme.toolbar.activeBg : undefined }} onClick={() => choose(node.id)}>
                            <span className="min-w-0"><span className="block truncate text-sm">{node.title || t("canvas.node.untitled")}</span><span className="block truncate text-xs opacity-50">{node.id}</span></span>
                            <span className="shrink-0 text-xs opacity-60">{typeLabel}</span>
                        </button>;
                    })}
                </div> : <div className="py-10 text-center text-sm opacity-50">{t("canvas.navigation.noResults")}</div>}
            </div>
        </div>
    </Modal>;
}
