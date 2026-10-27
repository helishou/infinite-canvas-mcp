import { useEffect, useState, type CSSProperties } from "react";
import { Popover, Tooltip } from "antd";
import { Activity, BookOpen, Keyboard, MoreHorizontal, Puzzle, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";

import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { CANVAS_GITHUB_URL, GitHubLink } from "@/components/layout/github-link";
import { VersionReleaseModal } from "@/components/layout/version-release-modal";
import { DOCS_URL } from "@/constant/env";
import { changeAppLocale, type AppLocale } from "@/i18n";
import { canvasThemes } from "@/lib/canvas-theme";
import { useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";

type UserStatusActionsProps = {
    showConfig?: boolean;
    variant?: "default" | "canvas";
    onOpenShortcuts?: () => void;
    onOpenPlugins?: () => void;
};

export function UserStatusActions({ showConfig = true, variant = "default", onOpenShortcuts, onOpenPlugins }: UserStatusActionsProps) {
    const { i18n, t } = useTranslation();
    const { pathname, search } = useLocation();
    const [moreOpen, setMoreOpen] = useState(false);
    useEffect(() => setMoreOpen(false), [pathname, search]);
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const canvasTheme = canvasThemes[theme];
    const naturalIconClass = "ui-icon-button inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";
    const iconStyle: CSSProperties | undefined = variant === "canvas" ? { color: canvasTheme.node.text } : undefined;
    const locale = i18n.resolvedLanguage as AppLocale;
    const nextLocale = locale === "zh-CN" ? "en-US" : "zh-CN";
    const languageLabel = t("topNav.switchLanguage", { language: t(nextLocale === "zh-CN" ? "locale.zhCN" : "locale.enUS") });
    const themeLabel = t(theme === "dark" ? "topNav.lightTheme" : "topNav.darkTheme");
    const popoverRowClass = "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted";

    const languageButton = (
        <Tooltip title={languageLabel} mouseEnterDelay={0.2}>
            <button type="button" className={`${naturalIconClass} text-xs font-semibold`} style={iconStyle} onClick={() => void changeAppLocale(nextLocale)} aria-label={languageLabel}>
                {locale === "zh-CN" ? "中" : "EN"}
            </button>
        </Tooltip>
    );
    const themeButton = <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className={naturalIconClass} style={iconStyle} aria-label={themeLabel} title={themeLabel} />;

    return (
        <div className="inline-flex shrink-0 items-center gap-1">
            {onOpenPlugins ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenPlugins} aria-label={t("topNav.plugins")} title={t("topNav.plugins")}>
                    <Puzzle className="size-4" />
                </button>
            ) : null}
            {onOpenShortcuts ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenShortcuts} aria-label={t("topNav.shortcuts")} title={t("topNav.shortcuts")}>
                    <Keyboard className="size-4" />
                </button>
            ) : null}
            {showConfig && variant !== "canvas" ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={() => openConfigDialog(false)} aria-label={t("workspaceNavigation.settings")} title={t("workspaceNavigation.settings")}>
                    <Settings2 className="size-4" />
                </button>
            ) : null}
            {variant !== "canvas" ? (
                <div className="hidden items-center gap-1 sm:inline-flex">
                    {languageButton}
                    {themeButton}
                </div>
            ) : null}
            <Popover
                trigger="click"
                open={moreOpen}
                onOpenChange={setMoreOpen}
                placement="bottomRight"
                title={t("workspaceNavigation.more")}
                content={
                    <div className="w-56" data-canvas-shortcuts-ignore>
                        <div className={`mb-2 flex items-center justify-between gap-3 border-b border-border pb-2 ${variant === "canvas" ? "" : "sm:hidden"}`}>
                            <span className="text-xs text-muted-foreground">{t("workspaceNavigation.appearance")}</span>
                            <div className="flex items-center">
                                {languageButton}
                                {themeButton}
                            </div>
                        </div>
                        {showConfig && variant === "canvas" ? (
                            <button type="button" className={popoverRowClass} onClick={() => openConfigDialog(false)}>
                                <Settings2 className="size-4" />
                                {t("workspaceNavigation.settings")}
                            </button>
                        ) : null}
                        <Link to="/config" onClick={() => setMoreOpen(false)} className={popoverRowClass}>
                            <Settings2 className="size-4" />
                            {t("workspaceNavigation.allSettings")}
                        </Link>
                        <Link to="/diagnostics/mcp" onClick={() => setMoreOpen(false)} className={popoverRowClass}>
                            <Activity className="size-4" />
                            {t("workspaceNavigation.diagnostics")}
                        </Link>
                        <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className={popoverRowClass}>
                            <BookOpen className="size-4" />
                            {t("topNav.docs")}
                        </a>
                        <div className="mt-2 flex items-center justify-between border-t border-border px-2 pt-2">
                            <VersionReleaseModal className="rounded-md py-2 text-xs text-muted-foreground transition-colors hover:text-foreground" />
                            <GitHubLink href={variant === "canvas" ? CANVAS_GITHUB_URL : undefined} className={naturalIconClass} />
                        </div>
                    </div>
                }
            >
                <button type="button" className={naturalIconClass} style={iconStyle} aria-label={t("workspaceNavigation.more")} title={t("workspaceNavigation.more")} aria-haspopup="dialog" aria-expanded={moreOpen}>
                    <MoreHorizontal className="size-4" />
                </button>
            </Popover>
        </div>
    );
}
