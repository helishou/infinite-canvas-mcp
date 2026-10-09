import { withH3ParameterEdits } from "@basketikun/canvas-agent/plugins/minimax-h3/runtime-params";
import { useEffect, useRef, useState, useCallback, useMemo } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContentProps } from "@infinite-canvas/plugin-sdk";
import { message } from "antd";
import type { H3CharacterGroupEditPatch, H3Ref, H3Segment } from "../types";
import { segmentsFor } from "../hooks/useH3Segments";
import { useH3LocalView } from "../hooks/useH3LocalView";
import { applyCharacterGroupEdits, inferReferenceRole, promoteCharacterSourceReferences, refsForSegment, removeCharacterGroup, replaceSegmentReference, resultUrl, syncCharacterGroupFromSource, upsertCharacterGroup, withSegmentRefs } from "../services/h3-data";
import { CharacterGroupParseError, normalizeDroppedH3Ref, h3RefCandidates, orderedGroupStoryboardRefs, readCharacterGroupFromDrop, readCharacterGroupFromNode, readCharacterImagesFromDrop, readH3Refs, refreshSmartImageReference, storyboardSubjectIdsForNode } from "../services/h3-refs";
import { sameRef } from "../services/h3-compatibility";
import { patchSelectedSegment } from "../services/h3-segment-utils";
import { patchAllH3Clips } from "../services/h3-global-settings";
import { clipRuntimeState } from "../services/h3-clip-runtime";
import { h3ThemeVars } from "../h3-theme";
import { alignStoryboardReferenceOrder, assignStoryboardShotRef, assignStoryboardShotRefs, dropUnboundStoryboardReferences, rebindStoryboardShot, removeStoryboardImageReference, storyboardRefsForSegment, storyboardTrackItems, syncStoryboardPrompt } from "../services/h3-storyboard-track";
import { H3PaneHandles, H3PreviewPlayer, H3RulerScrubber, H3StatusBadge, H3_TIMELINE_MIN, h3SolveRows, requestH3Run } from "./H3WorkbenchPrimitives";
import { SmartStoryboardModal } from "./SmartStoryboardModal";
import { H3CurrentClipPanel } from "./H3CurrentClipPanel";
import { H3ClipSettingsPanel } from "./H3ClipSettingsPanel";
import { H3Timeline } from "./H3Timeline";
import { H3MaterialLibrary } from "./H3MaterialLibrary";
import { H3Runner } from "./H3Runner";
import { H3WorkbenchToolbar } from "./H3WorkbenchToolbar";
import { H3ReferenceModal } from "./H3ReferenceModal";

export function H3ContentExact({ ctx: sharedContext }: CanvasNodeContentProps) {
    const ctx = useH3LocalView(sharedContext);
    const metadata = ctx.node.metadata || {};
    const sharedMetadata = sharedContext.node.metadata || {};
    const segments = useMemo(() => segmentsFor(sharedMetadata), [sharedMetadata]);
    const ctxRef = useRef(ctx);
    ctxRef.current = ctx;
    const storedSelectedId = String(metadata.selectedSegmentId || "");
    const selected = segments.find((item) => item.id === storedSelectedId) || segments[0];
    const selectedIndex = Math.max(0, segments.findIndex((item) => item.id === selected?.id));
    const appliedDeepLinkRef = useRef("");
    const emittedFocusRef = useRef(0);
    const focusRequest = Number(metadata.h3FocusRequest || 0);
    useEffect(() => {
        if (!focusRequest || emittedFocusRef.current === focusRequest) return;
        const frame = requestAnimationFrame(() => {
            emittedFocusRef.current = focusRequest;
            window.dispatchEvent(new CustomEvent("minimax-h3-focus-preview", { detail: { projectId: sharedContext.projectId, nodeId: sharedContext.node.id, requestId: focusRequest } }));
        });
        return () => cancelAnimationFrame(frame);
    }, [focusRequest, sharedContext.projectId, sharedContext.node.id]);
    useEffect(() => {
        const query = new URLSearchParams(window.location.search);
        const segmentId = query.get("segmentId") || "";
        if (query.get("nodeId") !== sharedContext.node.id || !segments.some((item) => item.id === segmentId)) return;
        const key = `${sharedContext.projectId}:${sharedContext.node.id}:${segmentId}`;
        if (appliedDeepLinkRef.current === key) return;
        appliedDeepLinkRef.current = key;
        ctx.updateMetadata({ selectedSegmentId: segmentId });
    }, [ctx, segments, sharedContext.node.id, sharedContext.projectId]);
    // 远端删除当前 Clip 时，只修复本窗口的选择，不产生共享文档写入。
    useEffect(() => {
        if (!segments.length) return;
        if (storedSelectedId && storedSelectedId === selected?.id) return;
        ctx.updateMetadata({ selectedSegmentId: selected?.id || segments[0].id });
    }, [ctx, segments, selected?.id, storedSelectedId]);
    const upstream = readH3Refs(ctx);
    const selectedRefs = selected ? refsForSegment(selected) : [];
    const outputs = useMemo(() => {
        const segmentByUrl = new Map<string, string>();
        const rawOutputs: Array<unknown> = [];
        for (const [segmentIndex, segment] of segments.entries()) {
            for (const item of segment.results || []) {
                rawOutputs.push(item);
                if (item.url && !segmentByUrl.has(item.url)) segmentByUrl.set(item.url, segment.id);
            }
            const url = resultUrl(segment.result);
            if (url) {
                rawOutputs.push({ url, type: "video", name: `Clip ${segmentIndex + 1}`, storageKey: segment.resultStorageKey, segmentId: segment.id });
                if (!segmentByUrl.has(url)) segmentByUrl.set(url, segment.id);
            }
        }
        const seenUrls = new Set<string>();
        const result: H3Ref[] = [];
        for (const [index, item] of rawOutputs.entries()) {
            const value = item && typeof item === "object" ? item as Record<string, unknown> : { url: String(item) };
            const url = String(value.url || value.video_url || value.content || "");
            if (!url || seenUrls.has(url)) continue;
            seenUrls.add(url);
            const rawType = String(value.type || value.kind || "video");
            const type = rawType.startsWith("image") ? "image" : rawType.startsWith("audio") ? "audio" : "video";
            result.push({
                url, type,
                name: String(value.name || `Clip ${index + 1}`),
                storageKey: typeof value.storageKey === "string" ? value.storageKey : undefined,
                segmentId: typeof value.segmentId === "string" ? value.segmentId : segmentByUrl.get(url),
                generationLogId: typeof value.generationLogId === "string" ? value.generationLogId : undefined,
                taskId: typeof value.taskId === "string" ? value.taskId : undefined,
                params: value.params && typeof value.params === "object" ? value.params as Record<string, unknown> : undefined,
            } as H3Ref);
        }
        return result.reverse();
    }, [segments]);
    const total = Math.max(1, segments.reduce((sum, item) => sum + Math.max(0.5, Number(item.duration || 1)), 0));
    const playhead = Math.max(0, Math.min(total, Number(metadata.playhead || 0)));
    const fmt = (value: number) => `${Number(value || 0).toFixed(Number(value || 0) % 1 ? 1 : 0)}s`;
    const selectedVideo = selectedRefs.find((item) => item.type === "video");
    const selectedImage = selectedRefs.find((item) => item.type === "image");
    const currentRuntime = clipRuntimeState(selected);
    const currentTaskId = currentRuntime.taskId;
    const [livePreview, setLivePreview] = useState<{ parentTaskId: string; sourceTaskId: string; url: string; mime: string; step?: number; total?: number } | null>(null);
    useEffect(() => {
        const taskId = currentTaskId;
        setLivePreview(null);
        if (currentRuntime.status !== "loading" || !taskId) return;
        const onPreview = (event: Event) => {
            const detail = (event as CustomEvent<{ parentTaskId?: string; sourceTaskId?: string; url?: string; mime?: string; step?: number; total?: number }>).detail;
            if (!detail?.url || detail.parentTaskId !== taskId || !detail.sourceTaskId) return;
            const sourceTaskId = detail.sourceTaskId;
            const url = detail.url;
            setLivePreview((current) => current?.parentTaskId === taskId && current.sourceTaskId === sourceTaskId && current.url === url && current.step === detail.step && current.total === detail.total
                ? current
                : { parentTaskId: taskId, sourceTaskId, url, mime: detail.mime || (url.startsWith("data:video/") ? "video/mp4" : "image/jpeg"), step: detail.step, total: detail.total });
        };
        window.addEventListener("minimax-h3-preview", onPreview);
        return () => window.removeEventListener("minimax-h3-preview", onPreview);
    }, [currentTaskId, currentRuntime.status]);
    const selectedOwnPreview = resultUrl(selected?.result) || selectedVideo?.url || selectedImage?.url || "";
    // 预览事件按父任务 ID 过滤；收到后必须独占主预览，不能再让原 Clip 视频留在同一层。
    const showLivePreview = Boolean(livePreview && livePreview.parentTaskId === currentTaskId && currentRuntime.status === "loading");
    const preview = showLivePreview ? livePreview!.url : (selectedOwnPreview || (selectedIndex === 0 ? String(metadata.content || upstream.find((item) => item.type === "video")?.url || "") : ""));
    const selectedResultRef = (selected?.results || []).find((item) => resultUrl(item.url) === preview || item.url === preview);
    const previewKind: H3Ref["type"] = showLivePreview ? (livePreview!.mime.startsWith("image/") ? "image" : "video") : (selectedResultRef?.type || (resultUrl(selected?.result) ? "video" : selectedVideo ? "video" : selectedImage ? "image" : "video"));
    const previewStorageKey = showLivePreview ? undefined : selectedResultRef?.storageKey || (resultUrl(selected?.result) ? selected?.resultStorageKey : (upstream.find((item) => item.url === preview)?.storageKey)) || undefined;
    const previewName = selectedResultRef?.name || (resultUrl(selected?.result) ? `Clip ${selectedIndex + 1}` : "H3 输出");
    const imageRefs = selectedRefs.filter((item) => item.type === "image");
    const videoRefs = selectedRefs.filter((item) => item.type === "video");
    const audioRefs = selectedRefs.filter((item) => item.type === "audio");
    const previewH = Math.max(130, Math.min(2000, Number(metadata.minimaxPreviewH || 220)));
    const promptW = Math.max(220, Math.min(900, Number(metadata.minimaxPromptW || 480)));
    const previewW = Math.max(280, Math.min(1400, Number(metadata.minimaxPreviewW || 960)));
    // 行高模型：行1(预览+当前Clip) 与 行2(时间轴) 固定 px，行3(Output 素材库) 吃剩余高度；
    // Refs 行高可独立调节；时间轴面板高度下限联动 Refs 行高：
    // 面板内部固定需求 = controls 44 + 刻度尺 28 + Video 行最低 ~110；
    // 时间轴收缩时 Refs 行可压到最小高度，避免高 Refs 默认值锁死 Output。
    const refLaneRaw = Math.max(60, Math.min(900, Number(metadata.minimaxRefLaneH || 150)));
    const timelineH = Math.max(H3_TIMELINE_MIN, Math.min(2000, Number(metadata.minimaxTimelineH || 320)));
    const refLaneH = Math.min(refLaneRaw, timelineH - 190);
    // 行高预算：节点被画布手动压小、行1+行2+Output 装不下时连续收敛
    //（预览先让到 130 → 时间轴再让到 max(250, 190+Refs) 下限，Output 始终保底 80）。
    // 求解函数与拖拽侧共用（h3SolveRows）；挤压态的收敛值由 H3PaneHandles 回写 metadata，保持「存的值 = 看到的值」。
    const bodyRef = useRef<HTMLDivElement | null>(null);
    const [bodyH, setBodyH] = useState(0);
    useEffect(() => {
        const el = bodyRef.current;
        if (!el) return;
        const ro = new ResizeObserver(() => setBodyH(el.clientHeight));
        ro.observe(el);
        setBodyH(el.clientHeight);
        return () => ro.disconnect();
    }, []);
    const solved = bodyH > 0 ? h3SolveRows(bodyH, previewH, timelineH, refLaneH) : { p: previewH, t: timelineH, r: refLaneH };
    const effPreviewH = solved.p;
    const effTimelineH = solved.t;
    const effRefLaneH = solved.r;
    const playRequest = Number(metadata.h3PlayRequest || 0);
    // 本地 playToken：仅在用户真正发起播放时（playAll / 续播换段）递增，
    // 用作 H3PreviewPlayer 实际触发 v.play() 的信号。本地 view 的 h3PlayRequest
    // 不直接驱动自动播放——避免 React StrictMode dev 模式下
    // mount 时 useEffect 跑两次让 skipFirstPlayRequestRef 失效、也避免其它路径
    // （MCP 同步、metadata 写回等）无意间让视频自动起播。
    const [playToken, setPlayToken] = useState(0);
    const [smartStoryboardOpen, setSmartStoryboardOpen] = useState(false);
    const [smartStoryboardUploads, setSmartStoryboardUploads] = useState<H3Ref[]>([]);
    const [submittingSegments, setSubmittingSegments] = useState<Set<string>>(() => new Set());
    const [canvasReferenceDragOver, setCanvasReferenceDragOver] = useState(false);
    const workbenchRef = useRef<HTMLDivElement | null>(null);
    // 播放期间由 rAF 调用：直接改写 ruler 上所有 .minimax-playhead 指针的 left（= 绝对时间秒 ×100px），
    // 不写 metadata、不 setState，因此不会触发 canvas 框架重绘/重载，且 60fps 匀速推进。
    const livePlayheadTick = useCallback((absoluteTime: number) => {
        const root = workbenchRef.current;
        if (!root) return;
        const px = absoluteTime * 100;
        root.querySelectorAll<HTMLElement>(".minimax-playhead").forEach((el) => { el.style.left = `${px}px`; });
    }, []);
    const [editingRef, setEditingRef] = useState<{ segmentId: string; ref: H3Ref } | null>(null);
    const editingRefSegment = editingRef ? segments.find((segment) => segment.id === editingRef.segmentId) : undefined;
    const editingRefGroup = editingRef?.ref.groupId ? editingRefSegment?.h3CharacterGroups?.[editingRef.ref.groupId] : undefined;
    const currentEditingRef = editingRefSegment && editingRef
        ? refsForSegment(editingRefSegment).find((ref) => editingRef.ref.bindingId && ref.bindingId === editingRef.ref.bindingId
            || (editingRef.ref.groupId && ref.groupId === editingRef.ref.groupId && ref.outfitId === editingRef.ref.outfitId && ref.type === editingRef.ref.type)) || editingRef.ref
        : editingRef?.ref;
    const referencedCharacterIds = new Set((editingRefSegment ? refsForSegment(editingRefSegment) : []).flatMap((ref) => {
        if (ref.enabled === false) return [];
        const nodeId = editingRefSegment?.h3CharacterGroups?.[ref.groupId || ""]?.characterNodeId || ref.nodeId;
        return nodeId && ctx.getNode(nodeId)?.type === "character" ? [nodeId] : [];
    }));
    const referencedCharacters = ctx.getNodes().filter((node) => node.type === "character" && referencedCharacterIds.has(node.id)).map((node) => {
        const metadata = (node.metadata || {}) as Record<string, unknown>;
        const images = Array.isArray(metadata.characterImages) ? metadata.characterImages as Array<{ url?: unknown }> : [];
        const primary = images[Number(metadata.characterPrimaryIndex || 0)] || images[0];
        return { id: node.id, name: String(metadata.characterName || node.title || "人物"), previewUrl: typeof primary?.url === "string" ? primary.url : undefined };
    });
    // 空 ref 槽添加或在职责弹窗内替换引用时，复用画布既有的「选节点作参考」模式；选中节点通过 canvas-reference-pick 回抛。
    const [pickingRef, setPickingRef] = useState<{ segmentId: string; slotIndex: number; types: H3Ref["type"][]; replaceRef?: H3Ref; shotId?: string } | null>(null);
    useEffect(() => {
        const onSubmitPending = (event: Event) => {
            const detail = (event as CustomEvent<{ nodeId?: string; segmentId?: string; pending?: boolean }>).detail || {};
            if (detail.nodeId !== ctx.node.id || !detail.segmentId) return;
            setSubmittingSegments((current) => {
                const next = new Set(current);
                if (detail.pending) next.add(detail.segmentId!);
                else next.delete(detail.segmentId!);
                return next;
            });
        };
        window.addEventListener("minimax-h3:submit-pending", onSubmitPending);
        return () => window.removeEventListener("minimax-h3:submit-pending", onSubmitPending);
    }, [ctx.node.id]);
    useEffect(() => {
        const syncReferences = (changedNodeIds?: Set<string>) => {
            const ctx = ctxRef.current;
            const liveMetadata = ctx.getNode(ctx.node.id)?.metadata || ctx.node.metadata || {};
            const currentSegments = segmentsFor(liveMetadata);
            let changed = false;
            const nextSegments = currentSegments.map((segment) => {
                if (segment.productionClipProjection) return segment;
                let nextSegment = segment;
                const sourceIds = new Set(refsForSegment(segment).filter((ref) => !ref.groupId && ref.nodeId && (!changedNodeIds || changedNodeIds.has(ref.nodeId))).map((ref) => ref.nodeId!));
                for (const sourceId of sourceIds) {
                    const sourceNode = ctx.getNode(sourceId);
                    if (sourceNode?.type !== "character") continue;
                    const source = readCharacterGroupFromNode(sourceNode);
                    if (source) nextSegment = promoteCharacterSourceReferences(nextSegment, source);
                }
                for (const [groupId, group] of Object.entries(nextSegment.h3CharacterGroups || {})) {
                    // Source edits are reconciled with every Clip in the Backend ops transaction.
                    // This mount-time pass only repairs older snapshots, avoiding a second client write.
                    if (changedNodeIds) continue;
                    if (!group.characterNodeId) continue;
                    const sourceNode = ctx.getNode(group.characterNodeId);
                    if (sourceNode?.type !== "character") continue;
                    const source = readCharacterGroupFromNode(sourceNode);
                    if (source) nextSegment = syncCharacterGroupFromSource(nextSegment, groupId, source);
                }
                const refs = refsForSegment(nextSegment);
                const nextRefs = refs.map((ref) => {
                    if (!ref.nodeId || (changedNodeIds && !changedNodeIds.has(ref.nodeId))) return ref;
                    return refreshSmartImageReference(ref, ctx.getNode(ref.nodeId));
                });
                if (!nextRefs.every((ref, index) => ref === refs[index])) nextSegment = withSegmentRefs(nextSegment, nextRefs);
                if (nextSegment !== segment) changed = true;
                return nextSegment;
            });
            if (changed) ctx.updateMetadata({ segments: nextSegments });
        };
        syncReferences();
        return ctxRef.current.on("canvas:node-metadata-updated", (payload) => {
            const ctx = ctxRef.current;
            const event = payload && typeof payload === "object" ? payload as { projectId?: string; nodeIds?: unknown } : {};
            if (event.projectId !== ctx.projectId || !Array.isArray(event.nodeIds)) return;
            syncReferences(new Set(event.nodeIds.filter((id): id is string => typeof id === "string")));
        });
    }, [sharedContext.node.id, sharedContext.projectId]);
    useEffect(() => {
        const ctx = ctxRef.current;
        let changed = false;
        const next = segments.map((segment) => {
            if (segment.productionClipProjection) return segment;
            // 先清掉指向已不存在引用的分镜绑定（旧版本遗留的孤儿卡），再做常规归一化。
            const healed = dropUnboundStoryboardReferences(segment);
            const hasStoryboards = storyboardRefsForSegment(healed).length > 0;
            if (!hasStoryboards && !Object.keys(healed.storyboardDurations || {}).length) return healed;
            const normalized = hasStoryboards
                ? withSegmentRefs(healed, refsForSegment(healed))
                : healed.storyboardShots !== undefined
                    ? { ...healed, storyboardDurations: {} }
                    : { ...healed, storyboardModeEnabled: undefined, storyboardDurations: {} };
            const missingIds = storyboardRefsForSegment(healed).some((ref) => !ref.bindingId);
            if (!missingIds && normalized.storyboardModeEnabled === healed.storyboardModeEnabled
                && JSON.stringify(normalized.storyboardDurations) === JSON.stringify(healed.storyboardDurations)) return healed;
            changed = true;
            void syncStoryboardPrompt(ctx, normalized);
            return normalized;
        });
        if (changed) ctx.updateMetadata({ segments: next });
    }, [segments, sharedContext.node.id]);
    const commitSegmentChange = useCallback((updated: H3Segment, select = false) => {
        updated = alignStoryboardReferenceOrder(updated);
        const liveMetadata = ctx.getNode(ctx.node.id)?.metadata || ctx.node.metadata || metadata;
        const current = segmentsFor(liveMetadata);
        const previous = current.find((item) => item.id === updated.id);
        if (!previous) return false;
        const previousItems = storyboardTrackItems(previous);
        const previousIds = new Set(previousItems.map((item) => item.id));
        const addedStoryboards = storyboardTrackItems(updated).filter((item) => !previousIds.has(item.id));
        if (previousItems.length && addedStoryboards.some((item) => item.duration < 0.5)) {
            message.warning("末张分镜时长不足 1 秒，无法再平分新增分镜。");
            return false;
        }
        ctx.updateMetadata({ ...(select ? { selectedSegmentId: updated.id } : {}), segments: current.map((item) => item.id === updated.id ? updated : item) });
        void syncStoryboardPrompt(ctx, updated, previous);
        return true;
    }, [ctx, metadata]);
    const patchSelected = useCallback((patch: Partial<H3Segment>) => {
        if (!selected) return;
        if ((patch.duration !== undefined || patch.mode !== undefined || patch.taskMode !== undefined) && storyboardTrackItems(selected).length) {
            const liveMetadata = ctx.getNode(ctx.node.id)?.metadata || ctx.node.metadata || metadata;
            const latest = segmentsFor(liveMetadata).find((item) => item.id === selected.id) || selected;
            const updated = withSegmentRefs({ ...latest, ...patch }, refsForSegment(latest));
            commitSegmentChange(updated);
            return;
        }
        patchSelectedSegment(ctx, { ...metadata, selectedSegmentId: selected.id }, patch);
    }, [commitSegmentChange, ctx, metadata, selected]);
    const patchAllSettings = useCallback((patch: Partial<H3Segment>) => {
        const liveMetadata = ctx.getNode(ctx.node.id)?.metadata || ctx.node.metadata || metadata;
        const current = Array.isArray(liveMetadata.segments) && liveMetadata.segments.length ? liveMetadata.segments as H3Segment[] : segmentsFor(liveMetadata);
        const next = current.map((segment) => {
            const updated = { ...segment, ...withH3ParameterEdits(segment as unknown as Record<string, unknown>, patch) } as H3Segment;
            if ((patch.duration !== undefined || patch.mode !== undefined || patch.taskMode !== undefined) && storyboardTrackItems(segment).length) {
                const withRefs = withSegmentRefs(updated, refsForSegment(segment));
                void syncStoryboardPrompt(ctx, withRefs, segment);
                return withRefs;
            }
            return updated;
        });
        ctx.updateMetadata(patchAllH3Clips(liveMetadata, next, patch));
    }, [ctx, metadata]);
    const removeTimelineRef = (segmentId: string, ref: H3Ref) => {
        const segment = segments.find((item) => item.id === segmentId);
        if (!segment) return false;
        // 分镜图走专用入口（摘掉分镜卡上的图、保留分镜格），否则 storyboardShots 会留下指向已删
        // bindingId 的孤立引用 → 轨道上出现一张永远空着的分镜卡。
        if (ref.type === "image" && inferReferenceRole(ref) === "storyboard") {
            return commitSegmentChange(removeStoryboardImageReference(segment, ref));
        }
        // 属于角色组的 ref：把对应 outfit 设为 disabled / 关闭 voice，由 group → refs 派生逻辑重写
        if (ref.groupId) {
            const group = segment.h3CharacterGroups?.[ref.groupId];
            if (group) {
                const isVoice = ref.role === "character_voice" || (ref.type === "audio" && !ref.outfitId);
                const nextSegment = isVoice
                    ? applyCharacterGroupEdits(segment, ref.groupId, { voiceEnabled: false })
                    : applyCharacterGroupEdits(segment, ref.groupId, { outfitEnabledById: ref.outfitId ? { [ref.outfitId]: false } : undefined });
                return commitSegmentChange(nextSegment);
            }
        }
        return commitSegmentChange(withSegmentRefs(segment, refsForSegment(segment).filter((entry) => ref.bindingId ? entry.bindingId !== ref.bindingId : entry.url !== ref.url)));
    };
    // 空 ref 槽选定画布节点后写入：从被点的槽位起依次插入，已存在的素材不重复加入。
    const addNodeRefs = (segmentId: string, slotIndex: number, refs: H3Ref[]) => {
        const segment = segments.find((item) => item.id === segmentId);
        if (!segment || !refs.length) return;
        const current = refsForSegment(segment);
        const fresh = refs.filter((ref) => !current.some((item) => sameRef(item, ref)));
        if (!fresh.length) return;
        const at = slotIndex >= 0 && slotIndex < current.length ? slotIndex : current.length;
        const next = [...current.slice(0, at), ...fresh, ...current.slice(at)];
        commitSegmentChange(withSegmentRefs(segment, next), true);
    };
    // 点空 ref 槽 → 请画布进入「选节点作参考」模式（高亮可点节点 + 顶部提示 + Esc 退出），不自建选节点面板。
    const requestCanvasRefPick = (segmentId: string, slotIndex: number) => {
        const segment = segments.find((item) => item.id === segmentId);
        if (!segment) return;
        const mode = String(segment.mode || segment.taskMode || "ref2va");
        if (mode === "t2v") return;
        setPickingRef({ segmentId, slotIndex, types: mode === "ref2va" ? ["image", "video", "audio"] : ["image"] });
        window.dispatchEvent(new CustomEvent("canvas-reference-pick-request", { detail: { nodeId: ctx.node.id } }));
    };
    // 空分镜双击 → 请画布进入「选节点作参考」模式，选中后把图片绑到该分镜（见 applyCanvasPickedNode 的 shotId 分支）。
    const requestStoryboardShotPick = (segmentId: string, shotId: string) => {
        const segment = segments.find((item) => item.id === segmentId);
        if (!segment) return;
        setPickingRef({ segmentId, slotIndex: -1, shotId, types: ["image"] });
        window.dispatchEvent(new CustomEvent("canvas-reference-pick-request", { detail: { nodeId: ctx.node.id } }));
    };
    const beginCanvasRefReplace = (segmentId: string, ref: H3Ref) => {
        const segment = segments.find((item) => item.id === segmentId);
        if (!segment) return;
        const mode = String(segment.mode || segment.taskMode || "ref2va");
        const allowedTypes: H3Ref["type"][] = mode === "ref2va" ? ["image", "video", "audio"] : ["image"];
        if (!allowedTypes.includes(ref.type)) return;
        const refs = refsForSegment(segment);
        const slotIndex = refs.findIndex((item) => ref.bindingId ? item.bindingId === ref.bindingId : sameRef(item, ref));
        if (slotIndex < 0) return;
        setPickingRef({ segmentId, slotIndex, types: [ref.type], replaceRef: ref });
        // 先卸载职责 Modal，等遮罩消失后再进入画布选点模式；否则 Modal 会拦截画布节点点击。
        setEditingRef(null);
        window.setTimeout(() => window.dispatchEvent(new CustomEvent("canvas-reference-pick-request", { detail: { nodeId: ctx.node.id } })), 0);
    };
    const requestCanvasRefReplace = () => {
        if (editingRef) beginCanvasRefReplace(editingRef.segmentId, editingRef.ref);
    };
    // 画布选中的节点 → 落进被点的槽。角色节点与拖拽路径保持同一口径：建/复用角色组，
    // outfit 拆 image ref、声线拆 audio ref；其余节点按内容展开（场景图 / H3 成品 / 通用媒体）。
    const applyCanvasPickedNode = (pick: { segmentId: string; slotIndex: number; types: H3Ref["type"][]; replaceRef?: H3Ref; shotId?: string }, sourceNodeId: string) => {
        const node = ctx.getNode(sourceNodeId);
        if (!node || node.id === ctx.node.id) return;
        const segment = segments.find((item) => item.id === pick.segmentId);
        if (!segment) return;
        const groupImages = node.type === "group" ? orderedGroupStoryboardRefs(node, ctx.getNodes(), ctx.node.id, ctx.getConnections()) : [];
        if (node.type === "group" && !node.metadata?.orderedGroup) {
            message.warning("请选择有序组以按槽位顺序导入分镜图");
            return;
        }
        // 空分镜绑图：有序组按槽位批量导入，单节点仍取首张图片（角色节点取主服装图）。
        if (pick.shotId) {
            if (node.type === "group") {
                if (!groupImages.length) { message.warning("有序组内没有可用分镜图"); return; }
                const updated = assignStoryboardShotRefs(segment, pick.shotId, groupImages);
                if (updated === segment) { message.warning("当前 Clip 时长不足以容纳组内所有分镜图，每张至少需要 0.5 秒"); return; }
                commitSegmentChange(updated, true);
                return;
            }
            const shotImage = node.type === "character"
                ? (() => { const group = readCharacterGroupFromNode(node); return group?.outfits[0]; })()
                : h3RefCandidates([node], ctx.node.id, ctx.getNodes(), ctx.getConnections()).map((item) => item.ref).find((ref) => ref.type === "image");
            if (!shotImage?.url && !shotImage?.storageKey) { message.warning("所选节点没有可用图片，未绑定分镜"); return; }
            commitSegmentChange(assignStoryboardShotRef(segment, pick.shotId, { ...shotImage, type: "image" }), true);
            return;
        }
        if (pick.replaceRef) {
            if (node.type === "group") { message.warning("替换单张参考时请选择一张图片节点"); return; }
            const current = refsForSegment(segment);
            const oldIndex = current.findIndex((ref) => pick.replaceRef?.bindingId ? ref.bindingId === pick.replaceRef.bindingId : sameRef(ref, pick.replaceRef!));
            if (oldIndex < 0) return;
            // 被替换的图若挂在分镜轨卡片上，先把原卡片时长取出来，换图后沿用（这段时间此后拿不到）。
            const oldShotId = pick.replaceRef.bindingId;
            const oldShotDuration = oldShotId
                ? storyboardTrackItems(segment).find((item) => item.referenceBindingId === oldShotId)?.duration
                : undefined;
            const groupReplacementIndex = current.slice(0, oldIndex).filter((ref) => !pick.replaceRef?.groupId || ref.groupId !== pick.replaceRef.groupId).length;
            if (node.type === "character" && pick.types.includes("image")) {
                const sourceGroup = readCharacterGroupFromNode(node);
                if (!sourceGroup?.outfits.length) { message.warning("所选角色节点没有可用参考图，未替换素材"); return; }
                const withoutOld = pick.replaceRef.groupId
                    ? removeCharacterGroup(segment, pick.replaceRef.groupId)
                    : withSegmentRefs(segment, current.filter((ref, index) => index !== oldIndex));
                const updated = upsertCharacterGroup(withoutOld, sourceGroup);
                const replacementGroup = Object.values(updated.h3CharacterGroups || {}).find((group) => group.characterNodeId === sourceGroup.characterNodeId);
                if (!replacementGroup) { message.warning("当前 Clip 无法加入所选角色，未替换素材"); return; }
                const allRefs = refsForSegment(updated);
                const inserted = allRefs.filter((ref) => ref.groupId === replacementGroup.id);
                if (!inserted.length) { message.warning("当前 Clip 没有可用的角色参考图，未替换素材"); return; }
                const others = allRefs.filter((ref) => ref.groupId !== replacementGroup.id);
                // 原引用是分镜图时把原分镜卡改绑到替换后的角色图（角色组 refs 拿不到原 bindingId）
                const replacement = inserted.find((ref) => ref.type === "image");
                let rebound = withSegmentRefs(updated, [...others.slice(0, groupReplacementIndex), ...inserted, ...others.slice(groupReplacementIndex)]);
                if (inferReferenceRole(pick.replaceRef) === "storyboard" && replacement?.bindingId) {
                    rebound = rebindStoryboardShot(rebound, pick.replaceRef.bindingId, replacement.bindingId, oldShotDuration);
                    rebound = withSegmentRefs(rebound, refsForSegment(rebound).map((ref) => ref.bindingId === replacement.bindingId ? { ...ref, role: "storyboard" as const } : ref));
                }
                setEditingRef(null);
                commitSegmentChange(rebound, true);
                return;
            }
            const candidates = h3RefCandidates([node], ctx.node.id, ctx.getNodes(), ctx.getConnections()).map((item) => item.ref).filter((ref) => pick.types.includes(ref.type));
            if (!candidates.length) { message.warning("所选节点没有相同类型的素材，未替换当前引用"); return; }
            // 复用原 bindingId 与职责：分镜轨卡片留在原位只换素材，不会留下空卡也不会多出一格。
            const updated = replaceSegmentReference(segment, pick.replaceRef, candidates);
            if (updated === segment) { message.warning("所选素材已存在于当前 Clip，未替换引用"); return; }
            setEditingRef(null);
            commitSegmentChange(updated, true);
            return;
        }
        if (node.type === "character" && pick.types.includes("image")) {
            const group = readCharacterGroupFromNode(node);
            if (group?.outfits.length) {
                const updated = upsertCharacterGroup(segment, { characterName: group.characterName, characterAssetId: group.characterAssetId, characterNodeId: group.characterNodeId, outfits: group.outfits, voice: group.voice, characterPrimaryIndex: group.characterPrimaryIndex });
                commitSegmentChange(updated, true);
                return;
            }
        }
        if (node.type === "group") {
            if (!groupImages.length) { message.warning("有序组内没有可用分镜图"); return; }
            addNodeRefs(pick.segmentId, pick.slotIndex, groupImages);
            return;
        }
        addNodeRefs(pick.segmentId, pick.slotIndex, h3RefCandidates([node], ctx.node.id, ctx.getNodes(), ctx.getConnections()).map((item) => item.ref).filter((ref) => pick.types.includes(ref.type)));
    };
    const applyReferenceEdit = (nextRef: H3Ref, characterPatch?: H3CharacterGroupEditPatch) => {
        if (!editingRef) return;
        const segment = segments.find((item) => item.id === editingRef.segmentId);
        if (!segment) return;
        let updated = withSegmentRefs(segment, refsForSegment(segment).map((item) => (editingRef.ref.bindingId ? item.bindingId === editingRef.ref.bindingId : item.url === editingRef.ref.url) ? nextRef : item));
        if (editingRef.ref.groupId && characterPatch) updated = applyCharacterGroupEdits(updated, editingRef.ref.groupId, characterPatch);
        commitSegmentChange(updated);
    };
    const deleteReferenceGroup = () => {
        if (!editingRef?.ref.groupId || !editingRefSegment) return;
        if (commitSegmentChange(removeCharacterGroup(editingRefSegment, editingRef.ref.groupId))) setEditingRef(null);
    };
    const removeEditingReference = () => {
        if (!editingRef) return;
        if (removeTimelineRef(editingRef.segmentId, editingRef.ref)) setEditingRef(null);
    };
    const removeEditingStoryboardImage = () => {
        if (!editingRef) return;
        const segment = segments.find((item) => item.id === editingRef.segmentId);
        if (!segment) return;
        const updated = removeStoryboardImageReference(segment, editingRef.ref);
        if (updated !== segment && commitSegmentChange(updated)) setEditingRef(null);
    };
    const addDroppedReference = (event: React.DragEvent<HTMLElement>) => {
        if ((event.target as HTMLElement).closest(".minimax-ref-track")) return;
        event.preventDefault();
        event.stopPropagation();
        if (!selected) return;
        const droppedPayload = event.dataTransfer.getData("application/x-infinite-canvas-ref") || event.dataTransfer.getData("text/plain");
        if (droppedPayload) {
            try {
                const payload = JSON.parse(droppedPayload) as Record<string, unknown>;
                if (String(payload.type || payload.kind || "").toLowerCase() === "character" && typeof payload.characterNodeId !== "string") {
                    console.warn("H3 角色参考已拒绝：必须绑定已有 character 画布节点");
                    return;
                }
            } catch { /* 普通 URL 交给后续解析 */ }
        }
        const mode = String(selected.mode || selected.taskMode || "ref2va");
        // 角色资产 / 角色节点：建/复用角色组，outfit 拆为 image refs、voice 拆为 audio ref（占 audio 槽，受 3 上限约束）
        let characterGroupInput: ReturnType<typeof readCharacterGroupFromDrop>;
        try {
            characterGroupInput = readCharacterGroupFromDrop(event);
        } catch (error) {
            if (error instanceof CharacterGroupParseError) console.warn(error.message);
            return;
        }
        if (characterGroupInput) {
            if (mode === "t2v") return;
            const updated = upsertCharacterGroup(selected, characterGroupInput);
            commitSegmentChange(updated, true);
            return;
        }
        const ref = normalizeDroppedH3Ref(event);
        if (!ref) return;
        if (mode === "t2v" || (mode !== "ref2va" && ref.type !== "image")) return;
        const refs = refsForSegment(selected);
        // ref2va 的图片槽位不设数量上限；i2v / fl2v 的图片槽位是固定语义（首帧 / 首尾帧）才受限。
        const max = ref.type === "image" ? (mode === "i2v" ? 1 : mode === "fl2v" ? 2 : Number.POSITIVE_INFINITY) : 3;
        if (refs.filter((item) => item.type === ref.type).length >= max || refs.some((item) => item.url === ref.url)) return;
        commitSegmentChange(withSegmentRefs(selected, [...refs, ref]), true);
    };
    const addCanvasReference = (detail: Record<string, unknown>) => {
        const x = Number(detail.clientX);
        const y = Number(detail.clientY);
        // 优先用鼠标实际命中的 ref 格子（精确），避免坐标换算误差导致落点与悬停位置不符
        let target: H3Segment | undefined;
        if (Number.isFinite(x) && Number.isFinite(y)) {
            const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>(".minimax-ref-grid");
            if (hit?.dataset.segmentId) target = segments.find((item) => item.id === hit.dataset.segmentId);
            if (!target) {
                // 兜底：基于 refs 栏内容坐标（含横向滚动偏移，100px/单位）换算时间，修正旧版按可见宽度比例映射的错位
                const refTrack = workbenchRef.current?.querySelector<HTMLElement>(".minimax-ref-track");
                const rect = refTrack?.getBoundingClientRect();
                if (rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
                    const contentX = (refTrack?.scrollLeft || 0) + (x - rect.left);
                    const time = Math.max(0, Math.min(total, contentX / 100));
                    target = segments.find((item) => time >= Number(item.start || 0) && time < Number(item.start || 0) + Math.max(0.5, Number(item.duration || 1))) || selected;
                }
            }
        }
        target = target || selected;
        if (!target) return;
        const targetMode = String(target.mode || target.taskMode || "ref2va");
        if (targetMode === "t2v") return;
        // 角色节点派发：建/复用角色组
        const kind = String(detail.type || detail.kind || "").toLowerCase();
        if (kind === "character") {
            if (typeof detail.characterNodeId !== "string" || !detail.characterNodeId) {
                console.warn("H3 角色参考已拒绝：必须绑定已有 character 画布节点");
                return;
            }
            const outfits = Array.isArray(detail.characterImages) ? detail.characterImages as Array<Record<string, unknown>> : [];
            const valid = outfits.map((image) => ({ url: String(image.url || "").trim(), name: String(image.outfit || image.name || "outfit"), storageKey: typeof image.storageKey === "string" ? image.storageKey : undefined, mimeType: typeof image.mimeType === "string" ? image.mimeType : undefined })).filter((image) => image.url);
            if (!valid.length) return;
            const voiceUrl = String(detail.characterVoiceUrl || detail.voice || "").trim();
            const voiceName = String(detail.characterVoiceName || detail.voiceName || "声线");
            const voiceDescription = String(detail.characterVoiceDescription || detail.voiceDescription || "").trim();
            const voiceStorageKey = typeof detail.characterVoiceStorageKey === "string" ? detail.characterVoiceStorageKey : undefined;
            const voiceAssetId = typeof detail.characterVoiceAssetId === "string" ? detail.characterVoiceAssetId : (typeof detail.voiceAssetId === "string" ? detail.voiceAssetId : undefined);
            // 主图索引透传给 upsertCharacterGroup，新建路径据此默认只启用主图服装；detail 里没有时回退到 character 节点 metadata。
            const detailPrimaryRaw = Number(detail.characterPrimaryIndex);
            const sourceNodeMeta = typeof detail.characterNodeId === "string" ? ctx.getNode(detail.characterNodeId)?.metadata as Record<string, unknown> | undefined : undefined;
            const fallbackPrimaryRaw = Number(sourceNodeMeta?.characterPrimaryIndex);
            const characterPrimaryIndex = Number.isFinite(detailPrimaryRaw) && detailPrimaryRaw >= 0
                ? Math.floor(detailPrimaryRaw)
                : (Number.isFinite(fallbackPrimaryRaw) && fallbackPrimaryRaw >= 0 ? Math.floor(fallbackPrimaryRaw) : undefined);
            const updated = upsertCharacterGroup(target, {
                characterName: String(detail.characterName || "角色"),
                characterAssetId: typeof detail.characterAssetId === "string" ? detail.characterAssetId : undefined,
                characterNodeId: typeof detail.characterNodeId === "string" ? detail.characterNodeId : undefined,
                outfits: valid,
                voice: voiceUrl ? { url: voiceUrl, name: voiceName, description: voiceDescription || undefined, storageKey: voiceStorageKey, assetId: voiceAssetId } : undefined,
                characterPrimaryIndex,
            });
            commitSegmentChange(updated, true);
            return;
        }
        const url = String(detail.url || "").trim();
        if (!url) return;
        const allowedRoles = new Set<H3Ref["role"]>(["character_identity", "character_turnaround", "storyboard", "scene", "blocking", "keyframe", "motion_reference", "audio_reference", "character_voice", "style", "palette", "prop", "other"]);
        const role = typeof detail.role === "string" && allowedRoles.has(detail.role as H3Ref["role"]) ? detail.role as H3Ref["role"] : undefined;
        const sourceNode = typeof detail.nodeId === "string" ? ctx.getNode(detail.nodeId) : null;
        const storyboardSubjectIds = storyboardSubjectIdsForNode(sourceNode, ctx.getNodes(), ctx.getConnections());
        const ref: H3Ref = { url, type: "image", name: String(detail.name || "图片"), storageKey: typeof detail.storageKey === "string" ? detail.storageKey : undefined, mimeType: typeof detail.mimeType === "string" ? detail.mimeType : undefined, ...(role ? { role } : {}), ...(detail.subjectId ? { subjectId: String(detail.subjectId) } : {}), ...(storyboardSubjectIds.length ? { storyboardSubjectIds } : {}) };
        const max = targetMode === "i2v" ? 1 : targetMode === "fl2v" ? 2 : Number.POSITIVE_INFINITY;
        const targetRefs = refsForSegment(target);
        if (targetRefs.filter((item) => item.type === "image").length >= max || targetRefs.some((item) => item.url === ref.url)) return;
        commitSegmentChange(withSegmentRefs(target, [...targetRefs, ref]), true);
    };
    useEffect(() => {
        const onStart = (event: Event) => { const detail = (event as CustomEvent<Record<string, unknown>>).detail || {}; if (detail.targetNodeId === ctx.node.id) setCanvasReferenceDragOver(true); };
        const onOver = (event: Event) => { const detail = (event as CustomEvent<Record<string, unknown>>).detail || {}; if (detail.targetNodeId === ctx.node.id) setCanvasReferenceDragOver(true); };
        const onDrop = (event: Event) => { const detail = (event as CustomEvent<Record<string, unknown>>).detail || {}; if (detail.targetNodeId !== ctx.node.id) return; setCanvasReferenceDragOver(false); addCanvasReference(detail); };
        const onEnd = (event: Event) => { const detail = (event as CustomEvent<Record<string, unknown>>).detail || {}; if (detail.targetNodeId === ctx.node.id) setCanvasReferenceDragOver(false); };
        // 画布「选节点作参考」模式选中的节点：落到点空槽时记下的位置
        const onPick = (event: Event) => { const detail = (event as CustomEvent<{ targetNodeId?: string; sourceNodeId?: string }>).detail || {}; if (detail.targetNodeId !== ctx.node.id || !pickingRef) return; const pick = pickingRef; setPickingRef(null); applyCanvasPickedNode(pick, String(detail.sourceNodeId || "")); };
        // 画布侧退出选择模式（Esc / 点顶部提示条）：清掉待填槽位
        const onPickEnd = (event: Event) => { const detail = (event as CustomEvent<{ targetNodeId?: string }>).detail || {}; if (detail.targetNodeId !== ctx.node.id) return; setPickingRef(null); };
        window.addEventListener("canvas-reference-drag-start", onStart);
        window.addEventListener("canvas-reference-drag-over", onOver);
        window.addEventListener("canvas-reference-drop", onDrop);
        window.addEventListener("canvas-reference-drag-end", onEnd);
        window.addEventListener("canvas-reference-pick", onPick);
        window.addEventListener("canvas-reference-pick-end", onPickEnd);
        return () => { window.removeEventListener("canvas-reference-drag-start", onStart); window.removeEventListener("canvas-reference-drag-over", onOver); window.removeEventListener("canvas-reference-drop", onDrop); window.removeEventListener("canvas-reference-drag-end", onEnd); window.removeEventListener("canvas-reference-pick", onPick); window.removeEventListener("canvas-reference-pick-end", onPickEnd); };
    }, [ctx.node.id, selected, segments, total, pickingRef]);
    // 找到 playhead 所在的 segment，从该位置开始播全部
    const startSegment = segments.find((seg) => {
        const segStart = Number(seg.start || 0);
        const segEnd = segStart + Math.max(0.5, Number(seg.duration || 1));
        return playhead >= segStart && playhead < segEnd && resultUrl(seg.result);
    }) || segments.find((item) => Boolean(resultUrl(item.result))) || segments[0];

    const playAll = () => {
        const fromSegment = startSegment;
        // 保留 playhead 在当前 clip 内的相对位置
        const localPlayhead = Math.max(0, playhead - Number(fromSegment.start || 0));
        setPlayToken((token) => token + 1);
        ctx.updateMetadata({ selectedSegmentId: fromSegment.id, playhead: Number(fromSegment.start || 0) + localPlayhead, h3PlayRequest: Number(metadata.h3PlayRequest || 0) + 1, h3PlaybackAll: true });
    };
    // continuedFromSlot=true 表示播放器的双槽交叉淡入已经自己把下一段起播了（buffer 槽接手）。
    // 这时**绝不能**再递增 playToken/h3PlayRequest：双槽续播已经把下一段起播了，再触发一次反而会切乱状态。
    const advancePlayback = (continuedFromSlot = false) => {
        if (metadata.h3PlaybackAll !== true) return;
        const next = segments.slice(selectedIndex + 1).find((item) => Boolean(resultUrl(item.result)));
        if (!next) { ctx.updateMetadata({ h3PlaybackAll: false, playhead: total }); return; }
        if (continuedFromSlot) {
            ctx.updateMetadata({ selectedSegmentId: next.id, playhead: Number(next.start || 0) });
        } else {
            setPlayToken((token) => token + 1);
            ctx.updateMetadata({ selectedSegmentId: next.id, playhead: Number(next.start || 0), h3PlayRequest: Number(metadata.h3PlayRequest || 0) + 1 });
        }
    };
    const nextSegment = segments.slice(selectedIndex + 1).find((item) => Boolean(resultUrl(item.result)));
    const preloadNext = metadata.h3PlaybackAll === true;
    const nextUrl = preloadNext && nextSegment ? (nextSegment.resultStorageKey ? ctx.mediaUrl(nextSegment.resultStorageKey) : resultUrl(nextSegment.result)) : undefined;
    const themeStyle = {
        ...h3ThemeVars(ctx.theme),
        "--minimax-prompt-w": `${promptW}px`,
        "--minimax-preview-w": `${previewW}px`,
        "--minimax-preview-h": `${effPreviewH}px`,
        "--minimax-timeline-h": `${effTimelineH}px`,
        "--minimax-ref-h": `${effRefLaneH}px`,
    };
    return <div ref={workbenchRef} className={`minimax-canvas-workbench${canvasReferenceDragOver ? " is-canvas-ref-drag-over" : ""}`} data-canvas-no-zoom data-canvas-ref-drop-target={ctx.node.id} style={themeStyle} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()} onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }} onDrop={addDroppedReference}>
        <H3Runner key="runner" ctx={ctx} />
        <H3PaneHandles key="pane-handles" ctx={ctx} />
        <H3RulerScrubber key="ruler-scrubber" ctx={ctx} segments={segments} total={total} previewH={effPreviewH} />
        <H3WorkbenchToolbar key="workbench-toolbar" ctx={ctx} metadata={metadata} segments={segments} selected={selected} selectedIndex={selectedIndex} playhead={playhead} total={total} fmt={fmt} onPlayAll={playAll} />
        <SmartStoryboardModal key="storyboard-modal" ctx={ctx} metadata={metadata} upstream={upstream} open={smartStoryboardOpen} uploads={smartStoryboardUploads} setUploads={setSmartStoryboardUploads} onClose={() => setSmartStoryboardOpen(false)} />
        {editingRef && currentEditingRef ? <H3ReferenceModal key="reference-modal" ctx={ctx} refItem={currentEditingRef} characters={referencedCharacters} group={editingRefGroup} onApply={applyReferenceEdit} onReplaceFromCanvas={requestCanvasRefReplace} onRemoveRef={removeEditingReference} onRemoveStoryboardImage={removeEditingStoryboardImage} onDeleteGroup={editingRefGroup ? deleteReferenceGroup : undefined} onClose={() => setEditingRef(null)} /> : null}
        <div key="workbench-body" ref={bodyRef} className="minimax-wb-body">
            <div key="player-stage" className="minimax-player-stage"><H3PreviewPlayer key={`${showLivePreview ? "live" : "result"}-${previewKind}`} ctx={ctx} url={previewStorageKey ? ctx.mediaUrl(previewStorageKey) : preview} kind={previewKind} aspectRatio={String(selected?.aspectRatio || metadata.aspectRatio || "16:9 (Widescreen)")} storageKey={previewStorageKey} name={previewName} livePreview={showLivePreview} playhead={playhead} timelineOffset={resultUrl(selected?.result) ? Number(selected?.start || 0) : 0} clipDuration={resultUrl(selected?.result) ? Number(selected?.duration || 0) : undefined} playToken={playToken} playRequest={playRequest} nextUrl={nextUrl} preloadNext={preloadNext} onEnded={advancePlayback} onPlayheadTick={livePlayheadTick} /></div>
            <div key="prompt-side" className="minimax-prompt-side"><H3ClipSettingsPanel ctx={ctx} metadata={metadata} selected={selected} submitting={submittingSegments.has(String(selected?.id || ""))} patchSelected={patchSelected} patchAllSettings={patchAllSettings} /></div>
        <H3Timeline key="timeline" ctx={ctx} segments={segments} selected={selected} total={total} onRemoveRef={removeTimelineRef} onEditRef={(segmentId, ref) => setEditingRef({ segmentId, ref })} onRequestReplaceRef={beginCanvasRefReplace} onRequestPickRef={requestCanvasRefPick} onRequestPickStoryboardShot={requestStoryboardShotPick} pickingShotKey={pickingRef?.shotId ? `${pickingRef.segmentId}:${pickingRef.shotId}` : undefined} onSegmentChange={commitSegmentChange} pickingKey={pickingRef ? `${pickingRef.segmentId}:${pickingRef.slotIndex}` : undefined} onPlayAll={playAll} fmt={fmt} />
            <H3MaterialLibrary key="material-library" ctx={ctx} outputs={outputs} segments={segments} selected={selected} patchSelected={patchSelected} />
            <div key="input-source" className="minimax-wb-input-source" style={{ padding: "8px 0", fontSize: 14 }}>
                使用当前已保存内容
                {selected?.productionClipProjection && <span> · 已关联导演基线</span>}
                {selected?.inputOutdated === true && <span> · 输入已修改</span>}
                {typeof (selected?.productionClipProjection?.nextValues as any)?.prompt === "string" && selected?.prompt !== (selected.productionClipProjection?.nextValues as any).prompt && <details>
                    <summary>已手动修改 · 查看导演提示词差异</summary>
                    <pre style={{ maxHeight: 240, overflow: "auto", whiteSpace: "pre-wrap" }}>{String((selected.productionClipProjection?.nextValues as any).prompt)}</pre>
                    <button type="button" onClick={() => patchSelected({ prompt: String((selected.productionClipProjection?.nextValues as any).prompt) })}>采用导演提示词</button>
                </details>}
            </div>
            <H3CurrentClipPanel key="current-clip-panel" ctx={ctx} selected={selected} selectedIndex={selectedIndex} imageRefs={imageRefs} videoRefs={videoRefs} audioRefs={audioRefs} patchSelected={patchSelected} fmt={fmt} onOpenStoryboard={() => setSmartStoryboardOpen(true)} />
        </div>
        <div key="status" className="minimax-wb-status"><H3StatusBadge status={submittingSegments.has(String(selected?.id || "")) && !["queued", "loading", "awaiting_confirmation"].includes(currentRuntime.status) ? "preparing" : currentRuntime.status} error={String(selected?.errorDetails || metadata.errorDetails || metadata.error || "")} onRetry={() => requestH3Run(ctx, false, true)} />{String(metadata.smartStoryboardStatus || "") === "loading" ? <span style={{ marginLeft: 8, color: "#f59e0b", fontSize: 24 }}>智能分镜正在分析参考图并生成提示词，请稍候…</span> : null}{String(metadata.smartStoryboardStatus || "") === "success" ? <span style={{ marginLeft: 8, color: "#22c55e", fontSize: 24 }}>智能分镜已完成</span> : null}{String(metadata.smartStoryboardStatus || "") === "error" ? <span style={{ marginLeft: 8, color: "#ef4444", fontSize: 24 }}>智能分镜生成失败</span> : null}</div>
    </div>;
}
