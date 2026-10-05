import { useEffect, useRef, useState, type FormEvent } from "react";
import { App, Button } from "antd";
import { ArrowLeft, ArrowUp, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAgentStore } from "@/stores/use-agent-store";
import { useAgentSkillStore } from "@/stores/use-agent-skill-store";
import { useProductionFollowStore } from "@/stores/use-production-follow-store";
import { findProjectAchengDirectorSkill } from "@/lib/agent/creative-launch";

/** Kept mounted with the director runtime so closing the popup retains the creative draft. */
export function AgentCreativeWelcome({ active, onShowChat, onClose }: { active: boolean; onShowChat: () => void; onClose: () => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const inputRef = useRef<HTMLTextAreaElement>(null);
    useEffect(() => { if (active) inputRef.current?.focus(); }, [active]);
    const creativeLaunch = useAgentStore((state) => state.creativeLaunch);
    const agentConnected = useAgentStore((state) => state.connected);
    const creativeMode = "drama" as const;
    const [creativeDraft, setCreativeDraft] = useState("");
    const [queuedCreativeLaunch, setQueuedCreativeLaunch] = useState<{ id: string; text: string } | null>(null);
    useEffect(() => {
        if (!queuedCreativeLaunch || creativeLaunch?.id === queuedCreativeLaunch.id) return;
        const composerText = useAgentStore.getState().prompt;
        setCreativeDraft(composerText === queuedCreativeLaunch.text ? queuedCreativeLaunch.text : "");
        setQueuedCreativeLaunch(null);
    }, [creativeLaunch, queuedCreativeLaunch]);
    const queueCreativeLaunch = (text: string, connected: boolean) => {
        const launch = { id: crypto.randomUUID(), mode: creativeMode, text, phase: "reset" as const };
        useProductionFollowStore.getState().setTarget({ workId: launch.id, mode: launch.mode });
        setQueuedCreativeLaunch({ id: launch.id, text });
        useAgentStore.getState().setAgentState({ activeTab: connected ? "chat" : "setup", creativeLaunch: launch });
        onShowChat();
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
            onShowChat();
            message.info(t("productionHub.creative.finishDraft"));
            return;
        }
        if (!agent.connected) {
            if (!agent.token.trim()) {
                agent.setAgentState({ activeTab: "setup" });
                onShowChat();
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


    return <div hidden={!active} className="h-full min-h-0" data-director-creative-entry>
        <section aria-labelledby="production-creative-title" className="flex h-full min-h-0 flex-col">
            <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3"><Button type="text" size="small" icon={<ArrowLeft className="size-4" />} onClick={onShowChat}>{t("productionCanvas.currentConversation")}</Button><Button type="text" size="small" aria-label={t("agent.panel.collapseLabel")} icon={<X className="size-4" />} onClick={onClose} /></header>
            <form onSubmit={startCreativeConversation} className="flex min-h-0 flex-1 flex-col overflow-y-auto p-5">
                <h2 id="production-creative-title" className="text-xl font-semibold">{t("landing.ideaTitle")}</h2>
                <p className="mt-2 text-sm opacity-70">{t("landing.conversationHint")}</p>
                <textarea ref={inputRef} id="director-creative-idea" value={creativeDraft} disabled={Boolean(queuedCreativeLaunch)} onChange={event => setCreativeDraft(event.target.value)} rows={5} placeholder={t("landing.dramaPlaceholder")} aria-label={t("productionHub.creative.ideaLabel")} className="mt-5 min-h-28 w-full resize-y rounded-xl border border-border bg-transparent px-3 py-3 text-sm leading-6 outline-none focus:border-current disabled:opacity-70" />
                <div className="mt-3 flex flex-wrap gap-2">{[0, 1, 2].map(index => <button key={index} type="button" disabled={Boolean(queuedCreativeLaunch)} className="rounded-lg border border-border px-2.5 py-2 text-xs hover:bg-black/5 dark:hover:bg-white/10" onClick={() => { setCreativeDraft(t(`landing.examples.drama.${index}.text`)); inputRef.current?.focus(); }}>{t(`landing.examples.drama.${index}.label`)}</button>)}</div>
                <div className="mt-auto flex items-center justify-between gap-2 pt-5"><p className="text-xs opacity-70">{queuedCreativeLaunch ? t(agentConnected ? "productionHub.creative.sending" : "productionHub.creative.connecting") : t("landing.withDirector")}</p><Button type="primary" htmlType="submit" disabled={!creativeDraft.trim() || Boolean(creativeLaunch) || Boolean(queuedCreativeLaunch)} icon={<ArrowUp className="size-4" />}>{queuedCreativeLaunch ? t("productionHub.creative.sending") : t("landing.startConversation")}</Button></div>
            </form>
        </section>
    </div>;
}
