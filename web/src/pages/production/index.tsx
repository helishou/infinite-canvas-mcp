import { lazy, Suspense, useEffect, useState, type FormEvent } from "react";
import { App, Button } from "antd";
import { ArrowUp, Clapperboard, Images, Sparkles } from "lucide-react";
import { useLocation, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAgentStore } from "@/stores/use-agent-store";
import { useAgentSkillStore } from "@/stores/use-agent-skill-store";
import { useProductionFollowStore } from "@/stores/use-production-follow-store";
import { CANVAS_CREATIVE_SKILL_NAME } from "@/lib/agent/creative-launch";
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
        if (!skillStore.skills.some((skill) => skill.name === CANVAS_CREATIVE_SKILL_NAME && skill.enabled)) {
            await skillStore.loadSkills(agent.url, agent.token, true);
            if (!useAgentSkillStore.getState().skills.some((skill) => skill.name === CANVAS_CREATIVE_SKILL_NAME && skill.enabled)) {
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

    return <div className="min-h-full bg-background">
        <header className="mx-auto max-w-7xl px-4 pb-4 pt-7 sm:px-6 lg:px-10">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-orange-600 dark:text-orange-400">{t("productionHub.eyebrow")}</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">{t("productionHub.title")}</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{t("productionHub.description")}</p>
        </header>
        <section className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-10" aria-labelledby="production-creative-title">
            <div className="rounded-2xl border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-950 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                        <p className="flex items-center gap-2 text-xs font-medium text-stone-500 dark:text-stone-400"><Sparkles className="size-3.5" />{t("productionHub.creative.eyebrow")}</p>
                        <h2 id="production-creative-title" className="mt-2 text-xl font-semibold">{t("productionHub.creative.title")}</h2>
                        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{t("productionHub.creative.description")}</p>
                    </div>
                    <div className="flex rounded-lg border border-stone-200 p-1 dark:border-stone-800" role="group" aria-label={t("productionHub.creative.modeLabel")}>
                        <button type="button" aria-pressed={creativeMode === "asset"} onClick={() => setCreativeMode("asset")} className={cn("flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors", creativeMode === "asset" ? "bg-foreground !text-background" : "text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-900")}><Images className="size-4" />{t("productionHub.creative.asset")}</button>
                        <button type="button" aria-pressed={creativeMode === "drama"} onClick={() => setCreativeMode("drama")} className={cn("flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors", creativeMode === "drama" ? "bg-foreground !text-background" : "text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-900")}><Clapperboard className="size-4" />{t("productionHub.creative.drama")}</button>
                    </div>
                </div>
                <form onSubmit={startCreativeConversation} className="mt-5 rounded-xl border border-stone-200 bg-stone-50 p-3 focus-within:border-stone-400 dark:border-stone-800 dark:bg-stone-900/60 dark:focus-within:border-stone-600">
                        <textarea value={creativeDraft} disabled={Boolean(queuedCreativeLaunch)} onChange={(event) => setCreativeDraft(event.target.value)} rows={3} placeholder={t(creativeMode === "drama" ? "productionHub.creative.dramaPlaceholder" : "productionHub.creative.assetPlaceholder")} aria-label={t("productionHub.creative.ideaLabel")} className="w-full resize-y bg-transparent text-sm leading-6 text-stone-900 outline-none placeholder:text-stone-400 dark:text-stone-100 dark:placeholder:text-stone-500 disabled:opacity-70" />
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                        <span className="text-xs text-stone-500 dark:text-stone-400">{queuedCreativeLaunch ? t(agentConnected ? "productionHub.creative.sending" : "productionHub.creative.connecting") : t("productionHub.creative.hint")}</span>
                        <Button type="primary" htmlType="submit" disabled={!creativeDraft.trim() || Boolean(creativeLaunch) || Boolean(queuedCreativeLaunch)} icon={<ArrowUp className="size-4" />}>{queuedCreativeLaunch ? t("productionHub.creative.sending") : t("productionHub.creative.start")}</Button>
                    </div>
                </form>
            </div>
        </section>
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-10">
            <nav className="mb-2 flex gap-1 border-b border-border" role="tablist" aria-label={t("productionHub.objectViews")}>
                {(["canvases", "dramas"] as const).map(view => <button
                    key={view}
                    type="button"
                    role="tab"
                    id={`production-tab-${view}`}
                    aria-selected={activeView === view}
                    aria-controls={`production-view-${view}`}
                    onClick={() => selectView(view)}
                    className={`relative -mb-px inline-flex items-center border-b-2 px-4 py-3 text-sm transition ${activeView === view ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                >{t(`productionHub.${view === "canvases" ? "canvasProjects" : "seriesAndEpisodes"}`)}</button>)}
            </nav>
            <div id={`production-view-${activeView}`} role="tabpanel" aria-labelledby={`production-tab-${activeView}`}>
                <Suspense fallback={<div className="py-12 text-center text-sm text-muted-foreground">{t("canvas.loading")}</div>}>
                    {activeView === "canvases" ? <CanvasProjects /> : <SeriesEpisodes />}
                </Suspense>
            </div>
        </div>
    </div>;
}
