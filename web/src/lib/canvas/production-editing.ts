import type { CanvasNodeData } from "@/types/canvas";
import type { CanvasProductionEditing, CanvasProductionStoryboardEditor } from "@/types/canvas-plugin";
import { productionSceneEntries, type DirectorProduction, type ProductionOperation } from "@basketikun/canvas-agent/drama/production-contract";
import { nanoid } from "nanoid";
import { applyProductionCompilation, BackendApiError, compileProduction, fetchProductionCompilation, fetchProductionWorkbench, type ProductionCompilationStatus } from "@/services/backend-api";

type Input = Parameters<CanvasProductionEditing["reverseSyncPrompt"]>[0];
type Handler = CanvasProductionEditing["reverseSyncPrompt"];
type StoryboardHandler = CanvasProductionEditing["replaceStoryboardTrack"];
type CompilePromptInput = Parameters<CanvasProductionEditing["compilePrompt"]>[0];
// Capability routing only: edits still use the production editor's existing persistent command journal.
const editors = new Map<string, { token: symbol; handler: Handler }>();
const storyboardEditors = new Map<string, { token: symbol; handler: StoryboardHandler }>();
const pendingPromptCompiles = new Map<string, { expectedRevision: number; operationId: string }>();
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

export function sourceSegmentForCanvasClip(groups: Array<{ id: string; nodeId: string | null; segmentId: string | null }>, nodeId: string, segmentId: string) {
    const group = groups.find(group => group.nodeId === nodeId && group.segmentId === segmentId);
    if (!group) throw new Error("PROMPT_REVERSE_SYNC_TARGET_MISMATCH");
    return group.id;
}

export function buildDirectorClipStoryboardOperation(director: DirectorProduction, groupId: string, input: CanvasProductionStoryboardEditor): ProductionOperation {
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
    if (!storyboard.length) throw new Error("SHOT_LAST_IN_CLIP: Clip 至少保留一个正式镜头；删除整个 Clip 才能移除最后一镜");
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
        } else {
            const template = existing || oldShots[0];
            next = { ...structuredClone(template), id: String(slot.id), start_frame: cursor, end_frame: cursor + frameCounts[index],
                ...(Number.isInteger(template.story_order) ? { story_order: firstOrder + index } : {}) };
        }
        const bindingId = String(slot.referenceBindingId || "");
        let keyframeAssetId: string | undefined;
        if (bindingId) {
            const binding = refs.find(ref => String(ref.id || ref.bindingId || "") === bindingId);
            if (!binding || binding.mediaType && binding.mediaType !== "image" || binding.role && binding.role !== "storyboard") throw new Error(`STORYBOARD_BINDING_INVALID: 分镜格 ${slot.id} 引用了无效图片`);
            const match = Object.entries(director.assets).find(([assetId, asset]) => asset.storageKey === binding.storageKey
                && (!binding.sourceNodeId || asset.nodeId === binding.sourceNodeId) && (source.asset_plan as Array<Record<string, any>> || []).some(assetPlan => String(assetPlan.asset_id || assetPlan.id) === assetId));
            if (!match) throw new Error(`STORYBOARD_ASSET_NOT_ADOPTED: 图片 ${binding.storageKey || bindingId} 尚未绑定为正式制作资产`);
            keyframeAssetId = match[0];
        }
        shots.push(next);
        shotInputs[String(slot.id)] = keyframeAssetId
            ? { ...(director.shotInputs[String(slot.id)] || {}), keyframePolicy: "reuse", assetIds: [...new Set([...(director.shotInputs[String(slot.id)]?.assetIds || []), keyframeAssetId])], keyframeAssetId }
            : { keyframePolicy: "none", assetIds: [] };
        cursor += frameCounts[index];
    }
    if (!v2 && cursor !== endFrame) throw new Error("STORYBOARD_COVERAGE: 分镜格未覆盖整个 Clip");
    const segment = { ...structuredClone(planned), shot_ids: shots.map(shot => shot.id) };
    return { type: "replace_director_clip_storyboard", segmentId: groupId, segment, shots, shotInputs };
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
        const key = `${projectId}:${input.nodeId}:${input.segmentId}`;
        let pending = pendingPromptCompiles.get(key);
        let status: ProductionCompilationStatus;
        if (!pending) {
            const loaded = await fetchProductionWorkbench(target, "clip_workbench", targetId);
            const production = loaded.production as Record<string, any>;
            if (String(production.clipWorkbench?.segment?.id || "") !== targetId) throw new Error("PROMPT_COMPILE_TARGET_MISMATCH: Backend 工作台返回了其他 Clip");
            const expectedRevision = Number(production.revision);
            if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error("PROMPT_COMPILE_REVISION_UNAVAILABLE: 无法读取当前制作版本");
            pending = { expectedRevision, operationId: `compile-${nanoid(14)}` };
            pendingPromptCompiles.set(key, pending);
        }
        try { status = (await compileProduction(target, pending.expectedRevision, pending.operationId, { targetIds: [targetId] })).compilation; }
        catch (error) { if (error instanceof BackendApiError && [400, 409, 422].includes(error.status)) pendingPromptCompiles.delete(key); throw error; }
        let waitedMs = 0, delayMs = 1200;
        const maxWaitMs = 600 * 1200;
        while (["queued", "running"].includes(status.status) && waitedMs < maxWaitMs) {
            await new Promise(resolve => setTimeout(resolve, Math.min(delayMs, maxWaitMs - waitedMs)));
            const waited = Math.min(delayMs, maxWaitMs - waitedMs);
            waitedMs += waited;
            status = (await fetchProductionCompilation(target, pending.operationId)).compilation;
            delayMs = Math.min(5000, Math.ceil(delayMs * 1.6));
        }
        if (status.status === "succeeded" && status.verdict !== "blocked") {
            if (status.application?.revision === undefined) {
                if (!status.preparedId) throw new Error("PROMPT_COMPILE_PREPARED_MISSING: 编译成功但没有可应用回执");
                await applyProductionCompilation(target, status.preparedId);
            }
            const refreshed = await fetchProductionWorkbench(target, "clip_workbench", targetId);
            const workbench = (refreshed.production as Record<string, any>).clipWorkbench;
            if (String(workbench?.segment?.id || "") !== targetId || status.sourceHash && workbench?.sourceHash !== status.sourceHash) throw new Error("PROMPT_COMPILE_SOURCE_CHANGED: 编译完成后制作源稿已变化，请重新编译");
            const canvasInput = (Array.isArray(workbench?.canvasInputs) ? workbench.canvasInputs : []).find((item: Record<string, any>) => item.nodeId === input.nodeId && item.segmentId === input.segmentId)
                || (Array.isArray(workbench?.canvasInputs) ? workbench.canvasInputs[0] : undefined);
            const baselinePrompt = canvasInput?.directorBaseline?.prompt;
            const currentPrompt = canvasInput?.current?.prompt;
            const manualPrompt = Array.isArray(canvasInput?.manualFields) && canvasInput.manualFields.includes("prompt");
            const prompt = manualPrompt ? baselinePrompt : currentPrompt ?? baselinePrompt;
            if (typeof prompt !== "string") throw new Error("PROMPT_COMPILE_RESULT_UNAVAILABLE: 编译已应用，但没有读到该 Clip 的编译 Prompt");
            pendingPromptCompiles.delete(key);
            return { prompt };
        }
        if (["blocked", "interrupted", "failed", "succeeded"].includes(status.status)) {
            pendingPromptCompiles.delete(key);
            throw new Error(status.blockingDiagnostic?.message || `PROMPT_COMPILE_${status.status.toUpperCase()}: 编译未能生成可应用 Prompt`);
        }
        throw new Error("PROMPT_COMPILE_STILL_RUNNING: 编译仍在运行；再次点击会继续查询同一编译任务");
    }, replaceStoryboardTrack: async (input: CanvasProductionStoryboardEditor) => {
        await flush();
        const node = getNode(input.nodeId), segments = node?.metadata?.segments;
        const clip = Array.isArray(segments) ? segments.find(item => item.id === input.segmentId) : undefined;
        const projection = clip?.productionClipProjection as Record<string, unknown> | undefined;
        const nextProjection = (input.segment.productionClipProjection || {}) as Record<string, unknown>;
        if (!clip || typeof projection?.targetId !== "string" || nextProjection.targetId !== projection.targetId) throw new Error("STORYBOARD_PROJECTION_MISMATCH");
        const editor = storyboardEditors.get(projectId);
        if (!editor) throw new Error("PRODUCTION_EDITOR_NOT_READY");
        return editor.handler(input);
    } };
}
