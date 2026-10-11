import { Button, Empty, Spin, Tag } from "antd";
import { Trash2 } from "lucide-react";

/** 一条运行历史。两个数据源（生图日志 / RunningHub 任务）都归一成这个形状。 */
export type RunHistoryEntry = {
    id: string;
    status: string;
    statusLabel?: string;
    title: string;
    time?: string;
    prompt?: string;
    error?: string;
    outputs: Array<{ url: string; mimeType?: string }>;
    texts?: string[];
    onDelete?: () => void;
};

const statusColor = (status: string) => (status === "success" || status === "succeeded" ? "green" : status === "failed" ? "red" : "blue");

function OutputThumb({ item }: { item: { url: string; mimeType?: string } }) {
    if (item.mimeType?.startsWith("audio/")) return <audio src={item.url} controls className="h-10 w-56" />;
    if (item.mimeType?.startsWith("video/")) return <video src={item.url} className="h-10 w-16 rounded object-cover" />;
    return <img src={item.url} alt="" className="h-10 w-10 rounded object-cover" />;
}

/**
 * 运行历史列表。本地工作流和 RunningHub 共用，
 * 差异只在数据源怎么把条目填出来，不在怎么显示。
 */
export function RunHistoryList({
    entries, loading, emptyText, onRefresh, hint,
}: {
    entries: RunHistoryEntry[];
    loading?: boolean;
    emptyText?: string;
    onRefresh?: () => void;
    hint?: string;
}) {
    return (
        <div>
            <div className="mb-3 flex items-center justify-between">
                <p className="text-xs text-stone-500">{hint || "工作流运行历史"}</p>
                {onRefresh ? <Button size="small" onClick={onRefresh} disabled={loading}>刷新</Button> : null}
            </div>
            {loading ? <Spin /> : entries.length === 0 ? <Empty description={emptyText || "暂无运行历史"} /> : (
                <div className="space-y-2">
                    {entries.map((entry) => (
                        <div key={entry.id} className="flex items-center gap-3 rounded border border-stone-200 bg-white p-3 text-sm dark:border-stone-700 dark:bg-stone-800">
                            <div className="min-w-0 flex-1">
                                <div className="mb-1 flex items-center gap-2">
                                    <Tag color={statusColor(entry.status)}>{entry.statusLabel || entry.status}</Tag>
                                    <span className="truncate font-medium">{entry.title}</span>
                                    {entry.time ? <span className="shrink-0 text-xs text-stone-400">{entry.time}</span> : null}
                                </div>
                                {entry.prompt ? <p className="truncate text-xs text-stone-500" title={entry.prompt}>{entry.prompt}</p> : null}
                                {entry.error ? <p className="truncate text-xs text-red-500" title={entry.error}>{entry.error}</p> : null}
                                {entry.texts?.length ? (
                                    <div className="mt-1 space-y-1">{entry.texts.map((text, i) => <pre key={i} className="max-h-24 overflow-auto whitespace-pre-wrap rounded bg-stone-50 p-2 text-[11px] dark:bg-stone-900">{text}</pre>)}</div>
                                ) : null}
                                {entry.outputs.length > 0 && (
                                    <div className="mt-1 flex flex-wrap gap-1">
                                        {entry.outputs.slice(0, 4).map((item, i) => <OutputThumb key={i} item={item} />)}
                                        {entry.outputs.length > 4 && (
                                            <span className="flex h-10 w-10 items-center justify-center rounded bg-stone-100 text-xs text-stone-500">+{entry.outputs.length - 4}</span>
                                        )}
                                    </div>
                                )}
                            </div>
                            {entry.onDelete ? <Button size="small" danger icon={<Trash2 className="size-3" />} onClick={entry.onDelete} /> : null}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}