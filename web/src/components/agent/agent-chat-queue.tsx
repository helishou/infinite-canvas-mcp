import { Button } from "antd";
import { ArrowUpToLine, RotateCcw, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import type { AgentQueuedPrompt } from "@/stores/use-agent-store";

export function AgentChatQueue({ items, paused, canInsert, theme, onRemove, onInsert, onRetry, onResume }: {
    items: AgentQueuedPrompt[];
    paused: boolean;
    canInsert: boolean;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    onRemove: (id: string) => void;
    onInsert: (id: string) => void;
    onRetry: (id: string) => void;
    onResume: () => void;
}) {
    const { t } = useTranslation();
    if (!items.length && !paused) return null;
    return (
        <section aria-label={t("agent.queue.title", { count: items.length })} className="mx-3 mb-2 max-h-40 shrink-0 overflow-y-auto rounded-xl border px-3 py-2" style={{ borderColor: theme.node.stroke, background: theme.toolbar.panel }}>
            <header className="mb-2 flex items-center justify-between gap-2 text-xs">
                <strong>{t("agent.queue.title", { count: items.length })}</strong>
                {paused ? <Button type="link" size="small" className="!h-auto !p-0" onClick={onResume}>{t("agent.queue.resume")}</Button> : null}
            </header>
            {paused ? <p className="mb-2 text-xs" style={{ color: theme.node.muted }}>{t("agent.queue.paused")}</p> : null}
            <ol className="space-y-2">
                {items.map((item) => {
                    const canRemove = item.status === "queued" || item.status === "failed";
                    const canPrioritize = item.status === "queued" && canInsert;
                    return (
                        <li key={item.id} data-testid="agent-queued-prompt" data-queue-id={item.id} className="rounded-lg border px-2.5 py-2" style={{ borderColor: theme.node.stroke }}>
                            <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                    <p className="whitespace-pre-wrap break-words text-xs leading-5">{item.payload.messageText || item.payload.text}</p>
                                    <p className="mt-1 text-[11px]" style={{ color: item.status === "failed" ? "#dc2626" : theme.node.muted }}>{t(`agent.queue.status.${item.status}`)}</p>
                                    {item.error ? <p role="alert" className="mt-1 break-words text-[11px] text-red-600">{item.error}</p> : null}
                                    {item.payload.attachments.length ? <p className="mt-1 text-[11px]" style={{ color: theme.node.muted }}>{t("agent.queue.attachments", { count: item.payload.attachments.length })}</p> : null}
                                    {item.payload.canvasReferences.length ? <p className="mt-1 text-[11px]" style={{ color: theme.node.muted }}>{t("agent.queue.canvasReferences", { count: item.payload.canvasReferences.length })}</p> : null}
                                </div>
                                <div className="flex shrink-0 items-center gap-1">
                                    <Button type="text" size="small" disabled={!canPrioritize} icon={<ArrowUpToLine className="size-3.5" />} aria-label={t("agent.queue.insert")} title={t("agent.queue.insert")} onClick={() => onInsert(item.id)} />
                                    {item.status === "failed" ? <Button type="text" size="small" icon={<RotateCcw className="size-3.5" />} aria-label={t("agent.queue.retry")} title={t("agent.queue.retry")} onClick={() => onRetry(item.id)} /> : null}
                                    <Button type="text" size="small" disabled={!canRemove} icon={<X className="size-3.5" />} aria-label={t("agent.queue.remove")} title={t("agent.queue.remove")} onClick={() => onRemove(item.id)} />
                                </div>
                            </div>
                        </li>
                    );
                })}
            </ol>
        </section>
    );
}
