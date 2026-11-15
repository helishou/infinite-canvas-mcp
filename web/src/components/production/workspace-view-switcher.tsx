import { Tooltip } from "antd";
import { PanelsTopLeft, Workflow } from "lucide-react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { shouldSwitchWorkspace, type WorkspaceViewMode } from "./workspace-view-switcher-model";
import { cn } from "@/lib/utils";

export { WORKSPACE_VIEW_MODES, shouldSwitchWorkspace, type WorkspaceViewMode } from "./workspace-view-switcher-model";

export type WorkspaceViewSwitcherProps = {
    mode: WorkspaceViewMode;
    onSelect: (mode: WorkspaceViewMode) => void;
};

/**
 * 双图标胶囊视图切换器（形态参考影策 CanvasViewSwitch）：
 * 胶囊轨道 + 两个圆按钮 + aria-pressed 选中态 + 底部气泡提示。
 * 通过 portal 挂到 body，才能在 z-[900] 的画布 overlay 之上保持同一个控件。
 */
export function WorkspaceViewSwitcher({ mode, onSelect }: WorkspaceViewSwitcherProps) {
    const { t } = useTranslation();
    const items = [
        { value: "canvas" as const, Icon: Workflow, label: t("workspaceViewSwitcher.canvas") },
        { value: "production" as const, Icon: PanelsTopLeft, label: t("workspaceViewSwitcher.production") },
    ];
    const tooltipFor = (value: WorkspaceViewMode) => {
        if (mode === value) return t(value === "canvas" ? "workspaceViewSwitcher.currentCanvas" : "workspaceViewSwitcher.currentProduction");
        return t(value === "canvas" ? "workspaceViewSwitcher.switchToCanvas" : "workspaceViewSwitcher.switchToProduction");
    };
    const content = (
        <div
            role="group"
            aria-label={t("workspaceViewSwitcher.group")}
            data-testid="workspace-view-switcher"
            className="fixed left-1/2 top-3 z-[950] flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-card/90 p-1 shadow-lg backdrop-blur-xl"
        >
            {items.map(({ value, Icon, label }) => {
                const active = mode === value;
                return (
                    <Tooltip key={value} title={tooltipFor(value)} placement="bottom" mouseLeaveDelay={0}>
                        <button
                            type="button"
                            data-testid={`workspace-view-${value}`}
                            data-active={active ? "true" : "false"}
                            aria-pressed={active}
                            aria-label={label}
                            onClick={() => { if (shouldSwitchWorkspace(mode, value)) onSelect(value); }}
                            className={cn(
                                "grid size-9 place-items-center rounded-full transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                                active ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                            )}
                        >
                            <Icon className="size-[18px]" strokeWidth={1.75} aria-hidden="true" />
                        </button>
                    </Tooltip>
                );
            })}
        </div>
    );
    return typeof document === "undefined" ? null : createPortal(content, document.body);
}
