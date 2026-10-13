import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Alert, App, Button, Dropdown, Input, Modal, Radio, Select, Tag } from "antd";
import { ArrowLeft, ArrowRight, ArrowUpRight, ChevronDown, Clapperboard, GripHorizontal, Image as ImageIcon, Layers3, Search, WandSparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isSubjectPromptAssembly, resolveSubjectPictureBindingIds, type DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { setShotPictureBindingIds, setShotPictureBindingMode, shotPictureBindingMode } from "./subject-picture-selection";
import { subjectShotWindows, subjectStateProjection } from "@basketikun/canvas-agent/drama/subject-assembly";
import { backendMediaUrl, fetchProductionWorkbench, type EpisodeProduction, type ProductionTarget } from "@/services/backend-api";
import { records, formatSeconds } from "./director-display";
import { productionWorkbenchValue, subjectDisplayName } from "./subject-shot-draft";
import { continuityPresentation } from "./continuity-presentation";
import { currentClipRefreshes } from "./production-refresh-display";
import { ReferenceNodeLink } from "./reference-node-link";
import { useReferenceResultVersion } from "./use-reference-result-version";
import { ShotOperations, type ShotOperation } from "./shot-operations";
import { readShotFormDraft, shotDraftChanged } from "./subject-shot-draft";
import type { DirectorWorkspace } from "./director-panel";
import { storyboardArtifactState, storyboardDurationFrames, storyboardPeople, storyboardReportedState, storyboardScenes, storyboardSceneShotIds } from "./storyboard-display";
import { boundaryCounts, clipBoundaryAutoScrollDelta, clipBoundaryPositions, clipDurationSeconds, clipProfileKey, clipShotIds, createClipBoundaryPointerHandlers, materializeClipPartition, nearestBoundaryCount, outsideClipWindow, partitionAt } from "./clip-boundary";

/** 工作包读取缓存（LRU）：同一镜头、同一源稿版本、同一参考结果版本直接命中，避免反复「正在读取镜头工作包」。 */
const workbenchCache = new Map<string, Record<string, any>>();

export type StoryboardViewMemory = { current?: { selectedId: string; sceneFilter: string; search: string; view: "shots" | "clips"; mobileEditing: boolean; detailView: "editing" | "context"; scrollTop: number } };

type Props = {
    director: DirectorProduction; production: EpisodeProduction; owner: ProductionTarget; initialShotId?: string;
    viewMemory?: StoryboardViewMemory;
    canvasId: string; onLocateClip?: (id: string) => void;
    canvasNodes: Array<{ id: string; title?: string; type?: string; metadata?: Record<string, unknown> }>;
    renderEditor: (shot: Record<string, any>, workbench?: Record<string, any>) => ReactNode; clipEditor: (scope: { sceneId?: string; shotIds: string[]; editable: boolean }) => ReactNode;
    /** 该镜头的起止状态（镜头开始时 / 镜头结束时），由 DirectorPanel 注入到左栏「连续性状态」，原在「画面与摄影」里。 */
    renderShotState?: (shot: Record<string, any>) => ReactNode;
    /** 该镜头的连续性动作（与下一段的边界开关），由 DirectorPanel 注入到左栏编辑区下方的「连续性状态」。 */
    renderContinuity?: (shot: Record<string, any>) => ReactNode;
    /** 该镜头的操作行（和导演讨论 / 跳到所在片段），由 DirectorPanel 注入到左栏最底部。 */
    renderShotActions?: (shot: Record<string, any>) => ReactNode;
    /** v2 源稿的 Clip 重新装箱入口：时间线上的分割块拖动/右键都落到这个 op。 */
    onRepartitionClips?: (shotIds: string[], segments: Array<Record<string, unknown>>) => Promise<boolean>;
    onEditShot?: (operation: ShotOperation) => Promise<boolean>;
    onSaveShotPatch?: (shotId: string, patch: Record<string, unknown>) => Promise<boolean>;
    onUpdateLegacyShotReferences?: (shotId: string, assetIds: string[], keyframeAssetId: string | null) => Promise<boolean>;

    /** 该镜头卡片左侧关键帧缩略图的存储键；由 DirectorPanel 注入，与右栏「关键帧」共用同一份取图逻辑。 */
    shotKeyframe?: (shotId: string) => string | undefined;

    shotDrafts?: Record<string, string>;
    /** Clip 组合使用与交付页相同的 Backend 编译提交与恢复流程。 */
    busy?: boolean; compileBusy?: boolean; compilePending?: boolean; compileError?: string; compileNotice?: string; onCompile?: (sceneId?: string) => void;
    onClip: (id: string) => void;
    onDiscuss: (shotId?: string) => void;
    /** 跳转到指定工作区（参考素材点开进素材库）。 */
    onNavigate: (workspace: DirectorWorkspace, target?: { kind: string; id: string }) => void;
};

/** The v2 authoring surface: stable Shots, derived Clip packaging, and compiler evidence. */
export function SubjectStoryboardWorkbench({ director, production, owner, initialShotId, viewMemory, canvasNodes, canvasId, onLocateClip, renderEditor, renderShotState, renderContinuity, renderShotActions, clipEditor, onRepartitionClips, onEditShot, onSaveShotPatch, onUpdateLegacyShotReferences, shotKeyframe, shotDrafts = {}, busy, compileBusy = false, compilePending = false, compileError = "", compileNotice = "", onCompile, onClip, onDiscuss, onNavigate }: Props) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const source = director.source as Record<string, any>;
    const subjectAssembly = isSubjectPromptAssembly(source);
    const humanState = continuityPresentation({ facts: records(source.ledger?.facts), timelines: records(source.ledger?.timelines), scenes: records(source.script_scenes), locations: records(source.scene_registry), characters: records(source.character_registry), assets: records(source.asset_plan), shots: records(source.shots), segments: records(source.segments), sourceBlocks: [] }, (key, values) => t(`director.workspace.continuity.${key}`, values));
    const fps = Number(source.fps_num || 24) / Number(source.fps_den || 1);
    const shots = records(source.shots).sort((a, b) => Number(a.story_order) - Number(b.story_order)), clips = records(source.segments), subjects = records(source.subject_registry);
    const operationShots = shots.map(shot => { const draft = readShotFormDraft(shotDrafts[`v2shot:${shot.id}`], shot); return draft.invalid ? shot : { ...shot, ...draft.draft.value }; });
    const unsavedShots = shots.filter(shot => { const draft = readShotFormDraft(shotDrafts[`v2shot:${shot.id}`], shot, source); return draft.invalid || shotDraftChanged(draft.draft); });
    const unsavedIds = new Set(unsavedShots.map(shot => String(shot.id)));
    const [selectedId, setSelectedId] = useState(initialShotId || viewMemory?.current?.selectedId || "");
    const [draggingShotId, setDraggingShotId] = useState("");
    const [search, setSearch] = useState(viewMemory?.current?.search || "");
    const [sceneFilter, setSceneFilter] = useState(viewMemory?.current?.sceneFilter || "");
    const [mobileEditing, setMobileEditing] = useState(Boolean(initialShotId) || Boolean(viewMemory?.current?.mobileEditing));
    const [detailView, setDetailView] = useState<"editing" | "context">(viewMemory?.current?.detailView || "editing");
    const selectShot = (id: string) => { setSelectedId(id); setMobileEditing(true); setDetailView("editing"); };
    const sceneDirectory = useMemo(() => storyboardScenes(source), [source, director.sourceHash]);
    const sceneIds = storyboardSceneShotIds(source, sceneFilter);
    const [view, setView] = useState<"shots" | "clips">(viewMemory?.current?.view || "shots");
    const [workbench, setWorkbench] = useState<Record<string, any>>();
    const [workbenchId, setWorkbenchId] = useState("");
    const workbenchReadKey = useRef("");
    const [workbenchError, setWorkbenchError] = useState("");
    const [retry, setRetry] = useState(0);
    const [reading, setReading] = useState(false);
    const windows = useMemo(() => subjectShotWindows(source), [source]);
    const states = useMemo(() => subjectStateProjection(source), [source]);
    const ownerKey = JSON.stringify(owner);
    useEffect(() => {
        if (sceneFilter && sceneFilter !== "__unassigned__" && !sceneDirectory.scenes.some(scene => scene.id === sceneFilter)) setSceneFilter("");
    }, [sceneFilter, sceneDirectory]);
    useEffect(() => { if (initialShotId) { setSelectedId(initialShotId); setView("shots"); setSceneFilter(""); setMobileEditing(true); } }, [initialShotId, ownerKey]);
    const selected = shots.find(shot => String(shot.id) === selectedId) || shots[0];
    const activeId = String(selected?.id || "");
    const clip = clips.find(item => (item.shot_ids || []).includes(activeId));
    const clipIndex = clips.findIndex(item => item.id === clip?.id);
    const number = shots.findIndex(item => String(item.id) === activeId) + 1;
    const title = (shot: Record<string, any>) => String(operationShots.find(item => item.id === shot.id)?.title || shot.title || t("director.studio.shotNumber", { number: shots.findIndex(item => item.id === shot.id) + 1 }));
    const framing = (shot: Record<string, any>) => ["EWS", "WS", "FS", "MS", "MCU", "CU", "ECU"].includes(shot.camera?.framing) ? t("director.atomic.framingName." + shot.camera.framing) : shot.camera?.framing || "—";
    const duration = (shot: Record<string, any>) => storyboardDurationFrames(shot) / fps;
    const people = (shot: Record<string, any>) => storyboardPeople(source, shot, subjectAssembly).join(" · ");
    // 镜头卡片左侧的关键帧缩略图：取不到图时保留同尺寸占位，列表纵向仍然对齐。
    const shotFrame = (id: string) => String(shotKeyframe?.(id) || "");
    const directSceneIds = sceneFilter === "__unassigned__" ? sceneDirectory.unassigned : sceneDirectory.scenes.find(scene => scene.id === sceneFilter)?.shotIds;
    const directSceneShotIds = new Set(sceneFilter ? directSceneIds || [] : shots.map(shot => String(shot.id)));
    const crossSceneCount = directSceneIds ? [...sceneIds].filter(id => !directSceneIds.includes(id)).length : 0;
    const scopeShots = shots.filter(shot => directSceneShotIds.has(String(shot.id)));
    const clipEditorShotIds = shots.filter(shot => sceneIds.has(String(shot.id))).map(shot => String(shot.id));
    const clipEditorSegments = clips.filter(item => (item.shot_ids || []).some((id: string) => sceneIds.has(String(id))));
    const clipEditorRange = shots.reduce((range, shot, index) => sceneIds.has(String(shot.id))
        ? { first: range.first < 0 ? index : range.first, last: index }
        : range, { first: -1, last: -1 });
    const clipEditorContiguous = !sceneFilter || clipEditorRange.first >= 0 && clipEditorRange.last - clipEditorRange.first + 1 === clipEditorShotIds.length;
    const clipEditorSceneLocal = !sceneFilter || clipEditorShotIds.every(id => directSceneShotIds.has(id));
    const clipEditorGroupsLocal = clipEditorSegments.every(item => (item.shot_ids || []).every((id: string) => sceneIds.has(String(id))));
    const clipEditorScope = { sceneId: sceneFilter || undefined, shotIds: clipEditorShotIds, editable: clipEditorContiguous && clipEditorSceneLocal && clipEditorGroupsLocal };
    const visible = shots.filter(shot => sceneIds.has(String(shot.id)) && `${title(shot)} ${shot.visual || ""} ${people(shot)}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
    const referencedNodes = new Set(records(selected?.subject_usages).flatMap(usage => records(subjects.find(subject => subject.id === usage.subjectId)?.pictureBindings).map(binding => String(binding.sourceNode?.nodeId || "")))
        .concat(records(selected?.keyframes).map(frame => String(frame.sourceNode?.nodeId || ""))));
    const referenceEvents = useReferenceResultVersion(records(selected?.subject_usages).flatMap(usage => records(subjects.find(subject => subject.id === usage.subjectId)?.pictureBindings).map(binding => binding.sourceNode || {})).concat(records(selected?.keyframes).map(frame => frame.sourceNode || {})));
    // Metadata only invalidates this read; Backend still selects and verifies the result.
    const referenceVersion = JSON.stringify(canvasNodes.filter(node => referencedNodes.has(node.id)).map(node => [node.id, node.metadata?.images, node.metadata?.storageKey, node.metadata?.resultStorageKey, node.metadata?.primaryImageId, node.metadata?.smartImageReferenceSelection]));
    const readView = subjectAssembly ? "shot_workbench" : "clip_workbench";
    const readId = subjectAssembly ? activeId : String(clip?.id || "");
    const expectedReadKey = `${ownerKey}|${readView}|${readId}|${director.sourceHash}|${referenceVersion}|${referenceEvents}`;
    useEffect(() => {
        if (!readId) { setWorkbench(undefined); setWorkbenchId(""); setReading(false); return; }
        // 缓存键含源稿哈希与参考结果版本：命中即先展示旧数据并后台静默刷新，避免每次切换/保存都闪「正在读取」。
        const cacheKey = expectedReadKey;
        let current = true;
        setWorkbenchError("");
        const hit = workbenchCache.get(cacheKey);
        const apply = (value: Record<string, any>) => {
            if (workbenchCache.size >= 80) workbenchCache.delete(workbenchCache.keys().next().value!);
            workbenchCache.set(cacheKey, value);
            if (current) { workbenchReadKey.current = cacheKey; setWorkbench(productionWorkbenchValue(value, subjectAssembly ? "shot" : "clip")); setWorkbenchId(readId); }
        };
        if (hit) { workbenchReadKey.current = cacheKey; setWorkbench(productionWorkbenchValue(hit, subjectAssembly ? "shot" : "clip")); setWorkbenchId(readId); setReading(false); }
        // 同一镜头因保存/分割合并触发重读时保留旧内容，仅提示刷新中：整体卸载会导致页面抖动。
        else if (workbenchId !== readId) { setReading(true); setWorkbench(undefined); }
        else setReading(true);
        void fetchProductionWorkbench(owner, readView, readId).then(result => {
            if (!current) return;
            if (result.production.sourceHash !== director.sourceHash) { setWorkbenchError(t("director.atomic.changedRead")); return; }
            apply(result.production);
        }).catch(error => { if (current && !hit) setWorkbenchError(error instanceof Error ? error.message : String(error)); })
            .finally(() => { if (current) setReading(false); });
        return () => { current = false; };
    }, [readId, readView, ownerKey, director.sourceHash, production.revision, referenceVersion, referenceEvents, retry, t]);
    const artifact = director.artifacts.find(item => item.kind === "h3" && item.targetId === clip?.id);
    const currentRefreshes = currentClipRefreshes(production.clipRefreshes || [], clips.map(item => String(item.id)), director.sourceHash);
    const refreshCandidate = currentRefreshes.find(item => item.segmentId === clip?.id);
    const compiled = Boolean(workbenchReadKey.current === expectedReadKey && artifact && records(subjectAssembly ? workbench?.directorArtifacts : workbench?.directorReferences?.compiled).some(item => item.id === artifact.id && item.sha256 === artifact.sha256 && item.current === true && item.status === "ready"));
    const refresh = compiled && ["blocked", "failed"].includes(refreshCandidate?.status || "") ? undefined : refreshCandidate;
    const state = subjectAssembly ? workbench?.continuity || states[activeId] : storyboardReportedState(workbench?.continuity, activeId);
    const assetIds = [...new Set([...(selected?.required_assets || []), ...(director.shotInputs[activeId]?.assetIds || [])].map(String))];
    const keyframeAssetIds = new Set(Object.values(director.shotInputs).map(input => String(input.keyframeAssetId || "")).filter(Boolean));
    const assetOptionsById = new Map<string, string>();
    for (const asset of records(source.asset_plan)) {
        const id = String(asset.asset_id || asset.id || "");
        if (id) assetOptionsById.set(id, String(asset.asset_name || asset.title || asset.name || id));
    }
    for (const [id, asset] of Object.entries(director.assets || {})) assetOptionsById.set(id, String(asset?.title || asset?.label || assetOptionsById.get(id) || id));
    for (const id of [...assetIds, ...keyframeAssetIds]) if (id && !assetOptionsById.has(id)) assetOptionsById.set(id, id);
    const assetOptions = [...assetOptionsById].map(([value, label]) => ({ value, label }));
    const ordinaryAssetOptions = assetOptions;
    const selectedKeyframeAssetId = String(director.shotInputs[activeId]?.keyframeAssetId || "");
    const references: Array<Record<string, any> & { subjectId: string }> = subjectAssembly ? records(workbench?.subjectUsages).flatMap(usage => records(usage.pictureBindings).map(binding => ({ ...binding, subjectId: String(usage.subjectId), presentation: usage.presentation })))
        : assetIds.map(assetId => ({ id: assetId, subjectId: assetId, displayName: records(source.asset_plan).find(asset => String(asset.asset_id || asset.id) === assetId)?.asset_name || assetId, resolved: workbench?.assets?.[assetId] || director.assets[assetId] }));
    const pictureBindingLabel = (binding: Record<string, any>) => {
        const node = canvasNodes.find(item => item.id === binding.sourceNode?.nodeId);
        const resultId = String(binding.selection?.resultId || "");
        const selectedImage = records(node?.metadata?.characterImages).find(image => {
            const key = String(image.storageKey || image.url || image.name || "");
            return [key, String(image.storageKey || ""), `${node?.id}:character-image:${key}`].includes(resultId);
        });
        const sourceLabel = node?.title || node?.metadata?.name || t("director.crud.boundImage");
        const mediaLabel = selectedImage?.outfit || selectedImage?.outfitDescription || selectedImage?.name || binding.displayName || binding.id;
        return [sourceLabel, mediaLabel].map(value => String(value || "").trim()).filter(Boolean).join(" · ");
    };
    const keyframes = records(workbench?.keyframes), referenceDiagnostics = records(workbench?.resolutionDiagnostics);
    // 左栏「连续性状态」里的动作块（与下一段的边界开关），由 DirectorPanel 注入。
    // Empty sources still pass through this setup before the empty-state branch below.
    // Do not call shot renderers until selection has resolved to an actual shot.
    const continuityActions = selected ? renderContinuity?.(selected) : undefined;
    // 起止状态（镜头开始时 / 镜头结束时）：从「画面与摄影」挪进来，与台账状态、边界开关同区展示。
    const shotStateFields = selected ? renderShotState?.(selected) : undefined;
    const statusLabel = refresh ? t("director.workspace.clipRefreshStatus." + refresh.status, { segment: t("director.studio.clipNumber", { number: clipIndex + 1 }) })
        : t(compiled ? "director.atomic.compiled" : "director.atomic.pendingCompile");
    // Clip 组合视图的编译状态：优先显示正在进行的自动刷新作业，其次读导演产物的真实编译状态（ready / 过期 / 未编译）。
    const clipCompileState = (clipId: string) => {
        const job = currentRefreshes.find(item => String(item.segmentId) === clipId);
        const artifact = director.artifacts.find(item => item.kind === "h3" && String(item.targetId) === clipId);
        const projection = workbenchReadKey.current === expectedReadKey && clipId === String(clip?.id) ? records(subjectAssembly ? workbench?.directorArtifacts : workbench?.directorReferences?.compiled).find(item => item.id === artifact?.id && item.sha256 === artifact?.sha256) : undefined;
        const status = storyboardArtifactState(artifact, projection);
        if (job && !(status === "ready" && ["failed", "blocked"].includes(job.status))) return { label: t("director.atomic.clipRefreshPhase." + job.status), color: ["failed", "blocked"].includes(job.status) ? "red" : "processing", tone: ["failed", "blocked"].includes(job.status) ? "blocked" as const : "live" as const };
        if (status === "pending") return { label: t("director.atomic.pendingCompile"), color: undefined, tone: "pending" as const };
        if (status === "recorded") return { label: t("director.atomic.recordedCompile"), color: undefined, tone: "recorded" as const };
        return status === "ready"
            ? { label: t("director.atomic.compiled"), color: "green", tone: "ready" as const }
            : { label: t("director.atomic.compileStale"), color: "orange", tone: "stale" as const };
    };
    const clipStates = clips.map(clip => ({ id: String(clip.id), ...clipCompileState(String(clip.id)) }));
    const visibleClipStates = !sceneFilter ? clipStates : clipStates.filter(item => clips.find(clip => String(clip.id) === item.id)?.shot_ids?.some((id: string) => directSceneShotIds.has(String(id))));
    const sceneCompileAvailable = !sceneFilter || sceneDirectory.scenes.some(scene => scene.id === sceneFilter);
    const compileCounts = { ready: visibleClipStates.filter(item => item.tone === "ready").length, pending: visibleClipStates.filter(item => item.tone === "pending").length, stale: visibleClipStates.filter(item => item.tone === "stale").length, running: visibleClipStates.filter(item => item.tone === "live").length, recorded: visibleClipStates.filter(item => item.tone === "recorded").length, blocked: visibleClipStates.filter(item => item.tone === "blocked").length };
    // 分割块：拖动或右键调整相邻片段之间的分镜归属。芯片按 id 登记，拖动时按实际布局吸附到镜头边界。
    const chipRefs = useRef(new Map<string, HTMLElement>());
    const trackRef = useRef<HTMLDivElement | null>(null);
    if (viewMemory) viewMemory.current = { selectedId: activeId, sceneFilter, search, view, mobileEditing, detailView, scrollTop: viewMemory.current?.scrollTop || 0 };
    useLayoutEffect(() => { if (trackRef.current && viewMemory?.current) trackRef.current.scrollTop = viewMemory.current.scrollTop; }, [ownerKey, view]);
    const revealShot = (id: string) => {
        setView("shots"); setSearch(""); setSceneFilter(sceneDirectory.scenes.find(scene => scene.shotIds.includes(id))?.id || "__unassigned__"); selectShot(id);
        requestAnimationFrame(() => { const row = chipRefs.current.get(id), track = trackRef.current; if (row && track?.clientHeight) track.scrollTop += row.getBoundingClientRect().top - track.getBoundingClientRect().top - track.clientHeight / 2 + row.clientHeight / 2; row?.focus({ preventScroll: true }); });
    };
    const clipLabel = (index: number) => t("director.atomic.clipHeading", { number: index + 1 });
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
    const moveShotByDrop = (event: React.DragEvent<HTMLButtonElement>, targetShotId: string) => {
        event.preventDefault();
        const sourceShotId = event.dataTransfer.getData("text/plain") || draggingShotId;
        setDraggingShotId("");
        if (!sourceShotId || sourceShotId === targetShotId || !onEditShot || busy) return;
        const sourceClip = clips.find(item => clipShotIds(item).includes(sourceShotId));
        const targetClip = clips.find(item => clipShotIds(item).includes(targetShotId));
        if (!sourceClip || sourceClip.id !== targetClip?.id) return;
        const rect = event.currentTarget.getBoundingClientRect();
        void onEditShot({ type: "edit_director_shot", action: "move", shotId: sourceShotId, targetShotId, position: event.clientY < rect.top + rect.height / 2 ? "before" : "after" });
    };
    // 场次切换并到标题上：点标题直接换场次，选项与计数沿用原来左侧场次目录那一份。
    const sceneTitle = sceneFilter === "__unassigned__" ? t("director.atomic.unassignedScene") : sceneDirectory.scenes.find(scene => scene.id === sceneFilter)?.title || t("director.atomic.allScenes");
    const sceneOptions = [
        { key: "", label: t("director.atomic.allScenes"), count: shots.length, shotIds: undefined as string[] | undefined },
        ...sceneDirectory.scenes.map(scene => ({ key: scene.id, label: scene.title, count: scene.shotIds.length, shotIds: scene.shotIds })),
        ...(sceneDirectory.unassigned.length ? [{ key: "__unassigned__", label: t("director.atomic.unassignedScene"), count: sceneDirectory.unassigned.length, shotIds: sceneDirectory.unassigned }] : []),
    ];
    const selectScene = (key: string) => {
        const next = key === "__all__" ? "" : key;
        setSceneFilter(next);
        const shotIds = sceneOptions.find(option => option.key === next)?.shotIds;
        if (shotIds && !shotIds.includes(activeId) && shotIds[0]) setSelectedId(shotIds[0]);
    };
    const sceneMenuItems = sceneOptions.map(option => ({ key: option.key || "__all__", label: <span className="flex items-center gap-3"><span>{option.label}</span><span className="text-xs tabular-nums text-muted-foreground">{option.count}</span></span> }));
    return <div className="space-y-6" data-subject-storyboard-workbench data-storyboard-view={view} data-canvas-id={canvasId} data-mobile-editing={mobileEditing && Boolean(selected) && view === "shots"} data-production-section-root>
        {/* 紧凑头部：标题 + 统计 + 视图页签合一行；「主体与图片 / 连续性台账」与顶部工作区页签重复，已去掉（连续性入口就是顶部工作区页签）。 */}
        <header className="storyboard-toolbar flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-border pb-4">
            <div className="storyboard-scene-context flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="m-0 min-w-0">
                    <Dropdown trigger={["click"]} menu={{ items: sceneMenuItems, selectable: true, selectedKeys: [sceneFilter || "__all__"], onClick: ({ key }) => selectScene(key) }}>
                        <button type="button" className="storyboard-scene-switch" aria-label={t("director.atomic.sceneNavigation")} aria-haspopup="menu">
                            <span className="storyboard-scene-switch-label">{sceneTitle}</span>
                            <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
                        </button>
                    </Dropdown>
                </h2>
                <p className="m-0 text-xs text-muted-foreground">{t("director.atomic.counts", { shots: scopeShots.length, clips: visibleClipStates.length, seconds: formatSeconds(scopeShots.reduce((sum, shot) => sum + duration(shot), 0)) })}{view === "shots" && crossSceneCount > 0 && <span className="block mt-1">{t("director.atomic.crossSceneIncluded", { count: crossSceneCount })}</span>}</p>
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-1" role="tablist" aria-label={t("director.atomic.views")}>{(["shots", "clips"] as const).map(key => <button key={key} type="button" role="tab" aria-selected={view === key} onClick={() => setView(key)} className={`flex items-center gap-1.5 border-b-2 px-1 py-1 text-sm ${view === key ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>{key === "shots" ? <Clapperboard className="size-4" /> : <Layers3 className="size-4" />}{t("director.atomic.view." + key)}</button>)}</div>
                {unsavedShots.length > 0 && <Dropdown trigger={["click"]} menu={{ items: unsavedShots.map(shot => ({ key: String(shot.id), label: title(shot) })), onClick: ({ key }) => revealShot(key) }}><Button type="text" size="small" className="storyboard-draft-locator">{t("director.atomic.unsavedCount", { count: unsavedShots.length })}</Button></Dropdown>}
                <Button type="text" size="small" icon={<WandSparkles className="size-3.5" />} onClick={() => onDiscuss(activeId || undefined)}>{t("director.studio.collaborate")}</Button>
            </div>
        </header>
        {view === "clips" ? <div className="storyboard-clip-editor space-y-3">
            {/* 编译状态与编译入口：Clip 组合是「保存 → 校验 → 编译 → 同步」的落点，状态与按钮放同一行，逐 Clip 显示。 */}
            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">{t(subjectAssembly ? "director.atomic.packagingHint" : "director.atomic.legacyPackagingHint")}</p>
                <div className="flex shrink-0 items-center gap-3">
                    {visibleClipStates.length > 0 && <span className="text-xs text-muted-foreground">{compileBusy ? t("director.atomic.compileInFlight") : t("director.atomic.compileSummary", compileCounts) + (compileCounts.blocked ? " · " + t("director.atomic.blockedCompileCount", { count: compileCounts.blocked }) : "") + (compileCounts.recorded ? " · " + t("director.atomic.recordedCompileCount", { count: compileCounts.recorded }) : "") + (compileCounts.running > 0 ? " · " + t("director.atomic.compileRunning", { running: compileCounts.running }) : "")}</span>}
                    <Button size="small" type="primary" icon={<WandSparkles className="size-3.5" />} loading={compileBusy} disabled={busy || compileBusy || !visibleClipStates.length || !onCompile || sceneFilter === "__unassigned__" || !sceneCompileAvailable} title={sceneFilter === "__unassigned__" ? t("director.atomic.compileUnassignedHint") : undefined} onClick={() => onCompile?.(sceneFilter && sceneFilter !== "__unassigned__" ? sceneFilter : undefined)}>{compilePending ? t("drama.production.recoverReceipt") : sceneFilter ? sceneFilter === "__unassigned__" ? t("director.atomic.compileAction") : t("director.atomic.compileSceneAction") : t("director.atomic.compileAction")}</Button>
                </div>
            </div>
            {compileError && <Alert type="error" showIcon message={t("director.atomic.compileFailed")} description={compileError} style={{ whiteSpace: "pre-line" }} />}
            {compileNotice && <Alert type="success" showIcon message={compileNotice} style={{ whiteSpace: "pre-line" }} />}
            {visibleClipStates.length > 0 && <div className="flex flex-wrap items-center gap-1.5" aria-label={t("director.atomic.compileStatus")}>
                <span className="mr-1 text-xs text-muted-foreground">{t("director.atomic.compileStatus")}</span>
                {visibleClipStates.map(item => <span key={item.id} className="flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs">
                    <button type="button" onClick={() => onClip(item.id)} className="text-muted-foreground hover:text-foreground">{t("director.studio.clipNumber", { number: clips.findIndex(clip => String(clip.id) === item.id) + 1 })}</button>
                    <Tag className="!mr-0 !text-[11px] !leading-4" color={item.color}>{item.label}</Tag>
                </span>)}
            </div>}
            {sceneFilter && !clipEditorScope.editable && <Alert type="info" showIcon message={t("director.atomic.clipPartitionScopeHint")} />}
            {clipEditor(clipEditorScope)}
        </div> : !shots.length ? <div className="space-y-3"><p className="text-sm text-muted-foreground">{t("director.workspace.noShots")}</p>{subjectAssembly && onEditShot && <ShotOperations source={source} busy={busy} onEdit={onEditShot} onSelect={selectShot} />}</div> : <>
            <div className="storyboard-columns">
            <div className="storyboard-list-panel">
            {/* 镜头检索并到时间线上方：原先左侧那份「镜头列表」与这条时间线是同一批镜头的两套入口，已合并（只保留时间线）。 */}
            <div className="storyboard-list-tools flex flex-wrap items-center gap-3">
                {/* antd 的 affix 输入框自带 width:100%，所以宽度要挂在外层容器上。 */}
                <div className="w-full sm:w-64 sm:shrink-0"><Input size="small" allowClear className="w-full" prefix={<Search className="size-3.5" />} value={search} onChange={event => setSearch(event.target.value)} placeholder={t("director.studio.searchShots")} aria-label={t("director.studio.searchShots")} /></div>

                {subjectAssembly && onEditShot && <ShotOperations source={{ ...source, shots: operationShots }} busy={busy} onEdit={onEditShot} onSelect={selectShot} />}
            </div>
            {search.trim() && <div className="storyboard-search-status"><span>{t("director.atomic.searchCount", { count: visible.length })}</span><button type="button" onClick={() => setSearch("")}>{t("director.atomic.clearSearch")}</button>{selected && !visible.some(shot => shot.id === selected.id) && <><span>{t("director.atomic.currentOutsideFilter")}</span><button type="button" onClick={() => revealShot(activeId)}>{t("director.atomic.revealCurrent")}</button></>}</div>}
            <div ref={trackRef} onScroll={event => { if (viewMemory?.current) viewMemory.current.scrollTop = event.currentTarget.scrollTop; }} data-clip-track className="storyboard-shot-list relative" aria-label={t("director.atomic.timeline")}>
                {clipEntries.map((entry, position) => { const next = clipEntries[position + 1]; const boundary = next && next.index === entry.index + 1 ? next : undefined;
                                        return <Fragment key={String(entry.group.id)}>
                    <section className={`storyboard-clip-group ${entry.group.id === clip?.id ? "is-selected" : ""}`}>
                        <div className="storyboard-clip-heading flex items-center justify-between gap-3">
                            <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{clipLabel(entry.index)}</strong><Tag className="!m-0" title={t("director.atomic.savedSourceStatus")} color={clipCompileState(String(entry.group.id)).color}>{clipCompileState(String(entry.group.id)).label}</Tag></div><p className="mt-1 text-xs text-muted-foreground">{t("director.atomic.clipSummary", { count: entry.members.length, seconds: formatSeconds(entry.members.reduce((sum, shot) => sum + duration(shot), 0)) })} · {String(entry.group.mode || "")}{entry.shown.length !== entry.members.length && <span className="ml-2">{t("director.atomic.filteredMembers", { shown: entry.shown.length, total: entry.members.length })}</span>}</p></div>
                            <div className="flex shrink-0 items-center gap-1"><Button type="text" size="small" onClick={() => onClip(String(entry.group.id))} aria-label={clipLabel(entry.index) + " · " + t("director.atomic.viewResults")}>{t("director.atomic.viewResults")}</Button>{production.draft.clipGroups.find(group => group.id === String(entry.group.id))?.nodeId && <Button type="text" size="small" icon={<ArrowUpRight className="size-3.5" />} title={t("director.atomic.locateClip")} onClick={() => onLocateClip?.(String(entry.group.id))}>H3</Button>}</div>
                        </div>
                        <div className="storyboard-clip-shots">
                            {entry.shown.map((shot, shotIndex) => {
                                const nextShot = entry.shown[shotIndex + 1];
                                const ids = clipShotIds(entry.group), boundaryIndex = ids.indexOf(String(shot.id)) + 1;
                                const canSplitHere = Boolean(nextShot && ids[boundaryIndex] === String(nextShot.id));
                                const leftIds = ids.slice(0, boundaryIndex), rightIds = ids.slice(boundaryIndex);
                                return <Fragment key={String(shot.id)}>
                                    <ShotOperations source={{ ...source, shots: operationShots }} shot={operationShots.find(item => item.id === shot.id)} busy={busy} onEdit={onEditShot || (async () => false)} onSelect={selectShot} contextMenu={subjectAssembly && Boolean(onEditShot)}>
                                        <button type="button" draggable={Boolean(subjectAssembly && onEditShot && !busy)} data-track-shot={String(shot.id)} ref={element => { if (element) chipRefs.current.set(String(shot.id), element); else chipRefs.current.delete(String(shot.id)); }} onClick={() => selectShot(String(shot.id))} onContextMenu={() => setSelectedId(String(shot.id))} onDragStart={event => { if (!subjectAssembly || !onEditShot || busy) return event.preventDefault(); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", String(shot.id)); setDraggingShotId(String(shot.id)); }} onDragOver={event => { const sourceId = event.dataTransfer.getData("text/plain") || draggingShotId; if (sourceId && sourceId !== String(shot.id) && clips.some(item => clipShotIds(item).includes(sourceId) && clipShotIds(item).includes(String(shot.id)))) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }} onDrop={event => moveShotByDrop(event, String(shot.id))} onDragEnd={() => setDraggingShotId("")} aria-pressed={activeId === String(shot.id)} title={title(shot)} className={`storyboard-shot-row w-full text-left ${draggingShotId === String(shot.id) ? "opacity-50" : ""} ${activeId === String(shot.id) ? "is-selected" : ""} ${subjectAssembly && onEditShot && !busy ? "cursor-grab active:cursor-grabbing" : ""}`}><span className="flex items-start gap-3"><ShotKeyframeThumb storageKey={shotFrame(String(shot.id))} /><span className="min-w-0 flex-1"><span className="flex items-start justify-between gap-3"><span className="storyboard-shot-title">{String(shots.findIndex(item => item.id === shot.id) + 1).padStart(2, "0")} · {title(shot)}{unsavedIds.has(String(shot.id)) && <span className="storyboard-unsaved-mark" title={t("director.atomic.draftKept")} aria-label={t("director.atomic.draftKept")}> · {t("director.atomic.unsavedShort")}</span>}</span><span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatSeconds(duration(shot))}s</span></span><span className="mt-1 block text-xs text-muted-foreground">{framing(shot)} · {people(shot)}</span><span className="mt-2 line-clamp-2 block text-sm leading-6 text-muted-foreground">{String(shot.visual?.description || shot.visual?.text || (typeof shot.visual === "string" ? shot.visual : ""))}</span></span></span></button>
                                    </ShotOperations>
                                    {canSplitHere && <ShotClipSplitHandle vertical disabled={!partitionEnabled} onSplit={() => {
                                        void saveClipPartition(ids, materializeClipPartition(clips, [{ ids: leftIds }, { ids: rightIds }]));
                                    }} />}
                                </Fragment>;
                            })}
                        </div>
                    </section>
                    {boundary ? <ClipBoundaryHandle vertical pairIndex={entry.index} leftClipId={String(entry.group.id)} rightClipId={String(boundary.group.id)} leftIds={clipShotIds(entry.group)} rightIds={clipShotIds(boundary.group)} profileConflict={clipProfileKey(entry.group) !== clipProfileKey(boundary.group)} shots={shots} fps={fps} chips={chipRefs} track={trackRef} disabled={!partitionEnabled} onCommit={count => commitBoundary(entry.index, count)} onMerge={profileSourceId => mergeBoundaryClips(entry.index, profileSourceId)} /> : null}
                </Fragment>; })}
                {visible.filter(shot => !clips.some(item => clipShotIds(item).includes(String(shot.id)))).map(shot => <section key={shot.id} className="storyboard-clip-group"><p className="p-3 text-xs text-muted-foreground">{t("director.atomic.ungroupedShot")}</p><ShotOperations source={{ ...source, shots: operationShots }} shot={operationShots.find(item => item.id === shot.id)} busy={busy} onEdit={onEditShot || (async () => false)} onSelect={selectShot} contextMenu={subjectAssembly && Boolean(onEditShot)}><button type="button" data-track-shot={String(shot.id)} ref={element => { if (element) chipRefs.current.set(String(shot.id), element); else chipRefs.current.delete(String(shot.id)); }} onClick={() => selectShot(String(shot.id))} className="storyboard-shot-row w-full text-left" aria-pressed={activeId === String(shot.id)}><span className="flex items-center gap-3"><ShotKeyframeThumb storageKey={shotFrame(String(shot.id))} /><span className="min-w-0 flex-1">{title(shot)}{unsavedIds.has(String(shot.id)) && <span className="storyboard-unsaved-mark"> · {t("director.atomic.unsavedShort")}</span>}</span></span></button></ShotOperations></section>)}
                {!visible.length && <div className="storyboard-empty-state"><Search className="size-5" /><p>{t(search.trim() ? "director.studio.emptyShotSearch" : "director.atomic.emptyScene")}</p><Button onClick={() => { setSearch(""); setSceneFilter(""); }}>{t("director.atomic.showAllShots")}</Button></div>}
            </div>
            </div>
            <div className="storyboard-detail-panel" data-detail-view={detailView}>
                <header className="storyboard-detail-heading">
                    <div className="storyboard-mobile-actions"><Button type="text" icon={<ArrowLeft className="size-4" />} onClick={() => { setMobileEditing(false); requestAnimationFrame(() => chipRefs.current.get(activeId)?.focus({ preventScroll: true })); }}>{t("director.atomic.backToShots")}</Button></div>
                    <div className="flex min-w-0 flex-1 items-center justify-between gap-2"><p className="min-w-0 text-xs text-muted-foreground">{t("director.studio.shotNumber", { number })} · {clip ? clipLabel(clipIndex) : t("director.atomic.ungroupedShot")}</p><div className="flex shrink-0 items-center gap-1"><Button type="text" onClick={() => setDetailView(detailView === "editing" ? "context" : "editing")}>{t(detailView === "editing" ? "director.atomic.contextDetails" : "director.atomic.returnToEditor")}</Button>{clip && production.draft.clipGroups.find(group => group.id === String(clip.id))?.nodeId && <Button type="text" icon={<ArrowUpRight className="size-4" />} onClick={() => onLocateClip?.(String(clip.id))} aria-label={t("director.atomic.locateClip")}>H3</Button>}</div></div>
                </header>
            {selected && !visible.some(shot => shot.id === selected.id) && <div className="storyboard-selection-notice" role="status"><span>{t(sceneIds.has(activeId) ? "director.atomic.currentOutsideFilter" : "director.atomic.currentOutsideScene")}</span><button type="button" onClick={() => revealShot(activeId)}>{t("director.atomic.revealCurrent")}</button></div>}
            <div className="storyboard-detail-surfaces">
                <section className="storyboard-editing" hidden={detailView !== "editing"} data-production-target={`shot:${activeId}`} data-production-section="shot-editing" tabIndex={-1}>
                    {(referenceDiagnostics.length > 0 || (!compiled && refresh?.blockingDiagnostic)) && <details className="mb-4 text-sm"><summary className="cursor-pointer text-muted-foreground">{t("director.workspace.shotIssueDetails")}</summary><div className="mt-2 space-y-2">{[...new Set([...(referenceDiagnostics.map(diagnostic => String(diagnostic.message || diagnostic.code))), ...(!compiled && refresh?.blockingDiagnostic ? [refresh.blockingDiagnostic.message] : [])])].map(message => <p key={message} className="whitespace-pre-wrap text-muted-foreground">{message}</p>)}</div></details>}
                    <div className="storyboard-editor-content" data-subject-editor={subjectAssembly || undefined}>{renderEditor(selected, workbench)}</div>
                    {/* 镜头操作行（和导演讨论 / 跳到所在片段）：整个左栏的最后一块，不再夹在对白与连续性状态之间。 */}
                    {renderShotActions?.(selected)}
                </section>
                <aside className="storyboard-context space-y-6" hidden={detailView !== "context"}>
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><div><p className="text-xs text-muted-foreground">{formatSeconds((windows.get(activeId)?.startFrame || 0) / fps)}–{formatSeconds((windows.get(activeId)?.endFrame || 0) / fps)}s</p></div><Tag color={refresh?.blockingDiagnostic ? "orange" : compiled ? "green" : undefined}>{statusLabel}</Tag></div>

                    <section className="border-t border-border pt-4" data-production-section="shot-state" tabIndex={-1}><h3 className="text-sm font-medium">{t("director.atomic.state")}</h3><p className="mt-1 text-xs text-muted-foreground">{t(subjectAssembly ? "director.atomic.derivedState" : "director.atomic.legacyStateHint")}</p>{!subjectAssembly && shotStateFields && <div className="mt-3" data-shot-state>{shotStateFields}</div>}{continuityActions && <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border pb-3 text-xs text-muted-foreground" data-shot-continuity-actions>{continuityActions}</div>}
                        {records(state?.start).length + records(state?.end).length > 0 ? <div className="mt-3 grid gap-4 ">{(["start", "end"] as const).map(phase => <div key={phase}><p className="text-[11px] font-medium text-muted-foreground">{t("director.atomic.statePhase." + phase)}</p>{records(state?.[phase]).map(item => <div key={item.factId} className="mt-2"><p className="text-[10px] text-muted-foreground">{item.subjectId ? subjectDisplayName(source, String(item.subjectId)) : item.property}</p><p className="text-xs leading-5">{humanState.value(String(item.factId), item.value)}</p></div>)}{!records(state?.[phase]).length && <p className="mt-1 text-xs text-muted-foreground">{t("director.atomic.noState")}</p>}</div>)}</div> : <p className="mt-3 text-xs text-muted-foreground">{t("director.atomic.noState")}</p>}{records(state?.unresolved).length > 0 && <p className="mt-3 text-xs text-amber-600">{t("director.atomic.stateIssue")} · {records(state?.unresolved).map(item => humanState.fact(String(item.factId))).join(" · ")}</p>}</section>

                    {subjectAssembly && selected && <section className="border-t border-border pt-4" data-shot-picture-binding-editor>
                        <h3 className="text-sm font-medium">{t("director.atomic.references")}</h3>
                        <p className="mt-1 text-xs text-muted-foreground">{t("director.atomic.referencesHint")}</p>
                        <div className="mt-3 space-y-3">{records(selected.subject_usages).map((usage, index) => {
                            const subject = subjects.find(item => String(item.id) === String(usage.subjectId));
                            const resolved = resolveSubjectPictureBindingIds(subject, usage);
                            const pictureMode = shotPictureBindingMode(usage);
                            return <div key={`${usage.subjectId}:${index}`} className="grid gap-2 text-xs">
                                <span>{subjectDisplayName(source, String(usage.subjectId))}</span>
                                <Select value={pictureMode} disabled={busy || reading || !subject || !onSaveShotPatch}
                                    options={["default", "explicit"].map(mode => ({ value: mode, label: t(`director.workspace.pictureBindingMode${mode === "default" ? "Default" : "Explicit"}`) }))}
                                    onChange={mode => {
                                        const nextUsage = setShotPictureBindingMode(subject, usage, mode as "default" | "explicit");
                                        const subject_usages = records(selected.subject_usages).map((item, itemIndex) => itemIndex === index ? nextUsage : item);
                                        void onSaveShotPatch?.(activeId, { subject_usages });
                                    }} />
                                <Select mode="multiple" value={resolved.bindingIds} disabled={busy || reading || !subject || !onSaveShotPatch || pictureMode === "default"}
                                    options={records(subject?.pictureBindings).map(binding => ({ value: String(binding.id), label: pictureBindingLabel(binding) }))}
                                    onChange={pictureBindingIds => {
                                        const subject_usages = records(selected.subject_usages).map((item, itemIndex) => itemIndex === index ? setShotPictureBindingIds(item, pictureBindingIds) : item);
                                        void onSaveShotPatch?.(activeId, { subject_usages });
                                    }} />
                                {pictureMode === "default" ? <p className="text-[11px] text-muted-foreground">{t("director.workspace.pictureBindingDefaultHint")}</p> : !resolved.bindingIds.length && <p className="text-[11px] text-muted-foreground">{t("director.workspace.pictureBindingExplicitEmptyHint")}</p>}
                            </div>;
                        })}</div>
                        <p className="mt-2 text-[11px] text-muted-foreground">{t("director.atomic.emptyBindingUsesDefault")}</p>
                    </section>}
                    {!subjectAssembly && selected && <section className="border-t border-border pt-4" data-legacy-shot-reference-editor>
                        <h3 className="text-sm font-medium">{t("director.atomic.editShotReferences")}</h3>
                        <div className="mt-3 space-y-3">
                            <label className="grid gap-1 text-xs"><span>{t("director.atomic.ordinaryImageReferences")}</span>
                                <Select mode="multiple" value={assetIds} disabled={busy || reading || !onUpdateLegacyShotReferences} options={ordinaryAssetOptions}
                                    onChange={nextAssetIds => void onUpdateLegacyShotReferences?.(activeId, nextAssetIds, selectedKeyframeAssetId || null)} />
                            </label>
                            <label className="grid gap-1 text-xs"><span>{t("director.atomic.keyframeReferences")}</span>
                                <Select allowClear value={selectedKeyframeAssetId || undefined} disabled={busy || reading || !onUpdateLegacyShotReferences} options={assetOptions}
                                    onChange={nextAssetId => void onUpdateLegacyShotReferences?.(activeId, assetIds, nextAssetId || null)} />
                            </label>
                        </div>
                    </section>}                    <section data-production-section="shot-references" tabIndex={-1}><h3 className="flex items-center gap-2 text-sm font-medium"><ImageIcon className="size-4" />{t("director.atomic.references")}</h3><p className="mt-1 text-xs text-muted-foreground">{t(subjectAssembly ? "director.atomic.referencesHint" : "director.atomic.legacyReferencesHint")}</p>{reading ? <p className="mt-3 text-xs text-muted-foreground">{t("director.atomic.loading")}</p> : workbenchError ? <div className="mt-3 text-xs"><p className="text-muted-foreground">{workbenchError}</p><Button size="small" type="text" onClick={() => setRetry(value => value + 1)}>{t("director.atomic.retry")}</Button></div> : <div className="mt-3 space-y-3">{references.map(reference => <div key={`${reference.subjectId}:${reference.id}`} className="flex gap-3">{reference.resolved?.storageKey ? <img src={backendMediaUrl(reference.resolved.storageKey)} alt={reference.displayName || subjectDisplayName(source, reference.subjectId)} className="h-16 w-16 shrink-0 rounded object-contain" loading="lazy" /> : <span className="flex h-16 w-16 shrink-0 items-center justify-center text-muted-foreground"><ImageIcon className="size-5" /></span>}<div className="min-w-0"><p className="text-xs font-medium">{reference.displayName || subjectDisplayName(source, reference.subjectId)}</p><p className="mt-1 text-[11px] text-muted-foreground">{(reference.provides || []).map((purpose: string) => t(`director.crud.purpose.${purpose}`, { defaultValue: /[\u4e00-\u9fff]/.test(purpose) ? purpose : t("director.crud.otherPurpose") })).join(" · ")}</p><p className="mt-1 text-[11px] text-muted-foreground">{t(!subjectAssembly ? "director.atomic.legacyReferenceBinding" : reference.selection?.mode === "node_selection" ? "director.atomic.followNodeReference" : reference.selection?.mode === "selected_result" ? "director.workspace.selectedHistory" : "director.workspace.followLatest")}</p><ReferenceNodeLink sourceNode={reference.sourceNode} /><button type="button" onClick={() => onNavigate("assets", { kind: "asset", id: subjectAssembly ? reference.subjectId : reference.id })} className="mt-1 inline-flex items-center gap-0.5 text-[11px] text-primary hover:underline">{t("director.atomic.viewReference")}<ArrowRight className="size-3" /></button></div></div>)}{!references.length && <p className="text-xs text-muted-foreground">{t("director.atomic.noResolvedReferences")}</p>}</div>}</section>
                    {keyframes.length > 0 && <section className="border-t border-border pt-4"><h3 className="text-sm font-medium">{t("director.atomic.keyframeReferences")}</h3><div className="mt-3 space-y-3">{keyframes.map(frame => <div key={frame.id} className="flex gap-3">{frame.resolved?.storageKey ? <img src={backendMediaUrl(frame.resolved.storageKey)} alt={t("director.atomic.anchor." + frame.anchor)} className="h-16 w-16 shrink-0 rounded object-contain" loading="lazy" /> : <span className="flex h-16 w-16 shrink-0 items-center justify-center text-muted-foreground"><ImageIcon className="size-5" /></span>}<div className="min-w-0"><p className="text-xs font-medium">{t("director.atomic.anchor." + frame.anchor)}</p><p className="mt-1 text-[11px] text-muted-foreground">{frame.requiredForSubmission ? t("director.atomic.requiredAnchor") : t("director.atomic.designAnchor")}</p>{frame.anchor === "at_frame" && <p className="mt-1 text-[11px] text-muted-foreground">{frame.localFrame}f</p>}<ReferenceNodeLink sourceNode={frame.sourceNode} /></div></div>)}</div></section>}
                    <details className="border-t border-border pt-4"><summary className="cursor-pointer text-sm font-medium">{t("director.atomic.compiledOutput")}</summary><p className="mt-2 text-xs text-muted-foreground">{t(compiled ? "director.atomic.outputHint" : "director.atomic.previousOutput")}</p>{artifact ? <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs leading-5">{artifact.prompt}</pre> : <p className="mt-3 text-xs text-muted-foreground">{t("director.atomic.pendingCompile")}</p>}<Button className="mt-2" size="small" type="text" disabled={!clip} onClick={() => clip && onClip(String(clip.id))}>{t("director.atomic.openClip")}<ArrowRight className="size-3" /></Button></details>
                </aside>
            </div>
            </div>
            </div>
        </>}
    </div>;
}

/**
 * 镜头卡片左侧的关键帧缩略图。未绑定关键帧时渲染同尺寸占位，避免同一列表里各行文字左右跳动。
 * 只读展示，点击仍然落在整张卡片上（选中镜头），所以这里不拦截事件。
 */
function ShotKeyframeThumb({ storageKey }: { storageKey: string }) {
    const frameClass = "h-11 w-20 shrink-0 rounded-md border border-border bg-muted/30";
    return storageKey
        ? <img className={`${frameClass} object-cover`} src={backendMediaUrl(storageKey)} alt="" loading="lazy" />
        : <span aria-hidden="true" className={`${frameClass} flex items-center justify-center text-muted-foreground`}><ImageIcon className="size-4" /></span>;
}

function ShotClipSplitHandle({ disabled, onSplit, vertical = false }: { disabled: boolean; vertical?: boolean; onSplit: () => void }) {
    const { t } = useTranslation();
    return <button type="button" disabled={disabled} onClick={onSplit} aria-label={t("director.atomic.clipBoundarySplit")} title={disabled ? undefined : t("director.atomic.clipBoundarySplitHint")} data-shot-clip-split-boundary
        className={vertical ? "storyboard-split group" : "group flex w-7 min-h-12 shrink-0 cursor-pointer items-stretch justify-center rounded-sm border-0 bg-transparent p-0 hover:bg-primary/10 disabled:cursor-not-allowed"}>
        <span className={vertical ? "text-xs text-muted-foreground" : "my-1 w-0.5 rounded-full bg-border group-hover:bg-primary/70 group-disabled:bg-transparent"}>{vertical ? t("director.atomic.clipBoundarySplit") : null}</span>
    </button>;
}

/**
 * 相邻两个 Clip 之间的分割块：拖动按镜头边界重新划分归属，右键做「并入相邻片段 / 合并」。
 * 每个 Clip 至少保留 1 个镜头，边界被夹在两侧非空的位置，因此不可能越过相邻的其他分割块。
 */
function ClipBoundaryHandle({ pairIndex, leftClipId, rightClipId, leftIds, rightIds, profileConflict, shots, fps, chips, track, disabled, onCommit, onMerge, vertical = false }: {
    vertical?: boolean; pairIndex: number; leftClipId: string; rightClipId: string; leftIds: string[]; rightIds: string[]; profileConflict: boolean; shots: Array<Record<string, any>>; fps: number;
    chips: { current: Map<string, HTMLElement> }; track: { current: HTMLDivElement | null }; disabled: boolean;
    onCommit: (count: number) => Promise<unknown> | unknown; onMerge: (profileSourceId?: string) => Promise<unknown> | unknown;
}) {
    const { t } = useTranslation();
    // 拖动状态全部留在本组件：move 期间不触发父级重渲染（被移动镜头的高亮直接操作芯片 DOM）。
    type DragState = { count: number; edges: Array<{ count: number; viewport: number; content: number }>; guide: number };
    const [drag, setDrag] = useState<DragState | null>(null);
    const [merge, setMerge] = useState<{ profileSourceId: string } | null>(null);
    const activeDrag = useRef<DragState | null>(null);
    const activePointerId = useRef<number | null>(null);
    const dragPointerY = useRef<number | null>(null);
    const autoScrollFrame = useRef<number | null>(null);
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
    const updateDragAt = (position: number) => {
        const current = activeDrag.current;
        if (!current) return;
        const elements = allIds.map(id => chips.current.get(id));
        const trackElement = track.current;
        const edges = trackElement && elements.every(Boolean)
            ? clipBoundaryPositions(elements.map(item => item!.getBoundingClientRect()), boundaryCounts(leftCount, rightCount), trackElement.getBoundingClientRect(), vertical ? trackElement.scrollTop : trackElement.scrollLeft, vertical)
            : current.edges;
        const count = nearestBoundaryCount(position, edges.map(item => ({ count: item.count, edge: item.viewport }))) ?? current.count;
        const target = edges.find(item => item.count === count);
        if (!target) return;
        const next = { count, edges, guide: target.content };
        const edgesChanged = edges.length !== current.edges.length || edges.some((edge, index) => edge.viewport !== current.edges[index]?.viewport || edge.content !== current.edges[index]?.content);
        if (count !== current.count) highlight(movingIds(count));
        activeDrag.current = next;
        if (count !== current.count || next.guide !== current.guide || edgesChanged) setDrag(next);
    };
    const stopAutoScroll = () => {
        if (autoScrollFrame.current !== null) {
            window.cancelAnimationFrame(autoScrollFrame.current);
            autoScrollFrame.current = null;
        }
    };
    const scheduleAutoScroll = () => {
        if (!vertical || autoScrollFrame.current !== null) return;
        autoScrollFrame.current = window.requestAnimationFrame(() => {
            autoScrollFrame.current = null;
            const trackElement = track.current;
            const pointerY = dragPointerY.current;
            if (!activeDrag.current || !trackElement || pointerY === null) return;
            const rect = trackElement.getBoundingClientRect();
            const delta = clipBoundaryAutoScrollDelta(pointerY, rect, trackElement.scrollTop, trackElement.scrollHeight, trackElement.clientHeight);
            if (!delta) return;
            const before = trackElement.scrollTop;
            const maxScrollTop = Math.max(0, trackElement.scrollHeight - trackElement.clientHeight);
            trackElement.scrollTop = Math.min(Math.max(0, before + delta), maxScrollTop);
            if (trackElement.scrollTop === before) return;
            updateDragAt(pointerY);
            scheduleAutoScroll();
        });
    };
    useEffect(() => () => {
        if (autoScrollFrame.current !== null) window.cancelAnimationFrame(autoScrollFrame.current);
    }, []);
    const begin = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (disabled || allIds.length < 2) return false;
        const elements = allIds.map(id => chips.current.get(id));
        if (elements.some(element => !element)) return false; // 搜索过滤掉边界上的镜头时不做几何吸附，右键仍可用
        const trackElement = track?.current ?? event.currentTarget.closest("[data-clip-track]");
        if (!trackElement) return false;
        const rects = elements.map(element => element!.getBoundingClientRect());
        const trackRect = trackElement.getBoundingClientRect();
        // 引导线吸附到「未来边界」的真实位置：相邻两枚芯片间隙的中点（含跨组的那条缝）。
        const edges = clipBoundaryPositions(rects, boundaryCounts(leftCount, rightCount), trackRect, vertical ? trackElement.scrollTop : trackElement.scrollLeft, vertical);
        stopAutoScroll();
        highlight(movingIds(leftCount));
        const initial = { count: leftCount, edges, guide: edges.find(item => item.count === leftCount)!.content };
        activeDrag.current = initial;
        dragPointerY.current = vertical ? event.clientY : null;
        setDrag(initial);
        return true;
    };
    const move = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!activeDrag.current) return;
        const position = vertical ? event.clientY : event.clientX;
        if (vertical) dragPointerY.current = event.clientY;
        updateDragAt(position);
        scheduleAutoScroll();
    };
    const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
        stopAutoScroll();
        if (activeDrag.current) updateDragAt(vertical ? event.clientY : event.clientX);
        dragPointerY.current = null;
        const current = activeDrag.current;
        activeDrag.current = null;
        setDrag(null); highlight([]);
        if (current && current.count !== leftCount) void onCommit(current.count);
    };
    const cancel = () => {
        stopAutoScroll();
        dragPointerY.current = null;
        activeDrag.current = null;
        setDrag(null); highlight([]);
    };
    const pointerHandlers = createClipBoundaryPointerHandlers<ReactPointerEvent<HTMLDivElement>>(activePointerId, { begin, move, finish, cancel });
    const items = [
        { key: "to-left", label: t("director.atomic.clipBoundaryToLeft", { clip: pairIndex + 1 }), disabled: rightCount <= 1 },
        { key: "to-right", label: t("director.atomic.clipBoundaryToRight", { clip: pairIndex + 2 }), disabled: leftCount <= 1 },
        { type: "divider" as const },
        { key: "merge", label: t("director.atomic.clipBoundaryMerge") },
    ];
    const mergedDuration = clipDurationSeconds(allIds, shots, fps);
    const handleMenuClick = ({ key }: { key: string }) => {
        if (key === "to-left" && rightCount > 1) void onCommit(leftCount + 1);
        else if (key === "to-right" && leftCount > 1) void onCommit(leftCount - 1);
        else if (key === "merge") {
            if (!profileConflict && !outsideClipWindow(mergedDuration)) void onMerge(leftClipId);
            else setMerge({ profileSourceId: leftClipId });
        }
    };
    const guide = drag && track.current ? createPortal(
        <div className={`pointer-events-none absolute z-20 ${vertical ? "inset-x-0 border-t-2 border-primary" : "inset-y-0"}`} style={vertical ? { top: drag.guide } : { left: drag.guide }} data-clip-boundary-guide>
            <span className="absolute inset-y-0 -ml-px w-0.5 bg-primary/80" />
            <span data-clip-boundary-badge className={`absolute top-0 ${vertical ? "left-2" : "left-0 -translate-x-1/2"} inline-flex items-center gap-2 whitespace-nowrap rounded bg-primary px-1.5 py-0.5 text-xs text-primary-foreground`}>
                <span data-clip-owner="left">{t("director.atomic.clipHeading", { number: pairIndex + 1 })} · {t("director.atomic.clipSummary", { count: leftNow, seconds: secondsOf(allIds.slice(0, leftNow)) })}</span>
                <span aria-hidden="true">|</span>
                <span data-clip-owner="right">{t("director.atomic.clipHeading", { number: pairIndex + 2 })} · {t("director.atomic.clipSummary", { count: allIds.length - leftNow, seconds: secondsOf(allIds.slice(leftNow)) })}</span>
            </span>
        </div>, track.current) : null;
    return <>{guide}
    {vertical ? <div className="storyboard-boundary group" data-clip-boundary={`${pairIndex + 1}-${pairIndex + 2}`}>
        <div aria-hidden="true" data-clip-boundary-grip className={`storyboard-boundary-grip ${drag ? "is-dragging" : ""} ${disabled ? "is-disabled" : ""}`} {...pointerHandlers}>
            <span className="storyboard-boundary-grip-icon"><GripHorizontal className="size-4" /></span>
        </div>
        <Dropdown trigger={["contextMenu", "click"]} disabled={disabled} menu={{ items, onClick: handleMenuClick }}>
            <button type="button" disabled={disabled} aria-label={t("director.atomic.clipBoundary")} title={disabled ? undefined : t("director.atomic.clipBoundaryHint")} aria-haspopup="menu" className="storyboard-boundary-menu">
                {t("director.atomic.adjustBoundary")} <span aria-hidden="true">⌄</span>
            </button>
        </Dropdown>
    </div> : <Dropdown trigger={["contextMenu"]} disabled={disabled} menu={{ items, onClick: handleMenuClick }}>
        <div role="separator" tabIndex={disabled ? -1 : 0} aria-orientation="vertical" aria-label={t("director.atomic.clipBoundary")} title={disabled ? undefined : t("director.atomic.clipBoundaryHint")}
            data-clip-boundary={`${pairIndex + 1}-${pairIndex + 2}`}
            {...pointerHandlers}
            className={`group relative flex w-3 shrink-0 touch-none items-stretch justify-center ${disabled ? "cursor-default" : "cursor-col-resize"}`}>
            <span className={`my-1 w-[3px] rounded-full transition-colors ${drag ? "bg-primary" : disabled ? "bg-border" : "bg-border group-hover:bg-primary/60"}`} />
        </div>
    </Dropdown>}
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
