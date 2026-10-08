import { canonicalProduction, directorProductionSchema, type DirectorProduction, type ProductionEdit } from "@basketikun/canvas-agent/drama/production-contract";
import { currentCompilationArtifact, compilationHash } from "@basketikun/canvas-agent/drama/compilation-scope";
import { ProductionValidationError } from "@basketikun/canvas-agent/drama/production-validation";

export const rows = (value: unknown): Record<string, any>[] => Array.isArray(value) ? value : [];
function reject(code: string, path: string, message: string): never {
    throw new ProductionValidationError([{ code, path, message, severity: "error" }]);
}
export function clipShots(d: DirectorProduction, id: string) {
    const segment = rows(d.source.segments).find(s => s.id === id);
    if (!segment) reject("CLIP_NOT_FOUND", "segmentId", `Segment ${id} 不存在`);
    const shots = (segment.shot_ids || []).map((shotId: string) => rows(d.source.shots).find(s => s.id === shotId));
    if (!shots.length || shots.some((s: unknown) => !s)) reject("CLIP_SHOTS_MISSING", `segments.${id}.shot_ids`, "Clip 镜头不完整");
    return { segment, shots: shots as Record<string, any>[] };
}
export function replaceDirectorClipStoryboard(d: DirectorProduction, op: { segmentId: string; segment: Record<string, unknown>; shots: Record<string, any>[]; shotInputs: Record<string, unknown> }) {
    const { segment, shots: old } = clipShots(d, op.segmentId), oldIds = new Set(old.map(s => s.id));
    if (op.segment.id !== segment.id || op.segment.start_frame !== segment.start_frame || op.segment.end_frame !== segment.end_frame)
        reject("CLIP_DURATION_CHANGED", `segments.${segment.id}`, "局部替换须保留 Segment 身份及起止帧");
    if (rows(d.source.segments).some(s => s.id !== segment.id && (s.shot_ids || []).some((id: string) => oldIds.has(id))))
        reject("CLIP_SHARED_SHOT", `segments.${segment.id}.shot_ids`, "镜头被其他 Clip 引用，请使用场次返修");
    const all = rows(d.source.shots), first = all.findIndex(s => s.id === old[0].id);
    if (all.slice(first, first + old.length).map(s => s.id).join() !== old.map(s => s.id).join()) reject("CLIP_SHOT_ORDER", "shots", "原镜头须连续且有序");
    const ids = new Set(op.shots.map(s => s.id)), scene = old[0].source_scene_id, timeline = old[0].timeline_id;
    if (ids.size !== op.shots.length || op.shots.some(s => !s.id || s.source_scene_id !== scene || s.timeline_id !== timeline || all.some(other => other.id === s.id && !oldIds.has(s.id))))
        reject("CLIP_SHOT_IDENTITY", "shots", "镜头 ID、场次或时间线无效");
    if (old.some(s => s.source_scene_id !== scene || s.timeline_id !== timeline)) reject("CLIP_CROSS_TIMELINE", "shots", "跨场次或时间线须使用场次返修");
    let cursor = segment.start_frame;
    for (const s of op.shots) {
        if (!Number.isInteger(s.start_frame) || !Number.isInteger(s.end_frame) || s.start_frame !== cursor || s.end_frame <= cursor) reject("CLIP_FRAME_WINDOW", `shots.${s.id}`, "镜头时间窗缺口或重叠");
        cursor = s.end_frame;
    }
    if (cursor !== segment.end_frame || (op.segment.shot_ids as string[] || []).join() !== op.shots.map(s => s.id).join()) reject("CLIP_COVERAGE", `segments.${segment.id}.shot_ids`, "新镜头须完整覆盖当前 Clip 一次");
    if (Object.keys(op.shotInputs).length !== ids.size || Object.keys(op.shotInputs).some(id => !ids.has(id))) reject("CLIP_INPUTS", "shotInputs", "输入须精确覆盖替换镜头");
    const next = structuredClone(d), startOrder = old[0].story_order, lastOrder = old.at(-1)!.story_order;
    const replacements = op.shots.map((s, i) => Number.isFinite(startOrder) ? { ...s, story_order: startOrder + i } : s);
    next.source.shots = [...all.slice(0, first), ...replacements, ...all.slice(first + old.length)].map(s =>
        timeline && !ids.has(s.id) && s.timeline_id === timeline && s.story_order > lastOrder ? { ...s, story_order: s.story_order + op.shots.length - old.length } : s);
    next.source.segments = rows(d.source.segments).map(s => s.id === segment.id ? op.segment : s);
    next.shotInputs = { ...Object.fromEntries(Object.entries(d.shotInputs).filter(([id]) => !oldIds.has(id))), ...op.shotInputs } as DirectorProduction["shotInputs"];
    next.sourceHash = compilationHash(next.source);
    next.artifacts = next.artifacts.map(a => currentCompilationArtifact(next, a) ? a : { ...a, status: "stale" });
    next.executionAuthorized = false;
    Object.assign(d, directorProductionSchema.parse(next));
}

/** Atomically replace an authored v2 Clip partition. Clip prompt fields never enter source. */
export function repartitionDirectorClips(d: DirectorProduction, op: { shotIds: string[]; segments: Record<string, any>[] }) {
    const allShots = rows(d.source.shots), allSegments = rows(d.source.segments);
    const selected = new Set(op.shotIds);
    if (selected.size !== op.shotIds.length) reject("CLIP_PARTITION_DUPLICATE_SHOT", "shotIds", "分组范围不能重复 Shot");
    const ordered = allShots.filter(shot => selected.has(String(shot.id)));
    if (ordered.length !== op.shotIds.length || ordered.some((shot, index) => String(shot.id) !== op.shotIds[index])) reject("CLIP_PARTITION_ORDER", "shotIds", "分组范围必须按正式 Shot 顺序连续提交");
    const first = allShots.findIndex(shot => selected.has(String(shot.id)));
    if (allShots.slice(first, first + ordered.length).some((shot, index) => String(shot.id) !== op.shotIds[index])) reject("CLIP_PARTITION_GAP", "shotIds", "分组范围不能跳过中间 Shot");
    const oldGroups = allSegments.filter(segment => (segment.shot_ids || []).some((id: string) => selected.has(id)));
    if (!oldGroups.length || oldGroups.some(segment => (segment.shot_ids || []).some((id: string) => !selected.has(id)))) reject("CLIP_PARTITION_SCOPE", "shotIds", "所选范围须完整覆盖受影响的旧 Clip");
    const oldIds = new Set(oldGroups.map(segment => String(segment.id)));
    const totalFrames = op.shotIds.reduce((sum, shotId) => sum + Number(allShots.find(shot => shot.id === shotId)!.duration_frames), 0);
    if (op.segments.reduce((sum, segment) => sum + (Array.isArray(segment.shot_ids) ? segment.shot_ids.length : 0), 0) !== op.shotIds.length) reject("CLIP_PARTITION_COVERAGE", "segments", "新分组必须完整覆盖所选 Shots");
    const createdIds = new Set<string>();
    const groups: Record<string, any>[] = [];
    let cursor = 0;
    for (const [index, raw] of op.segments.entries()) {
        const ids = Array.isArray(raw.shot_ids) ? raw.shot_ids.map(String) : [];
        if (!ids.length || ids.some((id, offset) => id !== op.shotIds[cursor + offset])) reject("CLIP_PARTITION_ORDER", `segments.${index}.shot_ids`, "新分组必须按源 Shot 顺序连续排列");
        cursor += ids.length;
        const matchingOld = oldGroups.find(segment => canonicalProduction(segment.shot_ids || []) === canonicalProduction(ids));
        const id = String(raw.id || matchingOld?.id || `SEG_${crypto.createHash("sha256").update(ids.join("\0")).digest("hex").slice(0, 20)}`);
        if (createdIds.has(id) || allSegments.some(segment => segment.id === id && !oldIds.has(id))) reject("CLIP_ID_CONFLICT", `segments.${index}.id`, `新 Clip ID 已被使用：${id}`);
        if (oldIds.has(id) && !matchingOld) reject("CLIP_ID_REUSE", `segments.${index}.id`, "覆盖范围改变时不能沿用旧 Clip ID");
        createdIds.add(id);
        const priorProfiles = oldGroups.filter(segment => (segment.shot_ids || []).some((shotId: string) => ids.includes(shotId))).map(segment => ({ mode: segment.mode, mode_lock: segment.mode_lock, mode_selection_reason: segment.mode_selection_reason, styleTemplateId: segment.styleTemplateId }));
        const sameProfile = priorProfiles.length > 0 && priorProfiles.every(profile => canonicalProduction(profile) === canonicalProduction(priorProfiles[0]));
        if (!sameProfile && !raw.mode) reject("CLIP_EXECUTION_PROFILE_CONFLICT", `segments.${index}.mode`, "组合了不同执行配置的旧 Clip；新分组必须明确选择 mode");
        const sourceFields = Object.fromEntries(Object.entries(raw).filter(([key]) => !["references", "subjects", "definition", "retention", "duration", "duration_frames", "start_frame", "end_frame", "summary", "overall_soundscape", "non_diegetic_music"].includes(key)));
        groups.push({ ...(matchingOld && sameProfile ? structuredClone(matchingOld) : {}), ...sourceFields, id, shot_ids: ids,
            mode: raw.mode || matchingOld?.mode, ...(sameProfile && raw.mode === undefined ? { mode_lock: matchingOld?.mode_lock, mode_selection_reason: matchingOld?.mode_selection_reason } : {}) });
    }
    if (cursor !== op.shotIds.length) reject("CLIP_PARTITION_COVERAGE", "segments", "新分组没有覆盖到所选范围末端");
    const firstSegment = Math.min(...oldGroups.map(segment => allSegments.findIndex(candidate => candidate.id === segment.id)));
    const replacement = [...allSegments.slice(0, firstSegment), ...groups, ...allSegments.slice(firstSegment).filter(segment => !oldIds.has(String(segment.id)))];
    const orderedSegmentIds = replacement.map(segment => String(segment.id));
    const oldEdges = new Map(d.boundaries.map(edge => [`${edge.from}\0${edge.to}`, edge]));
    const newBoundaries = replacement.slice(0, -1).map((segment, index) => {
        const from = String(segment.id), to = String(replacement[index + 1].id), old = oldEdges.get(`${from}\0${to}`);
        return old || { from, to, tailFrame: false, motionContext: false, reason: "New Clip partition boundary; continuity mode requires explicit review." };
    });
    const next = structuredClone(d);
    next.source.segments = replacement;
    next.boundaries = newBoundaries;
    next.sourceHash = compilationHash(next.source);
    next.artifacts = next.artifacts.map(artifact => oldIds.has(artifact.targetId) ? { ...artifact, status: "stale" } : artifact);
    next.executionAuthorized = false;
    Object.assign(d, directorProductionSchema.parse(next));
    return { previousIds: [...oldIds], currentIds: groups.map(segment => String(segment.id)), totalFrames };
}

/** Check the completed batch so continuity patches can repair deleted-shot references. */
export function assertClipEdit(before: DirectorProduction, after: DirectorProduction, input: ProductionEdit, segmentId: string) {
    const left = clipShots(before, segmentId), right = clipShots(after, segmentId);
    const allowed = new Set([...left.shots, ...right.shots].map(s => s.id));
    for (const op of input.ops) {
        const valid = op.type === "request_director_clip_refresh" && op.segmentId === segmentId
            || op.type === "replace_director_clip_storyboard" && op.segmentId === segmentId
            || op.type === "patch_director_source" && (op.entity === "shot" && allowed.has(op.id) || op.entity === "segment" && op.id === segmentId)
            || op.type === "patch_director_continuity";
        if (!valid) reject("CLIP_EDIT_SCOPE", "request.ops", "自动刷新仅接受当前 Clip 的镜头、Segment 和关联连续性修改");
    }
    if (left.segment.start_frame !== right.segment.start_frame || left.segment.end_frame !== right.segment.end_frame) reject("CLIP_DURATION_CHANGED", `segments.${segmentId}`, "自动刷新不能改变 Clip 起止帧");
    const stripOrder = (s: Record<string, any>) => { const { story_order: _, ...rest } = s; return rest; };
    if (canonicalProduction(rows(before.source.shots).filter(s => !allowed.has(s.id)).map(stripOrder)) !== canonicalProduction(rows(after.source.shots).filter(s => !allowed.has(s.id)).map(stripOrder))) reject("CLIP_EDIT_SCOPE", "shots", "修改越过当前 Clip");
    for (const field of ["events", "requirements", "coverage", "facts", "initial", "timelines"]) {
        const local = (r: Record<string, any>) => allowed.has(r.shot_id) || (r.shot_ids || []).length > 0 && r.shot_ids.every((id: string) => allowed.has(id));
        const a = rows((before.source.ledger as any)?.[field]), b = rows((after.source.ledger as any)?.[field]);
        if (canonicalProduction(a.filter(r => !local(r))) !== canonicalProduction(b.filter(r => !local(r)))) reject("CLIP_CONTINUITY_SCOPE", `ledger.${field}`, "连续性修改越过本段；请使用场次返修");
    }
    const validIds = new Set(rows(after.source.shots).map(s => s.id)), deleted = new Set(left.shots.filter(s => !validIds.has(s.id)).map(s => s.id));
    const visit = (value: unknown, path: string) => {
        if (Array.isArray(value)) value.forEach((v, i) => visit(v, `${path}.${i}`));
        else if (value && typeof value === "object") for (const [key, v] of Object.entries(value)) {
            if ((key === "shot_id" && deleted.has(v) || key === "shot_ids" && Array.isArray(v) && v.some(id => deleted.has(id)))) reject("CLIP_DANGLING_SHOT", `${path}.${key}`, "同批修复删除镜头的引用");
            visit(v, `${path}.${key}`);
        }
    };
    visit(after.source, "source");
}
