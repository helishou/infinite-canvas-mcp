import { useState } from "react";
import { Input, Modal } from "antd";
import { useTranslation } from "react-i18next";

import { searchCanvasShortcuts } from "@/lib/canvas/canvas-shortcuts";

/** 快捷键帮助：单一数据源 + 搜索 + 分类 + Kbd，键位不再写死在弹窗里。 */
export function CanvasShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { t, i18n } = useTranslation();
    const [query, setQuery] = useState("");
    const language = i18n.language?.toLowerCase().startsWith("zh") ? "zh" : "en";
    const groups = searchCanvasShortcuts(query, key => String(t(key)), language);
    const close = () => { setQuery(""); onClose(); };
    return <Modal title={t("canvas.shortcuts")} open={open} onCancel={close} footer={null} centered styles={{ body: { maxHeight: "min(70dvh, 560px)", overflowY: "auto", overscrollBehavior: "contain" } }}>
        <Input
            allowClear
            autoFocus
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t("canvas.shortcut.searchShortcuts", { defaultValue: "搜索快捷键（键位或说明）" })}
            aria-label={t("canvas.shortcut.searchShortcuts", { defaultValue: "搜索快捷键" })}
            className="mb-4"
        />
        {groups.length ? groups.map(group => <section key={group.category} className="mb-4 last:mb-0">
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.label}</h4>
            <dl className="divide-y divide-border">
                {group.entries.map(entry => <div key={entry.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                    <dt className="font-medium"><kbd className="inline-flex items-center rounded border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-xs">{entry.resolvedKeys}</kbd></dt>
                    <dd className="m-0 text-muted-foreground">{entry.resolvedLabel}</dd>
                </div>)}
            </dl>
        </section>) : <p className="py-8 text-center text-sm text-muted-foreground">{t("canvas.shortcut.noShortcuts", { defaultValue: "没有匹配的快捷键" })}</p>}
    </Modal>;
}
