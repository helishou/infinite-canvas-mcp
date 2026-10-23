import { canonicalProduction, directorProductionSchema, isSubjectPromptAssembly, productionSceneEntries, type DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { currentCompilationArtifact } from "@basketikun/canvas-agent/drama/compilation-scope";
import crypto from "node:crypto";
import { defaultDirectorBoundary } from "./continuity-defaults.js";
import { removeShotContent } from "./shot-edit.js";

type Row = Record<string, any>;
type Replacement = { sceneId: string; shots: Row[]; segments: Row[]; shotInputs: Record<string, unknown> };
const AUTO_BOUNDARY_REASONS = new Set([
    "Separate authored Shot coverage changes camera or viewpoint; carry no latent frames across this edge.",
    "默认引用前段尾帧承接下一 Clip 的动作与场景状态；Motion Context 保持关闭。",
    "目标 Clip 已有明确首帧分镜图，沿用该首帧。",
]);
const rows = (value: unknown): Row[] => Array.isArray(value)
    ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as Row[]
    : [];
const ids = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : [];
const timelineOf = (shot: Row) => String(shot.timeline_id || "main");
function reject(code: string, message: string): never {
    throw new Error(`${code}: ${message}`);
}

/**
 * Register or replace one script scene's formal Shots and Clips in a single source revision.
 * An empty scene uses the same operation to bootstrap its first storyboard. Prompt v2 derives
 * global frame windows from duration, timeline and story_order, so the Scene owns no frame range.
 */
export function replaceDirectorSceneStoryboard(director: DirectorProduction, op: Replacement) {
    if (!isSubjectPromptAssembly(director.source)) reject("SUBJECT_SOURCE_VERSION_REQUIRED", "场次分镜登记仅用于 Subject Prompt v2 制作稿");
    const next = structuredClone(director);
    const source = next.source as Row;
    const oldShots = rows(source.shots), oldSegments = rows(source.segments);
    const entries = productionSceneEntries(source);
    const sceneIndex = entries.findIndex(entry => entry.id === op.sceneId);
    if (sceneIndex < 0) reject("SCENE_STORYBOARD_SCENE_NOT_FOUND", `剧本场次未登记：${op.sceneId}`);
    const scene = entries[sceneIndex], ownedIds = new Set(scene.shotIds.map(String));
    const ownedShots = oldShots.filter(shot => ownedIds.has(String(shot.id)));
    const ownedSegments = oldSegments.filter(segment => ids(segment.shot_ids).some(id => ownedIds.has(id)));
    if (ownedSegments.some(segment => ids(segment.shot_ids).some(id => !ownedIds.has(id)))) reject("SCENE_STORYBOARD_SCOPE", "场次 Clip 跨场次");
    if (ownedShots.length) {
        const first = oldShots.findIndex(shot => ownedIds.has(String(shot.id)));
        if (oldShots.slice(first, first + ownedShots.length).some(shot => !ownedIds.has(String(shot.id)))) reject("SCENE_STORYBOARD_SCOPE", "场次镜头须连续");
        const clipped = new Set(ownedSegments.flatMap(segment => ids(segment.shot_ids)));
        if (clipped.size !== ownedIds.size || [...ownedIds].some(id => !clipped.has(id))) reject("SCENE_STORYBOARD_SCOPE", "场次镜头须完整归属本场 Clip");
    }

    const newShots = structuredClone(op.shots) as Row[];
    const newIds = new Set(newShots.map(shot => String(shot.id || "")));
    if (newIds.size !== newShots.length || newIds.has("")) reject("SCENE_STORYBOARD_SHOTS", "镜头 ID 必须唯一且非空");
    for (const shot of newShots) {
        const id = String(shot.id);
        if (oldShots.some(old => String(old.id) === id && !ownedIds.has(id))) reject("SCENE_STORYBOARD_SHOTS", `镜头 ID 已被其他场次使用：${id}`);
        if (Object.hasOwn(shot, "start_frame") || Object.hasOwn(shot, "end_frame") || !Number.isInteger(shot.duration_frames) || Number(shot.duration_frames) <= 0) {
            reject("SCENE_STORYBOARD_FRAMES", `Prompt v2 镜头须使用正整数 duration_frames：${id}`);
        }
        if (shot.scene_id !== undefined && String(shot.scene_id) !== String(scene.environmentId)) reject("SCENE_STORYBOARD_SHOTS", `镜头环境与场次不一致：${id}`);
        if (shot.scene_id === undefined) shot.scene_id = scene.environmentId;
    }

    const ownedTimelines = new Set(ownedShots.map(timelineOf));
    if (ownedTimelines.size > 1) reject("SCENE_STORYBOARD_TIMELINE", "原场次镜头跨叙事时间线");
    const suppliedTimelines = new Set(newShots.filter(shot => shot.timeline_id !== undefined).map(timelineOf));
    if (suppliedTimelines.size > 1) reject("SCENE_STORYBOARD_TIMELINE", "新镜头不可跨叙事时间线");
    const timeline = ownedTimelines.size ? [...ownedTimelines][0] : [...suppliedTimelines][0] || "main";
    for (const shot of newShots) {
        if (shot.timeline_id !== undefined && String(shot.timeline_id) !== timeline) reject("SCENE_STORYBOARD_TIMELINE", `新镜头须沿用场次时间线 ${timeline}：${shot.id}`);
        shot.timeline_id = timeline;
    }

    let insertShotIndex: number, baseOrder: number, shiftFrom: number;
    if (ownedShots.length) {
        insertShotIndex = oldShots.findIndex(shot => ownedIds.has(String(shot.id)));
        const orders = ownedShots.map(shot => Number(shot.story_order));
        if (orders.some(order => !Number.isInteger(order) || order < 0)) reject("SCENE_STORYBOARD_TIMELINE", "原场次镜头缺少有效 story_order");
        baseOrder = orders[0];
        if (orders.some((order, index) => order !== baseOrder + index)) reject("SCENE_STORYBOARD_TIMELINE", "原场次镜头 story_order 不连续");
        shiftFrom = baseOrder + ownedShots.length;
    } else {
        const previousScene = [...entries].slice(0, sceneIndex).reverse().find(entry => entry.shotIds.length);
        insertShotIndex = previousScene ? oldShots.findIndex(shot => String(shot.id) === String(previousScene.shotIds.at(-1))) + 1 : 0;
        let previousOrder: number | undefined;
        for (let index = insertShotIndex - 1; index >= 0; index--) if (timelineOf(oldShots[index]) === timeline) {
            const order = Number(oldShots[index].story_order);
            if (!Number.isInteger(order) || order < 0) reject("SCENE_STORYBOARD_TIMELINE", "相邻镜头缺少有效 story_order");
            previousOrder = order;
            break;
        }
        if (previousOrder !== undefined) {
            baseOrder = previousOrder + 1;
            shiftFrom = baseOrder;
        } else {
            let nextOrder: number | undefined;
            for (let index = insertShotIndex; index < oldShots.length; index++) if (timelineOf(oldShots[index]) === timeline) {
                const order = Number(oldShots[index].story_order);
                if (!Number.isInteger(order) || order < 0) reject("SCENE_STORYBOARD_TIMELINE", "相邻镜头缺少有效 story_order");
                nextOrder = order;
                break;
            }
            baseOrder = nextOrder ?? 0;
            shiftFrom = baseOrder;
        }
    }
    const delta = newShots.length - ownedShots.length;
    if (delta !== 0) for (const shot of oldShots) {
        if (ownedIds.has(String(shot.id)) || timelineOf(shot) !== timeline) continue;
        const order = Number(shot.story_order);
        if (!Number.isInteger(order) || order < 0) reject("SCENE_STORYBOARD_TIMELINE", "相邻镜头缺少有效 story_order");
        if (order >= shiftFrom) shot.story_order = order + delta;
    }
    newShots.forEach((shot, index) => { shot.story_order = baseOrder + index; });

    const remainingShots = oldShots.filter(shot => !ownedIds.has(String(shot.id)));
    const nextShotArray = [...remainingShots.slice(0, insertShotIndex), ...newShots, ...remainingShots.slice(insertShotIndex)];
    const mapped = productionSceneEntries({ ...source, shots: nextShotArray } as Record<string, unknown>);
    const target = mapped.find(entry => entry.id === op.sceneId);
    if (!target || target.shotIds.length !== newShots.length || target.shotIds.some(id => !newIds.has(String(id)))) {
        reject("SCENE_STORYBOARD_SHOTS", "新镜头须明确归属本场次；请填写 source_scene_id 或唯一环境／节拍");
    }
    if (mapped.some(entry => entry.id !== op.sceneId && entry.shotIds.some(id => newIds.has(String(id))))) reject("SCENE_STORYBOARD_SHOTS", "新镜头同时归属其他场次");

    const newSegments = structuredClone(op.segments) as Row[];
    const newSegmentIds = new Set(newSegments.map(segment => String(segment.id || "")));
    if (newSegmentIds.size !== newSegments.length || newSegmentIds.has("")) reject("SCENE_STORYBOARD_SEGMENTS", "Clip ID 必须唯一且非空");
    if (ownedShots.length) {
        const oldSegmentIds = new Set(ownedSegments.map(segment => String(segment.id)));
        if (newSegmentIds.size !== oldSegmentIds.size || [...newSegmentIds].some(id => !oldSegmentIds.has(id))) {
            reject("SCENE_STORYBOARD_SEGMENTS", "已有场次须保留原 Clip ID 集合；调整 Clip 分组请使用 repartition_director_clips");
        }
        const first = oldSegments.findIndex(segment => oldSegmentIds.has(String(segment.id)));
        if (oldSegments.slice(first, first + ownedSegments.length).some(segment => !oldSegmentIds.has(String(segment.id)))) reject("SCENE_STORYBOARD_SEGMENTS", "场次 Clip 须连续");
    } else for (const id of newSegmentIds) if (oldSegments.some(segment => String(segment.id) === id)) reject("SCENE_STORYBOARD_SEGMENTS", `Clip ID 已存在：${id}`);

    const covered: string[] = [], positions = new Map(nextShotArray.map((shot, index) => [String(shot.id), index]));
    for (const segment of newSegments) {
        if (["start_frame", "end_frame", "duration_frames", "generation_clip_duration"].some(field => Object.hasOwn(segment, field))) {
            reject("SCENE_STORYBOARD_SEGMENTS", "Prompt v2 Clip 时长由 Shot 时长求和派生，不保存帧窗字段");
        }
        const segmentShotIds = ids(segment.shot_ids);
        if (!segmentShotIds.length || segmentShotIds.some(id => !newIds.has(id))) reject("SCENE_STORYBOARD_COVERAGE", "Clip 镜头引用越界");
        const sequence = segmentShotIds.map(id => positions.get(id) ?? -1);
        if (sequence.some((position, index) => position < 0 || index > 0 && position !== sequence[index - 1] + 1)) reject("SCENE_STORYBOARD_COVERAGE", "Clip 内镜头须按源稿顺序连续排列");
        covered.push(...segmentShotIds);
    }
    if (covered.join("\0") !== newShots.map(shot => String(shot.id)).join("\0")) reject("SCENE_STORYBOARD_COVERAGE", "本场镜头必须按序完整归属 Clip 一次");
    if (Object.keys(op.shotInputs).length !== newIds.size || Object.keys(op.shotInputs).some(id => !newIds.has(id))) reject("SCENE_STORYBOARD_INPUTS", "输入须精确覆盖本场镜头");

    let insertSegmentIndex: number;
    if (ownedShots.length) {
        insertSegmentIndex = oldSegments.findIndex(segment => newSegmentIds.has(String(segment.id)));
    } else {
        const firstPosition = positions.get(String(newShots[0].id)) ?? 0;
        const at = oldSegments.findIndex(segment => {
            const firstShot = ids(segment.shot_ids)[0];
            return firstShot !== undefined && (positions.get(String(firstShot)) ?? Number.POSITIVE_INFINITY) >= firstPosition;
        });
        insertSegmentIndex = at < 0 ? oldSegments.length : at;
    }
    const remainingSegments = oldSegments.filter(segment => !newSegmentIds.has(String(segment.id)));
    const nextSegmentArray = [...remainingSegments.slice(0, insertSegmentIndex), ...newSegments, ...remainingSegments.slice(insertSegmentIndex)];

    const removedIds = new Set([...ownedIds].filter(id => !newIds.has(id)));
    if (removedIds.size) removeShotContent(source, removedIds);
    source.shots = nextShotArray;
    source.segments = nextSegmentArray;
    for (const id of ownedIds) delete next.shotInputs[id];
    Object.assign(next.shotInputs, structuredClone(op.shotInputs));
    const oldEdges = new Map(next.boundaries.map(edge => [`${edge.from}\0${edge.to}`, edge] as const));
    next.boundaries = nextSegmentArray.slice(0, -1).map((segment, index) => {
        const from = String(segment.id), to = String(nextSegmentArray[index + 1].id);
        const previous = oldEdges.get(`${from}\0${to}`);
        if (previous && !AUTO_BOUNDARY_REASONS.has(String(previous.reason || ""))) return previous;
        const authored = defaultDirectorBoundary(next, from, to, { destination: nextSegmentArray[index + 1], shotInputs: next.shotInputs, shots: nextShotArray });
        return previous ? { ...previous, tailFrame: authored.tailFrame, motionContext: false, reason: authored.reason } : authored;
    });
    next.sourceHash = crypto.createHash("sha256").update(canonicalProduction(next.source)).digest("hex");
    next.artifacts = next.artifacts.map(artifact => currentCompilationArtifact(next, artifact) ? artifact : { ...artifact, status: "stale" });
    next.executionAuthorized = false;
    Object.assign(director, directorProductionSchema.parse(next));
}
