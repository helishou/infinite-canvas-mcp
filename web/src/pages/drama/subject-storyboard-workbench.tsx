import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Button, Input, Tag } from "antd";
import { Activity, ArrowRight, Clapperboard, Image as ImageIcon, Layers3, Search, Users, WandSparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isSubjectPromptAssembly, type DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { subjectShotWindows, subjectStateProjection } from "@basketikun/canvas-agent/drama/subject-assembly";
import { backendMediaUrl, fetchProductionWorkbench, type EpisodeProduction, type ProductionTarget } from "@/services/backend-api";
import { records, formatSeconds, readableText } from "./director-display";
import { productionWorkbenchValue, subjectDisplayName } from "./subject-shot-draft";
import { continuityPresentation } from "./continuity-presentation";
import { ReferenceNodeLink } from "./reference-node-link";
import { storyboardDurationFrames, storyboardPeople, storyboardReportedState } from "./storyboard-display";

type Props = {
    director: DirectorProduction; production: EpisodeProduction; owner: ProductionTarget; initialShotId?: string;
    canvasNodes: Array<{ id: string; metadata?: Record<string, unknown> }>;
    renderEditor: (shot: Record<string, any>, workbench?: Record<string, any>) => ReactNode; clipEditor: ReactNode;
    onSubjects: () => void; onContinuity: () => void; onClip: (id: string) => void;
    onDiscuss: (shotId?: string) => void;
};

/** The v2 authoring surface: stable Shots, derived Clip packaging, and compiler evidence. */
export function SubjectStoryboardWorkbench({ director, production, owner, initialShotId, canvasNodes, renderEditor, clipEditor, onSubjects, onContinuity, onClip, onDiscuss }: Props) {
    const { t } = useTranslation();
    const source = director.source as Record<string, any>;
    const subjectAssembly = isSubjectPromptAssembly(source);
    const humanState = continuityPresentation({ facts: records(source.ledger?.facts), timelines: records(source.ledger?.timelines), scenes: records(source.script_scenes), locations: records(source.scene_registry), characters: records(source.character_registry), assets: records(source.asset_plan), shots: records(source.shots), segments: records(source.segments), sourceBlocks: [] }, (key, values) => t(`director.workspace.continuity.${key}`, values));
    const fps = Number(source.fps_num || 24) / Number(source.fps_den || 1);
    const shots = records(source.shots).sort((a, b) => Number(a.story_order) - Number(b.story_order)), clips = records(source.segments), subjects = records(source.subject_registry);
    const [selectedId, setSelectedId] = useState(initialShotId || "");
    const [search, setSearch] = useState("");
    const [view, setView] = useState<"shots" | "clips">("shots");
    const [workbench, setWorkbench] = useState<Record<string, any>>();
    const [workbenchError, setWorkbenchError] = useState("");
    const [retry, setRetry] = useState(0);
    const [reading, setReading] = useState(false);
    const windows = useMemo(() => subjectShotWindows(source), [source]);
    const states = useMemo(() => subjectStateProjection(source), [source]);
    const ownerKey = JSON.stringify(owner);
    useEffect(() => { if (initialShotId) { setSelectedId(initialShotId); setView("shots"); } }, [initialShotId, ownerKey]);
    const selected = shots.find(shot => String(shot.id) === selectedId) || shots[0];
    const activeId = String(selected?.id || "");
    const clip = clips.find(item => (item.shot_ids || []).includes(activeId));
    const clipIndex = clips.findIndex(item => item.id === clip?.id);
    const number = shots.findIndex(item => String(item.id) === activeId) + 1;
    const title = (shot: Record<string, any>) => String(shot.title || t("director.studio.shotNumber", { number: shots.findIndex(item => item.id === shot.id) + 1 }));
    const framing = (shot: Record<string, any>) => ["EWS", "WS", "FS", "MS", "MCU", "CU", "ECU"].includes(shot.camera?.framing) ? t("director.atomic.framingName." + shot.camera.framing) : shot.camera?.framing || "—";
    const duration = (shot: Record<string, any>) => storyboardDurationFrames(shot) / fps;
    const people = (shot: Record<string, any>) => storyboardPeople(source, shot, subjectAssembly).join(" · ");
    const visible = shots.filter(shot => `${title(shot)} ${shot.visual || ""} ${people(shot)}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
    const referencedNodes = new Set(records(selected?.subject_usages).flatMap(usage => records(subjects.find(subject => subject.id === usage.subjectId)?.pictureBindings).map(binding => String(binding.sourceNode?.nodeId || "")))
        .concat(records(selected?.keyframes).map(frame => String(frame.sourceNode?.nodeId || ""))));
    // Metadata only invalidates this read; Backend still selects and verifies the result.
    const referenceVersion = JSON.stringify(canvasNodes.filter(node => referencedNodes.has(node.id)).map(node => [node.id, node.metadata?.images, node.metadata?.storageKey, node.metadata?.resultStorageKey, node.metadata?.primaryImageId, node.metadata?.smartImageReferenceSelection]));
    const readView = subjectAssembly ? "shot_workbench" : "clip_workbench";
    const readId = subjectAssembly ? activeId : String(clip?.id || "");
    useEffect(() => {
        if (!readId) { setWorkbench(undefined); setReading(false); return; }
        let current = true;
        setReading(true); setWorkbench(undefined); setWorkbenchError("");
        void fetchProductionWorkbench(owner, readView, readId).then(result => {
            if (!current) return;
            if (result.production.sourceHash !== director.sourceHash) { setWorkbenchError(t("director.atomic.changedRead")); return; }
            setWorkbench(productionWorkbenchValue(result.production, subjectAssembly ? "shot" : "clip"));
        }).catch(error => { if (current) setWorkbenchError(error instanceof Error ? error.message : String(error)); })
            .finally(() => { if (current) setReading(false); });
        return () => { current = false; };
    }, [readId, readView, ownerKey, director.sourceHash, production.revision, referenceVersion, retry, t]);
    const artifact = director.artifacts.find(item => item.kind === "h3" && item.targetId === clip?.id);
    const refresh = production.clipRefreshes?.find(item => item.segmentId === clip?.id);
    const compiled = Boolean(artifact && records(subjectAssembly ? workbench?.directorArtifacts : workbench?.directorReferences?.compiled).some(item => item.id === artifact.id && item.sha256 === artifact.sha256 && item.current === true && item.status === "ready"));
    const state = subjectAssembly ? workbench?.continuity || states[activeId] : storyboardReportedState(workbench?.continuity, activeId);
    const assetIds = [...new Set([...(selected?.required_assets || []), ...(director.shotInputs[activeId]?.assetIds || [])].map(String))];
    const references: Array<Record<string, any> & { subjectId: string }> = subjectAssembly ? records(workbench?.subjectUsages).flatMap(usage => records(usage.pictureBindings).map(binding => ({ ...binding, subjectId: String(usage.subjectId), presentation: usage.presentation })))
        : assetIds.map(assetId => ({ id: assetId, subjectId: assetId, displayName: records(source.asset_plan).find(asset => String(asset.asset_id || asset.id) === assetId)?.asset_name || assetId, resolved: workbench?.assets?.[assetId] || director.assets[assetId] }));
    const keyframes = records(workbench?.keyframes), referenceDiagnostics = records(workbench?.resolutionDiagnostics);
    const totalSeconds = shots.reduce((sum, shot) => sum + duration(shot), 0);
    const statusLabel = refresh ? t("director.workspace.clipRefreshStatus." + refresh.status, { segment: t("director.studio.clipNumber", { number: clipIndex + 1 }) })
        : t(compiled ? "director.atomic.compiled" : "director.atomic.pendingCompile");
    return <div className="space-y-5" data-subject-storyboard-workbench>
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
            <div><p className="text-xs font-medium text-muted-foreground">{t("director.atomic.sourceEditing")}</p><h2 className="mt-1 text-2xl font-semibold tracking-tight">{t("director.atomic.title")}</h2><p className="mt-2 text-sm text-muted-foreground">{t(subjectAssembly ? "director.atomic.subtitle" : "director.atomic.legacyLayoutHint")}</p></div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{t("director.atomic.counts", { shots: shots.length, clips: clips.length, seconds: formatSeconds(totalSeconds) })}</span><Button type="text" size="small" icon={<Users className="size-3.5" />} onClick={onSubjects}>{t("director.atomic.subjects")}</Button><Button type="text" size="small" icon={<Activity className="size-3.5" />} onClick={onContinuity}>{t("director.atomic.ledger")}</Button><Button type="text" size="small" icon={<WandSparkles className="size-3.5" />} onClick={() => onDiscuss(activeId || undefined)}>{t("director.studio.collaborate")}</Button></div>
        </header>
        <div className="flex flex-wrap items-center gap-5"><div className="flex items-center gap-1" role="tablist" aria-label={t("director.atomic.views")}>{(["shots", "clips"] as const).map(key => <button key={key} type="button" role="tab" aria-selected={view === key} onClick={() => setView(key)} className={`flex items-center gap-2 border-b-2 px-1 py-2 text-sm ${view === key ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>{key === "shots" ? <Clapperboard className="size-4" /> : <Layers3 className="size-4" />}{t("director.atomic.view." + key)}</button>)}</div><span className="ml-auto text-xs text-muted-foreground">{t(subjectAssembly ? "director.atomic.automaticAssembly" : "director.atomic.legacyCompileHint")}</span></div>
        {view === "clips" ? <div className="space-y-3"><p className="text-sm text-muted-foreground">{t(subjectAssembly ? "director.atomic.packagingHint" : "director.atomic.legacyPackagingHint")}</p>{clipEditor}</div> : !shots.length ? <Alert type="info" message={t("director.workspace.noShots")} /> : <>
            <div className="flex gap-4 overflow-x-auto pb-2" aria-label={t("director.atomic.timeline")}>
                {clips.map((group, index) => { const members = shots.filter(shot => (group.shot_ids || []).includes(shot.id)); return <section key={group.id} className="min-w-fit border-l border-border pl-3"><div className="mb-2 flex items-center justify-between gap-5 text-xs text-muted-foreground"><button type="button" onClick={() => onClip(String(group.id))} className="flex items-center gap-1 hover:text-foreground">{t("director.studio.clipNumber", { number: index + 1 })}<ArrowRight className="size-3" /></button><span>{formatSeconds(members.reduce((sum, shot) => sum + duration(shot), 0))}s</span></div><div className="flex gap-1.5">{members.map(shot => <button type="button" key={shot.id} onClick={() => setSelectedId(String(shot.id))} aria-pressed={activeId === String(shot.id)} title={title(shot)} className={`min-w-20 rounded-md border px-3 py-2 text-left ${activeId === String(shot.id) ? "border-primary/40 bg-primary/10" : "border-border hover:bg-muted/40"}`}><span className="block text-xs font-medium">{String(shots.findIndex(item => item.id === shot.id) + 1).padStart(2, "0")} · {framing(shot)}</span><span className="mt-1 block text-[11px] tabular-nums text-muted-foreground">{formatSeconds(duration(shot))}s</span></button>)}</div></section>; })}
            </div>
            <div className="grid min-w-0 gap-5 lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_250px]">
                <nav className="min-w-0 border-b border-border pb-4 lg:border-b-0 lg:border-r lg:pr-4" aria-label={t("director.atomic.shotList")}>
                    <Input size="small" allowClear prefix={<Search className="size-3.5" />} value={search} onChange={event => setSearch(event.target.value)} placeholder={t("director.studio.searchShots")} aria-label={t("director.studio.searchShots")} />
                    <div className="mt-3 max-h-[60dvh] space-y-1 overflow-y-auto">{visible.map(shot => <button key={shot.id} type="button" aria-current={activeId === String(shot.id) ? "true" : undefined} onClick={() => setSelectedId(String(shot.id))} className={`w-full rounded-lg px-3 py-3 text-left ${activeId === String(shot.id) ? "bg-muted font-medium" : "hover:bg-muted/40"}`}><div className="flex items-baseline gap-2"><span className="text-[11px] tabular-nums text-muted-foreground">{String(shots.findIndex(item => item.id === shot.id) + 1).padStart(2, "0")}</span><span className="min-w-0 flex-1 truncate text-sm">{title(shot)}</span><span className="text-[11px] text-muted-foreground">{formatSeconds(duration(shot))}s</span></div><p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{people(shot) || t("director.atomic.noSubjects")}</p><div className="mt-1.5 flex gap-2 text-[10px] text-muted-foreground"><span>{framing(shot)}</span>{records(shot.utterance_refs).length > 0 && <span>{t("director.atomic.dialogue")}</span>}{states[String(shot.id)]?.unresolved.length > 0 && <span className="text-amber-600">{t("director.atomic.stateIssue")}</span>}</div></button>)}{!visible.length && <p className="p-3 text-xs text-muted-foreground">{t("director.studio.emptyShotSearch")}</p>}</div>
                </nav>
                <section className="min-w-0" data-production-target={`shot:${activeId}`}>
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><div><p className="text-xs text-muted-foreground">{t("director.studio.shotNumber", { number })} · {clip ? t("director.studio.clipNumber", { number: clipIndex + 1 }) : "—"} · {formatSeconds((windows.get(activeId)?.startFrame || 0) / fps)}–{formatSeconds((windows.get(activeId)?.endFrame || 0) / fps)}s</p></div><Tag color={refresh?.blockingDiagnostic ? "orange" : compiled ? "green" : undefined}>{statusLabel}</Tag></div>
                    {refresh?.blockingDiagnostic && <Alert className="mb-4" type="warning" showIcon message={refresh.blockingDiagnostic.message} />}
                    {referenceDiagnostics.map((diagnostic, index) => <Alert key={index} className="mb-4" type="warning" showIcon message={diagnostic.message || diagnostic.code} />)}
                    {renderEditor(selected, workbench)}
                </section>
                <aside className="min-w-0 space-y-5 border-t border-border pt-4 lg:col-span-2 xl:col-span-1 xl:border-t-0 xl:border-l xl:pt-0 xl:pl-4">
                    <section><h3 className="flex items-center gap-2 text-sm font-medium"><ImageIcon className="size-4" />{t("director.atomic.references")}</h3><p className="mt-1 text-xs text-muted-foreground">{t(subjectAssembly ? "director.atomic.referencesHint" : "director.atomic.legacyReferencesHint")}</p>{reading ? <p className="mt-3 text-xs text-muted-foreground">{t("director.atomic.loading")}</p> : workbenchError ? <div className="mt-3 text-xs"><p className="text-muted-foreground">{workbenchError}</p><Button size="small" type="text" onClick={() => setRetry(value => value + 1)}>{t("director.atomic.retry")}</Button></div> : <div className="mt-3 space-y-3">{references.map(reference => <div key={`${reference.subjectId}:${reference.id}`} className="flex gap-3">{reference.resolved?.storageKey ? <img src={backendMediaUrl(reference.resolved.storageKey)} alt={reference.displayName || subjectDisplayName(source, reference.subjectId)} className="h-16 w-16 shrink-0 rounded object-contain" loading="lazy" /> : <span className="flex h-16 w-16 shrink-0 items-center justify-center text-muted-foreground"><ImageIcon className="size-5" /></span>}<div className="min-w-0"><p className="text-xs font-medium">{reference.displayName || subjectDisplayName(source, reference.subjectId)}</p><p className="mt-1 text-[11px] text-muted-foreground">{(reference.provides || []).map((purpose: string) => t(`director.crud.purpose.${purpose}`, { defaultValue: /[\u4e00-\u9fff]/.test(purpose) ? purpose : t("director.crud.otherPurpose") })).join(" · ")}</p><p className="mt-1 text-[11px] text-muted-foreground">{t(!subjectAssembly ? "director.atomic.legacyReferenceBinding" : reference.selection?.mode === "node_selection" ? "director.atomic.followNodeReference" : reference.selection?.mode === "selected_result" ? "director.workspace.selectedHistory" : "director.workspace.followLatest")}</p><ReferenceNodeLink sourceNode={reference.sourceNode} /></div></div>)}{!references.length && <p className="text-xs text-muted-foreground">{t("director.atomic.noResolvedReferences")}</p>}</div>}</section>
                    {keyframes.length > 0 && <section className="border-t border-border pt-4"><h3 className="text-sm font-medium">{t("director.atomic.keyframeReferences")}</h3><div className="mt-3 space-y-3">{keyframes.map(frame => <div key={frame.id} className="flex gap-3">{frame.resolved?.storageKey ? <img src={backendMediaUrl(frame.resolved.storageKey)} alt={t("director.atomic.anchor." + frame.anchor)} className="h-16 w-16 shrink-0 rounded object-contain" loading="lazy" /> : <span className="flex h-16 w-16 shrink-0 items-center justify-center text-muted-foreground"><ImageIcon className="size-5" /></span>}<div className="min-w-0"><p className="text-xs font-medium">{t("director.atomic.anchor." + frame.anchor)}</p><p className="mt-1 text-[11px] text-muted-foreground">{frame.requiredForSubmission ? t("director.atomic.requiredAnchor") : t("director.atomic.designAnchor")}</p>{frame.anchor === "at_frame" && <p className="mt-1 text-[11px] text-muted-foreground">{frame.localFrame}f</p>}</div></div>)}</div></section>}
                    <section className="border-t border-border pt-4"><div className="flex items-center justify-between"><h3 className="text-sm font-medium">{t("director.atomic.state")}</h3><Button size="small" type="text" aria-label={t("director.atomic.ledger")} onClick={onContinuity}><Activity className="size-3.5" /></Button></div><p className="mt-1 text-xs text-muted-foreground">{t(subjectAssembly ? "director.atomic.derivedState" : "director.atomic.legacyStateHint")}</p><div className="mt-3 space-y-3">{(["start", "end"] as const).map(phase => <div key={phase}><p className="text-[11px] font-medium text-muted-foreground">{t("director.atomic.statePhase." + phase)}</p>{records(state?.[phase]).map(item => <div key={item.factId} className="mt-2"><p className="text-[10px] text-muted-foreground">{item.subjectId ? subjectDisplayName(source, String(item.subjectId)) : item.property}</p><p className="text-xs leading-5">{humanState.value(String(item.factId), item.value)}</p></div>)}{!records(state?.[phase]).length && <p className="mt-1 text-xs text-muted-foreground">{t("director.atomic.noState")}</p>}</div>)}</div>{!subjectAssembly && <><p className="mt-3 text-xs leading-5">{readableText(selected?.state_description)}</p><details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">{t("director.studio.legacyStateDetails")}</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify({ start: selected?.state_in, end: selected?.state_out }, null, 2)}</pre></details></>}{records(state?.unresolved).length > 0 && <p className="mt-3 text-xs text-amber-600">{t("director.atomic.stateIssue")} · {records(state?.unresolved).map(item => humanState.fact(String(item.factId))).join(" · ")}</p>}</section>
                    <details className="border-t border-border pt-4"><summary className="cursor-pointer text-sm font-medium">{t("director.atomic.compiledOutput")}</summary><p className="mt-2 text-xs text-muted-foreground">{t(compiled ? "director.atomic.outputHint" : "director.atomic.previousOutput")}</p>{artifact ? <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs leading-5">{artifact.prompt}</pre> : <p className="mt-3 text-xs text-muted-foreground">{t("director.atomic.pendingCompile")}</p>}<Button className="mt-2" size="small" type="text" disabled={!clip} onClick={() => clip && onClip(String(clip.id))}>{t("director.atomic.openClip")}<ArrowRight className="size-3" /></Button></details>
                </aside>
            </div>
        </>}
    </div>;
}
