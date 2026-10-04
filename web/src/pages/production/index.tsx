import { lazy, Suspense, useEffect, useState, type FormEvent } from "react";
import { App, Button } from "antd";
import { ArrowUp, ArrowRight, Clapperboard, Images, Sparkles, LayoutGrid } from "lucide-react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAgentStore } from "@/stores/use-agent-store";
import { useAgentSkillStore } from "@/stores/use-agent-skill-store";
import { useProductionFollowStore } from "@/stores/use-production-follow-store";
import { findProjectAchengDirectorSkill } from "@/lib/agent/creative-launch";
import { cn } from "@/lib/utils";

const CanvasProjects = lazy(() => import("@/pages/director"));
const SeriesEpisodes = lazy(() => import("@/pages/drama"));

type ProductionView = "canvases" | "dramas";

export default function ProductionHubPage() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const { pathname } = useLocation();
    const [searchParams, setSearchParams] = useSearchParams();
    const requestedView = searchParams.get("view");
    const defaultView: ProductionView = pathname === "/drama" ? "dramas" : "canvases";
    const readView = (): ProductionView => requestedView === "dramas" || requestedView === "canvases" ? requestedView : defaultView;
    const [activeView, setActiveView] = useState<ProductionView>(readView);
    const creativeLaunch = useAgentStore((state) => state.creativeLaunch);
    const agentConnected = useAgentStore((state) => state.connected);
    const [creativeMode, setCreativeMode] = useState<"asset" | "drama">("asset");
    const [creativeDraft, setCreativeDraft] = useState("");
    const [queuedCreativeLaunch, setQueuedCreativeLaunch] = useState<{ id: string; text: string } | null>(null);
    useEffect(() => setActiveView(readView()), [requestedView, defaultView]);
    useEffect(() => {
        if (!queuedCreativeLaunch || creativeLaunch?.id === queuedCreativeLaunch.id) return;
        const composerText = useAgentStore.getState().prompt;
        setCreativeDraft(composerText === queuedCreativeLaunch.text ? queuedCreativeLaunch.text : "");
        setQueuedCreativeLaunch(null);
    }, [creativeLaunch, queuedCreativeLaunch]);
    const selectView = (view: ProductionView) => {
        setActiveView(view);
        setSearchParams({ view }, { replace: false });
    };

    const queueCreativeLaunch = (text: string, connected: boolean) => {
        const launch = { id: crypto.randomUUID(), mode: creativeMode, text, phase: "reset" as const };
        useProductionFollowStore.getState().setTarget({ workId: launch.id, mode: launch.mode });
        setQueuedCreativeLaunch({ id: launch.id, text });
        useAgentStore.getState().setAgentState({ activeTab: connected ? "chat" : "setup", creativeLaunch: launch });
    };

    const startCreativeConversation = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const text = creativeDraft.trim();
        if (!text) return;
        let agent = useAgentStore.getState();
        agent.openPanel();
        if (queuedCreativeLaunch || agent.creativeLaunch || agent.sending || agent.waiting || agent.loadingThreads || agent.connected && !["ready", "warning"].includes(agent.conversation.status)) {
            message.info(t("productionHub.creative.agentBusy"));
            return;
        }
        if (agent.prompt.trim() || agent.attachments.length || agent.canvasReferences.length) {
            agent.setAgentState({ activeTab: "chat" });
            message.info(t("productionHub.creative.finishDraft"));
            return;
        }
        if (!agent.connected) {
            if (!agent.token.trim()) {
                agent.setAgentState({ activeTab: "setup" });
                message.info(t("productionHub.creative.connectFirst"));
                return;
            }
            if (!agent.enabled) agent.connectAgent();
            agent = useAgentStore.getState();
            if (!agent.enabled) {
                agent.setAgentState({ activeTab: "setup" });
                message.warning(agent.connectError || t("productionHub.creative.connectFirst"));
                return;
            }
            queueCreativeLaunch(text, false);
            message.info(t("productionHub.creative.connecting"));
            return;
        }
        if (agent.sending || agent.waiting || agent.loadingThreads || !["ready", "warning"].includes(agent.conversation.status)) {
            message.info(t("productionHub.creative.agentBusy"));
            return;
        }
        const skillStore = useAgentSkillStore.getState();
        if (!findProjectAchengDirectorSkill(skillStore.skills)) {
            await skillStore.loadSkills(agent.url, agent.token, true);
            if (!findProjectAchengDirectorSkill(useAgentSkillStore.getState().skills)) {
                message.warning(t("productionHub.creative.skillUnavailable"));
                return;
            }
            agent = useAgentStore.getState();
            if (!agent.connected || agent.creativeLaunch || agent.sending || agent.waiting || agent.loadingThreads || !["ready", "warning"].includes(agent.conversation.status)) {
                message.info(t("productionHub.creative.agentBusy"));
                return;
            }
        }
        queueCreativeLaunch(text, true);
    };

    return <main className="min-h-full bg-background text-foreground" data-testid="production-home">
        <div className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8">
            <header className="mb-6 flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold tracking-tight">{t("landing.productionTitle")}</h1><p className="mt-1 text-sm text-muted-foreground">{t("landing.productionSubtitle")}</p></div><Link to="/" className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"><LayoutGrid className="size-4" />{t("landing.canvasHome")}<ArrowRight className="size-4" /></Link></header>
            <section aria-labelledby="production-creative-title" className="mb-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
                <div className="min-w-0 rounded-2xl border border-border bg-card p-5">
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h2 id="production-creative-title" className="text-xl font-semibold">{t("landing.ideaTitle")}</h2><span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Sparkles className="size-3.5" />{t("landing.withDirector")}</span></div>
                    <form onSubmit={startCreativeConversation}>
                        <textarea id="production-idea" value={creativeDraft} disabled={Boolean(queuedCreativeLaunch)} onChange={event => setCreativeDraft(event.target.value)} rows={2} placeholder={t(creativeMode === "drama" ? "landing.dramaPlaceholder" : "landing.assetPlaceholder")} aria-label={t("productionHub.creative.ideaLabel")} className="min-h-20 w-full resize-y rounded-xl border border-border bg-background px-4 py-3 text-base leading-7 text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground/50 disabled:opacity-70" />
                        {!creativeDraft.trim() && <div className="mt-2 flex flex-wrap gap-2">{[0, 1, 2].map(index => <button key={index} type="button" className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => { setCreativeDraft(t(`landing.examples.${creativeMode}.${index}.text`)); document.getElementById("production-idea")?.focus(); }}>{t(`landing.examples.${creativeMode}.${index}.label`)}</button>)}</div>}
                        <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><p className="max-w-md text-xs leading-5 text-muted-foreground">{queuedCreativeLaunch ? t(agentConnected ? "productionHub.creative.sending" : "productionHub.creative.connecting") : t("landing.conversationHint")}</p><Button type="primary" htmlType="submit" disabled={!creativeDraft.trim() || Boolean(creativeLaunch) || Boolean(queuedCreativeLaunch)} icon={<ArrowUp className="size-4" />}>{queuedCreativeLaunch ? t("productionHub.creative.sending") : t("landing.startConversation")}</Button></div>
                    </form>
                </div>
                <div className="order-first min-w-0 lg:order-none" role="group" aria-label={t("productionHub.creative.modeLabel")}><p className="mb-3 text-xs font-medium text-muted-foreground">{t("landing.whatToMake")}</p><div className="grid grid-cols-2 gap-3 lg:grid-cols-1">
                    {(["asset", "drama"] as const).map(mode => { const Icon = mode === "asset" ? Images : Clapperboard; return <button key={mode} type="button" aria-pressed={creativeMode === mode} onClick={() => setCreativeMode(mode)} className={cn("flex min-w-0 items-start gap-3 rounded-xl border p-4 text-left transition-colors", creativeMode === mode ? "border-foreground/40 bg-muted/60" : "border-border hover:bg-muted/30")}><Icon className="mt-0.5 size-5 shrink-0" /><span><strong className="block text-sm font-medium">{t(`landing.mode.${mode}`)}</strong><span className="mt-1 hidden text-xs leading-5 text-muted-foreground sm:block">{t(`landing.modeHint.${mode}`)}</span></span></button>; })}
                </div><p className="mt-3 hidden text-xs leading-5 text-muted-foreground lg:block">{t("landing.modeHintFooter")}</p></div>
            </section>
            <nav className="mb-5 flex gap-1 border-b border-border" role="tablist" aria-label={t("productionHub.objectViews")}>
                {(["canvases", "dramas"] as const).map(view => <button key={view} type="button" role="tab" id={`production-tab-${view}`} aria-selected={activeView === view} aria-controls={`production-view-${view}`} tabIndex={activeView === view ? 0 : -1} onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); const next = view === "canvases" ? "dramas" : "canvases"; selectView(next); document.getElementById(`production-tab-${next}`)?.focus(); } }} onClick={() => selectView(view)} className={`-mb-px inline-flex items-center gap-2 border-b-2 px-4 py-3 text-sm transition-colors ${activeView === view ? "border-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}>{view === "canvases" ? <Images className="size-4" /> : <Clapperboard className="size-4" />}{t(`landing.library.${view}`)}</button>)}
            </nav>
            <div id={`production-view-${activeView}`} role="tabpanel" aria-labelledby={`production-tab-${activeView}`}><Suspense fallback={<div className="py-12 text-center text-sm text-muted-foreground">{t("canvas.loading")}</div>}>{activeView === "canvases" ? <CanvasProjects /> : <SeriesEpisodes embedded />}</Suspense></div>
        </div>
    </main>;
}
