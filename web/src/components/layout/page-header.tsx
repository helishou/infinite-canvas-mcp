import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * 页面宽度档位。只决定内容列的最大宽度，横向内边距由页面内容列负责，
 * 这样 PageHeader 与页面主体永远同一条竖线。
 * - gallery：1440，卡片/画廊型页面（与顶栏 lg:px-8 对齐，1440 视口下起点 32px）
 * - data：1280，表格/数据型页面（居中，1440 视口下起点 112px）
 */
export type PageWidth = "gallery" | "data";

export const pageWidthClass: Record<PageWidth, string> = {
    gallery: "max-w-[1440px]",
    data: "max-w-7xl",
};

export function PageHeader({
    title,
    description,
    icon,
    meta,
    actions,
    width = "gallery",
    sticky = false,
    className,
    children,
}: {
    title: ReactNode;
    description?: ReactNode;
    icon?: ReactNode;
    /** 计数/状态等标题行附属信息，避免在页头和列表头各写一遍。 */
    meta?: ReactNode;
    actions?: ReactNode;
    width?: PageWidth;
    sticky?: boolean;
    className?: string;
    /** 页头下方、与页头同宽的附属内容（搜索、筛选等）。 */
    children?: ReactNode;
}) {
    return (
        <header
            data-page-header
            className={cn("w-full", sticky && "sticky top-0 z-20 bg-background/95 backdrop-blur", className)}
        >
            <div className={cn("mx-auto flex w-full flex-wrap items-start justify-between gap-x-6 gap-y-3", pageWidthClass[width])}>
                <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                        <h1 className="ui-page-title flex min-w-0 items-center gap-2 text-foreground">
                            {icon ? <span className="shrink-0 text-muted-foreground" aria-hidden="true">{icon}</span> : null}
                            <span className="min-w-0 truncate">{title}</span>
                        </h1>
                        {meta ? <span className="ui-caption shrink-0 text-muted-foreground">{meta}</span> : null}
                    </div>
                    {description ? <p className="ui-body mt-1.5 text-muted-foreground">{description}</p> : null}
                </div>
                {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
            </div>
            {children ? <div className={cn("mx-auto w-full", pageWidthClass[width], "mt-4")}>{children}</div> : null}
        </header>
    );
}

/**
 * 页内小节头。标题字号固定 16px/500，与卡片标题同层，避免各页各写 text-lg / text-xl。
 */
export function PageSectionHeader({
    title,
    count,
    description,
    actions,
    className,
}: {
    /** 省略时只渲染右侧操作区，用于上级页头已给出同名标题的场景。 */
    title?: ReactNode;
    count?: ReactNode;
    description?: ReactNode;
    actions?: ReactNode;
    className?: string;
}) {
    return (
        <div className={cn("flex flex-wrap items-start justify-between gap-x-5 gap-y-3 border-b border-border pb-5", className)}>
            {title ? (
                <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <h2 className="ui-panel-title min-w-0 truncate text-foreground">{title}</h2>
                        {count != null && count !== "" ? <span className="ui-caption shrink-0 text-muted-foreground">{count}</span> : null}
                    </div>
                    {description ? <p className="ui-caption mt-1 text-muted-foreground">{description}</p> : null}
                </div>
            ) : null}
            {actions ? <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{actions}</div> : null}
        </div>
    );
}
