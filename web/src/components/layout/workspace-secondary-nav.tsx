import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { workspaceSecondaryNavigation } from "@/constant/navigation-tools";
import type { SecondaryNavigationSlug, SecondaryWorkspace } from "@/lib/workspace-navigation";
import { cn } from "@/lib/utils";

export function WorkspaceSecondaryNav({ workspace, activeSlug }: { workspace: SecondaryWorkspace; activeSlug?: SecondaryNavigationSlug }) {
    const { t } = useTranslation();
    const hint = workspace === "generate" ? "generationHint" : workspace === "resources" ? "resourcesHint" : undefined;

    return (
        <div className="border-t border-border/60 bg-card/40">
            <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4 px-4 lg:px-8">
                <nav aria-label={t("workspaceNavigation.secondaryLabel", { workspace: t(`workspaceNavigation.${workspace}`) })} className="hide-scrollbar flex min-w-0 items-center gap-1 overflow-x-auto py-1.5">
                    {workspaceSecondaryNavigation[workspace].map((item) => {
                        const Icon = item.icon;
                        const active = item.slug === activeSlug;
                        return (
                            <Link
                                key={item.slug}
                                to={item.href}
                                aria-current={active ? "page" : undefined}
                                className={cn("flex shrink-0 items-center gap-2 rounded-md min-h-11 px-3 py-2 ui-nav-label sm:min-h-9 transition-colors", active ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground")}
                            >
                                <Icon className="size-4" />
                                {t(`workspaceNavigation.${item.slug}`)}
                            </Link>
                        );
                    })}
                </nav>
                {hint ? <p className="hidden shrink-0 text-xs text-muted-foreground lg:block">{t(`workspaceNavigation.${hint}`)}</p> : null}
            </div>
        </div>
    );
}
