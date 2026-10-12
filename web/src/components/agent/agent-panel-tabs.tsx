import type { ReactNode } from "react";
import { Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";

export function AgentPanelTabs<T extends string>({ value, items, theme, leading, right, onChange }: { value: T; items: { value: T; label: string; icon?: ReactNode; count?: number }[]; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; leading?: ReactNode; right?: ReactNode; onChange: (value: T) => void }) {
    const { t } = useTranslation();
    return (
        <div className="@container shrink-0 border-b px-3" style={{ borderColor: theme.node.stroke }}>
            <div className="flex min-h-12 min-w-0 items-center justify-between gap-2 py-1">
                {leading ? <div className="flex min-w-0 items-center">{leading}</div> : null}
                {right ? <div className="ml-auto flex shrink-0 items-center gap-1">{right}</div> : null}
            </div>
            <nav className="grid min-w-0 grid-cols-4 gap-1" role="tablist" aria-label={t("agent.panel.content")}>
                {items.map((item) => (
                    <Tooltip key={item.value} title={`${item.label}${item.count ? ` ${item.count}` : ""}`} placement="bottom">
                        <button type="button" role="tab" aria-label={`${item.label}${item.count ? ` ${item.count}` : ""}`} aria-selected={value === item.value} className={`flex min-h-11 min-w-0 flex-col items-center justify-center gap-1 border-b-2 px-1 py-2 text-xs leading-4 transition hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-current dark:hover:bg-white/10 @min-[360px]:flex-row @min-[360px]:gap-1.5 @min-[480px]:text-sm ${value === item.value ? "font-medium" : "font-normal"}`} style={{ borderColor: value === item.value ? theme.node.text : "transparent", color: value === item.value ? theme.node.text : theme.node.muted }} onClick={() => onChange(item.value)}>
                            {item.icon ? <span className="inline-flex shrink-0 items-center justify-center" aria-hidden="true">{item.icon}</span> : null}
                            <span className="inline-flex min-w-0 flex-wrap items-center justify-center gap-x-1 gap-y-0.5">
                                {item.label}
                                {item.count ? <span className="text-[10px] font-normal leading-none tabular-nums opacity-60">{item.count > 99 ? "99+" : item.count}</span> : null}
                            </span>
                        </button>
                    </Tooltip>
                ))}
            </nav>
        </div>
    );
}
