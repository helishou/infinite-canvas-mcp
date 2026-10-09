import { useEffect, useState } from "react";
import { Alert, App, Button, Input, Modal, Tag } from "antd";
import { MediaImage } from "@/components/media/media-image";
import { useTranslation } from "react-i18next";
import { productionSceneEntries } from "@basketikun/canvas-agent/drama/production-contract";
import { backendMediaUrl, fetchProductionSceneWork, type ProductionSceneAction, type EpisodeProduction, type ProductionTarget, type SceneWorkInspection } from "@/services/backend-api";
import { useAgentStore } from "@/stores/use-agent-store";
import { readableText } from "./director-display";

export function SceneProductionPanel({ production, owner, onRefresh, onCommand, onAskDirector, disabled = false, commandPending = false }: { production: EpisodeProduction; owner: ProductionTarget; onRefresh: () => void; onCommand: (action: ProductionSceneAction, revision: number) => Promise<unknown>; onAskDirector: (scope: { targetId?: string; workId?: string; instruction: string }) => void; disabled?: boolean; commandPending?: boolean }) {
    const { t } = useTranslation(), { message } = App.useApp();
    const [state, setState] = useState<SceneWorkInspection>();
    const [busy, setBusy] = useState(false), [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [starting, setStarting] = useState<"source" | "media">();
    const [reviewing, setReviewing] = useState<"shared" | string>(), [evidence, setEvidence] = useState("");
    const [dossier, setDossier] = useState<{ active: SceneWorkInspection["works"][number] | NonNullable<SceneWorkInspection["shared"]>; inputHash?: string; revision: number; assetIds?: string[] }>();
    const openReview = (id: string) => {
        const active = id === "shared" ? state?.shared : state?.works.find(work => work.workId === id);
        if (!active || !state) return;
        setDossier(structuredClone({ active, inputHash: id === "shared" ? state.shared?.inputHash : state.works.find(work => work.workId === id)?.reviewInputHash, revision: state.revision, assetIds: id === "shared" ? state.shared?.reviewAssetIds : state.works.find(work => work.workId === id)?.reviewAssetIds }));
        setEvidence(""); setReviewing(id);
    };
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
        if (!production.draft.settings.reviewPolicy) return message.warning(t("sceneProduction.settingsMissing"));
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
    const active = dossier?.active, inputHash = dossier?.inputHash;
    const canReview = reviewing === "shared" || Boolean(active && "stage" in active && active.stage === "review" && ["awaiting_review", "paused"].includes(active.status));
    const sharedApproved = state?.shared?.reviewCurrent ?? (state?.shared?.review?.verdict === "approved");
    const sharedContinuation = state?.shared?.continuation;
    const sharedBusy = state?.shared?.reviewWorks?.some(work => ["pending", "running"].includes(work.status));
    const sharedErrors = [...new Set([state?.shared?.error, sharedContinuation?.error, ...(state?.shared?.reviewWorks || []).filter(work => work.status !== "succeeded").map(work => work.error)].filter((value): value is string => Boolean(value)))];
    const problems = [
        ...(error ? [{ key: "request", title: t("sceneProduction.title"), error, targetId: undefined, workId: undefined }] : []),
        ...(sharedErrors.length ? [{ key: "shared", title: t("sceneProduction.shared"), error: sharedErrors.join("\n"), targetId: undefined, workId: undefined }] : []),
        ...(state?.works || []).filter(work => ["blocked", "failed"].includes(work.status) || (Boolean(work.error) && ["awaiting_review", "paused"].includes(work.status))).map(work => ({ key: work.workId, title: scenes.find(scene => scene.id === work.sceneId)?.title || work.sceneId, error: work.error || t(`sceneProduction.status.${work.status}`), targetId: work.sceneId, workId: work.workId })),
    ];
    const askDirector = (problem: (typeof problems)[number]) => onAskDirector({ targetId: problem.targetId, workId: problem.workId, instruction: t("sceneProduction.resolveInstruction", { title: problem.title, error: problem.error, context: JSON.stringify({ owner, revision: state?.revision ?? production.revision, sceneId: problem.targetId, workId: problem.workId }) }) });
    const sourceEntries = [active?.source?.shots, active?.source?.script_scenes, active?.source?.asset_cards, active?.source?.asset_plan].find(value => Array.isArray(value) && value.length) as any[] | undefined;
    const reviewRecords = [...(active && "reviews" in active ? active.reviews || [] : []), ...(active && "assetReviews" in active ? active.assetReviews || [] : []), ...(active?.review ? [active.review] : [])];
    const review = (verdict: "approved" | "rejected") => {
        if (!canReview || !evidence.trim() || !inputHash) return message.warning(t("sceneProduction.viewRequired"));
        void perform(async () => { await onCommand({ action: "review", assetIds: dossier?.assetIds, workId: reviewing === "shared" ? undefined : reviewing, inputHash, verdict, evidence: evidence.trim() }, dossier!.revision); setReviewing(undefined); });
    };
    return <section className="space-y-3 rounded-xl border border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{t("sceneProduction.title")}</h3><div className="flex gap-2"><Button loading={starting === "source"} disabled={disabled || commandPending || busy || !scenes.length} onClick={() => start(false)}>{t("sceneProduction.startSource")}</Button><Button type="primary" loading={starting === "media"} disabled={disabled || commandPending || busy || !scenes.length} onClick={() => start(true)}>{t("sceneProduction.startMedia")}</Button></div></div>
        {notice && <Alert type="info" showIcon message={notice} />}
        {problems.length > 0 && <Alert type="error" showIcon message={t("sceneProduction.blockedTitle")} description={<div className="space-y-3"><p>{t("sceneProduction.blockedHint")}</p>{problems.map(problem => <div key={problem.key} className="space-y-1"><strong>{problem.title}</strong><p className="whitespace-pre-wrap break-words">{problem.error}</p><Button size="small" disabled={disabled || commandPending || busy} onClick={() => askDirector(problem)}>{t("sceneProduction.resolveWithDirector")}</Button></div>)}</div>} />}
        {state?.shared && !sharedApproved && <div className="space-y-2"><div className="flex flex-wrap items-center justify-between gap-2"><span>{t("sceneProduction.shared")}{state.shared.error && <span className="ml-2 text-xs text-muted-foreground">{state.shared.error}</span>}</span><div className="flex gap-2">{production.draft.settings.reviewPolicy?.shared === "automatic" && <Button disabled={disabled || commandPending || busy || sharedBusy || sharedContinuation?.status === "active"} onClick={() => { const agent = useAgentStore.getState(); void perform(() => onCommand({ action: "shared-review", model: agent.model || undefined, effort: agent.reasoningEffort || undefined }, state!.revision)); }}>{t(sharedContinuation?.status === "active" ? "sceneProduction.sharedEnabled" : "sceneProduction.sharedAuto")}</Button>}<Button disabled={busy || !state.shared.inputHash} onClick={() => openReview("shared")}>{t("sceneProduction.review")}</Button></div></div>{sharedContinuation && <p className="text-xs text-muted-foreground">{t(`sceneProduction.sharedContinuation.${sharedContinuation.status}`)}{sharedContinuation.error && ` · ${sharedContinuation.error}`}</p>}{state.shared.reviewWorks?.map(work => <p key={work.workId} className="text-xs text-muted-foreground">{t(`sceneProduction.sharedStatus.${work.status}`)}{work.error && ` · ${work.error}`}</p>)}</div>}
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">{t("sceneProduction.scene")}</th>{["create", "assets", "review", "compile", "produce", "complete"].map(stage => <th key={stage} className="p-2">{t(`sceneProduction.stage.${stage}`)}</th>)}<th className="p-2">{t("sceneProduction.actions")}</th></tr></thead><tbody>
            {(state?.works || []).map(work => <tr key={work.workId} className="border-t border-border"><td className="p-2"><strong>{scenes.find(scene => scene.id === work.sceneId)?.title || work.sceneId}</strong>{Object.values(work.workAdoptions || {}).map(adoption => <p key={adoption.artifactHash} title={adoption.artifactHash} className="mt-1 text-xs text-muted-foreground">{t("sceneProduction.artifactAdoption", { hash: adoption.artifactHash.slice(0, 8), revision: adoption.revision })}</p>)}{work.error && <p className="mt-1 max-w-64 text-xs text-muted-foreground">{work.error}</p>}</td>{["create", "assets", "review", "compile", "produce", "complete"].map(stage => <td key={stage} className="p-2">{work.stage === stage ? <Tag color={work.status === "succeeded" ? "green" : ["blocked", "failed"].includes(work.status) ? "red" : "blue"}>{t(`sceneProduction.status.${work.status}`)}</Tag> : "—"}</td>)}<td className="p-2"><div className="flex flex-wrap gap-1">
                {work.status === "failed" && <Button size="small" disabled={disabled || commandPending || busy} onClick={() => start(false, [work.sceneId])}>{t("sceneProduction.repair")}</Button>}
                {!work.generationAuthorized && !["failed", "succeeded"].includes(work.status) && <Button size="small" disabled={disabled || commandPending || busy} onClick={() => start(true, [work.sceneId])}>{t("sceneProduction.authorize")}</Button>}
                <Button size="small" disabled={busy} onClick={() => { openReview(work.workId); }}>{t("sceneProduction.review")}</Button>
                {!["paused", "succeeded", "failed"].includes(work.status) && <Button size="small" disabled={disabled || commandPending || busy} onClick={() => void perform(() => onCommand({ action: "pause", workId: work.workId }, state!.revision))}>{t("sceneProduction.pause")}</Button>}
                {["paused", "blocked", "awaiting_review"].includes(work.status) && <Button size="small" disabled={disabled || commandPending || busy} onClick={() => void perform(() => onCommand({ action: "resume", workId: work.workId }, state!.revision))}>{t("sceneProduction.resume")}</Button>}
            </div></td></tr>)}
        </tbody></table></div>
        <Modal title={t("sceneProduction.reviewTitle")} open={Boolean(reviewing)} onCancel={() => { if (!busy) setReviewing(undefined); }} footer={<><Button danger disabled={disabled || commandPending || busy || !inputHash || !canReview} onClick={() => review("rejected")}>{t("sceneProduction.reject")}</Button><Button type="primary" disabled={disabled || commandPending || busy || !inputHash || !canReview || !evidence.trim()} onClick={() => review("approved")}>{t("sceneProduction.approve")}</Button></>} width={880}>
            <div className="max-h-[65vh] space-y-4 overflow-y-auto">
                <h4 className="font-medium">{t("sceneProduction.source")}</h4>
                {(sourceEntries || []).map((item: any, index: number) => <article key={String(item.id || index)} className="rounded border border-border p-3"><strong>{item.title || item.display_summary || item.heading || item.id}</strong><p className="whitespace-pre-wrap">{readableText(item.visual || item.text || item.prompt || item.description || item)}</p>{item.performance && <p className="whitespace-pre-wrap">{readableText(item.performance)}</p>}{item.combat && <p className="whitespace-pre-wrap">{readableText(item.combat)}</p>}</article>)}
                {active?.media?.length ? <div className="grid grid-cols-2 gap-3">{active.media.map(item => <div key={item.targetId}><p className="text-xs">{item.targetId}</p><MediaImage src={backendMediaUrl(item.storageKey)} alt={item.targetId} /></div>)}</div> : <p className="text-muted-foreground">{t("sceneProduction.noMedia")}</p>}
                {reviewRecords.length > 0 && <details className="rounded border border-border p-3"><summary className="cursor-pointer font-medium">{t("sceneProduction.reviewHistory")}</summary><div className="mt-3 space-y-3">{reviewRecords.map((record, index) => <article key={`${record.checkedAt}:${index}`}><p className="text-xs text-muted-foreground">{t(`sceneProduction.verdict.${record.verdict}`)} · {new Date(record.checkedAt).toLocaleString()} · {record.media.map(item => item.targetId).join(", ")}</p><p className="whitespace-pre-wrap">{record.evidence}</p></article>)}</div></details>}
                <Input.TextArea value={evidence} onChange={event => setEvidence(event.target.value)} placeholder={t("sceneProduction.evidence")} autoSize={{ minRows: 3 }} />
            </div>
        </Modal>
    </section>;
}
