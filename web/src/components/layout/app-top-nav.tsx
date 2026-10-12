import { useEffect, useRef, useState } from "react";
import { Menu } from "lucide-react";
import { Button, Modal, Tooltip } from "antd";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { navigationTools } from "@/constant/navigation-tools";
import { AppConfigModal } from "@/components/layout/app-config-modal";
import { GlobalTaskButton } from "@/components/layout/global-task-button";
import { MobileNavDrawer } from "@/components/layout/mobile-nav-drawer";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { WorkspaceSecondaryNav } from "@/components/layout/workspace-secondary-nav";
import { resolveWorkspaceNavigation } from "@/lib/workspace-navigation";
import { cn } from "@/lib/utils";
import { useAgentStore } from "@/stores/use-agent-store";
import { useConfigStore } from "@/stores/use-config-store";

export function AppTopNav() {
    const { t } = useTranslation();
    const { pathname, search } = useLocation();
    const [mobileNavOpen, setMobileNavOpen] = useState(false);
    const [workflowNoticeOpen, setWorkflowNoticeOpen] = useState(false);
    const autoConnectRef = useRef(false);
    const agentToken = useAgentStore((state) => state.token);
    const agentEnabled = useAgentStore((state) => state.enabled);
    const agentConnected = useAgentStore((state) => state.connected);
    const connectAgent = useAgentStore((state) => state.connectAgent);
    const localComfyuiEnabled = useConfigStore((state) => state.config.localComfyuiEnabled);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const navigation = resolveWorkspaceNavigation(pathname, search);

    useEffect(() => {
        if (autoConnectRef.current || agentEnabled || agentConnected || !agentToken.trim()) return;
        autoConnectRef.current = true;
        connectAgent({ silent: true });
    }, [agentConnected, agentEnabled, agentToken, connectAgent]);

    useEffect(() => {
        setMobileNavOpen(false);
        setWorkflowNoticeOpen(false);
    }, [pathname, search]);

    const showWorkflowNotice = () => {
        setMobileNavOpen(false);
        setWorkflowNoticeOpen(true);
    };

    return (
        <>
            <header className="relative z-[60] shrink-0 border-b border-border bg-background" data-workspace-header data-canvas-shortcuts-ignore>
                <div className={cn("mx-auto flex max-w-[1600px] items-center justify-between gap-2 px-3 sm:gap-3 sm:px-4 lg:gap-5 lg:px-8", navigation.compact ? "h-12" : "h-16")}>
                    <div className="flex min-w-0 items-center">
                        <Link to="/" aria-label={t("meta.title")} className="flex shrink-0 items-center gap-2 text-sm font-semibold leading-none tracking-tight text-foreground transition hover:text-primary">
                            <span className="size-6 shrink-0 bg-primary" style={{ mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }} />
                            <span className="hidden text-sm font-semibold 2xl:inline">{t("meta.title")}</span>
                        </Link>

                        <button
                            type="button"
                            className="ml-2 inline-flex h-11 min-w-11 sm:h-9 sm:min-w-9 items-center justify-center gap-2 rounded-md px-2 text-muted-foreground transition hover:bg-muted hover:text-foreground lg:hidden"
                            onClick={() => setMobileNavOpen(true)}
                            aria-label={t("topNav.openMenu")}
                            aria-expanded={mobileNavOpen}
                            aria-controls="workspace-navigation-drawer"
                            title={t("topNav.menu")}
                        >
                            <Menu className="size-4 shrink-0" />
                            {navigation.area ? <span className="min-w-0 max-w-28 truncate ui-nav-label font-medium text-foreground">{t(`workspaceNavigation.${navigation.area}`)}</span> : null}
                        </button>

                        <nav aria-label={t("workspaceNavigation.primaryLabel")} className="ml-5 hidden min-w-0 items-center gap-1 lg:flex">
                            {navigationTools.map((tool) => {
                                const Icon = tool.icon;
                                const active = tool.slug === navigation.area;
                                const className = cn(
                                    "relative flex h-9 shrink-0 items-center gap-2 rounded-md px-3 ui-nav-label transition-colors",
                                    active ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                                );
                                if (tool.slug === "workflows" && !localComfyuiEnabled) {
                                    return (
                                        <Tooltip key={tool.slug} title={t("workspaceNavigation.workflowSettingsHint")}>
                                            <button type="button" className={className} onClick={showWorkflowNotice} aria-haspopup="dialog">
                                                <Icon className="size-4" />
                                                <span>{t(`workspaceNavigation.${tool.slug}`)}</span>
                                                <span className="size-1.5 rounded-full bg-muted-foreground/50" aria-label={t("workspaceNavigation.disabled")} />
                                            </button>
                                        </Tooltip>
                                    );
                                }
                                return (
                                    <Link key={tool.slug} to={tool.href} aria-current={active ? "page" : undefined} className={className}>
                                        <Icon className="size-4" />
                                        <span>{t(`workspaceNavigation.${tool.slug}`)}</span>
                                    </Link>
                                );
                            })}
                        </nav>
                    </div>

                    <div className="flex shrink-0 items-center gap-1 whitespace-nowrap">
                        <GlobalTaskButton className="ui-icon-button" />
                        <UserStatusActions />
                    </div>
                </div>
                {navigation.secondary && !(navigation.secondary === "projects" && ["/projects", "/canvas", "/production"].includes(pathname)) ? <WorkspaceSecondaryNav workspace={navigation.secondary} activeSlug={navigation.activeSecondary} /> : null}
            </header>

            <MobileNavDrawer open={mobileNavOpen} activeToolSlug={navigation.area} onClose={() => setMobileNavOpen(false)} onUnavailableWorkflows={showWorkflowNotice} />
            <Modal
                rootClassName="canvas-blocking-overlay"
                title={t("workspaceNavigation.workflowsDisabledTitle")}
                open={workflowNoticeOpen}
                onCancel={() => setWorkflowNoticeOpen(false)}
                footer={
                    <Button
                        type="primary"
                        onClick={() => {
                            setWorkflowNoticeOpen(false);
                            openConfigDialog(false, "preferences");
                        }}
                    >
                        {t("workspaceNavigation.openPreferences")}
                    </Button>
                }
            >
                <p className="py-2 text-sm leading-6 text-muted-foreground">{t("workspaceNavigation.workflowsDisabledDescription")}</p>
            </Modal>
            <AppConfigModal />
        </>
    );
}
