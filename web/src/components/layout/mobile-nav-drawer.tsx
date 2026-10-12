import { Drawer } from "antd";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { navigationTools, workspaceSecondaryNavigation, type NavigationToolSlug } from "@/constant/navigation-tools";
import { resolveWorkspaceNavigation } from "@/lib/workspace-navigation";
import { cn } from "@/lib/utils";
import { useConfigStore } from "@/stores/use-config-store";

type MobileNavDrawerProps = {
    open: boolean;
    activeToolSlug?: NavigationToolSlug;
    onClose: () => void;
    onUnavailableWorkflows: () => void;
};

export function MobileNavDrawer({ open, activeToolSlug, onClose, onUnavailableWorkflows }: MobileNavDrawerProps) {
    const { t } = useTranslation();
    const { pathname, search } = useLocation();
    const navigation = resolveWorkspaceNavigation(pathname, search);
    const localComfyuiEnabled = useConfigStore((state) => state.config.localComfyuiEnabled);

    return (
        <Drawer rootClassName="canvas-blocking-overlay" title={t("topNav.navigation")} placement="left" size={320} open={open} onClose={onClose} styles={{ wrapper: { maxWidth: "calc(100vw - 24px)" } }}>
            <nav id="workspace-navigation-drawer" aria-label={t("workspaceNavigation.primaryLabel")} className="space-y-3">
                {navigationTools.map((tool) => {
                    const Icon = tool.icon;
                    const active = tool.slug === activeToolSlug;
                    const className = cn("flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm transition-colors", active ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground");
                    const secondary = tool.slug === "projects" || tool.slug === "generate" || tool.slug === "resources" ? workspaceSecondaryNavigation[tool.slug] : undefined;
                    return (
                        <div key={tool.slug}>
                            {tool.slug === "workflows" && !localComfyuiEnabled ? (
                                <button type="button" className={className} onClick={onUnavailableWorkflows} aria-haspopup="dialog">
                                    <Icon className="size-5 shrink-0" />
                                    <span className="flex-1">{t(`workspaceNavigation.${tool.slug}`)}</span>
                                    <span className="text-[11px] text-muted-foreground">{t("workspaceNavigation.disabled")}</span>
                                </button>
                            ) : (
                                <Link to={tool.href} aria-current={active ? "page" : undefined} onClick={onClose} className={className}>
                                    <Icon className="size-5 shrink-0" />
                                    <span>{t(`workspaceNavigation.${tool.slug}`)}</span>
                                </Link>
                            )}
                            {secondary ? (
                                <div className="mt-1 flex flex-wrap gap-1 pl-10">
                                    {secondary.map((item) => (
                                        <Link
                                            key={item.slug}
                                            to={item.href}
                                            onClick={onClose}
                                            aria-current={navigation.activeSecondary === item.slug ? "page" : undefined}
                                            className={cn("rounded-md px-2 py-2 text-xs transition-colors", navigation.activeSecondary === item.slug ? "font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground")}
                                        >
                                            {t(`workspaceNavigation.${item.slug}`)}
                                        </Link>
                                    ))}
                                </div>
                            ) : null}
                        </div>
                    );
                })}
            </nav>
        </Drawer>
    );
}
