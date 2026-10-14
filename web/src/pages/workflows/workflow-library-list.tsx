// 工作流库的列表壳：本地 ComfyUI 与 RunningHub 两个库共用同一份渲染，
// 只换 items 数据源，避免两套列表在选中态、重命名和徽标上逐渐漂移。
import { useState, type ReactNode } from "react";
import { Empty, Input, Spin, Tooltip } from "antd";
import { ExternalLink } from "lucide-react";

export type WorkflowLibraryItem = {
    /** 本地用工作流文件名，RunningHub 用档案 id；同一列表内唯一即可。 */
    id: string;
    title: string;
    /** 第二行副标题：本地是文件名，RunningHub 是 workflowId。 */
    meta?: string;
    /** 右侧徽标文案，如「11 字段」。 */
    badge?: string;
    /** 内置项不可改名、不可删除。 */
    builtin?: boolean;
};

export function WorkflowLibraryList({
    items,
    selectedId,
    onSelect,
    onRename,
    emptyText = "暂无工作流",
    renderLeading,
    onAction,
    actionTitle,
    actionBusyId,
}: {
    items: WorkflowLibraryItem[];
    selectedId?: string | null;
    onSelect: (item: WorkflowLibraryItem) => void;
    onRename?: (item: WorkflowLibraryItem, title: string) => void;
    emptyText?: string;
    /** 选中态左侧的图标槽；两个库各自决定是否显示来源标记。 */
    renderLeading?: (item: WorkflowLibraryItem) => ReactNode;
    /** 行尾操作按钮（本地库是「在 ComfyUI 中打开」）；不传则不渲染，RunningHub 列表保持原样。 */
    onAction?: (item: WorkflowLibraryItem) => void;
    actionTitle?: string;
    /** 正在执行该操作的行 id：按钮转圈且不可再点。 */
    actionBusyId?: string | null;
}) {
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editValue, setEditValue] = useState("");

    if (!items.length) {
        return (
            <div className="flex flex-1 items-center justify-center p-6">
                <Empty description={emptyText} />
            </div>
        );
    }

    return (
        <div className="min-h-0 flex-1 divide-y divide-stone-200 overflow-y-auto dark:divide-stone-700">
            {items.map((item) => (
                <div
                    key={item.id}
                    className={`cursor-pointer px-3 py-2.5 transition hover:bg-stone-50 dark:hover:bg-stone-800 ${selectedId === item.id ? "bg-stone-100 dark:bg-stone-800" : ""}`}
                    onClick={() => {
                        if (editingId !== item.id) onSelect(item);
                    }}
                >
                    <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 flex-1 items-center gap-1.5">
                            {renderLeading?.(item)}
                            <div className="min-w-0 flex-1">
                                {editingId === item.id ? (
                                    <Input
                                        autoFocus
                                        size="small"
                                        value={editValue}
                                        onChange={(event) => setEditValue(event.target.value)}
                                        onClick={(event) => event.stopPropagation()}
                                        onPressEnter={() => {
                                            const next = editValue.trim();
                                            setEditingId(null);
                                            if (next && next !== item.title) onRename?.(item, next);
                                        }}
                                        onBlur={() => {
                                            const next = editValue.trim();
                                            setEditingId(null);
                                            if (next && next !== item.title) onRename?.(item, next);
                                        }}
                                        className="w-full"
                                    />
                                ) : (
                                    <p
                                        className={`truncate text-sm font-medium ${item.builtin ? "cursor-default" : "cursor-pointer hover:text-blue-600"}`}
                                        title={item.builtin || !onRename ? "" : "双击重命名"}
                                        onDoubleClick={(event) => {
                                            event.stopPropagation();
                                            if (item.builtin || !onRename) return;
                                            setEditingId(item.id);
                                            setEditValue(item.title);
                                        }}
                                    >
                                        {item.title}
                                    </p>
                                )}
                                {item.meta ? <p className="mt-0.5 truncate text-xs text-stone-500">{item.meta}</p> : null}
                            </div>
                        </div>
                        {onAction && actionTitle ? (
                            <Tooltip title={actionTitle}>
                                <button
                                    type="button"
                                    aria-label={actionTitle}
                                    className="flex size-6 shrink-0 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-blue-600 dark:hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50"
                                    disabled={actionBusyId === item.id}
                                    onClick={(event) => { event.stopPropagation(); onAction(item); }}
                                >
                                    {actionBusyId === item.id ? <Spin size="small" /> : <ExternalLink className="size-3.5" aria-hidden="true" />}
                                </button>
                            </Tooltip>
                        ) : null}
                        {item.badge ? (
                            <span className="shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-600 dark:bg-blue-950 dark:text-blue-300">{item.badge}</span>
                        ) : null}
                    </div>
                </div>
            ))}
        </div>
    );
}
