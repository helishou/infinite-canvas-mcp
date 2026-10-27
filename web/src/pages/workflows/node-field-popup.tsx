import { useMemo, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** API 格式节点输入的原始键值对；连线型输入已由调用方过滤。 */
export type NodeInputEntry = [string, unknown];

function previewValue(rawValue: unknown) {
    if (typeof rawValue === "string") {
        const text = rawValue.length > 40 ? rawValue.slice(0, 40) + "…" : rawValue;
        return `"${text}"`;
    }
    if (typeof rawValue === "number") return <span className="font-mono font-bold text-blue-700">{rawValue}</span>;
    if (typeof rawValue === "boolean") return <span className={`font-bold ${rawValue ? "text-green-700" : "text-amber-700"}`}>{rawValue ? "✓ true" : "✗ false"}</span>;
    if (rawValue && typeof rawValue === "object") return <span className="font-mono text-muted-foreground">{JSON.stringify(rawValue)}</span>;
    return <span className="text-muted-foreground">{String(rawValue)}</span>;
}

export type NodeFieldRowState = {
    /** 该输入是否已暴露为可填写字段。 */
    active: boolean;
    /** 已启用时，字段配置区的内容。 */
    editor?: ReactNode;
};

/**
 * 节点浮窗外壳：遮罩 + 标题 + 输入列表 + 每行的启用勾选与默认值预览。
 * 本地 ComfyUI 和 RunningHub 的差别只在每个输入的「配置什么」，
 * 所以外壳共用，配置区由调用方通过 editor 传入。
 */
export function NodeFieldPopupShell({
    classType, nodeId, inputs, rowState, onToggle, onClose, footer, emptyText = "无可配置输入",
}: {
    classType: string;
    nodeId: string;
    inputs: NodeInputEntry[];
    rowState: (inputKey: string) => NodeFieldRowState;
    onToggle: (inputKey: string) => void;
    onClose: () => void;
    footer?: ReactNode;
    emptyText?: string;
}) {
    const rows = useMemo(() => inputs.map(([key, rawValue]) => ({ key, rawValue, ...rowState(key) })), [inputs, rowState]);
    return createPortal(
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/20 p-4" onClick={onClose}>
            <div
                role="dialog"
                aria-modal="true"
                aria-label={`${classType || "Unknown"} #${nodeId}`}
                className="flex max-h-[min(70vh,calc(100dvh-2rem))] w-[420px] max-w-full flex-col overflow-hidden rounded-lg border border-border bg-white p-4 shadow-xl dark:bg-muted"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="mb-3 flex shrink-0 items-center justify-between border-b border-border pb-2">
                    <div>
                        <div className="font-medium">{classType || "Unknown"}</div>
                        <div className="text-xs text-muted-foreground">#{nodeId}</div>
                    </div>
                    <button onClick={onClose} className="text-xl leading-none text-muted-foreground hover:text-muted-foreground">×</button>
                </div>

                {rows.length === 0 ? (
                    <div className="min-h-0 overflow-y-auto py-4 text-center text-xs text-muted-foreground">{emptyText}</div>
                ) : (
                    <div className="min-h-0 space-y-2 overflow-y-auto">
                        {rows.map(({ key, rawValue, active, editor }) => (
                            <div key={key} className={`rounded border p-2 text-xs ${active ? "border-blue-300 bg-blue-50/50 dark:border-blue-700 dark:bg-blue-900/20" : "border-border"}`}>
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={() => onToggle(key)}
                                        aria-label={`启用 ${key}`}
                                        className={`flex size-4 shrink-0 items-center justify-center rounded border transition ${active ? "border-blue-500 bg-blue-500 text-white" : "border-border "}`}
                                    >
                                        {active && <span className="text-[11px] leading-none">✓</span>}
                                    </button>
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate font-medium">{key}</div>
                                        <div className="truncate text-[11px] text-muted-foreground">默认: {previewValue(rawValue)}</div>
                                    </div>
                                </div>
                                {active && editor ? <div className="mt-2 space-y-2 border-t border-border/50 pt-2">{editor}</div> : null}
                            </div>
                        ))}
                    </div>
                )}

                {footer ? <div className="mt-3 shrink-0">{footer}</div> : null}
            </div>
        </div>,
        document.body,
    );
}
