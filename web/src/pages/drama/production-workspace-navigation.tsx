import { useState } from "react";
import { Button, Drawer } from "antd";
import { Activity, Clapperboard, FileText, Images, Layers3, ListChecks, ListVideo, Menu, PackageOpen, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ProductionNavigationGroup, ProductionNavigationItem } from "./production-workspace";

const icons = { series: Clapperboard, overview: ListChecks, story: FileText, assets: PackageOpen, shots: Clapperboard, continuity: Activity, clips: Layers3, production: Images, advanced: Settings2 };

export function ProductionWorkspaceNavigation({ groups, selectedId, onSelect, compact = false, horizontal = false }: {
    groups: ProductionNavigationGroup[];
    selectedId: string;
    onSelect: (item: ProductionNavigationItem) => void;
    compact?: boolean;
    horizontal?: boolean;
}) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const selected = groups.flatMap(group => group.items).find(item => item.id === selectedId);
    const navigation = <nav aria-label={t("director.workspace.navigation")} className="space-y-6" data-production-hierarchy>
        {groups.map(group => <section key={group.id} data-production-scope={group.id}>
            <h2 className="mb-2 px-3 text-xs font-medium text-muted-foreground">{t(group.labelKey)}</h2>
            <ul className="space-y-1">
                {group.items.map(item => {
                    const Icon = item.seriesView === "episodes" ? ListVideo : item.seriesView === "planning" ? Images : icons[item.workspace];
                    return <li key={item.id}><button type="button" aria-current={selectedId === item.id ? "page" : undefined}
                        onClick={() => { setOpen(false); if (selectedId !== item.id) onSelect(item); }}
                        className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${selectedId === item.id ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}
                    ><Icon className="size-4 shrink-0" /><span>{t(item.labelKey)}</span></button></li>;
                })}
            </ul>
        </section>)}
    </nav>;
    if (horizontal) return <><nav data-production-horizontal-navigation aria-label={t("director.workspace.navigation")}>
        {/* 剧目工作区显示剧目子 Tab（规划/共享画布/分集），分集制作区显示制作子 Tab。 */}
        {groups.filter(group => selectedId.startsWith("series:") ? group.id === "series" : group.id === "owner").flatMap(group => group.items).map(item => {
            const Icon = item.seriesView === "shared" ? Images : item.seriesView === "episodes" ? ListVideo : item.seriesView === "planning" ? Images : icons[item.workspace];
            return <button key={item.id} type="button" aria-current={selectedId === item.id ? "page" : undefined} onClick={() => { if (selectedId !== item.id) onSelect(item); }}><Icon className="size-4 shrink-0" /><span>{t(item.labelKey)}</span></button>;
        })}
    </nav>
        <div data-production-mobile-navigation><Button className="w-full !justify-start" icon={<Menu className="size-4" />} aria-expanded={open} onClick={() => setOpen(true)}>{selected ? t(selected.labelKey) + " · " : ""}{t("director.workspaceHierarchy.openNavigation")}</Button></div>
        <Drawer rootClassName="canvas-blocking-overlay" title={t("director.workspace.navigation")} placement="left" size={288} zIndex={1200} open={open} onClose={() => setOpen(false)}>{navigation}</Drawer>
    </>;
    return <>
        <aside className={compact ? "hidden" : "hidden min-w-0 border-r border-border pr-5 lg:block"}>
            <div className="sticky top-5">{navigation}</div>
        </aside>
        <div className={compact ? "mb-4" : "lg:hidden"}>
            <Button className="w-full !justify-start" icon={<Menu className="size-4" />} aria-label={t("director.workspaceHierarchy.openNavigation")} aria-expanded={open} onClick={() => setOpen(true)}>{selected ? t(selected.labelKey) : t("director.workspace.navigation")}</Button>
        </div>
        <Drawer rootClassName="canvas-blocking-overlay" title={t("director.workspace.navigation")} placement="left" size={288} zIndex={1200} open={open} onClose={() => setOpen(false)}>
            {navigation}
        </Drawer>
    </>;
}

export function ProductionWorkspaceBreadcrumb({ items }: { items: Array<{ id: string; label: string; onSelect?: () => void }> }) {
    const { t } = useTranslation();
    return <nav aria-label={t("director.workspaceHierarchy.breadcrumb")} className="mb-4 min-w-0">
        <ol className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {items.map((item, index) => <li key={item.id} className="flex min-w-0 items-center gap-2">
                {index > 0 && <span aria-hidden="true" className="text-muted-foreground/60">/</span>}
                {item.onSelect && index < items.length - 1 ? <button type="button" className="max-w-64 truncate rounded py-1 text-left hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary" title={item.label} onClick={item.onSelect}>{item.label}</button> : <span className="max-w-64 truncate py-1" title={item.label} aria-current={index === items.length - 1 ? "page" : undefined}>{item.label}</span>}
            </li>)}
        </ol>
    </nav>;
}
