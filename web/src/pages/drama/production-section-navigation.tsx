import { useTranslation } from "react-i18next";

/** Scope the jump to this workspace, including when a compact workspace is nested. */
export function focusProductionSection(control: { closest: (selector: string) => Element | null }, id: string) {
    const root = control.closest("[data-production-section-root]");
    const section = root?.querySelector<HTMLElement>(`[data-production-section="${id}"]`);
    if (section?.tagName === "DETAILS") (section as HTMLDetailsElement).open = true;
    const standalone = section?.closest?.("[data-production-workspace-shell]");
    const content = standalone ? section?.closest?.<HTMLElement>("[data-production-workspace-content]") : null;
    if (section && content) content.scrollTop += section.getBoundingClientRect().top - content.getBoundingClientRect().top;
    else section?.scrollIntoView({ block: "start" });
    section?.focus({ preventScroll: true });
}

/** Local section shortcuts only scroll and focus; workspace URLs and drafts stay intact. */
export function ProductionSectionNavigation({ items }: { items: Array<{ id: string; label: string }> }) {
    const { t } = useTranslation();
    return <nav aria-label={t("director.micro.sectionNavigation")} className="flex flex-wrap items-center gap-1 border-b border-border pb-3" data-production-section-navigation>
        {items.map(item => <button key={item.id} type="button" className="min-h-9 rounded-md px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" onClick={event => focusProductionSection(event.currentTarget, item.id)}>{item.label}</button>)}
    </nav>;
}
