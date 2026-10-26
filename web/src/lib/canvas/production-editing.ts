import type { CanvasNodeData } from "@/types/canvas";
import type { CanvasProductionEditing, CanvasProductionStoryboardEditor } from "@/types/canvas-plugin";
import { productionSceneEntries, type DirectorProduction, type ProductionOperation } from "@basketikun/canvas-agent/drama/production-contract";
import { nanoid } from "nanoid";
import { applyProductionCompilation, BackendApiError, compileProduction, editEpisodeProduction, fetchBackendProject, fetchEpisodeProduction, fetchProductionCanvasContext, fetchProductionCompilation, fetchProductionWorkbench, type ProductionCompilationStatus, type ProductionTarget } from "@/services/backend-api";

type Input = Parameters<CanvasProductionEditing["reverseSyncPrompt"]>[0];
type Handler = CanvasProductionEditing["reverseSyncPrompt"];
type StoryboardHandler = (input: CanvasProductionStoryboardEditor, previousSegment?: Record<string, unknown>) => Promise<{ sourceSaved: boolean }>;
type ContinuationBoundaryInput = Parameters<CanvasProductionEditing["setContinuationBoundary"]>[0];
type ContinuationBoundariesInput = Parameters<CanvasProductionEditing["setContinuationBoundaries"]>[0];
type ContinuationBoundaryHandler = (input: { boundaries: Array<{ targetId: string; tailFrameContinuation: boolean; motionContextEnabled: boolean }>; requireNext?: boolean }) => Promise<{ sourceSaved: boolean }>;
type CompilePromptInput = Parameters<CanvasProductionEditing["compilePrompt"]>[0];
// Capability routing only: edits still use the production editor's existing persistent command journal.
const editors = new Map<string, { token: symbol; handler: Handler }>();
const storyboardEditors = new Map<string, { token: symbol; handler: StoryboardHandler }>();
const boundaryEditors = new Map<string, { token: symbol; handler: ContinuationBoundaryHandler }>();
const pendingPromptCompiles = new Map<string, PendingPromptCompile>();
type PendingPromptCompile = { expectedRevision: number; operationId: string; staleRetries?: number; waitedMs?: number };
// 已发送未确认的编译先用原 operationId 取回执：刷新页面或重新打开浮层后仍能接回同一次编译。
const PENDING_COMPILE_PREFIX = "prompt-compile-v1:";
function readPendingCompile(key: string): PendingPromptCompile | undefined {
    if (typeof window === "undefined") return undefined;
    try { const raw = sessionStorage.getItem(PENDING_COMPILE_PREFIX + key); return raw ? JSON.parse(raw) as PendingPromptCompile : undefined; } catch { return undefined; }
}
function rememberPendingCompile(key: string, value: PendingPromptCompile) {
    pendingPromptCompiles.set(key, value);
    try { sessionStorage.setItem(PENDING_COMPILE_PREFIX + key, JSON.stringify(value)); } catch { /* 存储不可用时只在内存里续查 */ }
}
function forgetPendingCompile(key: string) {
    pendingPromptCompiles.delete(key);
    try { sessionStorage.removeItem(PENDING_COMPILE_PREFIX + key); } catch { /* 忽略存储不可用 */ }
}
const rows = (value: unknown): Array<Record<string, any>> => Array.isArray(value) ? value : [];

function storyboardKeyframeForSlot(frame: Record<string, any>, slotId: string) {
    return String(frame.id || "").startsWith(`KF:${slotId}:`);
}

function removeKeyframeSubjectReferences(shot: Record<string, any>, removedFrames: Array<Record<string, any>>, source: Record<string, any>) {
    const removedSubjects = new Set(removedFrames.flatMap(frame => Array.isArray(frame.subjectIds) ? frame.subjectIds.map(String) : []));
    const removedPictureBindings = new Map<string, Set<string>>();
    for (const frame of removedFrames) for (const [subjectId, bindings] of Object.entries(frame.subjectPictureBindingIds || {})) {
        const selected = removedPictureBindings.get(subjectId) || new Set<string>();
        for (const bindingId of Array.isArray(bindings) ? bindings : []) selected.add(String(bindingId));
        removedPictureBindings.set(subjectId, selected);
    }
    if (!removedSubjects.size && !removedPictureBindings.size) return;
    const stillKeyframed = new Set(rows(shot.keyframes).flatMap(frame => Array.isArray(frame.subjectIds) ? frame.subjectIds.map(String) : []));
    const remainingPictureBindings = new Map<string, Set<string>>();
    for (const frame of rows(shot.keyframes)) for (const [subjectId, bindings] of Object.entries(frame.subjectPictureBindingIds || {})) {
        const selected = remainingPictureBindings.get(subjectId) || new Set<string>();
        for (const bindingId of Array.isArray(bindings) ? bindings : []) selected.add(String(bindingId));
        remainingPictureBindings.set(subjectId, selected);
    }
    const attended = new Set(rows(shot.camera?.attention_subject_ids).map(value => String(value)));
    const utteranceIds = new Set(rows(shot.utterance_refs).map(ref => String(ref.utteranceId)));
    const speaking = new Set(rows(source.utterances).filter(line => utteranceIds.has(String(line.id))).map(line => String(line.speakerSubjectId || "")));
    shot.subject_usages = rows(shot.subject_usages).flatMap(usage => {
        const subjectId = String(usage.subjectId || "");
        const removed = removedPictureBindings.get(subjectId);
        const retained = remainingPictureBindings.get(subjectId) || new Set<string>();
        const pictureBindingIds = (Array.isArray(usage.pictureBindingIds) ? usage.pictureBindingIds : []).map(String)
            .filter(bindingId => !removed?.has(bindingId) || retained.has(bindingId));
        if (removedSubjects.has(subjectId) && !stillKeyframed.has(subjectId) && !attended.has(subjectId) && !speaking.has(subjectId)) return [];
        return [{ ...usage, pictureBindingIds }];
    });
}

export function registerProductionPromptEditor(projectId: string, handler: Handler) {
    const token = Symbol(projectId);
    editors.set(projectId, { token, handler });
    return () => { if (editors.get(projectId)?.token === token) editors.delete(projectId); };
}
export function registerProductionStoryboardEditor(projectId: string, handler: StoryboardHandler) {
    const token = Symbol(projectId);
    storyboardEditors.set(projectId, { token, handler });
    return () => { if (storyboardEditors.get(projectId)?.token === token) storyboardEditors.delete(projectId); };
}
export function registerProductionBoundaryEditor(projectId: string, handler: ContinuationBoundaryHandler) {
    const token = Symbol(projectId);
    boundaryEditors.set(projectId, { token, handler });
    return () => { if (boundaryEditors.get(projectId)?.token === token) boundaryEditors.delete(projectId); };
}

export function sourceSegmentForCanvasClip(nodes: Array<{ id: string; metadata?: Record<string, any> }>, source: Record<string, any>, nodeId: string, segmentId: string) {
    const matches = nodes.flatMap(node => (Array.isArray(node.metadata?.segments) ? node.metadata!.segments : [])
        .filter((segment: Record<string, any>) => String(segment.id || "") === segmentId && String(segment.productionClipProjection?.targetId || "")
            && Array.isArray(source.segments) && source.segments.some((item: Record<string, any>) => String(item.id || "") === String(segment.productionClipProjection.targetId)))
        .map((segment: Record<string, any>) => ({ nodeId: node.id, segmentId: String(segment.id), targetId: String(segment.productionClipProjection.targetId) })));
    if (matches.length !== 1 || matches[0].nodeId !== nodeId) throw new Error("PROMPT_REVERSE_SYNC_TARGET_MISMATCH");
    return matches[0].targetId;
}

export function buildDirectorClipStoryboardOperation(director: DirectorProduction, groupId: string, input: CanvasProductionStoryboardEditor, previousSegment?: Record<string, unknown>, projectId?: string): ProductionOperation {
    const source = director.source as Record<string, any>;
    const planned = (Array.isArray(source.segments) ? source.segments : []).find((segment: Record<string, any>) => segment.id === groupId);
    if (!planned) throw new Error("CLIP_NOT_FOUND: 制作台 Clip 不存在");
    const group = planned;
    const oldShots = (group.shot_ids || []).map((id: string) => (source.shots as Record<string, any>[]).find(shot => shot.id === id)).filter(Boolean) as Record<string, any>[];
    if (!oldShots.length || oldShots.length !== group.shot_ids.length) throw new Error("CLIP_SHOTS_MISSING: 制作台镜头映射不完整");
    const h3Segment = input.segment as Record<string, any>;
    const projection = h3Segment.productionClipProjection as Record<string, unknown> | undefined;
    if (h3Segment.id !== input.segmentId || projection?.targetId !== groupId) throw new Error("CLIP_PROJECTION_MISMATCH: H3 Clip 与制作台绑定不一致");
    const storyboard = Array.isArray(h3Segment.storyboardShots) ? h3Segment.storyboardShots as Array<Record<string, any>> : [];
    const previousRefs = rows(previousSegment?.referenceBindings);
    if (!storyboard.length) throw new Error("SHOT_LAST_IN_CLIP: Clip 至少保留一个镜头；删除整个 Clip 才能移除最后一镜");
    const v2 = (source.prompt_assembly as Record<string, unknown> | undefined)?.version === 2;
    const fpsNum = Number(source.fps_num || 24), fpsDen = Number(source.fps_den || 1), fps = fpsNum / fpsDen;
    const startFrame = v2 ? 0 : Number(planned.start_frame), endFrame = v2 ? 0 : Number(planned.end_frame);
    const totalFrames = v2 ? oldShots.reduce((sum, shot) => sum + Number(shot.duration_frames || 0), 0) : endFrame - startFrame;
    if (!Number.isFinite(fps) || fps <= 0 || totalFrames <= 0 || !v2 && (!Number.isInteger(startFrame) || !Number.isInteger(endFrame))) throw new Error("CLIP_FRAME_WINDOW: Clip 缺少可验证的帧范围或帧率");
    const durations = storyboard.map(shot => Number(shot.duration));
    if (durations.some(duration => !Number.isFinite(duration) || duration <= 0)) throw new Error("STORYBOARD_DURATION_INVALID: 每格都必须有正时长");
    const frameCounts = durations.map(duration => Math.round(duration * fps));
    const frameDelta = totalFrames - frameCounts.reduce((sum, value) => sum + value, 0);
    if (Math.abs(frameDelta) > storyboard.length) throw new Error("STORYBOARD_DURATION_TOTAL_MISMATCH: 分镜总时长必须覆盖当前 Clip");
    frameCounts[frameCounts.length - 1] += frameDelta;
    if (frameCounts.some(value => value <= 0)) throw new Error("STORYBOARD_DURATION_INVALID: 分镜时长小于一帧");
    const refs = Array.isArray(h3Segment.referenceBindings) ? h3Segment.referenceBindings as Array<Record<string, any>> : [];
    const shots: Record<string, any>[] = [];
    const shotInputs: Record<string, unknown> = {};
    const keyframeBindings: Array<{ shotId: string; assetId: string; bindingId: string; nodeId?: string; containerNodeId?: string; storageKey?: string; label?: string }> = [];
    const removedKeyframesByShot = new Map<string, Array<Record<string, any>>>();
    const originalById = new Map(oldShots.map(shot => [String(shot.id), shot]));
    const firstOrder = Number(oldShots[0].story_order || 0);
    const mappedSceneIds = [...new Set(productionSceneEntries(source).filter(scene => oldShots.some(shot => scene.shotIds.includes(String(shot.id)))).map(scene => scene.id))];
    const explicitSceneId = String(oldShots[0].source_scene_id || "");
    if (mappedSceneIds.length > 1 || explicitSceneId && mappedSceneIds.some(id => id !== explicitSceneId)) throw new Error("CLIP_CROSS_SCENE: 无法唯一确认当前 Clip 的场次");
    const sceneId = explicitSceneId || mappedSceneIds[0];
    if (v2 && Array.isArray(source.script_scenes) && source.script_scenes.length && !sceneId) throw new Error("SCENE_ARCHIVE_OCCURRENCE_AMBIGUOUS: 无法唯一确认该 Clip 的场次");
    let cursor = startFrame;
    for (const [index, slot] of storyboard.entries()) {
        const existing = originalById.get(String(slot.id));
        let next: Record<string, any>;
        if (v2) {
            next = existing ? structuredClone(existing) : {
                id: String(slot.id), timeline_id: oldShots[0].timeline_id, story_order: firstOrder + index,
                ...(sceneId ? { source_scene_id: sceneId } : {}), subject_usages: [], keyframes: [], utterance_refs: [],
            };
            next.id = String(slot.id); next.timeline_id = oldShots[0].timeline_id; next.story_order = firstOrder + index; next.duration_frames = frameCounts[index];
            delete next.start_frame; delete next.end_frame;
            // 重建改变了镜头时长时，按比例缩放 Subject 出现范围；否则克隆来的 localEndFrame 会超出
            // 新时长，触发「Subject 出现范围必须位于 Shot 时长内且起止递增」校验，整个 Clip 的
            // 分镜/参考回写被 400 拒绝（典型场景：画布上拆分镜头后时长减半）。
            const previousFrames = existing ? Number(existing.duration_frames || 0) : 0;
            if (previousFrames > 0 && frameCounts[index] > 0 && previousFrames !== frameCounts[index]) {
                const scale = frameCounts[index] / previousFrames;
                for (const usage of rows(next.subject_usages)) {
                    const start = usage.localStartFrame, end = usage.localEndFrame;
                    if (start === undefined && end === undefined) continue;
                    const nextStart = start === undefined ? undefined : Math.min(Math.round(Number(start) * scale), frameCounts[index] - 1);
                    let nextEnd = end === undefined ? undefined : Math.round(Number(end) * scale);
                    if (nextEnd !== undefined) {
                        nextEnd = Math.min(Math.max(nextEnd, (nextStart ?? 0) + 1), frameCounts[index]);
                        if (nextStart !== undefined && nextEnd <= nextStart) nextEnd = Math.min(frameCounts[index], nextStart + 1);
                    }
                    if (nextStart !== undefined) usage.localStartFrame = nextStart;
                    if (nextEnd !== undefined) usage.localEndFrame = nextEnd;
                }
                // 关键帧同样按比例缩放；校验要求 localFrame < duration_frames。
                for (const keyframe of rows(next.keyframes)) {
                    if (keyframe.localFrame === undefined) continue;
                    keyframe.localFrame = Math.min(Math.round(Number(keyframe.localFrame) * scale), frameCounts[index] - 1);
                }
                // 对白引用时窗同理；校验要求 start < end <= duration_frames。
                for (const ref of rows(next.utterance_refs)) {
                    if (ref.localStartFrame === undefined && ref.localEndFrame === undefined) continue;
                    const nextStart = ref.localStartFrame === undefined ? 0 : Math.min(Math.round(Number(ref.localStartFrame) * scale), frameCounts[index] - 1);
                    let nextEnd = ref.localEndFrame === undefined ? frameCounts[index] : Math.round(Number(ref.localEndFrame) * scale);
                    nextEnd = Math.min(Math.max(nextEnd, nextStart + 1), frameCounts[index]);
                    ref.localStartFrame = nextStart;
                    ref.localEndFrame = nextEnd;
                }
            }
        } else {
            const template = existing || oldShots[0];
            next = { ...structuredClone(template), id: String(slot.id), start_frame: cursor, end_frame: cursor + frameCounts[index],
                ...(Number.isInteger(template.story_order) ? { story_order: firstOrder + index } : {}) };
        }
        const bindingId = String(slot.referenceBindingId || "");
        let keyframeAssetId: string | undefined;
        const slotFrames = oldShots.flatMap(ownerShot => rows(ownerShot.keyframes)
            .filter(frame => storyboardKeyframeForSlot(frame, String(slot.id)))
            .map(frame => ({ ownerShot, frame })));
        if (bindingId) {
            const binding = refs.find(ref => String(ref.id || ref.bindingId || "") === bindingId);
            if (!binding || binding.mediaType && binding.mediaType !== "image" || binding.role && binding.role !== "storyboard") throw new Error(`STORYBOARD_BINDING_INVALID: 分镜格 ${slot.id} 引用了无效图片`);
            const match = Object.entries(director.assets).find(([assetId, asset]) => {
                const assetPlan = (source.asset_plan as Array<Record<string, any>> || []).find(item => String(item.asset_id || item.id) === assetId);
                return asset.storageKey === binding.storageKey && (!binding.sourceNodeId || asset.nodeId === binding.sourceNodeId)
                    && ["keyframe", "storyboard", "frame"].includes(String(assetPlan?.kind || assetPlan?.asset_type || "").toLowerCase());
            });
            keyframeAssetId = match?.[0] || `storyboard:${encodeURIComponent(bindingId)}`;
            keyframeBindings.push({ shotId: String(slot.id), assetId: keyframeAssetId, bindingId,
                ...(binding.sourceNodeId ? { nodeId: String(binding.sourceNodeId) } : { clearNodeId: true }),
                ...(binding.storageKey ? { storageKey: String(binding.storageKey) } : {}),
                ...(binding.label ? { label: String(binding.label) } : {}) });
            if (v2) {
                // A quick-storyboard reference may be stored directly on this H3 smart node rather than
                // on a separate image node. In that case the H3 node is the authoritative source for
                // the specific referenceBindingId/storageKey being promoted to a formal Shot keyframe.
                // Quick Storyboard references have no image-node owner. Keep the
                // archived result bound by storageKey instead of fabricating the
                // H3 container as the image's source node.
                const nodeId = String(binding.sourceNodeId || "");
                const frameId = slotFrames[0]?.frame.id || `KF:${slot.id}:storyboard`;
                const previousFrame = slotFrames[0]?.frame || {};
                const keyframe = { ...previousFrame, id: String(frameId), assetId: keyframeAssetId,
                    ...(nodeId && projectId ? { sourceNode: { projectId, nodeId } } : { sourceNode: undefined }),
                    selection: nodeId ? { mode: "node_selection" } : { mode: "selected_result", resultId: String(binding.storageKey || bindingId) }, anchor: "opening",
                    subjectIds: Array.isArray(previousFrame.subjectIds) ? previousFrame.subjectIds : [],
                    retain: Array.isArray(previousFrame.retain) ? previousFrame.retain : ["分镜图的画面构图"],
                    exclude: Array.isArray(previousFrame.exclude) ? previousFrame.exclude : [],
                    // A quick-storyboard image is already an archived production input.
                    // It remains valid without an image-node owner; compilation resolves
                    // the selected storageKey directly instead of requiring a fake node.
                    requiredForSubmission: Boolean(binding.storageKey) };
                next.keyframes = [...rows(next.keyframes).filter(frame => !storyboardKeyframeForSlot(frame, String(slot.id))), keyframe];
            }
        } else if (v2 && slotFrames.length) {
            for (const { ownerShot, frame } of slotFrames) {
                const removed = removedKeyframesByShot.get(String(ownerShot.id)) || [];
                removed.push(frame);
                removedKeyframesByShot.set(String(ownerShot.id), removed);
            }
        }
        if (v2 && slotFrames.length) {
            const removedFrameIds = new Set([...removedKeyframesByShot.values()].flat().map(frame => String(frame.id)));
            next.keyframes = rows(next.keyframes).filter(frame => !removedFrameIds.has(String(frame.id)));
        }
        shots.push(next);
        const previousInput = director.shotInputs[String(slot.id)];
        const previousKeyframeAssetId = previousInput?.keyframeAssetId;
        const retainedAssetIds = (previousInput?.assetIds || []).filter(assetId => assetId !== previousKeyframeAssetId);
        const boundReference = bindingId ? refs.find(ref => String(ref.id || ref.bindingId || "") === bindingId) : undefined;
        shotInputs[String(slot.id)] = keyframeAssetId
            ? { ...previousInput, keyframePolicy: boundReference?.storageKey ? "reuse" : "new", assetIds: [...new Set([...retainedAssetIds, keyframeAssetId])], keyframeAssetId }
            : { ...previousInput, keyframePolicy: "none", assetIds: retainedAssetIds };
        if (!keyframeAssetId) delete (shotInputs[String(slot.id)] as Record<string, unknown>).keyframeAssetId;
        cursor += frameCounts[index];
    }
    const removedKeyframeIds = new Set([...removedKeyframesByShot.values()].flat().map(frame => String(frame.id)));
    for (const shot of shots) {
        shot.keyframes = rows(shot.keyframes).filter(frame => !removedKeyframeIds.has(String(frame.id)));
        const removed = removedKeyframesByShot.get(String(shot.id));
        if (removed?.length) removeKeyframeSubjectReferences(shot, removed, source);
    }
    if (!v2 && cursor !== endFrame) throw new Error("STORYBOARD_COVERAGE: 分镜格未覆盖整个 Clip");
    const segment = { ...structuredClone(planned), shot_ids: shots.map(shot => shot.id) };
    const currentBindingIds = new Set(refs.map(ref => String(ref.id || ref.bindingId || "")));
    const previousTrackBindingIds = new Set(rows(previousSegment?.storyboardShots).map(shot => String(shot.referenceBindingId || "")).filter(Boolean));
    const currentTrackBindingIds = new Set(storyboard.map(shot => String(shot.referenceBindingId || "")).filter(Boolean));
    // Clearing a frame's image leaves its old binding in referenceBindings unless
    // this boundary removes it too. Track removals are authoritative when the
    // image is no longer used by another storyboard slot.
    const removedStoryboardBindingIds = [...new Set([
        ...previousRefs.filter(ref => ref.mediaType === "image" && String(ref.role || "").toLowerCase() === "storyboard")
            .map(ref => String(ref.id || ref.bindingId || "")).filter(id => id && !currentBindingIds.has(id)),
        ...[...previousTrackBindingIds].filter(id => !currentTrackBindingIds.has(id)
            && refs.some(ref => String(ref.id || ref.bindingId || "") === id
                && ref.mediaType === "image" && String(ref.role || "").toLowerCase() === "storyboard")),
    ])];
    return { type: "replace_director_clip_storyboard", segmentId: groupId, segment, shots, shotInputs,
        ...(keyframeBindings.length ? { keyframeBindings } : {}),
        ...(removedStoryboardBindingIds.length ? { removedStoryboardBindingIds: [...new Set(removedStoryboardBindingIds)] } : {}) };
}

export function createProductionEditing(projectId: string, getNode: (id: string) => CanvasNodeData | null, flush: () => Promise<void>): CanvasProductionEditing {
    return { reverseSyncPrompt: async (input: Input) => {
        await flush();
        const node = getNode(input.nodeId), segments = node?.metadata?.segments;
        const clip = Array.isArray(segments) ? segments.find(clip => clip.id === input.segmentId) : undefined;
        const projection = clip?.productionClipProjection as Record<string, unknown> | undefined;
        if (!clip || projection?.promptAssemblyVersion !== 2 || projection.artifactId !== input.artifactId
            || projection.sourceHash !== input.sourceHash || projection.promptHash !== input.basePromptHash) throw new Error("PROMPT_REVERSE_SYNC_BASELINE_MISMATCH");
        const editor = editors.get(projectId);
        if (!editor) throw new Error("PRODUCTION_EDITOR_NOT_READY");
        return editor.handler(input);
    }, compilePrompt: async (input: CompilePromptInput) => {
        await flush();
        const node = getNode(input.nodeId), segments = node?.metadata?.segments;
        const clip = Array.isArray(segments) ? segments.find(item => item.id === input.segmentId) : undefined;
        const projection = clip?.productionClipProjection as Record<string, unknown> | undefined;
        const targetId = typeof projection?.targetId === "string" ? projection.targetId : "";
        if (!clip || !targetId) throw new Error("PROMPT_COMPILE_TARGET_MISMATCH: 当前 Clip 没有有效的正式制作编译基线");
        const target = { projectId };
        const recompileCurrentRevision = async (key: string, stale: PendingPromptCompile) => {
            if ((stale.staleRetries || 0) >= 1) {
                forgetPendingCompile(key);
                throw new Error("PROMPT_COMPILE_SOURCE_CHANGED: 制作稿连续变化，旧编译回执已作废；请在源稿稳定后重试。");
            }
            forgetPendingCompile(key);
            const loaded = await fetchProductionWorkbench(target, "clip_workbench", targetId);
            const production = loaded.production as Record<string, any>;
            if (String(production.workbench?.segment?.id || "") !== targetId) throw new Error("PROMPT_COMPILE_TARGET_MISMATCH: Backend 工作台返回了其他 Clip");
            const expectedRevision = Number(production.revision);
            if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error("PROMPT_COMPILE_REVISION_UNAVAILABLE: 无法读取当前制作版本");
            rememberPendingCompile(key, {
                expectedRevision, operationId: "compile-" + nanoid(14),
                staleRetries: (stale.staleRetries || 0) + 1, waitedMs: stale.waitedMs || 0,
            });
            return createProductionEditing(projectId, getNode, flush).compilePrompt(input);
        };
        const key = `${projectId}:${input.nodeId}:${input.segmentId}`;
        let pending = pendingPromptCompiles.get(key) || readPendingCompile(key);
        if (pending) pendingPromptCompiles.set(key, pending);
        let status: ProductionCompilationStatus;
        if (!pending) {
            const loaded = await fetchProductionWorkbench(target, "clip_workbench", targetId);
            const production = loaded.production as Record<string, any>;
            if (String(production.workbench?.segment?.id || "") !== targetId) throw new Error("PROMPT_COMPILE_TARGET_MISMATCH: Backend 工作台返回了其他 Clip");
            const expectedRevision = Number(production.revision);
            if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error("PROMPT_COMPILE_REVISION_UNAVAILABLE: 无法读取当前制作版本");
            pending = { expectedRevision, operationId: `compile-${nanoid(14)}` };
            rememberPendingCompile(key, pending);
        }
        try { status = (await compileProduction(target, pending.expectedRevision, pending.operationId, { targetIds: [targetId] })).compilation; }
        catch (error) {
            if (error instanceof BackendApiError && error.status === 409) return recompileCurrentRevision(key, pending);
            if (error instanceof BackendApiError && [400, 422].includes(error.status)) forgetPendingCompile(key);
            throw error;
        }
        let waitedMs = pending.waitedMs || 0, delayMs = 1200;
        const maxWaitMs = 600 * 1200;
        while (["queued", "running"].includes(status.status) && waitedMs < maxWaitMs) {
            await new Promise(resolve => setTimeout(resolve, Math.min(delayMs, maxWaitMs - waitedMs)));
            const waited = Math.min(delayMs, maxWaitMs - waitedMs);
            waitedMs += waited;
            pending = { ...pending, waitedMs };
            pendingPromptCompiles.set(key, pending);
            status = (await fetchProductionCompilation(target, pending.operationId)).compilation;
            delayMs = Math.min(5000, Math.ceil(delayMs * 1.6));
        }
        if (status.status === "succeeded" && status.verdict !== "blocked") {
            if (status.application?.revision === undefined) {
                if (!status.preparedId) throw new Error("PROMPT_COMPILE_PREPARED_MISSING: 编译成功但没有可应用回执");
                try { await applyProductionCompilation(target, status.preparedId); }
                catch (error) {
                    if (error instanceof BackendApiError && error.status === 409) {
                        return recompileCurrentRevision(key, pending);
                    }
                    throw error;
                }
            }
            const refreshed = await fetchProductionWorkbench(target, "clip_workbench", targetId);
            const workbench = (refreshed.production as Record<string, any>).workbench;
            if (String(workbench?.segment?.id || "") !== targetId || status.sourceHash && workbench?.sourceHash !== status.sourceHash) return recompileCurrentRevision(key, pending);
            const canvasInputs = Array.isArray(workbench?.runtime?.canvasInputs) ? workbench.runtime.canvasInputs : [];
            const canvasInput = canvasInputs.find((item: Record<string, any>) => item.nodeId === input.nodeId && item.segmentId === input.segmentId)
                || canvasInputs[0];
            const baselinePrompt = canvasInput?.directorBaseline?.prompt;
            const currentPrompt = canvasInput?.current?.prompt;
            const manualPrompt = Array.isArray(canvasInput?.manualFields) && canvasInput.manualFields.includes("prompt");
            const prompt = manualPrompt ? baselinePrompt : currentPrompt ?? baselinePrompt;
            if (typeof prompt !== "string") throw new Error("PROMPT_COMPILE_RESULT_UNAVAILABLE: 编译已应用，但没有读到该 Clip 的编译 Prompt");
            forgetPendingCompile(key);
            return { prompt };
        }
        if (["blocked", "interrupted", "failed", "succeeded"].includes(status.status)) {
            forgetPendingCompile(key);
            throw new Error(status.blockingDiagnostic?.message || `PROMPT_COMPILE_${status.status.toUpperCase()}: 编译未能生成可应用 Prompt`);
        }
        throw new Error("PROMPT_COMPILE_STILL_RUNNING: 编译仍在运行；再次点击会继续查询同一编译任务");
    }, replaceStoryboardTrack: async (input: CanvasProductionStoryboardEditor) => {
        await flush();
        let node = getNode(input.nodeId);
        let segments = node?.metadata?.segments;
        let clip = Array.isArray(segments) ? segments.find(item => item.id === input.segmentId) : undefined;
        let projection = clip?.productionClipProjection as Record<string, unknown> | undefined;
        if (!projection?.targetId) {
            const { project } = await fetchBackendProject(projectId);
            node = ((project.nodes as Array<Record<string, any>> | undefined)?.find(item => item.id === input.nodeId) as CanvasNodeData | undefined) || null;
            segments = node?.metadata?.segments;
            clip = Array.isArray(segments) ? segments.find(item => item.id === input.segmentId) : undefined;
            projection = clip?.productionClipProjection as Record<string, unknown> | undefined;
        }
        const nextProjection = (input.segment.productionClipProjection || {}) as Record<string, unknown>;
        if (!clip || typeof projection?.targetId !== "string" || nextProjection.targetId && nextProjection.targetId !== projection.targetId) throw new Error("STORYBOARD_PROJECTION_MISMATCH");
        const editor = storyboardEditors.get(projectId);
        if (!editor) throw new Error("PRODUCTION_EDITOR_NOT_READY");
        const result = await editor.handler({ ...input, segment: { ...input.segment, productionClipProjection: projection } }, clip);
        if (!result.sourceSaved) return result;
        // The production edit reprojects its authoritative Shot data to the H3 canvas.
        // Return that committed Clip so the caller can merge local-only Quick Storyboard
        // fields without replaying an older H3 projection over the new track.
        try {
            const { project: latestProject } = await fetchBackendProject(projectId);
            const latestNode = rows(latestProject.nodes).find(node => String(node.id || "") === input.nodeId);
            const latestSegment = rows(latestNode?.metadata?.segments).find(segment => String(segment.id || "") === input.segmentId);
            return latestSegment ? { ...result, segment: latestSegment } : result;
        } catch { return result; }
    }, setContinuationBoundary: async (input: ContinuationBoundaryInput) => {
        return setContinuationBoundaries({ nodeId: input.nodeId, boundaries: [{ segmentId: input.segmentId, tailFrameContinuation: input.tailFrameContinuation, motionContextEnabled: input.motionContextEnabled }] }, true);
    }, setContinuationBoundaries: async (input: ContinuationBoundariesInput) => setContinuationBoundaries(input, false) };

    async function setContinuationBoundaries(input: ContinuationBoundariesInput, requireNext: boolean) {
        await flush();
        const node = getNode(input.nodeId), segments = node?.metadata?.segments;
        if (!Array.isArray(segments)) throw new Error("CONTINUATION_BOUNDARY_PROJECTION_MISMATCH");
        const boundaries = input.boundaries.map(boundary => {
            const clip = segments.find(item => String(item.id || "") === boundary.segmentId);
            const projection = clip?.productionClipProjection as Record<string, unknown> | undefined;
            const targetId = typeof projection?.targetId === "string" ? projection.targetId : "";
            if (!clip || !targetId || typeof boundary.tailFrameContinuation !== "boolean" || typeof boundary.motionContextEnabled !== "boolean") throw new Error("CONTINUATION_BOUNDARY_PROJECTION_MISMATCH");
            return { targetId, tailFrameContinuation: boundary.tailFrameContinuation, motionContextEnabled: boundary.motionContextEnabled };
        });
        const editor = boundaryEditors.get(projectId);
        if (editor) return editor.handler({ boundaries, ...(requireNext ? { requireNext: true } : {}) });
        const context = (await fetchProductionCanvasContext(projectId)).context;
        const owner: ProductionTarget | undefined = context.owner?.kind === "episode" ? context.owner.id
            : context.owner?.kind === "scene" ? { sceneId: context.owner.id }
                : context.owner?.kind === "canvas" ? { projectId: context.owner.id } : undefined;
        if (!owner) throw new Error("PRODUCTION_EDITOR_NOT_READY");
        const production = (await fetchEpisodeProduction(owner)).production;
        const director = production.draft.director;
        const sourceSegments = Array.isArray(director?.source.segments) ? director.source.segments as Array<Record<string, unknown>> : [];
        if (!director || !sourceSegments.length) throw new Error("CONTINUATION_BOUNDARY_SOURCE_UNAVAILABLE");
        const operations: ProductionOperation[] = [];
        for (const boundary of boundaries) {
            const index = sourceSegments.findIndex(segment => String(segment.id || "") === boundary.targetId);
            // 节点级批量设置可能包含已从当前制作稿移除的旧投影；不能因此阻断有效边界。
            if (index < 0) {
                if (requireNext) throw new Error(`正式制作 Clip 不存在：${boundary.targetId}`);
                continue;
            }
            const next = sourceSegments[index + 1];
            if (!next) {
                if (requireNext) throw new Error("当前 H3 Clip 没有相邻的下一段，无法登记续段衔接");
                continue;
            }
            const to = String(next.id || "");
            if (!to) throw new Error("下一段缺少正式 Clip 标识，无法保存续段衔接");
            const previous = director.boundaries.find(edge => edge.from === boundary.targetId && edge.to === to);
            const canvasSegment = (Array.isArray(node?.metadata?.segments) ? node.metadata.segments : [])
                .find(segment => String((segment.productionClipProjection as Record<string, unknown> | undefined)?.targetId || "") === boundary.targetId);
            const projectionOutOfSync = canvasSegment && (
                canvasSegment.tailFrameContinuation !== boundary.tailFrameContinuation
                || canvasSegment.motionContextEnabled !== boundary.motionContextEnabled
            );
            if (previous?.tailFrame === boundary.tailFrameContinuation && previous?.motionContext === boundary.motionContextEnabled && previous.reason?.trim() && !projectionOutOfSync) continue;
            operations.push({ type: "set_director_boundary", boundary: {
                from: boundary.targetId, to, tailFrame: boundary.tailFrameContinuation, motionContext: boundary.motionContextEnabled,
                reason: "由 H3 Clip 设置保存续段衔接",
            } });
        }
        if (!operations.length) return { sourceSaved: true };
        await editEpisodeProduction(owner, production.revision, operations);
        return { sourceSaved: true };
    }
}
