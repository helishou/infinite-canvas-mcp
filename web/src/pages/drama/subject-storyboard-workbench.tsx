import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Alert, App, Button, Dropdown, Input, Modal, Progress, Radio, Select, Tag } from "antd";
import { ArrowLeft, ArrowRight, ArrowUpRight, CheckCircle2, ChevronDown, Circle, CircleAlert, Database, Eye, GripHorizontal, Image as ImageIcon, LoaderCircle, Locate, Lock, LockOpen, Play, Search, Trash2, WandSparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isSubjectPromptAssembly, type DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { currentCompilationArtifact } from "@basketikun/canvas-agent/drama/compilation-scope";
import { subjectShotWindows, subjectStateProjection } from "@basketikun/canvas-agent/drama/subject-assembly";
import { backendMediaUrl, fetchProductionWorkbench, type EpisodeProduction, type ProductionCompilationDiagnostic, type ProductionTarget } from "@/services/backend-api";
import { records, formatSeconds, readableText } from "./director-display";
import { productionWorkbenchValue, subjectDisplayName } from "./subject-shot-draft";
import { productionSegmentRuntimeMatches } from "@/lib/production-source";
import { translateCompiledH3Prompts, type H3PromptBatchProgress } from "@/services/api/translation";
import { continuityPresentation } from "./continuity-presentation";
import { currentClipRefreshes } from "./production-refresh-display";
import { compileElapsedSeconds, isCompileActive, useCompileClock } from "./compile-progress";
import { ReferenceNodeLink } from "./reference-node-link";
import { useReferenceResultVersion } from "./use-reference-result-version";
import { ShotOperations, type ShotOperation } from "./shot-operations";
import { readShotFormDraft, shotDraftChanged } from "./subject-shot-draft";
import type { DirectorWorkspace } from "./director-panel";
import { storyboardArtifactState, storyboardDurationFrames, storyboardPeople, storyboardReportedState, storyboardScenes, storyboardSceneShotIds } from "./storyboard-display";
import { boundaryCounts, clipBoundaryAutoScrollDelta, clipBoundaryPositions, clipDurationSeconds, clipProfileKey, clipShotIds, createClipBoundaryPointerHandlers, materializeClipPartition, nearestBoundaryCount, outsideClipWindow, partitionAt } from "./clip-boundary";

/** 单独计时的最小节点：只有它每秒重渲染，避免把整条时间线一起带动。 */
function CompileElapsed({ updatedAt, status }: { updatedAt?: string; status?: string }) {
    const now = useCompileClock(Boolean(updatedAt && isCompileActive(status)));
    const seconds = compileElapsedSeconds(updatedAt, now);
    return !isCompileActive(status) || seconds === undefined ? null : <span className="text-muted-foreground"> · {seconds}s</span>;
}

/** 工作包读取缓存（LRU）：同一镜头、同一源稿版本、同一参考结果版本直接命中，避免反复「正在读取镜头工作包」。 */
const workbenchCache = new Map<string, Record<string, any>>();

export type StoryboardViewMemory = { current?: { selectedId: string; sceneFilter: string; search: string; view: "shots" | "clips"; mobileEditing: boolean; detailView: "editing" | "context"; shotSection?: "direction" | "sound" | "subjects" | "anchors"; scrollTop: number } };

function readSavedStoryboardSelection(storageKey: string) {
    try { return typeof window === "undefined" ? "" : window.localStorage.getItem(storageKey) || ""; }
    catch { return ""; }
}

type Props = {
    director: DirectorProduction; production: EpisodeProduction; owner: ProductionTarget; initialShotId?: string;
    activeView: "shots" | "clips";
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
    /** 保存并重新编译相邻 Clip 的 H3 衔接设置。 */
    onH3Boundary?: (boundary: DirectorProduction["boundaries"][number]) => Promise<boolean> | boolean;
    onEditShot?: (operation: ShotOperation) => Promise<boolean>;
    onSaveShotPatch?: (shotId: string, patch: Record<string, unknown>) => Promise<boolean>;
    onUpdateLegacyShotReferences?: (shotId: string, assetIds: string[], keyframeAssetId: string | null) => Promise<boolean>;

    /** 该镜头卡片左侧时间关键帧缩略图；由 DirectorPanel 注入，构图参考不作为此缩略图来源。 */
    shotKeyframe?: (shotId: string) => string | undefined;

    shotDrafts?: Record<string, string>;
    /** Clip 组合使用与交付页相同的 Backend 编译提交与恢复流程。 */
    busy?: boolean; compileBusy?: boolean; compilePending?: boolean; compileError?: string; compileNotice?: string; compileDiagnostics?: ProductionCompilationDiagnostic[];
    compileTargets?: { sourceHash: string; engineRuntimeId?: string; compilerHash?: string; items: Array<{ targetId: string; status: string }>; notReadyTargetIds?: string[] }; onCompile?: (sceneId?: string, targetId?: string, targetIds?: string[]) => void;
    onApplyTranslatedPrompts?: (items: Array<{ targetId: string; nodeId: string; segmentId: string; sourcePrompt: string; expectedCanvasPrompt: string; translatedPrompt: string }>) => Promise<void>;
    onToggleClipLock?: (clipId: string, locked: boolean) => Promise<boolean>;
    lockReadOnly?: boolean;
    autoTranslateCompilation?: { id: string; targetIds: string[] } | null;
    onClip: (id: string) => void;
    onDeleteClip?: (clipId: string) => Promise<boolean | void>;
    /** 编译就绪后直接提交该 Clip 的生成，不再要求切到「生成」工作区。 */
    onGenerateClip?: (clipId: string) => void;
    runStartPending?: boolean;
    onDiscuss: (targetId?: string, instruction?: string, workspace?: DirectorWorkspace, clipContext?: boolean) => void;
    /** 跳转到指定工作区（参考素材点开进素材库）。 */
    onNavigate: (workspace: DirectorWorkspace, target?: { kind: string; id: string }) => void;
};

type TranslationProgressDetail = H3PromptBatchProgress & { phase: "preparing" | "translating" | "writing" | "complete" | "failed"; targetIds: string[]; writingIds: string[]; writtenIds: string[] };

function compileDiagnosticTaskContext(diagnostics: ProductionCompilationDiagnostic[]) {
    type Group = { severity: string; code: string; path: string; message: string; blocksCompilation?: boolean; blockingActions: string[]; count: number; targetIds: Set<string>; shotIds: Set<string> };
    const groups = new Map<string, Group>();
    const targetIds = new Set<string>();
    for (const item of diagnostics) {
        const severity = String(item.severity || "warning"), code = String(item.code || "UNKNOWN_COMPILATION_DIAGNOSTIC");
        const path = String(item.path || "compile"), message = String(item.message || code).replace(/\s+/g, " ").trim();
        const blockingActions = [...new Set(item.blockingActions || [])].sort();
        const key = JSON.stringify([severity, code, path, message, item.blocksCompilation, blockingActions]);
        let group = groups.get(key);
        if (!group) {
            group = { severity, code, path, message, blocksCompilation: item.blocksCompilation, blockingActions, count: 0, targetIds: new Set(), shotIds: new Set() };
            groups.set(key, group);
        }
        group.count += 1;
        for (const id of [...(item.affectedTargets || []), item.targetId].filter((value): value is string => Boolean(value))) {
            group.targetIds.add(id); targetIds.add(id);
        }
        if (item.shotId) group.shotIds.add(item.shotId);
    }
    const details = [...groups.values()].map(group => [
        `- [${group.severity}${group.blocksCompilation ? ", blocks compilation" : ""}] ${group.code} · ${group.path}`,
        group.message,
        group.count > 1 ? `重复 ${group.count} 次` : "",
        group.targetIds.size ? `目标：${[...group.targetIds].sort().join(", ")}` : "",
        group.shotIds.size ? `镜头：${[...group.shotIds].sort().join(", ")}` : "",
        group.blockingActions.length ? `阻断动作：${group.blockingActions.join(", ")}` : "",
    ].filter(Boolean).join("；"));
    return {
        targetId: targetIds.size === 1 ? [...targetIds][0] : undefined,
        instruction: [
            `请处理当前 Clip 组合最近一次编译返回的 ${diagnostics.length} 条诊断（相同诊断已归组为 ${groups.size} 项）：`,
            ...details,
            "先读取当前 Backend 正式源稿和相关工作包，按诊断修复可定位的源字段；保留已确认的故事、对白、连续性和未涉及内容。诊断若无法安全映射到源稿，说明原因并提出需要人工决定的选项。修改后核对 Backend 回执与诊断状态；不要生成媒体。",
        ].join("\n"),
    };
}

/** The v2 authoring surface: stable Shots, derived Clip packaging, and compiler evidence. */
export function SubjectStoryboardWorkbench({ director, production, owner, initialShotId, activeView, viewMemory, canvasNodes, canvasId, onLocateClip, renderEditor, renderShotState, renderContinuity, renderShotActions, clipEditor, onRepartitionClips, onH3Boundary, onEditShot, onSaveShotPatch, onUpdateLegacyShotReferences, shotKeyframe, shotDrafts = {}, busy, compileBusy = false, compilePending = false, compileError = "", compileNotice = "", compileDiagnostics = [], compileTargets, onCompile, onApplyTranslatedPrompts, onToggleClipLock, lockReadOnly = false, autoTranslateCompilation, onClip, onDeleteClip, onGenerateClip, runStartPending = false, onDiscuss, onNavigate }: Props) {
    const { t } = useTranslation();
    const { message, modal } = App.useApp();
    const source = director.source as Record<string, any>;
    const subjectAssembly = isSubjectPromptAssembly(source);
    const humanState = continuityPresentation({ facts: records(source.ledger?.facts), timelines: records(source.ledger?.timelines), scenes: records(source.script_scenes), locations: records(source.scene_registry), characters: records(source.character_registry), assets: records(source.asset_plan), shots: records(source.shots), segments: records(source.segments), sourceBlocks: [] }, (key, values) => t(`director.workspace.continuity.${key}`, values));
    const fps = Number(source.fps_num || 24) / Number(source.fps_den || 1);
    const shots = records(source.shots).sort((a, b) => Number(a.story_order) - Number(b.story_order)), clips = records(source.segments), subjects = records(source.subject_registry);
    const [clipLockOverrides, setClipLockOverrides] = useState<Record<string, boolean>>({});
    const [clipLockPending, setClipLockPending] = useState<Record<string, boolean>>({});
    const clipLockQueueRef = useRef<Promise<void>>(Promise.resolve());
    const onToggleClipLockRef = useRef(onToggleClipLock);
    const lockBusyRef = useRef(Boolean(busy));
    const lockRenderWaitersRef = useRef<Array<() => void>>([]);
    onToggleClipLockRef.current = onToggleClipLock;
    lockBusyRef.current = Boolean(busy);
    useEffect(() => {
        lockRenderWaitersRef.current.splice(0).forEach(resolve => resolve());
    });
    useEffect(() => {
        const savedLocks = new Map(clips.map(item => [String(item.id), item.locked === true]));
        setClipLockOverrides(current => {
            const next = { ...current };
            for (const [id, locked] of Object.entries(current)) if (savedLocks.get(id) === locked) delete next[id];
            return Object.keys(next).length === Object.keys(current).length ? current : next;
        });
    }, [director.sourceHash]);
    const operationShots = shots.map(shot => { const draft = readShotFormDraft(shotDrafts[`v2shot:${shot.id}`], shot); return draft.invalid ? shot : { ...shot, ...draft.draft.value }; });
    const unsavedShots = shots.filter(shot => { const draft = readShotFormDraft(shotDrafts[`v2shot:${shot.id}`], shot, source); return draft.invalid || shotDraftChanged(draft.draft); });
    const unsavedIds = new Set(unsavedShots.map(shot => String(shot.id)));
    const ownerKey = JSON.stringify(owner);
    const sceneFilterStorageKey = `drama-storyboard-scene-filter:${ownerKey}`;
    const storyboardSelectionStorageKey = `director-storyboard-selection-v1:${ownerKey}`;
    const [selectedId, setSelectedId] = useState(() => initialShotId || viewMemory?.current?.selectedId || readSavedStoryboardSelection(storyboardSelectionStorageKey));
    const clipCardRefs = useRef(new Map<string, HTMLElement>());
    const observedSelectionOwner = useRef("");
    const observedProductionClip = useRef("");
    const initialViewMemory = useRef(viewMemory?.current);
    const pendingClipScrollShotId = useRef("");
    const pendingScrollTop = useRef<number | null>(null);
    const scrollSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const storyboardScrollStorageKey = `director-storyboard-scroll-v1:${ownerKey}`;
    const [draggingShotId, setDraggingShotId] = useState("");
    const [translationProgress, setTranslationProgress] = useState<TranslationProgressDetail | null>(null);
    const [writtenTranslationStatuses, setWrittenTranslationStatuses] = useState<Record<string, { sourceHash: string; status: "complete" | "cached" }>>({});
    const [translationError, setTranslationError] = useState("");
    const [translatingPrompts, setTranslatingPrompts] = useState(false);
    const [promptPreviewClipId, setPromptPreviewClipId] = useState("");
    const translatingPromptsRef = useRef(false);
    const autoTranslateHandledRef = useRef("");
    const activeTranslationRef = useRef<{ controller: AbortController; sourceHash: string } | null>(null);
    const [search, setSearch] = useState(viewMemory?.current?.search || "");
    const [sceneFilter, setSceneFilter] = useState(() => {
        if (initialShotId) return "";
        try { return window.localStorage.getItem(sceneFilterStorageKey) ?? viewMemory?.current?.sceneFilter ?? ""; }
        catch { return viewMemory?.current?.sceneFilter || ""; }
    });
    const [mobileEditing, setMobileEditing] = useState(Boolean(initialShotId) || Boolean(viewMemory?.current?.mobileEditing));
    const [detailView, setDetailView] = useState<"editing" | "context">(viewMemory?.current?.detailView || "editing");
    const [shotSection, setShotSection] = useState<"direction" | "sound" | "subjects" | "anchors">(viewMemory?.current?.shotSection || "direction");
    const selectShot = (id: string) => {
        setSelectedId(id);
        pendingClipScrollShotId.current = id === activeId ? "" : id;
        try { localStorage.setItem(storyboardSelectionStorageKey, id); } catch { /* Selection restoration is an optional view preference. */ }
        setMobileEditing(true);
    };
    const sceneDirectory = useMemo(() => storyboardScenes(source), [source, director.sourceHash]);
    const sceneIds = storyboardSceneShotIds(source, sceneFilter);
    const view = activeView;
    const [workbench, setWorkbench] = useState<Record<string, any>>();
    const [workbenchId, setWorkbenchId] = useState("");
    const [continuityFactDrafts, setContinuityFactDrafts] = useState<Record<string, Record<string, string[]>>>({});
    const [savingContinuityFacts, setSavingContinuityFacts] = useState(false);
    const [continuityFactModalOpen, setContinuityFactModalOpen] = useState(false);
    const workbenchReadKey = useRef("");
    const [workbenchError, setWorkbenchError] = useState("");
    const [retry, setRetry] = useState(0);
    const [reading, setReading] = useState(false);
    const windows = useMemo(() => subjectShotWindows(source), [source]);
    const states = useMemo(() => subjectStateProjection(source), [source]);
    useEffect(() => {
        if (sceneFilter && sceneFilter !== "__unassigned__" && !sceneDirectory.scenes.some(scene => scene.id === sceneFilter)) setSceneFilter("");
    }, [sceneFilter, sceneDirectory]);
    useEffect(() => {
        try { window.localStorage.setItem(sceneFilterStorageKey, sceneFilter); } catch { /* View preference storage is optional. */ }
    }, [sceneFilterStorageKey, sceneFilter]);
    useEffect(() => { if (initialShotId) { setSelectedId(initialShotId); setSceneFilter(""); setMobileEditing(true); } }, [initialShotId, ownerKey]);
    const selected = shots.find(shot => String(shot.id) === selectedId) || shots[0];
    const activeId = String(selected?.id || "");
    const clip = clips.find(item => (item.shot_ids || []).includes(activeId));
    const clipIndex = clips.findIndex(item => item.id === clip?.id);
    useEffect(() => {
        if (!activeId) return;
        try { localStorage.setItem(storyboardSelectionStorageKey, activeId); } catch { /* Selection restoration is an optional view preference. */ }
    }, [activeId, storyboardSelectionStorageKey]);
    useEffect(() => {
        const clipId = String(clip?.id || "");
        if (!clipId) return;
        if (observedSelectionOwner.current !== ownerKey) {
            // Seed the baseline on mount; a fallback first Shot must not overwrite the saved H3 selection on refresh.
            observedSelectionOwner.current = ownerKey;
            observedProductionClip.current = clipId;
            return;
        }
        if (observedProductionClip.current === clipId) return;
        observedProductionClip.current = clipId;
        if (activeView !== "shots") return;
        const matches = productionSegmentRuntimeMatches(canvasNodes as any, clipId);
        if (matches.length !== 1) return;
        const match = matches[0];
        window.dispatchEvent(new CustomEvent("production-select-clip", { detail: { projectId: canvasId, nodeId: match.node.id, segmentId: String(match.segment.id || "") } }));
    }, [activeView, canvasId, canvasNodes, clip?.id, ownerKey]);
    useEffect(() => {
        const onH3SelectClip = (event: Event) => {
            const detail = (event as CustomEvent<{ projectId?: string; nodeId?: string; segmentId?: string }>).detail;
            if (detail?.projectId !== canvasId || !detail.nodeId || !detail.segmentId) return;
            const node = canvasNodes.find(item => item.id === detail.nodeId);
            const segment = (Array.isArray(node?.metadata?.segments) ? node.metadata.segments : [])
                .find(item => String((item as Record<string, unknown>).id || "") === detail.segmentId) as Record<string, any> | undefined;
            const targetId = String(segment?.productionClipProjection?.targetId || "");
            const targetClip = clips.find(item => String(item.id) === targetId);
            const firstShotId = targetClip ? clipShotIds(targetClip)[0] : undefined;
            if (!firstShotId) return;
            observedProductionClip.current = targetId;
            setSelectedId(firstShotId);
            if (firstShotId === activeId && activeView === "shots") {
                pendingClipScrollShotId.current = "";
                requestAnimationFrame(() => clipCardRefs.current.get(targetId)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
            } else pendingClipScrollShotId.current = firstShotId;
            try { localStorage.setItem(storyboardSelectionStorageKey, firstShotId); } catch { /* Selection restoration is an optional view preference. */ }
        };
        window.addEventListener("minimax-h3-select-clip", onH3SelectClip);
        return () => window.removeEventListener("minimax-h3-select-clip", onH3SelectClip);
    }, [activeId, activeView, canvasId, canvasNodes, clips, storyboardSelectionStorageKey]);
    useLayoutEffect(() => {
        const shotId = pendingClipScrollShotId.current;
        if (!shotId || activeView !== "shots") return;
        pendingClipScrollShotId.current = "";
        const targetClip = clips.find(item => clipShotIds(item).includes(shotId));
        if (targetClip) clipCardRefs.current.get(String(targetClip.id))?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, [activeView, activeId, clips]);
    const number = shots.findIndex(item => String(item.id) === activeId) + 1;
    const title = (shot: Record<string, any>) => String(operationShots.find(item => item.id === shot.id)?.title || shot.title || t("director.studio.shotNumber", { number: shots.findIndex(item => item.id === shot.id) + 1 }));
    const framing = (shot: Record<string, any>) => ["EWS", "WS", "FS", "MS", "MCU", "CU", "ECU"].includes(shot.camera?.framing) ? t("director.atomic.framingName." + shot.camera.framing) : shot.camera?.framing || "—";
    const duration = (shot: Record<string, any>) => storyboardDurationFrames(shot) / fps;
    // 全片时间轴：该镜头在全片成片中的起止秒（前面所有镜头时长累加，按 story_order 顺序）。
    const filmRanges = (() => { const ranges = new Map<string, { start: number; end: number }>(); let running = 0; for (const shot of shots) { const frames = storyboardDurationFrames(shot); ranges.set(String(shot.id), { start: running / fps, end: (running + frames) / fps }); running += frames; } return ranges; })();
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
    const clipEditorScope = { sceneId: sceneFilter || undefined, shotIds: clipEditorShotIds, editable: clipEditorContiguous && clipEditorSceneLocal && clipEditorGroupsLocal && clipEditorSegments.every(item => item.locked !== true) };
    const searchTerm = search.trim().toLocaleLowerCase();
    const visible = shots.filter((shot, index) => {
        const id = String(shot.id);
        if (!searchTerm) return sceneIds.has(id);
        const number = index + 1;
        if (/^\d+$/.test(searchTerm)) {
            const titleNumbers: string[] = String(title(shot)).match(/\d+/g) || [];
            return number === Number(searchTerm) || titleNumbers.includes(searchTerm);
        }
        const fields = `${title(shot)} ${id} 镜头${number} shot ${number} ${readableText(shot.visual)} ${people(shot)}`.toLocaleLowerCase();
        return fields.includes(searchTerm);
    });
    const referencedNodes = new Set(records(selected?.subject_usages).flatMap(usage => records(subjects.find(subject => subject.id === usage.subjectId)?.pictureBindings).map(binding => String(binding.sourceNode?.nodeId || "")))
        .concat(records(selected?.keyframes).map(frame => String(frame.sourceNode?.nodeId || ""))));
    const h3ClipMatches = clip ? productionSegmentRuntimeMatches(canvasNodes as any, String(clip.id)) : [];
    const h3ClipNodeIds = new Set(h3ClipMatches.length === 1 ? [String(h3ClipMatches[0].node.id)] : []);
    const referenceEvents = useReferenceResultVersion(records(selected?.subject_usages).flatMap(usage => records(subjects.find(subject => subject.id === usage.subjectId)?.pictureBindings).map(binding => binding.sourceNode || {})).concat(records(selected?.keyframes).map(frame => frame.sourceNode || {})));
    // Metadata only invalidates this read; Backend still selects and verifies the result.
    const referenceVersion = JSON.stringify(canvasNodes.filter(node => referencedNodes.has(node.id) || h3ClipNodeIds.has(node.id)).map(node => [node.id, node.metadata?.images, node.metadata?.storageKey, node.metadata?.resultStorageKey, node.metadata?.primaryImageId, node.metadata?.smartImageReferenceSelection,
        h3ClipNodeIds.has(node.id) ? records(node.metadata?.segments).filter(segment => String(segment.id) === String(h3ClipMatches[0]?.segment.id || "")).map(segment => [segment.audioDrive, segment.audioDriveFile, segment.audioDriveStart, segment.audioDriveEnd, segment.referenceBindings]) : null]));
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
    const activeRefreshJob = (clipId: string) => {
        const job = currentRefreshes.find(item => String(item.segmentId) === clipId);
        return job && isCompileActive(job.status) ? job : undefined;
    };
    const refreshCandidate = currentRefreshes.find(item => item.segmentId === clip?.id);
    const compiled = Boolean(workbenchReadKey.current === expectedReadKey && artifact && records(subjectAssembly ? workbench?.runtime?.directorArtifacts : workbench?.directorReferences?.compiled).some(item => item.id === artifact.id && item.sha256 === artifact.sha256 && item.current === true && item.status === "ready"));
    const compileBasisMatches = compileTargets?.sourceHash === director.sourceHash
        && compileTargets.engineRuntimeId === director.engine.runtimeId
        && compileTargets.compilerHash === director.engine.compilerHash;
    const compiledByLatestReceipt = compileBasisMatches
        && compileTargets.items.some(item => item.targetId === String(clip?.id) && item.status === "ready");
    const currentCompiled = compiled || compiledByLatestReceipt;
    const refresh = currentCompiled && ["blocked", "failed"].includes(refreshCandidate?.status || "") ? undefined : refreshCandidate;
    const selectedShotUsages = records(selected?.subject_usages);
    const factDraftForShot = continuityFactDrafts[activeId] || {};
    const continuityFacts = records(source.ledger?.facts);
    const continuityFactIdsForUsage = (usage: Record<string, any>) => {
        const subjectId = String(usage.subjectId || "");
        return factDraftForShot[subjectId] ?? (Array.isArray(usage.continuityFactIds) ? usage.continuityFactIds.map(String) : []);
    };
    const fullState = subjectAssembly ? workbench?.context?.continuity || states[activeId] : storyboardReportedState(workbench?.continuity, activeId);
    const selectedFactIds = new Set(selectedShotUsages.flatMap(continuityFactIdsForUsage));
    const state = subjectAssembly && fullState ? {
        ...fullState,
        start: records(fullState.start).filter(item => selectedFactIds.has(String(item.factId))),
        end: records(fullState.end).filter(item => selectedFactIds.has(String(item.factId))),
        unresolved: records(fullState.unresolved).filter(item => selectedFactIds.has(String(item.factId))),
    } : fullState;
    const continuityFactSelectionChanged = selectedShotUsages.some(usage => {
        const draftIds = factDraftForShot[String(usage.subjectId || "")];
        const savedIds = Array.isArray(usage.continuityFactIds) ? usage.continuityFactIds.map(String) : [];
        return draftIds !== undefined && JSON.stringify([...new Set(draftIds)].sort()) !== JSON.stringify([...new Set(savedIds)].sort());
    });
    const saveContinuityFactSelection = async () => {
        if (!selected || !onSaveShotPatch || !continuityFactSelectionChanged || savingContinuityFacts) return false;
        const subject_usages = selectedShotUsages.map(usage => {
            const subjectId = String(usage.subjectId || ""), draftIds = factDraftForShot[subjectId];
            return draftIds === undefined ? usage : { ...usage, continuityFactIds: [...new Set(draftIds.map(String))] };
        });
        setSavingContinuityFacts(true);
        try {
            if (await onSaveShotPatch(activeId, { subject_usages })) {
                setContinuityFactDrafts(current => { const next = { ...current }; delete next[activeId]; return next; });
                setContinuityFactModalOpen(false);
                return true;
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally { setSavingContinuityFacts(false); }
        return false;
    };
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
    const references: Array<Record<string, any> & { subjectId: string }> = subjectAssembly ? records(workbench?.context?.resolvedSubjectUsages).flatMap(usage => records(usage.pictureBindings).map(binding => ({ ...binding, subjectId: String(usage.subjectId) })))
        : assetIds.map(assetId => ({ id: assetId, subjectId: assetId, displayName: records(source.asset_plan).find(asset => String(asset.asset_id || asset.id) === assetId)?.asset_name || assetId, resolved: workbench?.assets?.[assetId] || director.assets[assetId] }));
    const keyframes = records(workbench?.context?.keyframeMedia), referenceDiagnostics = records(workbench?.runtime?.resolutionDiagnostics);
    // 左栏「连续性状态」里的动作块（与下一段的边界开关），由 DirectorPanel 注入。
    // Empty sources still pass through this setup before the empty-state branch below.
    // Do not call shot renderers until selection has resolved to an actual shot.
    const continuityActions = selected ? renderContinuity?.(selected) : undefined;
    // 起止状态（镜头开始时 / 镜头结束时）：从「画面与摄影」挪进来，与台账状态、边界开关同区展示。
    const shotStateFields = selected ? renderShotState?.(selected) : undefined;
    const statusLabel = refresh ? t("director.workspace.clipRefreshStatus." + refresh.status, { segment: t("director.studio.clipNumber", { number: clipIndex + 1 }) })
        : t(currentCompiled ? "director.atomic.stateReady" : "director.atomic.statePending");
    const compiledArtifactMatchesCanvas = (clipId: string, artifact: DirectorProduction["artifacts"][number] | undefined) => {
        if (!artifact || artifact.kind !== "h3" || artifact.status !== "ready"
            || !currentCompilationArtifact(director, artifact)) return false;
        const matches = productionSegmentRuntimeMatches(canvasNodes as any, clipId);
        return matches.length === 1 && /^minimax|^smart-minimax/i.test(String(matches[0].node.type || ""));
    };
    const compileStaleReason = (artifact: DirectorProduction["artifacts"][number] | undefined, projection?: Record<string, unknown>) => {
        if (!artifact) return t("compileStaleReason.generic");
        const receipt = artifact.receipt as Record<string, any> | undefined;
        const compiledEngine = receipt?.engine as Record<string, unknown> | undefined;
        if (String(compiledEngine?.compilerHash || "") !== String(director.engine.compilerHash || "")) return t("compileStaleReason.compilerChanged");
        if (!receipt?.compilationScope && (artifact.sourceHash !== director.sourceHash || receipt?.sourceHash !== director.sourceHash)) return t("compileStaleReason.sourceChanged");
        if (projection?.current === false || receipt?.compilationScope) return t("compileStaleReason.inputChanged");
        return t("compileStaleReason.generic");
    };
    const staleReceiptTargets = compileBasisMatches
        ? (compileTargets.notReadyTargetIds || compileTargets.items.filter(item => item.status !== "ready").map(item => item.targetId))
            .filter(targetId => !compiledArtifactMatchesCanvas(String(targetId), director.artifacts.find(artifact => artifact.kind === "h3" && String(artifact.targetId) === String(targetId))))
        : [];
    // Clip 组合视图的编译状态：优先显示正在进行的自动刷新作业，其次读导演产物的真实编译状态（ready / 过期 / 未编译）。
    const clipCompileState = (clipId: string) => {
        const job = currentRefreshes.find(item => String(item.segmentId) === clipId);
        const artifact = director.artifacts.find(item => item.kind === "h3" && String(item.targetId) === clipId);
        const projection = workbenchReadKey.current === expectedReadKey && clipId === String(clip?.id) ? records(subjectAssembly ? workbench?.runtime?.directorArtifacts : workbench?.directorReferences?.compiled).find(item => item.id === artifact?.id && item.sha256 === artifact?.sha256) : undefined;
        const status = storyboardArtifactState(artifact, projection);
        const readyByLatestReceipt = compileBasisMatches && compileTargets.items.some(item => item.targetId === clipId && item.status === "ready");
        const notReadyByLatestReceipt = staleReceiptTargets.includes(clipId);
        const readyByPromptMatch = compiledArtifactMatchesCanvas(clipId, artifact);
        const artifactDiagnostics = artifact?.receipt?.diagnostics as Record<string, unknown> | undefined;
        const hasPersistedBlockers = Array.isArray(artifactDiagnostics?.blockers) && artifactDiagnostics.blockers.length > 0;
        if (job && !(readyByLatestReceipt || status === "ready" || readyByPromptMatch) ) {
            const active = isCompileActive(job.status);
            return { label: t(active ? "director.atomic.stateCompiling" : "director.atomic.stateBlocked"), color: active ? "processing" : "red",
                tone: active ? "live" as const : "blocked" as const, reason: t("director.atomic.clipRefreshPhase." + job.status) };
        }
        if ((notReadyByLatestReceipt || hasPersistedBlockers) && !readyByPromptMatch) return { label: t("director.atomic.stateBlocked"), color: "red", tone: "blocked" as const, reason: compileStaleReason(artifact, projection) };
        if (status === "pending") return { label: t("director.atomic.statePending"), color: undefined, tone: "pending" as const };
        if (status === "recorded" && !readyByPromptMatch) return { label: t("director.atomic.stateBlocked"), color: undefined, tone: "recorded" as const };
        return status === "ready" || readyByLatestReceipt || readyByPromptMatch
            ? { label: t("director.atomic.stateReady"), color: "green", tone: "ready" as const }
            : { label: t("director.atomic.stateBlocked"), color: "orange", tone: "stale" as const, reason: compileStaleReason(artifact, projection) };
    };
    const clipStates = clips.map(clip => ({ id: String(clip.id), ...clipCompileState(String(clip.id)) }));
    const lockedClipIds = new Set(clips.filter(item => clipLockOverrides[String(item.id)] ?? item.locked === true).map(item => String(item.id)));
    const visibleClipStates = !sceneFilter ? clipStates : clipStates.filter(item => clips.find(clip => String(clip.id) === item.id)?.shot_ids?.some((id: string) => directSceneShotIds.has(String(id))));
    const viewableCompiledPrompts = visibleClipStates.flatMap(item => {
        const artifact = director.artifacts.find(candidate => candidate.kind === "h3" && candidate.targetId === item.id);
        return item.tone === "ready" && artifact?.status === "ready" && currentCompilationArtifact(director, artifact)
            ? [{ targetId: item.id, prompt: artifact.prompt }]
            : [];
    });
    const selectedPromptPreview = viewableCompiledPrompts.find(item => item.targetId === promptPreviewClipId);
    const activeVisibleClipStates = visibleClipStates.filter(item => !lockedClipIds.has(item.id));
    const clipsNeedingCompile = activeVisibleClipStates.filter(item => item.tone !== "ready");
    const sceneCompileAvailable = !sceneFilter || sceneDirectory.scenes.some(scene => scene.id === sceneFilter);
    const compileCounts = { ready: activeVisibleClipStates.filter(item => item.tone === "ready").length, pending: activeVisibleClipStates.filter(item => item.tone === "pending").length, stale: activeVisibleClipStates.filter(item => item.tone === "stale").length, running: activeVisibleClipStates.filter(item => item.tone === "live").length, recorded: activeVisibleClipStates.filter(item => item.tone === "recorded").length, blocked: activeVisibleClipStates.filter(item => item.tone === "blocked").length };
    const canTranslateCompiledPrompts = Boolean(onApplyTranslatedPrompts && activeVisibleClipStates.length && activeVisibleClipStates.every(item => item.tone === "ready") && !busy && !compileBusy && !compilePending && !translatingPrompts);
    const translateCompiledPrompts = async (requestedTargetIds?: string[], supersedeActive = false) => {
        const translationClipStates = (requestedTargetIds
            ? clipStates.filter(item => requestedTargetIds.includes(item.id))
            : visibleClipStates).filter(item => !lockedClipIds.has(item.id));
        if (!onApplyTranslatedPrompts || !translationClipStates.length
            || requestedTargetIds && translationClipStates.length !== new Set(requestedTargetIds).size
            || translationClipStates.some(item => item.tone !== "ready")
            || busy || compileBusy || compilePending) return;
        if (translatingPromptsRef.current && !supersedeActive) return;
        if (supersedeActive) activeTranslationRef.current?.controller.abort();
        const controller = new AbortController();
        const sourceHash = director.sourceHash;
        activeTranslationRef.current = { controller, sourceHash };
        const isCurrent = () => activeTranslationRef.current?.controller === controller && !controller.signal.aborted;
        translatingPromptsRef.current = true;
        setTranslatingPrompts(true);
        setTranslationError("");
        const targetIds = translationClipStates.map(item => item.id);
        setTranslationProgress({ phase: "preparing", completed: 0, total: translationClipStates.length, targetIds, completedIds: [], cachedIds: [], inProgressIds: [], failedIds: [], writingIds: [], writtenIds: [] });
        const publishNodeTranslationState = (sources: Array<{ nodeId: string; segmentId: string }>, translating: boolean) => {
            if (typeof window === "undefined") return;
            const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("production-h3-prompt-translation") : null;
            for (const source of sources) {
                const detail = { projectId: canvasId, nodeId: source.nodeId, segmentId: source.segmentId, translating };
                window.dispatchEvent(new CustomEvent("production-h3-prompt-translation", { detail }));
                channel?.postMessage(detail);
            }
            channel?.close();
        };
        let translationSources: Array<{ nodeId: string; segmentId: string }> = [];
        try {
            const sources = translationClipStates.map(item => {
                const matches = productionSegmentRuntimeMatches(canvasNodes as any, item.id);
                if (matches.length !== 1) throw new Error(`${t("director.studio.clipNumber", { number: clips.findIndex(clip => String(clip.id) === item.id) + 1 })}：无法唯一定位已编译的 H3 Clip`);
                const match = matches[0];
                if (!/^minimax|^smart-minimax/i.test(String(match.node.type || ""))) throw new Error(`${t("director.studio.clipNumber", { number: clips.findIndex(clip => String(clip.id) === item.id) + 1 })}：目标不是 H3 Clip`);
                const artifact = director.artifacts.find(artifact => artifact.kind === "h3" && String(artifact.targetId) === item.id);
                const sourcePrompt = String(artifact?.prompt || "");
                if (!sourcePrompt.trim()) throw new Error(`${t("director.studio.clipNumber", { number: clips.findIndex(clip => String(clip.id) === item.id) + 1 })}：没有可翻译的编译提示词`);
                return { targetId: item.id, nodeId: match.node.id, segmentId: String(match.segment.id), sourcePrompt, expectedCanvasPrompt: String(match.segment.prompt || "") };
            });
            translationSources = sources;
            publishNodeTranslationState(sources, true);
            const writtenIds: string[] = [];
            const writeFailures: string[] = [];
            let writeQueue = Promise.resolve();
            const results = await translateCompiledH3Prompts(
                sources.map((source, index) => ({ id: translationClipStates[index].id, text: source.sourcePrompt })),
                progress => { if (isCurrent()) setTranslationProgress(current => ({ ...progress, completed: writtenIds.length, targetIds, phase: writeFailures.length ? "failed" : current?.phase === "writing" ? "writing" : "translating", writingIds: current?.writingIds || [], writtenIds: [...writtenIds] })); },
                { signal: controller.signal },
                results => {
                    const write = writeQueue.then(async () => {
                        if (!isCurrent()) return;
                        const translated = results.map(result => {
                            const source = sources.find(item => item.targetId === result.id);
                            if (!source) throw new Error(`Clip ${result.id} 缺少写入目标`);
                            return { ...source, translatedPrompt: result.translatedText };
                        });
                        const targetIds = translated.map(item => item.targetId);
                        if (isCurrent()) setTranslationProgress(current => current ? { ...current, phase: "writing", writingIds: [...new Set([...current.writingIds, ...targetIds])] } : current);
                        try {
                            if (!isCurrent()) return;
                            await onApplyTranslatedPrompts(translated);
                            publishNodeTranslationState(translated, false);
                            writtenIds.push(...targetIds);
                            setWrittenTranslationStatuses(current => {
                                const next = { ...current };
                                for (const result of results) if (targetIds.includes(result.id)) next[result.id] = { sourceHash, status: result.cached ? "cached" : "complete" };
                                return next;
                            });
                            if (isCurrent()) setTranslationProgress(current => current ? {
                                ...current,
                                phase: writeFailures.length ? "failed" : "translating",
                                completed: writtenIds.length,
                                writingIds: current.writingIds.filter(id => !targetIds.includes(id)),
                                writtenIds: [...writtenIds],
                            } : current);
                        } catch (error) {
                            if (!isCurrent()) return;
                            publishNodeTranslationState(translated, false);
                            const detail = error instanceof Error ? error.message : String(error);
                            writeFailures.push(...targetIds);
                            setTranslationProgress(current => current ? {
                                ...current,
                                phase: "failed",
                                writingIds: current.writingIds.filter(id => !targetIds.includes(id)),
                            } : current);
                            setTranslationError(detail);
                        }
                    });
                    writeQueue = write.catch(() => undefined);
                    return write;
                },
            );
            if (!isCurrent()) return;
            const cachedCount = results.filter(result => result.cached).length;
            if (writeFailures.length) throw new Error(`${writeFailures.length} 个 Clip 的译文未能写入画布`);
            message.success(t("director.atomic.translationDone", { count: writtenIds.length, cached: cachedCount }));
            setTranslationError("");
            setTranslationProgress({
                phase: "complete",
                completed: writtenIds.length,
                total: translationClipStates.length,
                targetIds,
                completedIds: writtenIds,
                cachedIds: results.filter(result => result.cached).map(result => result.id),
                inProgressIds: [],
                failedIds: [],
                writingIds: [],
                writtenIds,
            });
        } catch (error) {
            if (!isCurrent()) return;
            const detail = clips.reduce((message, clip, index) => message.replaceAll(
                `Clip ${clip.id}`,
                t("director.atomic.clipHeading", { number: index + 1 }),
            ), error instanceof Error ? error.message : String(error));
            setTranslationError(detail || t("director.atomic.translationFailed"));
            setTranslationProgress(current => current ? { ...current, phase: "failed" } : current);
            message.error(t("director.atomic.translationFailed"));
        } finally {
            publishNodeTranslationState(translationSources, false);
            if (activeTranslationRef.current?.controller === controller) {
                activeTranslationRef.current = null;
                translatingPromptsRef.current = false;
                setTranslatingPrompts(false);
            }
        }
    };
    useEffect(() => {
        const active = activeTranslationRef.current;
        if (!active || (active.sourceHash === director.sourceHash && !compileBusy && !compilePending && !busy)) return;
        active.controller.abort();
        activeTranslationRef.current = null;
        translatingPromptsRef.current = false;
        setTranslatingPrompts(false);
        setTranslationProgress(null);
    }, [director.sourceHash, compileBusy, compilePending, busy]);
    useEffect(() => {
        setTranslationProgress(null);
        setWrittenTranslationStatuses({});
        setTranslationError("");
    }, [director.sourceHash]);
    useEffect(() => {
        const request = autoTranslateCompilation;
        if (!request?.id || autoTranslateHandledRef.current === request.id || compileBusy || compilePending || busy) return;
        autoTranslateHandledRef.current = request.id;
        void translateCompiledPrompts(request.targetIds, true);
    }, [autoTranslateCompilation, compileBusy, compilePending, busy, clipStates, onApplyTranslatedPrompts]);
    const failedCompileTargetIds = new Set<string>();
    if (compileBasisMatches) for (const targetId of staleReceiptTargets) {
        failedCompileTargetIds.add(String(targetId));
        const targetClip = clips.find(entry => String(entry.id) === String(targetId));
        for (const shotId of targetClip?.shot_ids || []) failedCompileTargetIds.add(String(shotId));
    }
    const orderedCompileDiagnostics = compileDiagnostics.map((item, index) => {
        const relatedToFailedTarget = [item.targetId, item.shotId, ...(item.affectedTargets || [])].some(id => id && failedCompileTargetIds.has(String(id)));
        const blocksCompile = item.blocksCompilation === true || item.severity === "error" || item.severity === "unverified" || item.blockingActions?.includes("compile");
        return { item, index, priority: relatedToFailedTarget ? 0 : blocksCompile ? 1 : 2 };
    }).sort((left, right) => left.priority - right.priority || left.index - right.index).map(entry => entry.item);
    const clipCompileMessages = (clipId: string) => {
        const group = clips.find(item => String(item.id) === clipId), scopeIds = new Set([clipId, ...(group?.shot_ids || []).map(String)]);
        const related = orderedCompileDiagnostics.filter(item => [item.targetId, item.shotId, ...(item.affectedTargets || [])].some(id => id && scopeIds.has(String(id))));
        const blockers = related.filter(item => item.blocksCompilation === true || item.severity === "error" || item.severity === "unverified" || item.blockingActions?.includes("compile"));
        const artifact = director.artifacts.find(item => item.kind === "h3" && String(item.targetId) === clipId);
        const receiptDiagnostics = artifact?.receipt?.diagnostics as Record<string, unknown> | undefined;
        const persisted = Array.isArray(receiptDiagnostics?.blockers) ? receiptDiagnostics.blockers.map(String) : [];
        return [...new Set([
            ...blockers.map(item => item.message || item.code || ""),
            ...persisted,
            ...related.filter(item => !blockers.includes(item)).map(item => item.message || item.code || ""),
        ].map(value => String(value).trim()).filter(Boolean))];
    };
    const clipsWithCompileErrors = visibleClipStates.filter(item => item.tone === "blocked").map(item => ({ ...item, messages: clipCompileMessages(item.id) }));
    // 分割块：拖动或右键调整相邻片段之间的分镜归属。芯片按 id 登记，拖动时按实际布局吸附到镜头边界。
    const chipRefs = useRef(new Map<string, HTMLElement>());
    const trackRef = useRef<HTMLDivElement | null>(null);
    const recordStoryboardScroll = (scrollTop: number) => {
        if (viewMemory?.current) viewMemory.current.scrollTop = scrollTop;
        pendingScrollTop.current = scrollTop;
        if (scrollSaveTimer.current) clearTimeout(scrollSaveTimer.current);
        scrollSaveTimer.current = setTimeout(() => {
            scrollSaveTimer.current = null;
            const value = pendingScrollTop.current;
            if (value === null) return;
            pendingScrollTop.current = null;
            try { localStorage.setItem(storyboardScrollStorageKey, String(value)); } catch { /* Scroll restoration is an optional view preference. */ }
        }, 120);
    };
    useEffect(() => {
        const flushScroll = () => {
            if (scrollSaveTimer.current) clearTimeout(scrollSaveTimer.current);
            scrollSaveTimer.current = null;
            const value = pendingScrollTop.current;
            if (value === null) return;
            pendingScrollTop.current = null;
            try { localStorage.setItem(storyboardScrollStorageKey, String(value)); } catch { /* Scroll restoration is an optional view preference. */ }
        };
        window.addEventListener("pagehide", flushScroll);
        return () => { window.removeEventListener("pagehide", flushScroll); flushScroll(); };
    }, [storyboardScrollStorageKey]);
    if (viewMemory) viewMemory.current = { selectedId: activeId, sceneFilter, search, view, mobileEditing, detailView, shotSection, scrollTop: viewMemory.current?.scrollTop || 0 };
    const hasRestoredScroll = useRef(false);
    useLayoutEffect(() => {
        const track = trackRef.current;
        if (!track) return;
        let scrollTop: number | undefined;
        if (hasRestoredScroll.current) scrollTop = viewMemory?.current?.scrollTop;
        else {
            try {
                const raw = localStorage.getItem(storyboardScrollStorageKey);
                if (raw !== null) {
                    const saved = Number(raw);
                    if (Number.isFinite(saved)) scrollTop = saved;
                }
            } catch { /* Scroll restoration is an optional view preference. */ }
            if (scrollTop === undefined) scrollTop = initialViewMemory.current?.scrollTop;
        }
        hasRestoredScroll.current = true;
        if (scrollTop === undefined || scrollTop === null) {
            scrollTop = 0;
        }
        if (scrollTop !== undefined && scrollTop !== null && Number.isFinite(scrollTop)) track.scrollTop = Math.max(0, scrollTop);
    }, [ownerKey, view, storyboardScrollStorageKey]);
    const revealShot = (id: string) => {
        onNavigate("shots", { kind: "shot", id }); setSearch(""); setSceneFilter(sceneDirectory.scenes.find(scene => scene.shotIds.includes(id))?.id || "__unassigned__"); selectShot(id);
        requestAnimationFrame(() => { const row = chipRefs.current.get(id), track = trackRef.current; if (row && track?.clientHeight) track.scrollTop += row.getBoundingClientRect().top - track.getBoundingClientRect().top - track.clientHeight / 2 + row.clientHeight / 2; row?.focus({ preventScroll: true }); });
    };
    const locateSelectedShot = () => {
        if (!activeId) return;
        setSearch(""); setSceneFilter(sceneDirectory.scenes.find(scene => scene.shotIds.includes(activeId))?.id || "__unassigned__");
        const scrollToRow = (attempt = 0) => requestAnimationFrame(() => {
            const row = chipRefs.current.get(activeId), track = trackRef.current;
            if (!row && attempt < 2) return scrollToRow(attempt + 1);
            if (!row || !track?.clientHeight) return;
            track.scrollTop += row.getBoundingClientRect().top - track.getBoundingClientRect().top - track.clientHeight / 2 + row.clientHeight / 2;
            row.focus({ preventScroll: true });
        });
        scrollToRow();
    };
    const clipLabel = (index: number) => t("director.atomic.clipHeading", { number: index + 1 });
    const saveClipPartition = async (shotIds: string[], groups: Array<Record<string, unknown>>) => {
        if (!onRepartitionClips) return false;
        const invalid = groups.map((group, index) => {
            const ids = (Array.isArray(group.shot_ids) ? group.shot_ids : []).map(String);
            return { index, seconds: clipDurationSeconds(ids, shots, fps) };
        }).filter(item => !Number.isFinite(item.seconds) || item.seconds < 4 || item.seconds > 15);
        if (invalid.length) {
            message.error(invalid.map(item => t("director.atomic.clipBoundaryWindow", { clip: item.index + 1, duration: formatSeconds(item.seconds) })).join(" "));
            return false;
        }
        try {
            if (await onRepartitionClips(shotIds, groups) === false) return false;
            message.success(t("director.atomic.clipBoundarySaved"));
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
    const confirmDeleteClip = (clipId: string, label: string) => modal.confirm({
        title: t("productionCanvas.deleteClipConfirm", { clip: label }),
        okText: t("productionCanvas.deleteClip"), okType: "danger", cancelText: t("common.cancel"),
        onOk: () => onDeleteClip?.(clipId),
    });
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
    const translationPercent = translationProgress?.total ? Math.round(translationProgress.completed / translationProgress.total * 100) : 0;
    const translationInFlightCount = (translationProgress?.inProgressIds.length || 0) + (translationProgress?.writingIds.length || 0);
    const translationFailedCount = translationProgress?.failedIds.length || 0;
    const translationWaitingCount = Math.max(0, (translationProgress?.total || 0) - (translationProgress?.completed || 0) - translationInFlightCount - translationFailedCount);
    const translationStatusFor = (id: string) => {
        if (!translationProgress?.targetIds.includes(id)) {
            const written = writtenTranslationStatuses[id];
            return written?.sourceHash === director.sourceHash ? written.status : "waiting";
        }
        if (translationProgress?.failedIds.includes(id)) return "failed";
        if (translationProgress?.writtenIds.includes(id)) return "complete";
        if (translationProgress?.writingIds.includes(id)) return "writing";
        if (translationProgress?.phase === "failed" && translationProgress.completedIds.includes(id)) return "writeFailed";
        if (translationProgress?.phase === "failed") return "failed";
        if (translationProgress?.phase === "complete" && translationProgress.completedIds.includes(id)) return "complete";
        if (translationProgress?.inProgressIds.includes(id)) return "translating";
        if (translationProgress?.completedIds.includes(id)) return translationProgress.cachedIds.includes(id) ? "cached" : "translated";
        return "waiting";
    };
    const discussClip = (entry: (typeof clipEntries)[number]) => {
        const clipId = String(entry.group.id);
        onDiscuss(clipId, `${t("director.atomic.discussClipInstruction")} ${clipLabel(entry.index)} (${clipId}).`, "shots", true);
    };
    return <div className="space-y-6" data-subject-storyboard-workbench data-storyboard-view={view} data-canvas-id={canvasId} data-mobile-editing={mobileEditing && Boolean(selected) && view === "shots"} data-production-section-root>
        {/* 紧凑头部：标题 + 统计 + 视图页签合一行；「主体与图片 / 连续性台账」与顶部工作区页签重复，已去掉（连续性入口就是顶部工作区页签）。 */}
        <header className="storyboard-toolbar border-b border-border pb-1">
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
                {unsavedShots.length > 0 && <Dropdown trigger={["click"]} menu={{ items: unsavedShots.map(shot => ({ key: String(shot.id), label: title(shot) })), onClick: ({ key }) => revealShot(key) }}><Button type="text" size="small" className="storyboard-draft-locator">{t("director.atomic.unsavedCount", { count: unsavedShots.length })}</Button></Dropdown>}
            </div>
            <div className="storyboard-toolbar-actions">
                <Button type="text" size="small" icon={<Locate className="size-3.5" />} aria-label={t("director.atomic.locateSelectedShot")} title={t("director.atomic.locateSelectedShot")} onClick={locateSelectedShot} />
            </div>
        </header>
        {view === "clips" ? <div className="storyboard-clip-editor space-y-3">
            {/* 编译状态与编译入口：Clip 组合是「保存 → 校验 → 编译 → 同步」的落点，状态与按钮放同一行，逐 Clip 显示。 */}
            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">{t(subjectAssembly ? "director.atomic.packagingHint" : "director.atomic.legacyPackagingHint")}</p>
                <div className="flex shrink-0 items-center gap-3">
                    {visibleClipStates.length > 0 && <span className="text-xs text-muted-foreground">{compileBusy ? t("director.atomic.compileInFlight") : t("director.atomic.compileSummary", compileCounts) + (compileCounts.blocked ? " · " + t("director.atomic.blockedCompileCount", { count: compileCounts.blocked }) : "") + (compileCounts.recorded ? " · " + t("director.atomic.recordedCompileCount", { count: compileCounts.recorded }) : "") + (compileCounts.running > 0 ? " · " + t("director.atomic.compileRunning", { running: compileCounts.running }) : "")}</span>}
                    <Button size="small" type="primary" icon={<WandSparkles className="size-3.5" />} loading={compileBusy} disabled={busy || compileBusy || translatingPrompts || !clipsNeedingCompile.length || !onCompile || sceneFilter === "__unassigned__" || !sceneCompileAvailable} title={sceneFilter === "__unassigned__" ? t("director.atomic.compileUnassignedHint") : undefined} onClick={() => onCompile?.(undefined, undefined, clipsNeedingCompile.map(item => item.id))}>{compilePending ? t("drama.production.recoverReceipt") : t("director.atomic.compileAction")}</Button>
                </div>
            </div>
            {compileError && <Alert type="error" showIcon message={t("director.atomic.compileFailed")} description={compileError} style={{ whiteSpace: "pre-line" }} />}
            {compileNotice && <Alert type="success" showIcon message={<div className="flex flex-wrap items-center justify-between gap-2"><span>{compileNotice}</span>{orderedCompileDiagnostics.length > 0 && <Button type="link" size="small" className="px-0" icon={<WandSparkles className="size-3.5" />} disabled={busy || compileBusy} onClick={() => { const task = compileDiagnosticTaskContext(orderedCompileDiagnostics); onDiscuss(task.targetId, task.instruction); }}>{t("director.atomic.compileAskDirector")}</Button>}</div>} description={orderedCompileDiagnostics.length > 0 ? <details className="text-sm"><summary className="cursor-pointer underline underline-offset-2">{t("director.atomic.compileViewDiagnostics", { count: orderedCompileDiagnostics.length })}</summary><ul className="mt-2 max-h-72 list-disc space-y-2 overflow-auto pl-5">{orderedCompileDiagnostics.map((item, index) => <li key={`${item.code || "diagnostic"}:${item.path || ""}:${item.targetId || ""}:${index}`}><p>{item.message || item.code || t("director.atomic.compileHintOther")}</p><p className="mt-0.5 text-xs text-muted-foreground">{[item.code, item.path, item.targetId, item.shotId].filter(Boolean).join(" · ")}</p></li>)}</ul></details> : undefined} style={{ whiteSpace: "pre-line" }} />}
            {visibleClipStates.length > 0 && <div className="flex flex-wrap items-center gap-1.5" aria-label={t("director.atomic.compileStatus")}>
                <span className="mr-1 text-xs text-muted-foreground">{t("director.atomic.compileStatus")}</span>
                {visibleClipStates.map(item => {
                    const clipNumber = t("director.studio.clipNumber", { number: clips.findIndex(clip => String(clip.id) === item.id) + 1 });
                    const refreshJob = activeRefreshJob(item.id);
                    const locked = lockedClipIds.has(item.id);
                    const compiledPrompt = viewableCompiledPrompts.find(candidate => candidate.targetId === item.id);
                    const translationStatus = translationStatusFor(item.id);
                    const translationColor = translationStatus === "failed" || translationStatus === "writeFailed" ? "red"
                        : translationStatus === "complete" || translationStatus === "cached" ? "green"
                            : translationStatus === "translating" || translationStatus === "writing" ? "blue"
                                : translationStatus === "translated" ? "cyan" : undefined;
                    return <span key={item.id} className="flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs">
                    <button type="button" onClick={() => onClip(item.id)} className="text-muted-foreground hover:text-foreground">{clipNumber}</button>
                    <Tag className="!mr-0 !text-[11px] !leading-4" color={locked ? "default" : item.color} title={locked ? t("director.atomic.clipLocked") : item.reason || t("director.atomic.savedSourceStatus")}><span className="grid"><span className={`col-start-1 row-start-1 ${locked ? "invisible" : ""}`} aria-hidden={locked}>{item.label}</span><span className={`col-start-1 row-start-1 ${locked ? "" : "invisible"}`} aria-hidden={!locked}>{t("director.atomic.clipLocked")}</span></span><CompileElapsed updatedAt={refreshJob?.updatedAt} status={refreshJob?.status} /></Tag>
                    {translationStatus && <Tag className="!mr-0 !text-[11px] !leading-4" color={translationColor} data-clip-translation-status={translationStatus}>{t(`director.atomic.translationClipStatus.${translationStatus}`)}</Tag>}
                    {compiledPrompt && <Button type="text" size="small" className="!h-5 !px-1" icon={<Eye className="size-3" />} aria-label={`${t("director.atomic.viewCompiledPrompt")} · ${clipNumber}`} title={`${t("director.atomic.viewCompiledPrompt")} · ${clipNumber}`} onClick={() => setPromptPreviewClipId(item.id)} />}
                    {onToggleClipLock && <Button type="text" size="small" className="!h-5 !px-1" icon={locked ? <Lock className="size-3" /> : <LockOpen className="size-3" />} aria-pressed={locked} aria-label={locked ? t("director.atomic.unlockClip", { clip: clipNumber }) : t("director.atomic.lockClip", { clip: clipNumber })} title={locked ? t("director.atomic.unlockClip", { clip: clipNumber }) : t("director.atomic.lockClip", { clip: clipNumber })} disabled={lockReadOnly || compileBusy || compilePending || clipLockPending[item.id] === true} onClick={() => { const next = !locked; setClipLockOverrides(current => ({ ...current, [item.id]: next })); setClipLockPending(current => ({ ...current, [item.id]: true })); const action = clipLockQueueRef.current.then(async () => {
                        while (lockBusyRef.current) await new Promise<void>(resolve => lockRenderWaitersRef.current.push(resolve));
                        const callback = onToggleClipLockRef.current;
                        const saved = await callback?.(item.id, next);
                        if (!saved) setClipLockOverrides(current => { const value = { ...current }; delete value[item.id]; return value; });
                        else {
                            if (onToggleClipLockRef.current === callback) await new Promise<void>(resolve => lockRenderWaitersRef.current.push(resolve));
                            while (lockBusyRef.current) await new Promise<void>(resolve => lockRenderWaitersRef.current.push(resolve));
                        }
                    }).catch(() => { setClipLockOverrides(current => { const value = { ...current }; delete value[item.id]; return value; }); }).finally(() => setClipLockPending(current => { const value = { ...current }; delete value[item.id]; return value; })); clipLockQueueRef.current = action; }} />}
                    {!locked && onGenerateClip && item.tone === "ready" && <Button type="text" size="small" className="!h-5 !px-1" icon={<Play className="size-3" />} loading={runStartPending} disabled={busy || compileBusy || compilePending || runStartPending} aria-label={t("director.atomic.generateOneClip", { clip: clipNumber })} title={t("director.atomic.generateOneClip", { clip: clipNumber })} onClick={() => onGenerateClip?.(item.id)} />}
                    {!locked && <Button type="text" size="small" className="!h-5 !px-1" icon={<WandSparkles className="size-3" />} aria-label={t("director.atomic.compileOneClip", { clip: clipNumber })} title={t("director.atomic.compileOneClip", { clip: clipNumber })} disabled={busy || compileBusy || compilePending || translatingPrompts || !onCompile} onClick={() => onCompile?.(undefined, item.id)} />}
                </span>;
                })}
            </div>}
            {activeVisibleClipStates.length > 0 && <div className="flex flex-wrap items-center justify-end gap-3">
                <Button size="small" icon={<WandSparkles className="size-3.5" />} loading={translatingPrompts} disabled={!canTranslateCompiledPrompts} title={!visibleClipStates.every(item => item.tone === "ready") ? t("director.atomic.translationRequiresCompile") : undefined} onClick={() => void translateCompiledPrompts()}>
                    {translatingPrompts ? t("director.atomic.translationRunning") : t("director.atomic.translateCompiledPrompts")}
                </Button>
            </div>}
            <Modal open={Boolean(promptPreviewClipId && selectedPromptPreview)} onCancel={() => setPromptPreviewClipId("")} footer={null} title={t("director.atomic.viewCompiledPrompt")} width={900} destroyOnHidden>
                <Input.TextArea value={selectedPromptPreview?.prompt || ""} readOnly autoSize={{ minRows: 18, maxRows: 30 }} className="font-mono text-xs" />
            </Modal>
            {visibleClipStates.length > 0 && <section className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-sm" aria-live={translationProgress ? "polite" : undefined} data-translation-progress>
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><WandSparkles className="size-4" aria-hidden="true" /></span>
                        <div className="min-w-0">
                            <h3 className="m-0 text-sm font-semibold">{translationProgress ? t(`director.atomic.translationPhase.${translationProgress.phase}`) : t("director.atomic.translationClipList")}</h3>
                            {translationProgress && <p className="mt-1 mb-0 text-xs text-muted-foreground">{t("director.atomic.translationProgressSummary", { completed: translationProgress.completed, total: translationProgress.total })}</p>}
                        </div>
                    </div>
                    {translationProgress && <span className="shrink-0 font-mono text-lg font-semibold tabular-nums">{translationPercent}%</span>}
                </div>
                {translationProgress && <Progress percent={translationPercent} showInfo={false} status={translationProgress.phase === "failed" ? "exception" : translationProgress.phase === "complete" ? "success" : "active"} strokeColor={translationProgress.phase === "failed" ? "#ef4444" : undefined} />}
                {translationProgress && <div className="flex flex-wrap gap-2 text-xs">
                    <span className="rounded-full border border-border px-2.5 py-1">{t("director.atomic.translationMetricCompleted", { count: translationProgress.completed })}</span>
                    {translationInFlightCount > 0 && <span className="rounded-full border border-blue-500/30 bg-blue-500/5 px-2.5 py-1 text-blue-700 dark:text-blue-300">{t("director.atomic.translationMetricActive", { count: translationInFlightCount })}</span>}
                    {translationWaitingCount > 0 && <span className="rounded-full border border-border px-2.5 py-1 text-muted-foreground">{t("director.atomic.translationMetricWaiting", { count: translationWaitingCount })}</span>}
                    {translationProgress.cachedIds.length > 0 && <span className="rounded-full border border-border px-2.5 py-1"><Database className="mr-1 inline size-3" aria-hidden="true" />{t("director.atomic.translationMetricCached", { count: translationProgress.cachedIds.length })}</span>}
                    {translationFailedCount > 0 && <span className="rounded-full border border-red-500/30 bg-red-500/5 px-2.5 py-1 text-red-700 dark:text-red-300">{t("director.atomic.translationMetricFailed", { count: translationFailedCount })}</span>}
                </div>}
                <div className="grid max-h-72 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2 xl:grid-cols-3" aria-label={t("director.atomic.translationClipList")}>
                    {visibleClipStates.map(item => {
                        const status = translationStatusFor(item.id);
                        const clip = clips.find(candidate => String(candidate.id) === item.id);
                        const artifact = director.artifacts.find(candidate => candidate.kind === "h3" && String(candidate.targetId) === item.id);
                        const promptLength = Array.from(String(artifact?.prompt || "")).length;
                        const shotCount = clip ? clipShotIds(clip).length : 0;
                        const statusLabel = t(`director.atomic.translationClipStatus.${status}`);
                        return <button key={item.id} type="button" onClick={() => onClip(item.id)} className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border bg-background/70 px-3 py-2.5 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50">
                            <span className="flex min-w-0 items-center gap-2.5">
                                {status === "complete" || status === "cached" ? <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                                    : status === "failed" ? <CircleAlert className="size-4 shrink-0 text-red-600 dark:text-red-400" aria-hidden="true" />
                                    : status === "writeFailed" ? <CircleAlert className="size-4 shrink-0 text-red-600 dark:text-red-400" aria-hidden="true" />
                                    : status === "translating" || status === "writing" ? <LoaderCircle className="size-4 shrink-0 animate-spin text-blue-600 dark:text-blue-400" aria-hidden="true" />
                                    : status === "translated" ? <CheckCircle2 className="size-4 shrink-0 text-sky-600 dark:text-sky-400" aria-hidden="true" />
                                    : <Circle className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                                <span className="min-w-0">
                                    <span className="block truncate text-sm font-medium">{clipLabel(clips.findIndex(candidate => String(candidate.id) === item.id))}</span>
                                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">{t("director.atomic.translationClipDetail", { shots: shotCount, chars: promptLength })}</span>
                                </span>
                            </span>
                            <span className={`shrink-0 text-xs ${status === "failed" || status === "writeFailed" ? "text-red-600 dark:text-red-400" : status === "complete" || status === "cached" ? "text-emerald-700 dark:text-emerald-300" : status === "translating" || status === "writing" ? "text-blue-700 dark:text-blue-300" : "text-muted-foreground"}`}>{statusLabel}</span>
                        </button>;
                    })}
                </div>
            </section>}
            {translationError && <Alert type="error" showIcon closable onClose={() => setTranslationError("")} message={t("director.atomic.translationFailed")} description={<pre className="m-0 whitespace-pre-wrap break-words font-sans text-sm">{translationError}</pre>} />}
            {clipsWithCompileErrors.filter(item => !lockedClipIds.has(item.id)).length > 0 && <div className="mt-2 w-full space-y-2" data-previous-clip-compile-errors>
                {clipsWithCompileErrors.filter(item => !lockedClipIds.has(item.id)).map(item => <Alert key={item.id} type="error" showIcon message={`${t("director.studio.clipNumber", { number: clips.findIndex(clip => String(clip.id) === item.id) + 1 })} · ${t("director.atomic.compileTargetError")}`} description={<div className="space-y-2"><ul className="list-disc space-y-1 pl-5">{(item.messages.length ? item.messages : [t("director.atomic.compileTargetNoReason", { status: item.label })]).map((value, index) => <li key={`${item.id}:${index}`}>{value}</li>)}</ul><Button size="small" type="primary" icon={<WandSparkles className="size-3" />} disabled={busy || compileBusy || compilePending || !onCompile} onClick={() => onCompile?.(undefined, item.id)}>{t("director.atomic.compileOneClip", { clip: t("director.studio.clipNumber", { number: clips.findIndex(clip => String(clip.id) === item.id) + 1 }) })}</Button></div>} />)}
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
            <div ref={trackRef} onScroll={event => recordStoryboardScroll(event.currentTarget.scrollTop)} data-clip-track className="storyboard-shot-list relative" aria-label={t("director.atomic.timeline")}>
                {clipEntries.map((entry, position) => { const next = clipEntries[position + 1]; const boundary = next && next.index === entry.index + 1 ? next : undefined;
                                        const clipId = String(entry.group.id), compileState = clipCompileState(clipId), refreshJob = activeRefreshJob(clipId), translationStatus = translationStatusFor(clipId);
                                        const translationColor = translationStatus === "failed" || translationStatus === "writeFailed" ? "red"
                                            : translationStatus === "complete" || translationStatus === "cached" ? "green"
                                                : translationStatus === "translating" || translationStatus === "writing" ? "blue"
                                                    : translationStatus === "translated" ? "cyan" : undefined;
                                        return <Fragment key={clipId}>
                    <section ref={element => { if (element) clipCardRefs.current.set(clipId, element); else clipCardRefs.current.delete(clipId); }} data-production-clip-id={clipId} className={`storyboard-clip-group ${entry.group.id === clip?.id ? "is-selected" : ""}`}>
                        <div className="storyboard-clip-heading flex items-center justify-between gap-3">
                            <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{clipLabel(entry.index)}</strong><Tag className="!m-0" title={compileState.reason || t("director.atomic.savedSourceStatus")} color={compileState.color}>{compileState.label}<CompileElapsed updatedAt={refreshJob?.updatedAt} status={refreshJob?.status} /></Tag>{translationStatus && <Tag className="!m-0" color={translationColor} data-clip-translation-status={translationStatus}>{t(`director.atomic.translationClipStatus.${translationStatus}`)}</Tag>}</div><p className="mt-1 text-xs text-muted-foreground">{t("director.atomic.clipSummary", { count: entry.members.length, seconds: formatSeconds(entry.members.reduce((sum, shot) => sum + duration(shot), 0)) })} · {String(entry.group.mode || "")}{entry.shown.length !== entry.members.length && <span className="ml-2">{t("director.atomic.filteredMembers", { shown: entry.shown.length, total: entry.members.length })}</span>}</p></div>
                            <div className="flex shrink-0 items-center gap-1"><Button type="text" size="small" icon={<WandSparkles className="size-3.5" />} disabled={busy} onClick={() => discussClip(entry)}>{t("productionCanvas.discussObject")}</Button>{onGenerateClip && compileState.tone === "ready" && <Button type="text" size="small" icon={<Play className="size-3.5" />} loading={runStartPending} disabled={busy || compileBusy || compilePending || runStartPending} title={t("director.atomic.generateOneClip", { clip: clipLabel(entry.index) })} onClick={() => onGenerateClip?.(clipId)}>{t("director.workspace.generateClip")}</Button>}{productionSegmentRuntimeMatches(canvasNodes as any, clipId).length === 1 && <Button type="text" size="small" icon={<ArrowUpRight className="size-3.5" />} title={t("director.atomic.locateClip")} onClick={() => onLocateClip?.(clipId)}>H3</Button>}{onDeleteClip && <Button type="text" size="small" danger icon={<Trash2 className="size-3.5" />} disabled={busy || compileBusy || compilePending || runStartPending} title={t("productionCanvas.deleteClip") + " · " + clipLabel(entry.index)} onClick={() => confirmDeleteClip(clipId, clipLabel(entry.index))}>{t("productionCanvas.deleteClip")}</Button>}</div>
                        </div>
                        <div className="storyboard-clip-shots">
                            {entry.shown.map((shot, shotIndex) => {
                                const nextShot = entry.shown[shotIndex + 1];
                                const range = filmRanges.get(String(shot.id));
                                const ids = clipShotIds(entry.group), boundaryIndex = ids.indexOf(String(shot.id)) + 1;
                                const canSplitHere = Boolean(nextShot && ids[boundaryIndex] === String(nextShot.id));
                                const leftIds = ids.slice(0, boundaryIndex), rightIds = ids.slice(boundaryIndex);
                                return <Fragment key={String(shot.id)}>
                                    <ShotOperations source={{ ...source, shots: operationShots }} shot={operationShots.find(item => item.id === shot.id)} busy={busy} onEdit={onEditShot || (async () => false)} onSelect={selectShot} contextMenu={subjectAssembly && Boolean(onEditShot)}>
                                        <button type="button" draggable={Boolean(subjectAssembly && onEditShot && !busy)} data-track-shot={String(shot.id)} ref={element => { if (element) chipRefs.current.set(String(shot.id), element); else chipRefs.current.delete(String(shot.id)); }} onClick={() => selectShot(String(shot.id))} onContextMenu={() => setSelectedId(String(shot.id))} onDragStart={event => { if (!subjectAssembly || !onEditShot || busy) return event.preventDefault(); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", String(shot.id)); setDraggingShotId(String(shot.id)); }} onDragOver={event => { const sourceId = event.dataTransfer.getData("text/plain") || draggingShotId; if (sourceId && sourceId !== String(shot.id) && clips.some(item => clipShotIds(item).includes(sourceId) && clipShotIds(item).includes(String(shot.id)))) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }} onDrop={event => moveShotByDrop(event, String(shot.id))} onDragEnd={() => setDraggingShotId("")} aria-pressed={activeId === String(shot.id)} title={title(shot)} className={`storyboard-shot-row w-full text-left ${draggingShotId === String(shot.id) ? "opacity-50" : ""} ${activeId === String(shot.id) ? "is-selected" : ""} ${subjectAssembly && onEditShot && !busy ? "cursor-grab active:cursor-grabbing" : ""}`}><span className="flex items-start gap-3"><ShotKeyframeThumb storageKey={shotFrame(String(shot.id))} /><span className="min-w-0 flex-1"><span className="flex items-start justify-between gap-3"><span className="storyboard-shot-title">{String(shots.findIndex(item => item.id === shot.id) + 1).padStart(2, "0")} · {title(shot)}{unsavedIds.has(String(shot.id)) && <span className="storyboard-unsaved-mark"> · {t("director.atomic.unsavedShort")}</span>}</span><span className="flex shrink-0 flex-col items-end text-xs leading-4 tabular-nums text-muted-foreground"><span>{formatSeconds(duration(shot))}s</span>{range && <span>{t("director.atomic.clipFilmRange", { start: formatSeconds(range.start), end: formatSeconds(range.end) })}</span>}</span></span><span className="mt-1 block text-xs text-muted-foreground">{framing(shot)} · {people(shot)}</span><span className="mt-2 line-clamp-2 block text-sm leading-6 text-muted-foreground">{String(shot.visual?.description || shot.visual?.text || (typeof shot.visual === "string" ? shot.visual : ""))}</span></span></span></button>
                                    </ShotOperations>
                                    {canSplitHere && <ShotClipSplitHandle vertical disabled={!partitionEnabled} onSplit={() => {
                                        void saveClipPartition(ids, materializeClipPartition(clips, [{ ids: leftIds }, { ids: rightIds }]));
                                    }} />}
                                </Fragment>;
                            })}
                        </div>
                    </section>
                    {boundary ? (() => {
                        const from = String(entry.group.id), to = String(boundary.group.id);
                        const savedBoundary = director.boundaries.find(item => item.from === from && item.to === to);
                        const runtimeMatches = productionSegmentRuntimeMatches(canvasNodes as any, from);
                        const runtimeBoundary = runtimeMatches.length === 1 ? runtimeMatches[0].segment : undefined;
                        const transitionMode = runtimeBoundary
                            ? runtimeBoundary.tailFrameContinuation ? "tailFrame" : runtimeBoundary.motionContextEnabled ? "motionContext" : "none"
                            : savedBoundary?.tailFrame ? "tailFrame" : savedBoundary?.motionContext ? "motionContext" : "none";
                        return <ClipBoundaryHandle vertical pairIndex={entry.index} leftClipId={from} rightClipId={to} leftIds={clipShotIds(entry.group)} rightIds={clipShotIds(boundary.group)} profileConflict={clipProfileKey(entry.group) !== clipProfileKey(boundary.group)} shots={shots} fps={fps} chips={chipRefs} track={trackRef} disabled={!partitionEnabled} transitionMode={transitionMode} transitionDisabled={busy || compileBusy || compilePending || !onH3Boundary} onTransitionChange={mode => onH3Boundary?.({ from, to, tailFrame: mode === "tailFrame", motionContext: mode === "motionContext", reason: savedBoundary?.reason || "" })} onCommit={count => commitBoundary(entry.index, count)} onMerge={profileSourceId => mergeBoundaryClips(entry.index, profileSourceId)} addClip={onEditShot && partitionEnabled && subjectAssembly ? (() => {
                    const anchorShot = shots.find(item => String(item.id) === String(clipShotIds(entry.group)[clipShotIds(entry.group).length - 1]));
                    if (!anchorShot) return undefined;
                    const segmentBase = { ...(entry.group.mode ? { mode: entry.group.mode } : {}), ...(entry.group.mode_lock !== undefined ? { mode_lock: entry.group.mode_lock } : {}), ...(entry.group.styleTemplateId !== undefined ? { styleTemplateId: entry.group.styleTemplateId } : {}) };
                    return { source, anchorShot, segmentBase, onEdit: onEditShot, onSelect: selectShot };
                })() : undefined} />;
                    })() : null}
                </Fragment>; })}
                {visible.filter(shot => !clips.some(item => clipShotIds(item).includes(String(shot.id)))).map(shot => <section key={shot.id} className="storyboard-clip-group"><p className="p-3 text-xs text-muted-foreground">{t("director.atomic.ungroupedShot")}</p><ShotOperations source={{ ...source, shots: operationShots }} shot={operationShots.find(item => item.id === shot.id)} busy={busy} onEdit={onEditShot || (async () => false)} onSelect={selectShot} contextMenu={subjectAssembly && Boolean(onEditShot)}><button type="button" data-track-shot={String(shot.id)} ref={element => { if (element) chipRefs.current.set(String(shot.id), element); else chipRefs.current.delete(String(shot.id)); }} onClick={() => selectShot(String(shot.id))} className="storyboard-shot-row w-full text-left" aria-pressed={activeId === String(shot.id)}><span className="flex items-center gap-3"><ShotKeyframeThumb storageKey={shotFrame(String(shot.id))} /><span className="min-w-0 flex-1">{title(shot)}{unsavedIds.has(String(shot.id)) && <span className="storyboard-unsaved-mark"> · {t("director.atomic.unsavedShort")}</span>}</span></span></button></ShotOperations></section>)}
                {!visible.length && <div className="storyboard-empty-state"><Search className="size-5" /><p>{t(search.trim() ? "director.studio.emptyShotSearch" : "director.atomic.emptyScene")}</p><Button onClick={() => { setSearch(""); setSceneFilter(""); }}>{t("director.atomic.showAllShots")}</Button></div>}
            </div>
            </div>
            <div className="storyboard-detail-panel" data-detail-view={detailView}>
                {/* 桌面端标题行已删；仅剩的移动端全屏编辑返回键直接挂在面板下（CSS 按类名独立生效，无需原 header 外壳）。 */}
                <div className="storyboard-mobile-actions"><Button type="text" icon={<ArrowLeft className="size-4" />} onClick={() => { setMobileEditing(false); requestAnimationFrame(() => chipRefs.current.get(activeId)?.focus({ preventScroll: true })); }}>{t("director.atomic.backToShots")}</Button></div>
            {selected && !visible.some(shot => shot.id === selected.id) && <div className="storyboard-selection-notice" role="status"><span>{t(sceneIds.has(activeId) ? "director.atomic.currentOutsideFilter" : "director.atomic.currentOutsideScene")}</span><button type="button" onClick={() => revealShot(activeId)}>{t("director.atomic.revealCurrent")}</button></div>}
            <div className="storyboard-detail-surfaces">
                <section className="storyboard-editing" data-production-target={`shot:${activeId}`} data-production-section="shot-editing" tabIndex={-1}>
                    {(referenceDiagnostics.length > 0 || (!compiled && refresh?.blockingDiagnostic)) && <details className="mb-4 text-sm" hidden={detailView !== "editing"}><summary className="cursor-pointer text-muted-foreground">{t("director.workspace.shotIssueDetails")}</summary><div className="mt-2 space-y-2">{[...new Set([...(referenceDiagnostics.map(diagnostic => String(diagnostic.message || diagnostic.code))), ...(!compiled && refresh?.blockingDiagnostic ? [refresh.blockingDiagnostic.message] : [])])].map(message => <p key={message} className="whitespace-pre-wrap text-muted-foreground">{message}</p>)}</div></details>}
                    {/* 「连续性」收编为编辑器页签：detailView 开关经 __contextControl 传给 SubjectShotEditor，选中时它隐藏表单体与保存栏。 */}
                    <div className="storyboard-editor-content" data-subject-editor={subjectAssembly || undefined}>{renderEditor(selected, { ...(workbench || {}), __contextControl: { active: detailView === "context", enter: () => setDetailView("context"), exit: () => setDetailView("editing") }, __sectionControl: { current: shotSection, select: setShotSection } })}</div>
                    {/* 镜头操作行（和导演讨论 / 跳到所在片段）：整个左栏的最后一块，不再夹在对白与连续性状态之间。 */}
                    <div hidden={detailView !== "editing"}>{renderShotActions?.(selected)}</div>
                </section>
                <aside className="storyboard-context space-y-6" hidden={detailView !== "context"}>
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><div><p className="text-xs text-muted-foreground">{formatSeconds((windows.get(activeId)?.startFrame || 0) / fps)}–{formatSeconds((windows.get(activeId)?.endFrame || 0) / fps)}s</p></div><Tag color={refresh?.blockingDiagnostic ? "orange" : compiled ? "green" : undefined}>{statusLabel}</Tag></div>

                    <section className="border-t border-border pt-4" data-production-section="shot-state" tabIndex={-1}><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">{t("director.atomic.state")}</h3>{subjectAssembly && selected && <div className="flex items-center gap-2" data-shot-continuity-fact-editor><Button size="small" disabled={busy || !onSaveShotPatch} onClick={() => setContinuityFactModalOpen(true)}>{t("director.atomic.editContinuityFacts")}</Button>{continuityFactSelectionChanged && <Tag color="orange">{t("director.atomic.unsavedContinuityFacts")}</Tag>}</div>}</div><p className="mt-1 text-xs text-muted-foreground">{t(subjectAssembly ? "director.atomic.derivedState" : "director.atomic.legacyStateHint")}</p>{!subjectAssembly && shotStateFields && <div className="mt-3" data-shot-state>{shotStateFields}</div>}{continuityActions && <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border pb-3 text-xs text-muted-foreground" data-shot-continuity-actions>{continuityActions}</div>}
                        {records(state?.start).length + records(state?.end).length > 0 ? <div className="mt-3 grid gap-4 sm:grid-cols-2">{(["start", "end"] as const).map(phase => <div key={phase} className="min-w-0"><p className="text-[11px] font-medium text-muted-foreground">{t("director.atomic.statePhase." + phase)}</p>{records(state?.[phase]).map(item => <div key={item.factId} className="mt-2"><p className="text-[11px] text-muted-foreground">{item.subjectId ? subjectDisplayName(source, String(item.subjectId)) : item.property}</p><p className="text-xs leading-5">{humanState.value(String(item.factId), item.value)}</p></div>)}{!records(state?.[phase]).length && <p className="mt-1 text-xs text-muted-foreground">{t("director.atomic.noState")}</p>}</div>)}</div> : <p className="mt-3 text-xs text-muted-foreground">{t("director.atomic.noState")}</p>}{records(state?.unresolved).length > 0 && <p className="mt-3 text-xs text-amber-600">{t("director.atomic.stateIssue")} · {records(state?.unresolved).map(item => humanState.fact(String(item.factId))).join(" · ")}</p>}</section>
                    {subjectAssembly && selected && <Modal title={t("director.atomic.continuityFactSelection")} open={continuityFactModalOpen} width={640} onCancel={() => setContinuityFactModalOpen(false)} footer={<div className="flex items-center justify-between gap-3"><span className="text-xs text-muted-foreground">{continuityFactSelectionChanged ? t("director.atomic.unsavedContinuityFacts") : t("director.atomic.savedContinuityFacts")}</span><div className="flex gap-2"><Button disabled={savingContinuityFacts} onClick={() => setContinuityFactModalOpen(false)}>{t("common.cancel")}</Button><Button type="primary" loading={savingContinuityFacts} disabled={busy || !onSaveShotPatch || !continuityFactSelectionChanged} onClick={() => void saveContinuityFactSelection()}>{t("director.atomic.saveContinuityFacts")}</Button></div></div>}>
                        <p className="mb-4 text-xs text-muted-foreground">{t("director.atomic.continuityFactSelectionHint")}</p>
                        {selectedShotUsages.length ? <div className="space-y-4">{selectedShotUsages.map(usage => {
                            const subject = subjects.find(item => String(item.id) === String(usage.subjectId));
                            const entityRef = subject?.entityRef || {};
                            const options = continuityFacts.filter(fact => String(fact.object_kind || "") === String(entityRef.kind || "") && String(fact.object_id || "") === String(entityRef.id || ""))
                                .map(fact => ({ value: String(fact.id), label: humanState.fact(String(fact.id)) }));
                            const optionIds = new Set(options.map(option => option.value));
                            for (const factId of continuityFactIdsForUsage(usage)) if (!optionIds.has(factId)) options.push({ value: factId, label: humanState.fact(factId) || factId });
                            return <label key={String(usage.subjectId)} className="grid gap-1 text-xs text-muted-foreground"><span>{subjectDisplayName(source, String(usage.subjectId))}</span><Select className="w-full" mode="multiple" value={continuityFactIdsForUsage(usage)} disabled={busy || savingContinuityFacts || !onSaveShotPatch || !options.length} placeholder={t("director.atomic.noContinuityFacts")} options={options} onChange={values => setContinuityFactDrafts(current => ({ ...current, [activeId]: { ...(current[activeId] || {}), [String(usage.subjectId)]: [...new Set(values.map(String))] } }))} /></label>;
                        })}</div> : <p className="text-xs text-muted-foreground">{t("director.atomic.noContinuityFactSubjects")}</p>}
                    </Modal>}

                    {/* 图片绑定的编辑控件原先在这里和「主体引用」页签各有一份、走两条写入路径；统一收进「主体引用」页签，侧栏只留一行指引和下面的只读解析列表。 */}
                    {subjectAssembly && selected && <section className="border-t border-border pt-4" data-shot-picture-binding-hint><p className="text-xs text-muted-foreground">{t("director.atomic.pictureBindingEditorMoved")}</p></section>}
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
                    </section>}                    <section data-production-section="shot-references" tabIndex={-1} hidden={subjectAssembly}><h3 className="flex items-center gap-2 text-sm font-medium"><ImageIcon className="size-4" />{t("director.atomic.references")}</h3><p className="mt-1 text-xs text-muted-foreground">{t(subjectAssembly ? "director.atomic.referencesHint" : "director.atomic.legacyReferencesHint")}</p>{reading ? <p className="mt-3 text-xs text-muted-foreground">{t("director.atomic.loading")}</p> : workbenchError ? <div className="mt-3 text-xs"><p className="text-muted-foreground">{workbenchError}</p><Button size="small" type="text" onClick={() => setRetry(value => value + 1)}>{t("director.atomic.retry")}</Button></div> : <div className="mt-3 space-y-3">{references.map(reference => <div key={`${reference.subjectId}:${reference.id}`} className="flex gap-3">{reference.resolved?.storageKey ? <img src={backendMediaUrl(reference.resolved.storageKey)} alt={reference.displayName || subjectDisplayName(source, reference.subjectId)} className="h-16 w-16 shrink-0 rounded object-contain" loading="lazy" /> : <span className="flex h-16 w-16 shrink-0 items-center justify-center text-muted-foreground"><ImageIcon className="size-5" /></span>}<div className="min-w-0"><p className="text-xs font-medium">{reference.displayName || subjectDisplayName(source, reference.subjectId)}</p><p className="mt-1 text-[11px] text-muted-foreground">{(reference.provides || []).map((purpose: string) => t(`director.crud.purpose.${purpose}`, { defaultValue: /[\u4e00-\u9fff]/.test(purpose) ? purpose : t("director.crud.otherPurpose") })).join(" · ")}</p><p className="mt-1 text-[11px] text-muted-foreground">{t(!subjectAssembly ? "director.atomic.legacyReferenceBinding" : reference.selection?.mode === "node_selection" ? "director.atomic.followNodeReference" : reference.selection?.mode === "selected_result" ? "director.workspace.selectedHistory" : "director.workspace.followLatest")}</p><ReferenceNodeLink sourceNode={reference.sourceNode} /><button type="button" onClick={() => onNavigate("assets", { kind: "asset", id: subjectAssembly ? reference.subjectId : reference.id })} className="mt-1 inline-flex items-center gap-0.5 text-[11px] text-primary hover:underline">{t("director.atomic.viewReference")}<ArrowRight className="size-3" /></button></div></div>)}{!references.length && <p className="text-xs text-muted-foreground">{t("director.atomic.noResolvedReferences")}</p>}</div>}</section>
                    {/* 关键帧只读概览：v2 有专门的「关键帧」页签，此处仅 legacy 源稿保留（那边没有对应编辑面）。 */}
                    {keyframes.length > 0 && !subjectAssembly && <section className="border-t border-border pt-4"><h3 className="text-sm font-medium">{t("director.atomic.keyframeReferences")}</h3><div className="mt-3 space-y-3">{keyframes.map(frame => <div key={frame.id} className="flex gap-3">{frame.resolved?.storageKey ? <img src={backendMediaUrl(frame.resolved.storageKey)} alt={t("director.atomic.anchor." + frame.anchor)} className="h-16 w-16 shrink-0 rounded object-contain" loading="lazy" /> : <span className="flex h-16 w-16 shrink-0 items-center justify-center text-muted-foreground"><ImageIcon className="size-5" /></span>}<div className="min-w-0"><p className="text-xs font-medium">{t("director.atomic.anchor." + frame.anchor)}</p><p className="mt-1 text-[11px] text-muted-foreground">{frame.requiredForSubmission ? t("director.atomic.requiredAnchor") : t("director.atomic.designAnchor")}</p>{frame.anchor === "at_frame" && <p className="mt-1 text-[11px] text-muted-foreground">{(Number(frame.localFrame) / fps).toFixed(3)}s</p>}<ReferenceNodeLink sourceNode={frame.sourceNode} /></div></div>)}</div></section>}
                    <details className="border-t border-border pt-4"><summary className="cursor-pointer text-sm font-medium">{t("director.atomic.compiledOutput")}</summary><p className="mt-2 text-xs text-muted-foreground">{t(compiled ? "director.atomic.outputHint" : "director.atomic.previousOutput")}</p>{artifact ? <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs leading-5">{artifact.prompt}</pre> : <p className="mt-3 text-xs text-muted-foreground">{t("director.atomic.statePending")}</p>}<Button className="mt-2" size="small" type="text" disabled={!clip} onClick={() => clip && onClip(String(clip.id))}>{t("director.atomic.openClip")}<ArrowRight className="size-3" /></Button></details>
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
function ClipBoundaryHandle({ pairIndex, leftClipId, rightClipId, leftIds, rightIds, profileConflict, shots, fps, chips, track, disabled, transitionMode = "none", transitionDisabled = true, onTransitionChange, onCommit, onMerge, addClip, vertical = false }: {
    vertical?: boolean; pairIndex: number; leftClipId: string; rightClipId: string; leftIds: string[]; rightIds: string[]; profileConflict: boolean; shots: Array<Record<string, any>>; fps: number;
    chips: { current: Map<string, HTMLElement> }; track: { current: HTMLDivElement | null }; disabled: boolean;
    transitionMode?: "tailFrame" | "motionContext" | "none"; transitionDisabled?: boolean; onTransitionChange?: (mode: "tailFrame" | "motionContext" | "none") => void;
    onCommit: (count: number) => Promise<unknown> | unknown; onMerge: (profileSourceId?: string) => Promise<unknown> | unknown;
    addClip?: { source: Record<string, any>; anchorShot: Record<string, any>; segmentBase: Record<string, any>; onEdit: (operation: ShotOperation) => Promise<boolean>; onSelect: (id: string) => void };
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
    const transitionItems = [
        { key: "tailFrame", label: t("director.atomic.clipTransitionTailFrame") },
        { key: "motionContext", label: t("director.atomic.clipTransitionMotionContext") },
        { key: "none", label: t("director.atomic.clipTransitionNone") },
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
        {onTransitionChange ? <Dropdown trigger={["click"]} disabled={transitionDisabled} menu={{ items: transitionItems, selectedKeys: [transitionMode], onClick: ({ key }) => onTransitionChange(key as "tailFrame" | "motionContext" | "none") }}>
            <button type="button" disabled={transitionDisabled} aria-label={t("director.atomic.clipTransitionLabel")} title={t("director.atomic.clipTransitionLabel")} aria-haspopup="menu" className="storyboard-boundary-menu storyboard-boundary-transition">
                {transitionItems.find(item => item.key === transitionMode)?.label} <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
            </button>
        </Dropdown> : null}
        <div aria-hidden="true" data-clip-boundary-grip className={`storyboard-boundary-grip ${drag ? "is-dragging" : ""} ${disabled ? "is-disabled" : ""}`} {...pointerHandlers}>
            <span className="storyboard-boundary-grip-icon"><GripHorizontal className="size-4" /></span>
        </div>
        <Dropdown trigger={["contextMenu", "click"]} disabled={disabled} menu={{ items, onClick: handleMenuClick }}>
            <button type="button" disabled={disabled} aria-label={t("director.atomic.clipBoundary")} title={disabled ? undefined : t("director.atomic.clipBoundaryHint")} aria-haspopup="menu" className="storyboard-boundary-menu">
                {t("director.atomic.adjustBoundary")} <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
            </button>
        </Dropdown>
        {addClip ? <ShotOperations source={addClip.source} anchor={{ shot: addClip.anchorShot, segment: addClip.segmentBase }} busy={disabled} onEdit={addClip.onEdit} onSelect={addClip.onSelect} /> : null}
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
