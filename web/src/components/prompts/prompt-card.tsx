import { Copy, FileText } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button, Card, Tag } from "antd";
import { useTranslation } from "react-i18next";

import { formatPromptDate, type Prompt } from "@/services/api/prompts";

export function PromptCard({
    item,
    onOpen,
    onCopy,
    actionLabel,
    actionIcon = <Copy className="size-3.5" />,
    actionType = "text",
    extraAction,
    managementAction,
    compact = false,
}: {
    item: Prompt;
    onOpen: () => void;
    onCopy: () => void;
    actionLabel?: string;
    actionIcon?: ReactNode;
    actionType?: "text" | "primary";
    extraAction?: ReactNode;
    managementAction?: ReactNode;
    compact?: boolean;
}) {
    const { i18n, t } = useTranslation();
    const [coverFailed, setCoverFailed] = useState(false);
    const coverClass = compact ? "aspect-square w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" : "aspect-[4/3] w-full object-cover";
    const placeholderClass = compact ? "grid aspect-square w-full place-items-center bg-muted text-muted-foreground" : "grid aspect-[4/3] w-full place-items-center bg-muted text-muted-foreground";
    return (
        <Card
            hoverable
            className={compact ? "group cursor-pointer overflow-hidden !border-border !bg-card transition-colors hover:!border-primary/40 hover:!shadow-none" : "flex h-full flex-col overflow-hidden !border-border !bg-card transition-colors hover:!border-primary/40 hover:!shadow-none"}
            styles={{ body: compact ? { padding: 0 } : { display: "flex", flex: 1, flexDirection: "column", padding: 0 } }}
            cover={
                <button type="button" className="block w-full cursor-pointer text-left" onClick={onOpen}>
                    {item.coverUrl && !coverFailed ? <img src={item.coverUrl} alt={item.title} className={coverClass} loading="lazy" onError={() => setCoverFailed(true)} /> : <span className={placeholderClass}><FileText className="size-8" /></span>}
                </button>
            }
        >
            <button type="button" className={compact ? "block w-full cursor-pointer text-left" : "block w-full flex-1 cursor-pointer text-left"} onClick={onOpen}>
                <div className={compact ? "px-3 py-2.5" : "p-4"}>
                    <div className="flex items-start justify-between gap-3">
                        <h2 className="line-clamp-2 text-sm font-medium leading-6 text-foreground">{item.title}</h2>
                    </div>
                    <p className="mt-1 truncate text-[11px] text-muted-foreground">{t("prompts.workspace.source")}: {item.category}</p>
                    {!compact ? <p className="mt-1 text-[11px] text-muted-foreground">{formatPromptDate(item.updatedAt, i18n.resolvedLanguage)}</p> : null}
                    {!compact ? <><p className="mt-2 line-clamp-3 text-xs leading-5 text-muted-foreground">{item.description || item.prompt}</p><div className="mt-3 flex flex-wrap gap-1.5">{item.tags.map((tag) => <Tag key={tag} className="m-0 text-[11px]">{tag}</Tag>)}</div></> : null}
                </div>
            </button>
            {!compact || actionLabel ? <div className={compact ? "border-t border-border px-3 py-2.5" : "mx-4 mt-auto border-t border-border py-3"} data-resource-group="prompt-use">
                <div className="flex flex-wrap items-center gap-1.5">
                    <Button block={actionType === "primary"} type={actionType} size="small" icon={actionIcon} onClick={onCopy}>{actionLabel || t("common.copy")}</Button>
                    {extraAction}
                </div>
                {managementAction ? <div className="mt-3 flex flex-wrap items-center gap-1 border-t border-border pt-2" data-resource-group="prompt-management">
                    <span className="mr-auto text-[11px] text-muted-foreground">{t("prompts.workspace.managePrompt")}</span>
                    {managementAction}
                </div> : null}
            </div> : null}
        </Card>
    );
}
