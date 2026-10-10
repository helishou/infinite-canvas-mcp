import { Fragment, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Alert, App, Button, Dropdown, Input, Modal, Radio, Tag } from "antd";
import { ArrowRight, Clapperboard, Image as ImageIcon, Layers3, Search, WandSparkles } from "lucide-react";
import { nanoid } from "nanoid";
import { useTranslation } from "react-i18next";
import { isSubjectPromptAssembly, type DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { subjectShotWindows, subjectStateProjection } from "@basketikun/canvas-agent/drama/subject-assembly";
import { backendMediaUrl, applyProductionCompilation, compileProduction, fetchProductionCompilation, fetchProductionWorkbench, type EpisodeProduction, type ProductionTarget } from "@/services/backend-api";
import { records, formatSeconds } from "./director-display";
import { productionWorkbenchValue, subjectDisplayName } from "./subject-shot-draft";
import { continuityPresentation } from "./continuity-presentation";
import { currentClipRefreshes } from "./production-refresh-display";
import { ReferenceNodeLink } from "./reference-node-link";
import type { DirectorWorkspace } from "./director-panel";
import { storyboardDurationFrames, storyboardPeople, storyboardReportedState } from "./storyboard-display";
import { boundaryCounts, clipDurationSeconds, clipProfileKey, clipShotIds, materializeClipPartition, nearestBoundaryCount, outsideClipWindow, partitionAt } from "./clip-boundary";

type Props = {
    director: DirectorProduction; production: EpisodeProduction; owner: ProductionTarget; initialShotId?: string;
    canvasNodes: Array<{ id: string; metadata?: Record<string, unknown> }>;
    renderEditor: (shot: Record<string, any>, workbench?: Record<string, any>) => ReactNode; clipEditor: ReactNode;
    /** 该镜头的起止状态（镜头开始时 / 镜头结束时），由 DirectorPanel 注入到左栏「连续性状态」，原在「画面与摄影」里。 */
    renderShotState?: (shot: Record<string, any>) => ReactNode;
    /** 该镜头的连续性动作（与下一段的边界开关），由 DirectorPanel 注入到左栏编辑区下方的「连续性状态」。 */
    renderContinuity?: (shot: Record<string, any>) => ReactNode;
    /** 该镜头的操作行（和导演讨论 / 跳到所在片段），由 DirectorPanel 注入到左栏最底部。 */
    renderShotActions?: (shot: Record<string, any>) => ReactNode;
    /** v2 源稿的 Clip 重新装箱入口：时间线上的分割块拖动/右键都落到这个 op。 */
    onRepartitionClips?: (shotIds: string[], segments: Array<Record<string, unknown>>) => Promise<boolean>;
    /** Clip 组合视图的「一键编译」：本组件直接提交/轮询/应用编译回执，完成后回调 refresh 重读正式源稿。 */
    busy?: boolean; onRefresh?: () => void;
    onClip: (id: string) => void;
    onDiscuss: (shotId?: string) => void;
    /** 跳转到指定工作区（参考素材点开进素材库）。 */
    onNavigate: (workspace: DirectorWorkspace, target?: { kind: string; id: string }) => void;
};

/** The v2 authoring surface: stable Shots, derived Clip packaging, and compiler evidence. */
export function SubjectStoryboardWorkbench({ director, production, owner, initialShotId, canvasNodes, renderEditor, renderShotState, renderContinuity, renderShotActions, clipEditor, onRepartitionClips, busy, onRefresh, onClip, onDiscuss, onNavigate }: Props) {
    const { t } = useTranslation();
    const { message } = App.useApp();
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
    const currentRefreshes = currentClipRefreshes(production.clipRefreshes || [], clips.map(item => String(item.id)), director.sourceHash);
    const refreshCandidate = currentRefreshes.find(item => item.segmentId === clip?.id);
    const compiled = Boolean(artifact && records(subjectAssembly ? workbench?.directorArtifacts : workbench?.directorReferences?.compiled).some(item => item.id === artifact.id && item.sha256 === artifact.sha256 && item.current === true && item.status === "ready"));
    const refresh = compiled && ["blocked", "failed"].includes(refreshCandidate?.status || "") ? undefined : refreshCandidate;
    const state = subjectAssembly ? workbench?.continuity || states[activeId] : storyboardReportedState(workbench?.continuity, activeId);
    const assetIds = [...new Set([...(selected?.required_assets || []), ...(director.shotInputs[activeId]?.assetIds || [])].map(String))];
    const references: Array<Record<string, any> & { subjectId: string }> = subjectAssembly ? records(workbench?.subjectUsages).flatMap(usage => records(usage.pictureBindings).map(binding => ({ ...binding, subjectId: String(usage.subjectId), presentation: usage.presentation })))
        : assetIds.map(assetId => ({ id: assetId, subjectId: assetId, displayName: records(source.asset_plan).find(asset => String(asset.asset_id || asset.id) === assetId)?.asset_name || assetId, resolved: workbench?.assets?.[assetId] || director.assets[assetId] }));
    const keyframes = records(workbench?.keyframes), referenceDiagnostics = records(workbench?.resolutionDiagnostics);
    const totalSeconds = shots.reduce((sum, shot) => sum + duration(shot), 0);
    // 左栏「连续性状态」里的动作块（与下一段的边界开关），由 DirectorPanel 注入。
    const continuityActions = renderContinuity?.(selected);
    // 起止状态（镜头开始时 / 镜头结束时）：从「画面与摄影」挪进来，与台账状态、边界开关同区展示。
    const shotStateFields = renderShotState?.(selected);
    const statusLabel = refresh ? t("director.workspace.clipRefreshStatus." + refresh.status, { segment: t("director.studio.clipNumber", { number: clipIndex + 1 }) })
        : t(compiled ? "director.atomic.compiled" : "director.atomic.pendingCompile");
    // Clip 组合视图的编译状态：优先显示正在进行的自动刷新作业，其次读导演产物的真实编译状态（ready / 过期 / 未编译）。
    const clipCompileState = (clipId: string) => {
        const job = currentRefreshes.find(item => String(item.segmentId) === clipId);
        if (job) return { label: t("director.atomic.clipRefreshPhase." + job.status), color: ["failed", "blocked"].includes(job.status) ? "red" : ["superseded", "interrupted"].includes(job.status) ? "orange" : "processing", tone: "live" as const };
        const artifact = director.artifacts.find(item => item.kind === "h3" && String(item.targetId) === clipId);
        if (!artifact) return { label: t("director.atomic.pendingCompile"), color: undefined, tone: "pending" as const };
        return artifact.status === "ready"
            ? { label: t("director.atomic.compiled"), color: "green", tone: "ready" as const }
            : { label: t("director.atomic.compileStale"), color: "orange", tone: "stale" as const };
    };
    const clipStates = clips.map(clip => ({ id: String(clip.id), ...clipCompileState(String(clip.id)) }));
    const compileCounts = { ready: clipStates.filter(item => item.tone === "ready").length, pending: clipStates.filter(item => item.tone === "pending").length, stale: clipStates.filter(item => item.tone === "stale").length, running: clipStates.filter(item => item.tone === "live").length };
    // 一键编译：提交一次全量编译作业 → 沿同一 operationId 轮询 → 用 preparedId 应用回执写回正式源稿。
    // 编译失败/被阻塞时保留后端的诊断原文，不自行改写；不做媒体生成。
    const [compiling, setCompiling] = useState(false);
    const [compileError, setCompileError] = useState("");
    const [compileNotice, setCompileNotice] = useState("");
    const runCompile = async () => {
        if (compiling || busy || !clips.length) return;
        setCompiling(true); setCompileError(""); setCompileNotice("");
        try {
            const operationId = `compile-clips-${nanoid(10)}`;
            const started = await compileProduction(owner, production.revision, operationId);
            let status = started.compilation;
            for (let attempt = 0; attempt < 600 && ["queued", "running"].includes(String(status.status)); attempt++) {
                await new Promise(resolve => setTimeout(resolve, 1200));
                status = (await fetchProductionCompilation(owner, operationId)).compilation;
            }
            if (status.status !== "succeeded" || !status.preparedId) {
                setCompileError(status.blockingDiagnostic?.message || t("director.atomic.compileBlocked", { status: status.status }));
                return;
            }
            await applyProductionCompilation(owner, status.preparedId);
            setCompileNotice(t("director.atomic.compileDone", { count: status.targetCount || clips.length }));
        } catch (error) {
            setCompileError(error instanceof Error ? error.message : String(error));
        } finally {
            setCompiling(false);
            onRefresh?.();
        }
    };
    // 分割块：拖动或右键调整相邻片段之间的分镜归属。芯片按 id 登记，拖动时按实际布局吸附到镜头边界。
    const chipRefs = useRef(new Map<string, HTMLElement>());
    const trackRef = useRef<HTMLDivElement | null>(null);
    const clipLabel = (index: number) => t("director.studio.clipNumber", { number: index + 1 });
    const saveClipPartition = async (shotIds: string[], groups: Array<Record<string, unknown>>) => {
        if (!onRepartitionClips) return false;
        try {
            if (await onRepartitionClips(shotIds, groups) === false) return false;
            message.success(t("director.atomic.clipBoundarySaved"));
            for (const group of groups) {
                const ids = (Array.isArray(group.shot_ids) ? group.shot_ids : []).map(String), seconds = clipDurationSeconds(ids, shots, fps);
                const owner = clips.findIndex(item => clipShotIds(item).includes(ids[0]));
                if (outsideClipWindow(seconds)) message.warning(t("director.atomic.clipBoundaryWindow", { clip: clipLabel(Math.max(0, owner)), duration: formatSeconds(seconds) }));
            }
            return true;
        } catch (error) { message.error(error instanceof Error ? error.message : String(error)); return false; }
    };
    const commitBoundary = async (pairIndex: number, count: number) => {
        const left = clips[pairIndex], right = clips[pairIndex + 1];
        const parted = partitionAt(clipShotIds(left), clipShotIds(right), count);
        if (!parted.left.length || !parted.right.length) return message.warning(t("director.atomic.clipBoundaryMinOne"));
        // 两侧各自沿用自己原来的执行配置；跨配置移动时 Backend 要求显式指明来源，否则整批被拒（CLIP_EXECUTION_PROFILE_CONFLICT）。
        const groups = materializeClipPartition(clips, [{ ids: parted.left, profileSourceId: String(left.id) }, { ids: parted.right, profileSourceId: String(right.id) }]);
        const saved = await saveClipPartition([...clipShotIds(left), ...clipShotIds(right)], groups);
        if (saved) {
            const crossed = clipProfileKey(left) !== clipProfileKey(right);
            const target = count > clipShotIds(left).length ? left : count < clipShotIds(left).length ? right : undefined;
            if (crossed && target) message.warning(t("director.atomic.clipBoundaryProfileInherited", { clip: clips.indexOf(target) + 1 }));
        }
        return saved;
    };
    const mergeBoundaryClips = async (pairIndex: number, profileSourceId?: string) => {
        const left = clips[pairIndex], right = clips[pairIndex + 1];
        const ids = [...clipShotIds(left), ...clipShotIds(right)];
        await saveClipPartition(ids, materializeClipPartition(clips, [{ ids, profileSourceId: profileSourceId || String(left.id) }]));
    };
    // 时间线按 Clip 分组渲染；只有顺序相邻且都被渲染出来的两组之间才放分割块，避免搜索过滤后错配边界。
    const clipEntries = clips.map((group, index) => ({ group, index, members: shots.filter(shot => clipShotIds(group).includes(String(shot.id))) }))
        .map(entry => ({ ...entry, shown: entry.members.filter(shot => visible.includes(shot)) })).filter(entry => entry.shown.length);
    const partitionEnabled = Boolean(onRepartitionClips) && !busy;
    return <div className="space-y-5" data-subject-storyboard-workbench>
        {/* 紧凑头部：标题 + 统计 + 视图页签合一行；「主体与图片 / 连续性台账」与顶部工作区页签重复，已去掉（连续性入口就是顶部工作区页签）。 */}
        <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border pb-2">
            <h2 className="text-base font-semibold tracking-tight">{t("director.atomic.title")}</h2>
            <span className="text-xs text-muted-foreground">{t("director.atomic.counts", { shots: shots.length, clips: clips.length, seconds: formatSeconds(totalSeconds) })}</span>
            <div className="ml-auto flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-1" role="tablist" aria-label={t("director.atomic.views")}>{(["shots", "clips"] as const).map(key => <button key={key} type="button" role="tab" aria-selected={view === key} onClick={() => setView(key)} className={`flex items-center gap-1.5 border-b-2 px-1 py-1 text-sm ${view === key ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>{key === "shots" ? <Clapperboard className="size-4" /> : <Layers3 className="size-4" />}{t("director.atomic.view." + key)}</button>)}</div>
                <Button type="text" size="small" icon={<WandSparkles className="size-3.5" />} onClick={() => onDiscuss(activeId || undefined)}>{t("director.studio.collaborate")}</Button>
            </div>
        </header>
        {view === "clips" ? <div className="space-y-3">
            {/* 编译状态与编译入口：Clip 组合是「保存 → 校验 → 编译 → 同步」的落点，状态与按钮放同一行，逐 Clip 显示。 */}
            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">{t(subjectAssembly ? "director.atomic.packagingHint" : "director.atomic.legacyPackagingHint")}</p>
                <div className="flex shrink-0 items-center gap-3">
                    {clipStates.length > 0 && <span className="text-xs text-muted-foreground">{compiling ? t("director.atomic.compileInFlight") : t("director.atomic.compileSummary", compileCounts) + (compileCounts.running > 0 ? " · " + t("director.atomic.compileRunning", { running: compileCounts.running }) : "")}</span>}
                    <Button size="small" type="primary" icon={<WandSparkles className="size-3.5" />} loading={compiling} disabled={busy || !clipStates.length} onClick={() => void runCompile()}>{t("director.atomic.compileAction")}</Button>
                </div>
            </div>
            {compileError && <Alert type="error" showIcon closable message={t("director.atomic.compileFailed")} description={compileError} onClose={() => setCompileError("")} />}
            {compileNotice && <Alert type="success" showIcon closable message={compileNotice} onClose={() => setCompileNotice("")} />}
            {clipStates.length > 0 && <div className="flex flex-wrap items-center gap-1.5" aria-label={t("director.atomic.compileStatus")}>
                <span className="mr-1 text-xs text-muted-foreground">{t("director.atomic.compileStatus")}</span>
                {clipStates.map((item, index) => <span key={item.id} className="flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs">
                    <button type="button" onClick={() => onClip(item.id)} className="text-muted-foreground hover:text-foreground">{t("director.studio.clipNumber", { number: index + 1 })}</button>
                    <Tag className="!mr-0 !text-[11px] !leading-4" color={item.color}>{item.label}</Tag>
                </span>)}
            </div>}
            {clipEditor}
        </div> : !shots.length ? <Alert type="info" message={t("director.workspace.noShots")} /> : <>
            {/* 镜头检索并到时间线上方：原先左侧那份「镜头列表」与这条时间线是同一批镜头的两套入口，已合并（只保留时间线）。 */}
            <div className="flex flex-wrap items-center gap-3">
                {/* antd 的 affix 输入框自带 width:100%，所以宽度要挂在外层容器上。 */}
                <div className="w-64 shrink-0"><Input size="small" allowClear className="w-full" prefix={<Search className="size-3.5" />} value={search} onChange={event => setSearch(event.target.value)} placeholder={t("director.studio.searchShots")} aria-label={t("director.studio.searchShots")} /></div>
                <span className="text-xs text-muted-foreground">{t("director.atomic.shotListCount", { visible: visible.length, total: shots.length })}</span>
            </div>
            <div ref={trackRef} data-clip-track className="relative flex gap-4 overflow-x-auto pb-2" aria-label={t("director.atomic.timeline")}>
                {clipEntries.map((entry, position) => { const next = clipEntries[position + 1]; const boundary = next && next.index === entry.index + 1 ? next : undefined;
                    const preceded = position > 0 && clipEntries[position - 1].index === entry.index - 1; // 前面已有分割块时不再画 section 自带的左边框，避免双线
                    return <Fragment key={String(entry.group.id)}>
                    <section className={`min-w-fit${preceded ? "" : " border-l border-border"} pl-3`}><div className="mb-2 flex items-center justify-between gap-5 text-xs text-muted-foreground"><button type="button" onClick={() => onClip(String(entry.group.id))} className="flex items-center gap-1 hover:text-foreground">{clipLabel(entry.index)}<ArrowRight className="size-3" /></button><span>{formatSeconds(entry.members.reduce((sum, shot) => sum + duration(shot), 0))}s</span></div><div className="flex gap-1.5">{entry.shown.map(shot => <button type="button" key={shot.id} data-track-shot={String(shot.id)} ref={element => { if (element) chipRefs.current.set(String(shot.id), element); else chipRefs.current.delete(String(shot.id)); }} onClick={() => setSelectedId(String(shot.id))} aria-pressed={activeId === String(shot.id)} title={title(shot)} className={`max-w-56 min-w-40 rounded-md border px-3 py-2 text-left ${activeId === String(shot.id) ? "border-primary/40 bg-primary/10" : "border-border hover:bg-muted/40"}`}><span className="block truncate text-xs font-medium">{String(shots.findIndex(item => item.id === shot.id) + 1).padStart(2, "0")} · {title(shot)}</span><span className="mt-1 block text-[11px] tabular-nums text-muted-foreground">{framing(shot)} · {formatSeconds(duration(shot))}s</span></button>)}</div></section>
                    {boundary ? <ClipBoundaryHandle pairIndex={entry.index} leftClipId={String(entry.group.id)} rightClipId={String(boundary.group.id)} leftIds={clipShotIds(entry.group)} rightIds={clipShotIds(boundary.group)} profileConflict={clipProfileKey(entry.group) !== clipProfileKey(boundary.group)} shots={shots} fps={fps} chips={chipRefs} track={trackRef} disabled={!partitionEnabled} onCommit={count => commitBoundary(entry.index, count)} onMerge={profileSourceId => mergeBoundaryClips(entry.index, profileSourceId)} /> : null}
                </Fragment>; })}
                {!visible.length && <p className="py-2 text-xs text-muted-foreground">{t("director.studio.emptyShotSearch")}</p>}
            </div>
            <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_250px]">
                <section className="min-w-0" data-production-target={`shot:${activeId}`}>
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><div><p className="text-xs text-muted-foreground">{t("director.studio.shotNumber", { number })} · {clip ? t("director.studio.clipNumber", { number: clipIndex + 1 }) : "—"} · {formatSeconds((windows.get(activeId)?.startFrame || 0) / fps)}–{formatSeconds((windows.get(activeId)?.endFrame || 0) / fps)}s</p></div><Tag color={refresh?.blockingDiagnostic ? "orange" : compiled ? "green" : undefined}>{statusLabel}</Tag></div>
                    {(referenceDiagnostics.length > 0 || (!compiled && refresh?.blockingDiagnostic)) && <details className="mb-4 text-sm"><summary className="cursor-pointer text-muted-foreground">{t("director.workspace.shotIssueDetails")}</summary><div className="mt-2 space-y-2">{[...new Set([...(referenceDiagnostics.map(diagnostic => String(diagnostic.message || diagnostic.code))), ...(!compiled && refresh?.blockingDiagnostic ? [refresh.blockingDiagnostic.message] : [])])].map(message => <p key={message} className="whitespace-pre-wrap text-muted-foreground">{message}</p>)}</div></details>}
                    {renderEditor(selected, workbench)}
                    {/* 连续性状态块：从右侧栏挪到左栏编辑区下方（右栏 250px 太窄，英文状态正文读不开）。 */}
                    <section className="border-t border-border pt-4"><h3 className="text-sm font-medium">{t("director.atomic.state")}</h3><p className="mt-1 text-xs text-muted-foreground">{t(subjectAssembly ? "director.atomic.derivedState" : "director.atomic.legacyStateHint")}</p>{shotStateFields && <div className="mt-3" data-shot-state>{shotStateFields}</div>}{continuityActions && <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border pb-3 text-xs text-muted-foreground" data-shot-continuity-actions>{continuityActions}</div>}{/* 台账事实为空时只留一行提示，不再把「镜头开始 / 镜头结束」两行空占位铺在页面上。 */}
                        {records(state?.start).length + records(state?.end).length > 0 ? <div className="mt-3 grid gap-4 sm:grid-cols-2">{(["start", "end"] as const).map(phase => <div key={phase}><p className="text-[11px] font-medium text-muted-foreground">{t("director.atomic.statePhase." + phase)}</p>{records(state?.[phase]).map(item => <div key={item.factId} className="mt-2"><p className="text-[10px] text-muted-foreground">{item.subjectId ? subjectDisplayName(source, String(item.subjectId)) : item.property}</p><p className="text-xs leading-5">{humanState.value(String(item.factId), item.value)}</p></div>)}{!records(state?.[phase]).length && <p className="mt-1 text-xs text-muted-foreground">{t("director.atomic.noState")}</p>}</div>)}</div> : <p className="mt-3 text-xs text-muted-foreground">{t("director.atomic.noState")}</p>}{records(state?.unresolved).length > 0 && <p className="mt-3 text-xs text-amber-600">{t("director.atomic.stateIssue")} · {records(state?.unresolved).map(item => humanState.fact(String(item.factId))).join(" · ")}</p>}</section>
                    {/* 镜头操作行（和导演讨论 / 跳到所在片段）：整个左栏的最后一块，不再夹在对白与连续性状态之间。 */}
                    {renderShotActions?.(selected)}
                </section>
                <aside className="min-w-0 space-y-5 border-t border-border pt-4 xl:border-t-0 xl:border-l xl:pt-0 xl:pl-4">
                    <section><h3 className="flex items-center gap-2 text-sm font-medium"><ImageIcon className="size-4" />{t("director.atomic.references")}</h3><p className="mt-1 text-xs text-muted-foreground">{t(subjectAssembly ? "director.atomic.referencesHint" : "director.atomic.legacyReferencesHint")}</p>{reading ? <p className="mt-3 text-xs text-muted-foreground">{t("director.atomic.loading")}</p> : workbenchError ? <div className="mt-3 text-xs"><p className="text-muted-foreground">{workbenchError}</p><Button size="small" type="text" onClick={() => setRetry(value => value + 1)}>{t("director.atomic.retry")}</Button></div> : <div className="mt-3 space-y-3">{references.map(reference => <div key={`${reference.subjectId}:${reference.id}`} className="flex gap-3">{reference.resolved?.storageKey ? <img src={backendMediaUrl(reference.resolved.storageKey)} alt={reference.displayName || subjectDisplayName(source, reference.subjectId)} className="h-16 w-16 shrink-0 rounded object-contain" loading="lazy" /> : <span className="flex h-16 w-16 shrink-0 items-center justify-center text-muted-foreground"><ImageIcon className="size-5" /></span>}<div className="min-w-0"><p className="text-xs font-medium">{reference.displayName || subjectDisplayName(source, reference.subjectId)}</p><p className="mt-1 text-[11px] text-muted-foreground">{(reference.provides || []).map((purpose: string) => t(`director.crud.purpose.${purpose}`, { defaultValue: /[\u4e00-\u9fff]/.test(purpose) ? purpose : t("director.crud.otherPurpose") })).join(" · ")}</p><p className="mt-1 text-[11px] text-muted-foreground">{t(!subjectAssembly ? "director.atomic.legacyReferenceBinding" : reference.selection?.mode === "node_selection" ? "director.atomic.followNodeReference" : reference.selection?.mode === "selected_result" ? "director.workspace.selectedHistory" : "director.workspace.followLatest")}</p><ReferenceNodeLink sourceNode={reference.sourceNode} /><button type="button" onClick={() => onNavigate("assets", { kind: "asset", id: subjectAssembly ? reference.subjectId : reference.id })} className="mt-1 inline-flex items-center gap-0.5 text-[11px] text-primary hover:underline">{t("director.atomic.viewReference")}<ArrowRight className="size-3" /></button></div></div>)}{!references.length && <p className="text-xs text-muted-foreground">{t("director.atomic.noResolvedReferences")}</p>}</div>}</section>
                    {keyframes.length > 0 && <section className="border-t border-border pt-4"><h3 className="text-sm font-medium">{t("director.atomic.keyframeReferences")}</h3><div className="mt-3 space-y-3">{keyframes.map(frame => <div key={frame.id} className="flex gap-3">{frame.resolved?.storageKey ? <img src={backendMediaUrl(frame.resolved.storageKey)} alt={t("director.atomic.anchor." + frame.anchor)} className="h-16 w-16 shrink-0 rounded object-contain" loading="lazy" /> : <span className="flex h-16 w-16 shrink-0 items-center justify-center text-muted-foreground"><ImageIcon className="size-5" /></span>}<div className="min-w-0"><p className="text-xs font-medium">{t("director.atomic.anchor." + frame.anchor)}</p><p className="mt-1 text-[11px] text-muted-foreground">{frame.requiredForSubmission ? t("director.atomic.requiredAnchor") : t("director.atomic.designAnchor")}</p>{frame.anchor === "at_frame" && <p className="mt-1 text-[11px] text-muted-foreground">{frame.localFrame}f</p>}</div></div>)}</div></section>}
                    <details className="border-t border-border pt-4"><summary className="cursor-pointer text-sm font-medium">{t("director.atomic.compiledOutput")}</summary><p className="mt-2 text-xs text-muted-foreground">{t(compiled ? "director.atomic.outputHint" : "director.atomic.previousOutput")}</p>{artifact ? <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs leading-5">{artifact.prompt}</pre> : <p className="mt-3 text-xs text-muted-foreground">{t("director.atomic.pendingCompile")}</p>}<Button className="mt-2" size="small" type="text" disabled={!clip} onClick={() => clip && onClip(String(clip.id))}>{t("director.atomic.openClip")}<ArrowRight className="size-3" /></Button></details>
                </aside>
            </div>
        </>}
    </div>;
}

/**
 * 相邻两个 Clip 之间的分割块：拖动按镜头边界重新划分归属，右键做「并入相邻片段 / 合并」。
 * 每个 Clip 至少保留 1 个镜头，边界被夹在两侧非空的位置，因此不可能越过相邻的其他分割块。
 */
function ClipBoundaryHandle({ pairIndex, leftClipId, rightClipId, leftIds, rightIds, profileConflict, shots, fps, chips, track, disabled, onCommit, onMerge }: {
    pairIndex: number; leftClipId: string; rightClipId: string; leftIds: string[]; rightIds: string[]; profileConflict: boolean; shots: Array<Record<string, any>>; fps: number;
    chips: { current: Map<string, HTMLElement> }; track: { current: HTMLDivElement | null }; disabled: boolean;
    onCommit: (count: number) => Promise<unknown> | unknown; onMerge: (profileSourceId?: string) => Promise<unknown> | unknown;
}) {
    const { t } = useTranslation();
    // 拖动状态全部留在本组件：move 期间不触发父级重渲染（被移动镜头的高亮直接操作芯片 DOM）。
    const [drag, setDrag] = useState<{ count: number; edges: Array<{ count: number; viewport: number; content: number }>; guide: number } | null>(null);
    const [merge, setMerge] = useState<{ profileSourceId: string } | null>(null);
    const leftCount = leftIds.length, rightCount = rightIds.length, allIds = [...leftIds, ...rightIds];
    const movingIds = (count: number) => count < leftCount ? leftIds.slice(count) : allIds.slice(leftCount, count);
    const leftNow = drag ? drag.count : leftCount;
    const secondsOf = (ids: string[]) => formatSeconds(clipDurationSeconds(ids, shots, fps));
    const highlight = (ids: string[]) => {
        for (const [shotId, element] of chips.current) {
            const on = ids.includes(shotId);
            element.classList.toggle("border-primary", on);
            element.classList.toggle("ring-2", on);
            element.classList.toggle("ring-primary/40", on);
        }
    };
    const begin = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (disabled || event.button !== 0 || allIds.length < 2) return;
        const elements = allIds.map(id => chips.current.get(id));
        if (elements.some(element => !element)) return; // 搜索过滤掉边界上的镜头时不做几何吸附，右键仍可用
        const trackElement = track.current ?? event.currentTarget.closest("[data-clip-track]");
        if (!trackElement) return;
        const rects = elements.map(element => element!.getBoundingClientRect());
        const trackRect = trackElement.getBoundingClientRect();
        // 引导线吸附到「未来边界」的真实位置：相邻两枚芯片间隙的中点（含跨组的那条缝）。
        const edges = boundaryCounts(leftCount, rightCount).map(count => {
            const viewport = (rects[count - 1].right + rects[count].left) / 2;
            return { count, viewport, content: viewport - trackRect.left + trackElement.scrollLeft };
        });
        event.currentTarget.setPointerCapture(event.pointerId);
        highlight(movingIds(leftCount));
        setDrag({ count: leftCount, edges, guide: edges.find(item => item.count === leftCount)!.content });
    };
    const move = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!drag) return;
        const count = nearestBoundaryCount(event.clientX, drag.edges.map(item => ({ count: item.count, edge: item.viewport }))) ?? drag.count;
        const guide = drag.edges.find(item => item.count === count)!.content;
        if (count !== drag.count) { highlight(movingIds(count)); setDrag({ ...drag, count, guide }); }
        else if (guide !== drag.guide) setDrag({ ...drag, guide }); // 拖动中滚动了轨道也能跟手
    };
    const finish = () => {
        if (!drag) return;
        const count = drag.count;
        setDrag(null); highlight([]);
        if (count !== leftCount) void onCommit(count);
    };
    const items = [
        { key: "to-left", label: t("director.atomic.clipBoundaryToLeft", { clip: pairIndex + 1 }), disabled: rightCount <= 1 },
        { key: "to-right", label: t("director.atomic.clipBoundaryToRight", { clip: pairIndex + 2 }), disabled: leftCount <= 1 },
        { type: "divider" as const },
        { key: "merge", label: t("director.atomic.clipBoundaryMerge") },
    ];
    const mergedDuration = clipDurationSeconds(allIds, shots, fps);
    const guide = drag && track.current ? createPortal(
        <div className="pointer-events-none absolute inset-y-0 z-20 transition-[left] duration-75 ease-out" style={{ left: drag.guide }} data-clip-boundary-guide>
            <span className="absolute inset-y-0 -ml-px w-0.5 bg-primary/80" />
            <span data-clip-boundary-badge className="absolute top-0 left-0 -translate-x-1/2 whitespace-nowrap rounded bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground">{t("director.atomic.clipBoundaryBadge", { left: leftNow, leftSeconds: secondsOf(allIds.slice(0, leftNow)), right: allIds.length - leftNow, rightSeconds: secondsOf(allIds.slice(leftNow)) })}</span>
        </div>, track.current) : null;
    return <>{guide}<Dropdown trigger={["contextMenu"]} disabled={disabled} menu={{ items, onClick: ({ key }) => {
        if (key === "to-left" && rightCount > 1) void onCommit(leftCount + 1);
        else if (key === "to-right" && leftCount > 1) void onCommit(leftCount - 1);
        else if (key === "merge") {
            if (!profileConflict && !outsideClipWindow(mergedDuration)) void onMerge(leftClipId);
            else setMerge({ profileSourceId: leftClipId });
        }
    } }}>
        <div role="separator" aria-orientation="vertical" aria-label={t("director.atomic.clipBoundary")} title={disabled ? undefined : t("director.atomic.clipBoundaryHint")}
            data-clip-boundary={`${pairIndex + 1}-${pairIndex + 2}`}
            onPointerDown={begin} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish}
            className={`group relative flex w-3 shrink-0 touch-none items-stretch justify-center ${disabled ? "cursor-default" : "cursor-col-resize"}`}>
            <span className={`my-1 w-[3px] rounded-full transition-colors ${drag ? "bg-primary" : disabled ? "bg-border" : "bg-border group-hover:bg-primary/60"}`} />
        </div>
    </Dropdown>
        <Modal open={Boolean(merge)} title={t("director.atomic.clipBoundaryMergeTitle", { left: pairIndex + 1, right: pairIndex + 2 })} okText={t("director.atomic.clipBoundaryMergeOk")} cancelText={t("common.cancel")}
            onCancel={() => setMerge(null)} onOk={async () => { const chosen = merge?.profileSourceId; setMerge(null); await onMerge(chosen); }}>
            <p>{t("director.atomic.clipBoundaryMergeBody", { shots: allIds.length, duration: formatSeconds(mergedDuration) })}</p>
            {outsideClipWindow(mergedDuration) ? <p className="mt-2 text-amber-600">{t("director.atomic.clipBoundaryWindow", { clip: pairIndex + 1, duration: formatSeconds(mergedDuration) })}</p> : null}
            {profileConflict ? <div className="mt-3 space-y-2"><p className="text-sm">{t("director.atomic.clipBoundaryProfile")}</p>
                <Radio.Group value={merge?.profileSourceId} onChange={event => setMerge({ profileSourceId: String(event.target.value) })}>
                    {[leftClipId, rightClipId].map((id, index) => <Radio key={id} value={id}>{t("director.studio.clipNumber", { number: pairIndex + 1 + index })}</Radio>)}
                </Radio.Group></div> : null}
        </Modal>
    </>;
}
