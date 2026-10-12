import type { ReactNode } from "react";
import { Button, Popover } from "antd";
import { CircleHelp } from "lucide-react";
import { useTranslation } from "react-i18next";

/** Keep workspace context and actions together; optional guidance must not become a hero. */
export function ProductionPageHeading({ title, summary, help, actions, titleAlreadyVisible = false, toolbar }: {
    title: ReactNode;
    /** Set only when the owning navigation already names this workspace. */
    titleAlreadyVisible?: boolean;
    toolbar?: ReactNode;
    summary?: ReactNode;
    help?: ReactNode;
    actions?: ReactNode;
}) {
    const { t } = useTranslation();
    const helpButton = help && <Popover trigger="click" title={title} content={<div className="max-w-[min(28rem,75vw)] space-y-2 text-sm leading-6">{help}</div>}><Button type="text" size="small" aria-label={`${title} · ${t("common.details")}`} icon={<CircleHelp className="size-4" />} /></Popover>;
    if (titleAlreadyVisible) return <header data-production-page-heading className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 className="sr-only">{title}</h2>
        {toolbar && <div className="min-w-0 flex-[1_1_24rem]">{toolbar}</div>}
        {summary && <div className="min-w-0 flex-[1_1_16rem] text-xs leading-5 text-muted-foreground">{summary}</div>}
        {(help || actions) && <div className="production-page-actions ml-auto flex min-w-0 flex-wrap items-center gap-2">{helpButton}{actions}</div>}
    </header>;
    return <><header data-production-page-heading className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="production-page-context min-w-0 flex-[1_1_280px]">
            <div className="production-page-title flex items-center gap-1.5"><h2 className="m-0 text-lg font-semibold leading-7">{title}</h2>{helpButton}</div>
            {summary && <div className="production-page-summary mt-0.5 text-xs leading-5 text-muted-foreground">{summary}</div>}
        </div>
        {actions && <div className="production-page-actions flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>{toolbar}</>;
}
