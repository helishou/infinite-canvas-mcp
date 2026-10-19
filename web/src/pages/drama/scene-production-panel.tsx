import { useEffect, useState } from "react";
import { Alert, App, Button, Tag } from "antd";
import { useTranslation } from "react-i18next";
import { productionSceneEntries } from "@basketikun/canvas-agent/drama/production-contract";
import { fetchProductionSceneWork, type ProductionSceneAction, type EpisodeProduction, type ProductionTarget, type SceneWorkInspection } from "@/services/backend-api";
import { useAgentStore } from "@/stores/use-agent-store";

export function SceneProductionPanel({ production, owner, onRefresh, onCommand, onAskDirector, disabled = false, commandPending = false }: { production: EpisodeProduction; owner: ProductionTarget; onRefresh: () => void; onCommand: (action: ProductionSceneAction, revision: number) => Promise<unknown>; onAskDirector: (scope: { targetId?: string; workId?: string; instruction: string }) => void; disabled?: boolean; commandPending?: boolean }) {
    const { t } = useTranslation(), { message } = App.useApp();
    const [state, setState] = useState<SceneWorkInspection>();
    const [busy, setBusy] = useState(false), [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [starting, setStarting] = useState<"source" | "media">();
    const scenes = productionSceneEntries(production.draft.director?.source || {});
    const ownerKey = JSON.stringify(owner);
    useEffect(() => {
        let disposed = false;
        void fetchProductionSceneWork(owner).then(result => { if (!disposed) { setState(current => !current || result.state.revision >= current.revision ? result.state : current); setError(""); } }, reason => { if (!disposed) setError(String(reason)); });
        return () => { disposed = true; };
    }, [ownerKey, production.revision]);
    const perform = async (action: () => Promise<unknown>) => {
        setBusy(true); setError(""); setNotice("");
        try { await action(); const result = await fetchProductionSceneWork(owner); setState(current => !current || result.state.revision >= current.revision ? result.state : current); onRefresh(); }
        catch (reason) { setError(String(reason)); message.error(String(reason)); const fresh = await fetchProductionSceneWork(owner).catch(() => undefined); if (fresh) setState(current => !current || fresh.state.revision >= current.revision ? fresh.state : current); onRefresh(); }
        finally { setBusy(false); }
    };
    const start = (generateMedia: boolean, selectedSceneIds?: string[]) => {
        const sceneIds = scenes.filter(scene => (!selectedSceneIds || selectedSceneIds.includes(scene.id)) && !state?.works.some(work => work.sceneId === scene.id && work.status !== "failed" && !(work.status === "succeeded" && work.inputChanged) && !(generateMedia && work.status !== "succeeded" && (!work.generationAuthorized || work.status === "awaiting_review")))).map(scene => scene.id);
        if (!sceneIds.length) {
            const text = t(scenes.length ? "sceneProduction.alreadyStarted" : "sceneProduction.noScenes");
            setNotice(text); message.info(text);
            return;
        }
        const agent = useAgentStore.getState();
        setStarting(generateMedia ? "media" : "source");
        void perform(async () => {
            await onCommand({ action: "start", sceneIds, generateMedia, model: agent.model || undefined, effort: agent.reasoningEffort || undefined }, state?.revision ?? production.revision);
            setNotice(t(generateMedia ? "sceneProduction.mediaAccepted" : "sceneProduction.sourceAccepted", { count: sceneIds.length }));
        }).finally(() => setStarting(undefined));
    };
    const problems = [
        ...(error ? [{ key: "request", title: t("sceneProduction.title"), error, targetId: undefined, workId: undefined }] : []),
        ...(state?.works || []).filter(work => ["blocked", "failed"].includes(work.status) || (Boolean(work.error) && ["awaiting_review", "paused"].includes(work.status))).map(work => ({ key: work.workId, title: scenes.find(scene => scene.id === work.sceneId)?.title || work.sceneId, error: work.error || t(`sceneProduction.status.${work.status}`), targetId: work.sceneId, workId: work.workId })),
    ];
    const askDirector = (problem: (typeof problems)[number]) => onAskDirector({ targetId: problem.targetId, workId: problem.workId, instruction: t("sceneProduction.resolveInstruction", { title: problem.title, error: problem.error, context: JSON.stringify({ owner, revision: state?.revision ?? production.revision, sceneId: problem.targetId, workId: problem.workId }) }) });
    return <section className="space-y-3 rounded-xl border border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{t("sceneProduction.title")}</h3><div className="flex gap-2"><Button loading={starting === "source"} disabled={disabled || commandPending || busy || !scenes.length} onClick={() => start(false)}>{t("sceneProduction.startSource")}</Button><Button type="primary" loading={starting === "media"} disabled={disabled || commandPending || busy || !scenes.length} onClick={() => start(true)}>{t("sceneProduction.startMedia")}</Button></div></div>
        {notice && <Alert type="info" showIcon message={notice} />}
        {problems.length > 0 && <Alert type="error" showIcon message={t("sceneProduction.blockedTitle")} description={<div className="space-y-3"><p>{t("sceneProduction.blockedHint")}</p>{problems.map(problem => <div key={problem.key} className="space-y-1"><strong>{problem.title}</strong><p className="whitespace-pre-wrap break-words">{problem.error}</p><Button size="small" disabled={disabled || commandPending || busy} onClick={() => askDirector(problem)}>{t("sceneProduction.resolveWithDirector")}</Button></div>)}</div>} />}
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">{t("sceneProduction.scene")}</th>{["create", "assets", "review", "compile", "produce", "complete"].map(stage => <th key={stage} className="p-2">{t(`sceneProduction.stage.${stage}`)}</th>)}<th className="p-2">{t("sceneProduction.actions")}</th></tr></thead><tbody>
            {(state?.works || []).map(work => <tr key={work.workId} className="border-t border-border"><td className="p-2"><strong>{scenes.find(scene => scene.id === work.sceneId)?.title || work.sceneId}</strong>{Object.values(work.workAdoptions || {}).map(adoption => <p key={adoption.artifactHash} title={adoption.artifactHash} className="mt-1 text-xs text-muted-foreground">{t("sceneProduction.artifactAdoption", { hash: adoption.artifactHash.slice(0, 8), revision: adoption.revision })}</p>)}{work.error && <p className="mt-1 max-w-64 text-xs text-muted-foreground">{work.error}</p>}</td>{["create", "assets", "review", "compile", "produce", "complete"].map(stage => <td key={stage} className="p-2">{work.stage === stage ? <Tag color={work.status === "succeeded" ? "green" : ["blocked", "failed"].includes(work.status) ? "red" : "blue"}>{t(`sceneProduction.status.${work.status}`)}</Tag> : "—"}</td>)}<td className="p-2"><div className="flex flex-wrap gap-1">
                {work.status === "failed" && <Button size="small" disabled={disabled || commandPending || busy} onClick={() => start(false, [work.sceneId])}>{t("sceneProduction.repair")}</Button>}
                {!work.generationAuthorized && !["failed", "succeeded"].includes(work.status) && <Button size="small" disabled={disabled || commandPending || busy} onClick={() => start(true, [work.sceneId])}>{t("sceneProduction.authorize")}</Button>}
                {!["paused", "succeeded", "failed"].includes(work.status) && <Button size="small" disabled={disabled || commandPending || busy} onClick={() => void perform(() => onCommand({ action: "pause", workId: work.workId }, state!.revision))}>{t("sceneProduction.pause")}</Button>}
                {["paused", "blocked", "awaiting_review"].includes(work.status) && <Button size="small" disabled={disabled || commandPending || busy} onClick={() => void perform(() => onCommand({ action: "resume", workId: work.workId }, state!.revision))}>{t("sceneProduction.resume")}</Button>}
            </div></td></tr>)}
        </tbody></table></div>
    </section>;
}
