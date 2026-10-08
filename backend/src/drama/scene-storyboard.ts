import { canonicalProduction, directorProductionSchema, type DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";
import { currentCompilationArtifact } from "@basketikun/canvas-agent/drama/compilation-scope";
import crypto from "node:crypto";

type Row = Record<string, any>;
type Replacement = { sceneId: string; shots: Row[]; segments: Row[]; shotInputs: Record<string, unknown> };
export function replaceDirectorSceneStoryboard(director: DirectorProduction, op: Replacement) {
    const rows = (value: unknown): Row[] => Array.isArray(value) ? value : [];
    const oldShots = rows(director.source.shots), oldSegments = rows(director.source.segments);
    const owned = oldShots.filter(shot => shot.source_scene_id === op.sceneId);
    if (!owned.length) throw new Error("SCENE_STORYBOARD_NOT_FOUND: 未登记场次镜头");
    const oldIds = new Set(owned.map(shot => shot.id));
    const ownedSegments = oldSegments.filter(segment => segment.shot_ids?.some((id: string) => oldIds.has(id)));
    if (ownedSegments.some(segment => segment.shot_ids.some((id: string) => !oldIds.has(id)))) throw new Error("SCENE_STORYBOARD_SCOPE: Segment 跨场次");
    const first = oldShots.findIndex(shot => oldIds.has(shot.id));
    if (oldShots.slice(first, first + owned.length).some(shot => !oldIds.has(shot.id))) throw new Error("SCENE_STORYBOARD_SCOPE: 场次镜头须连续");
    const segmentIds = new Set(ownedSegments.map(segment => segment.id));
    const newIds = new Set(op.shots.map(shot => shot.id));
    if (newIds.size !== op.shots.length || op.shots.some(shot => !shot.id || shot.source_scene_id !== op.sceneId || oldShots.some(old => old.id === shot.id && !oldIds.has(old.id)))) throw new Error("SCENE_STORYBOARD_SCOPE: 镜头身份或归属无效");
    if (op.segments.length !== segmentIds.size || new Set(op.segments.map(segment => segment.id)).size !== segmentIds.size || op.segments.some(segment => !segmentIds.has(segment.id))) throw new Error("SCENE_STORYBOARD_SEGMENTS: 须保留原场次 Segment ID");
    let cursor = owned[0].start_frame;
    for (const shot of op.shots) {
        if (!Number.isInteger(shot.start_frame) || !Number.isInteger(shot.end_frame) || shot.start_frame !== cursor || shot.end_frame <= cursor) throw new Error("SCENE_STORYBOARD_FRAMES: Shot 时间窗缺口或重叠");
        cursor = shot.end_frame;
    }
    if (cursor !== owned.at(-1)!.end_frame) throw new Error("SCENE_STORYBOARD_DURATION: 场次起止帧不可改变");
    const covered: string[] = [];
    for (const segment of op.segments) {
        if (!Array.isArray(segment.shot_ids) || !segment.shot_ids.length || segment.shot_ids.some((id: string) => !newIds.has(id))) throw new Error("SCENE_STORYBOARD_COVERAGE: Segment 引用越界");
        const selected = segment.shot_ids.map((id: string) => op.shots.find(shot => shot.id === id)!);
        if (segment.start_frame !== selected[0].start_frame || segment.end_frame !== selected.at(-1)!.end_frame) throw new Error("SCENE_STORYBOARD_COVERAGE: Segment 帧窗与镜头不符");
        covered.push(...segment.shot_ids);
    }
    if (covered.join("\0") !== op.shots.map(shot => shot.id).join("\0")) throw new Error("SCENE_STORYBOARD_COVERAGE: 镜头必须按序完整覆盖一次");
    if (Object.keys(op.shotInputs).length !== newIds.size || Object.keys(op.shotInputs).some(id => !newIds.has(id))) throw new Error("SCENE_STORYBOARD_INPUTS: 输入须精确覆盖本场镜头");
    const next = structuredClone(director);
    const firstShot = oldShots.findIndex(shot => oldIds.has(shot.id));
    next.source.shots = [...oldShots.slice(0, firstShot), ...op.shots, ...oldShots.slice(firstShot).filter(shot => !oldIds.has(shot.id))];
    const timelines = new Set(op.shots.map(shot => shot.timeline_id).filter(Boolean));
    for (const timeline of timelines) {
        const previous = owned.filter(shot => shot.timeline_id === timeline);
        const replacement = op.shots.filter(shot => shot.timeline_id === timeline);
        const firstOrder = Math.min(...previous.map(shot => shot.story_order));
        const lastOrder = Math.max(...previous.map(shot => shot.story_order));
        const replacementOrder = new Map(replacement.map((shot, index) => [shot.id, firstOrder + index]));
        const delta = replacement.length - previous.length;
        next.source.shots = rows(next.source.shots).map(shot => replacementOrder.has(shot.id) ? { ...shot, story_order: replacementOrder.get(shot.id) }
            : shot.timeline_id === timeline && shot.story_order > lastOrder ? { ...shot, story_order: shot.story_order + delta } : shot);
    }
    const firstSegment = oldSegments.findIndex(segment => segmentIds.has(segment.id));
    next.source.segments = [...oldSegments.slice(0, firstSegment), ...op.segments, ...oldSegments.slice(firstSegment).filter(segment => !segmentIds.has(segment.id))];
    const orderedSegments = [...ownedSegments];
    const internalEdges = new Set(orderedSegments.slice(0, -1).map((segment, index) => `${segment.id}\0${orderedSegments[index + 1].id}`));
    next.boundaries = next.boundaries.map(edge => internalEdges.has(`${edge.from}\0${edge.to}`)
        ? { ...edge, tailFrame: false, motionContext: false, reason: "Separate authored Shot coverage changes camera or viewpoint; carry no latent frames across this edge." }
        : edge);
    next.shotInputs = { ...Object.fromEntries(Object.entries(next.shotInputs).filter(([id]) => !oldIds.has(id))), ...op.shotInputs } as DirectorProduction["shotInputs"];
    next.sourceHash = crypto.createHash("sha256").update(canonicalProduction(next.source)).digest("hex");
    next.artifacts = next.artifacts.map(artifact => currentCompilationArtifact(next, artifact) ? artifact : { ...artifact, status: "stale" });
    next.executionAuthorized = false;
    Object.assign(director, directorProductionSchema.parse(next));
}
