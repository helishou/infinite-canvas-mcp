import crypto from "node:crypto";
import { canonicalProduction, directorProductionSchema, isSubjectPromptAssembly, type DirectorProduction, type ProductionOperation } from "@basketikun/canvas-agent/drama/production-contract";
import { ProductionValidationError } from "@basketikun/canvas-agent/drama/production-validation";
import { subjectShotWindows } from "@basketikun/canvas-agent/drama/subject-assembly";
import { currentCompilationArtifact } from "@basketikun/canvas-agent/drama/compilation-scope";

type Row = Record<string, any>;
type Edit = Extract<ProductionOperation, { type: "edit_director_shot" }>;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value : [];
function reject(code: string, path: string, message: string): never { throw new ProductionValidationError([{ code, path, targetId: path.split(".")[1], message, severity: "error" }]); }
const clip = (source: Row, id: string) => rows(source.segments).find(segment => (segment.shot_ids || []).includes(id));
const patchFields = new Set(["title", "visual", "camera", "audio", "performance", "subject_usages"]);
function patch(shot: Row, value?: Row) {
    if (!value) return;
    for (const key of Object.keys(value)) if (!patchFields.has(key)) reject("SHOT_PATCH_FIELD", `shots.${shot.id}.${key}`, "拆镜补丁只接受名称、画面、摄影、声音和表演字段");
    Object.assign(shot, value);
}
function sound(source: Row) {
    const windows = subjectShotWindows(source), order = rows(source.utterances).map(utterance => {
        const start = windows.get(utterance.start?.shotId), end = windows.get(utterance.end?.shotId);
        return { id: utterance.id, text: utterance.text, timeline: start?.timelineId, start: Number(start?.startFrame) + Number(utterance.start?.localFrame), duration: Number(end?.startFrame) + Number(utterance.end?.localFrame) - Number(start?.startFrame) - Number(utterance.start?.localFrame) };
    });
    return order.sort((a, b) => String(a.timeline).localeCompare(String(b.timeline)) || a.start - b.start).map(({ start, ...value }) => value);
}
function sliceUsages(shot: Row, start: number, end: number) {
    return rows(shot.subject_usages).flatMap(usage => {
        const from = Math.max(start, Number(usage.localStartFrame ?? 0)), to = Math.min(end, Number(usage.localEndFrame ?? shot.duration_frames));
        return to > from ? [{ ...usage, localStartFrame: from - start, localEndFrame: to - start }] : [];
    });
}
function slicePerformance(value: Row | undefined, start: number, end: number, category = "动作") {
    if (!value || !Array.isArray(value.events)) return value;
    return { ...value, events: rows(value.events).flatMap(event => {
        if (!Number.isInteger(event.start) || !Number.isInteger(event.end)) reject("SHOT_PERFORMANCE_TIME", "shots.performance.events", "定时表演须使用本镜整数帧 start/end");
        const from = Math.max(start, event.start), to = Math.min(end, event.end);
        return to > from ? [{ ...event, start: from - start, end: to - start, ...(event.start < start && typeof event.cue === "string" ? { cue: `延续切点前已经开始的${category}：${event.cue}` } : {}) }] : [];
    }) };
}
function mergeAudio(left: unknown, right: unknown, offset: number, duration: number) {
    const a: Row = left && typeof left === "object" ? left : { description: typeof left === "string" ? left : "" };
    const b: Row = right && typeof right === "object" ? right : { description: typeof right === "string" ? right : "" };
    const extra = (row: Row) => Object.fromEntries(Object.entries(row).filter(([key]) => !["description", "events"].includes(key)));
    if (Object.keys(extra(a)).length && Object.keys(extra(b)).length && canonicalProduction(extra(a)) !== canonicalProduction(extra(b))) reject("SHOT_MERGE_AUDIO", "shots.audio", "两镜声音配置不同，请在合镜表单明确填写新的声音设计");
    return { ...(Object.keys(extra(a)).length ? extra(a) : extra(b)), description: `[0–${offset}帧] ${a.description || ""}\n[${offset}–${offset + duration}帧] ${b.description || ""}`, events: [...rows(a.events), ...rows(b.events).map(event => ({ ...event, start: event.start + offset, end: event.end + offset }))] };
}

/** Shared deletion cleanup for one Shot or an entire Clip. */
export function removeShotContent(source: Row, deletedIds: Set<string>) {
    const shots = rows(source.shots), ledger = source.ledger || {};
    // Deleting a Shot explicitly removes its authored content. Keep surviving
    // portions of cross-Shot dialogue, never orphan IDs or delete other Shots.
    source.utterances = rows(source.utterances).flatMap(utterance => {
        const removed = shots.filter(row => deletedIds.has(String(row.id))).flatMap(row => rows(row.utterance_refs)).filter(ref => ref.utteranceId === utterance.id);
        if (!removed.length) return [utterance];
        const remaining = shots.filter(row => !deletedIds.has(String(row.id))).flatMap(row => rows(row.utterance_refs).filter(ref => ref.utteranceId === utterance.id).map(ref => ({ row, ref })));
        if (!remaining.length) return [];
        const chars = Array.from(String(utterance.text));
        const removedAt = (index: number) => removed.some(ref => index >= ref.textStart && index < ref.textEnd);
        const shifted = (index: number) => chars.slice(0, index).filter((_, i) => !removedAt(i)).length;
        const text = chars.filter((_, i) => !removedAt(i)).join("");
        for (const { ref } of remaining) { ref.textStart = shifted(ref.textStart); ref.textEnd = shifted(ref.textEnd); }
        const first = remaining[0], last = remaining.at(-1)!;
        return [{ ...utterance, text, start: { shotId: first.row.id, localFrame: first.ref.localStartFrame }, end: { shotId: last.row.id, localFrame: last.ref.localEndFrame } }];
    });
    const removedEvents = new Set(rows(ledger.events).filter(row => deletedIds.has(String(row.shot_id))).map(row => row.id));
    ledger.events = rows(ledger.events).filter(row => !removedEvents.has(row.id));
    for (const key of ["requirements", "coverage"]) ledger[key] = rows(ledger[key]).flatMap(row => {
        if (deletedIds.has(String(row.shot_id))) return [];
        const value = { ...row };
        if (Array.isArray(value.shot_ids)) { value.shot_ids = value.shot_ids.filter((id: string) => !deletedIds.has(String(id))); if (!value.shot_ids.length) return []; }
        if (Array.isArray(value.event_ids)) { value.event_ids = value.event_ids.filter((id: string) => !removedEvents.has(id)); if (row.kind === "change" && !value.event_ids.length) return []; }
        return [value];
    });
    for (const other of shots) if (Array.isArray(other.outcome_events)) other.outcome_events = other.outcome_events.filter((id: string) => !removedEvents.has(id));
}

export function reconcileShotClipBoundaries(director: DirectorProduction, previousIds: string[]) {
    const ids = rows(director.source.segments).map(row => String(row.id));
    const edges = director.boundaries;
    director.boundaries = ids.slice(0, -1).flatMap((from, index) => {
        const to = ids[index + 1], existing = edges.filter(edge => edge.from === from && edge.to === to);
        if (existing.length) return existing;
        if (previousIds.some((id, oldIndex) => id === from && previousIds[oldIndex + 1] === to)) return [];
        return [{ from, to, tailFrame: false, motionContext: false, reason: "镜头结构修改后形成的新剪辑边界；不继承旧片段的尾帧或运动上下文。" }];
    });
}

/** Source edits only: no Prompt, media or published snapshot is modified. */
export function editDirectorShot(director: DirectorProduction, operation: Edit) {
    if (!isSubjectPromptAssembly(director.source)) reject("SHOT_EDIT_VERSION", "prompt_assembly", "原子镜头操作只用于 Prompt v2 制作稿");
    const next = structuredClone(director), source = next.source as Row;
    let shots = rows(source.shots);
    const selected = shots.find(shot => shot.id === operation.shotId), index = shots.indexOf(selected!);
    const originalSound = sound(source);
    const previousClips = rows(source.segments).map(row => String(row.id));
    const ledger = source.ledger || {};
    const requireSelected = () => { if (!selected) reject("SHOT_NOT_FOUND", `shots.${operation.shotId}`, "镜头不存在"); return selected!; };
    const freshId = (id: unknown) => { if (typeof id !== "string" || !id || shots.some(shot => shot.id === id)) reject("SHOT_ID_CONFLICT", "newShotId", "新镜头需要未使用的稳定 ID"); return id as string; };
    const group = selected && clip(source, selected.id);
    if (selected && !group) reject("SHOT_CLIP_MISSING", `shots.${selected.id}`, "镜头未归属有效 Clip");

    if (operation.action === "insert" || operation.action === "duplicate") {
        if (operation.action === "duplicate") requireSelected();
        const authored: Row = operation.action === "duplicate" ? { ...selected!, id: freshId(operation.newShotId), title: `${selected!.title || "镜头"} · 副本`, keyframes: [], utterance_refs: [], audio: {}, performance: undefined, outcome_events: [] } : structuredClone(operation.shot || {});
        if (operation.action === "insert") authored.id = freshId(authored.id);
        if (selected) {
            for (const key of ["scene_id", "source_scene_id", "timeline_id"]) if (authored[key] !== undefined && authored[key] !== selected[key]) reject("SHOT_INSERT_SCOPE", `shots.${authored.id}.${key}`, "新增镜头须沿用所在片段的场次和时间线");
            Object.assign(authored, { scene_id: selected.scene_id, timeline_id: selected.timeline_id, ...(selected.source_scene_id ? { source_scene_id: selected.source_scene_id } : {}) });
            shots.splice(index + 1, 0, authored);
            group!.shot_ids.splice(group!.shot_ids.indexOf(selected.id) + 1, 0, authored.id);
        } else {
            const segment = structuredClone(operation.segment || {});
            if (!segment.id || rows(source.segments).some(row => row.id === segment.id)) reject("SHOT_NEW_CLIP", "segment.id", "首镜需要新的 Clip 身份及执行模式");
            segment.shot_ids = [authored.id]; source.segments = [...rows(source.segments), segment]; shots.push(authored);
        }
        if (!Number.isInteger(authored.duration_frames) || authored.duration_frames <= 0) reject("SHOT_DURATION", `shots.${authored.id}.duration_frames`, "镜头时长必须为正整数帧");
        next.shotInputs[authored.id] = { assetIds: [], keyframePolicy: "none" };
    } else if (operation.action === "delete") {
        const shot = requireSelected();
        if (group!.shot_ids.length === 1) reject("SHOT_LAST_IN_CLIP", `shots.${shot.id}`, "这是片段唯一镜头，请使用删除片段入口保留媒体历史");
        removeShotContent(source, new Set([String(shot.id)]));
        shots.splice(index, 1); group!.shot_ids = group!.shot_ids.filter((id: string) => id !== shot.id); delete next.shotInputs[shot.id];
    } else if (operation.action === "move") {
        const shot = requireSelected(), target = shots.find(row => row.id === operation.targetShotId);
        if (!target || target.id === shot.id || clip(source, target.id)?.id !== group!.id) reject("SHOT_MOVE_SCOPE", `shots.${shot.id}`, "排序须选择同一片段中的其他镜头；片段归属通过 Clip 组合调整");
        shots.splice(index, 1); const position = shots.indexOf(target) + (operation.position === "before" ? 0 : 1); shots.splice(position, 0, shot);
        group!.shot_ids = shots.filter(row => group!.shot_ids.includes(row.id)).map(row => row.id);
    } else if (operation.action === "split") {
        const shot = requireSelected(), cut = operation.splitFrame!, duration = Number(shot.duration_frames), newId = freshId(operation.newShotId);
        if (!Number.isInteger(cut) || cut < 1 || cut >= duration) reject("SHOT_SPLIT_FRAME", `shots.${shot.id}.duration_frames`, "切点必须位于镜头内部，两侧至少各保留一帧");
        const original = structuredClone(shot), right = structuredClone(shot);
        shot.duration_frames = cut; right.id = newId; right.duration_frames = duration - cut; right.title = `${shot.title || "镜头"} · 后半段`;
        shot.subject_usages = sliceUsages(original, 0, cut); right.subject_usages = sliceUsages(original, cut, duration);
        shot.performance = slicePerformance(original.performance, 0, cut); right.performance = slicePerformance(original.performance, cut, duration);
        if (original.audio && typeof original.audio === "object" && Array.isArray(original.audio.events)) { shot.audio = slicePerformance(original.audio, 0, cut, "声音"); right.audio = slicePerformance(original.audio, cut, duration, "声音"); }
        shot.keyframes = []; right.keyframes = [];
        for (const frame of rows(original.keyframes)) {
            if (frame.anchor === "composition") { shot.keyframes.push(frame); right.keyframes.push({ ...frame, id: `${frame.id}:${newId}` }); }
            else if (frame.anchor === "opening") shot.keyframes.push(frame);
            else if (frame.anchor === "closing") right.keyframes.push(frame);
            else if (frame.localFrame < cut) shot.keyframes.push(frame);
            else right.keyframes.push({ ...frame, localFrame: frame.localFrame - cut });
        }
        shot.utterance_refs = []; right.utterance_refs = [];
        for (const ref of rows(original.utterance_refs)) {
            if (ref.localEndFrame <= cut) shot.utterance_refs.push(ref);
            else if (ref.localStartFrame >= cut) right.utterance_refs.push({ ...ref, localStartFrame: ref.localStartFrame - cut, localEndFrame: ref.localEndFrame - cut });
            else {
                const textLength = Number(ref.textEnd) - Number(ref.textStart);
                const automaticOffset = textLength > 1 ? Math.max(ref.textStart + 1, Math.min(ref.textEnd - 1, ref.textStart + Math.round(textLength * (cut - ref.localStartFrame) / (ref.localEndFrame - ref.localStartFrame)))) : undefined;
                const offset = operation.textOffsets?.[String(ref.utteranceId)] ?? automaticOffset;
                if (!Number.isInteger(offset) || offset! <= ref.textStart || offset! >= ref.textEnd) reject("SHOT_DIALOGUE_SPLIT", `utterances.${ref.utteranceId}.text`, "请明确选择跨切对白的切字位置；单字片段请将切点移到该声音窗之外");
                shot.utterance_refs.push({ ...ref, localEndFrame: cut, textEnd: offset });
                right.utterance_refs.push({ ...ref, localStartFrame: 0, localEndFrame: ref.localEndFrame - cut, textStart: offset });
            }
        }
        if (operation.reaction) for (const ref of right.utterance_refs) ref.role = "reaction";
        for (const utterance of rows(source.utterances)) {
            if (utterance.start.shotId === shot.id && utterance.start.localFrame >= cut) utterance.start = { shotId: newId, localFrame: utterance.start.localFrame - cut };
            if (utterance.end.shotId === shot.id && utterance.end.localFrame > cut) utterance.end = { shotId: newId, localFrame: utterance.end.localFrame - cut };
        }
        for (const event of rows(ledger.events)) if (event.shot_id === shot.id && event.local_frame >= cut) { event.shot_id = newId; event.local_frame -= cut; }
        ledger.requirements = rows(ledger.requirements).flatMap(row => {
            if (row.shot_id !== shot.id) return [row];
            if (row.kind === "hold") return [row, { ...row, id: `${row.id}:${newId}`, shot_id: newId }];
            if (Array.isArray(row.event_ids)) {
                const leftEvents = row.event_ids.filter((id: string) => rows(ledger.events).find(event => event.id === id)?.shot_id !== newId), rightEvents = row.event_ids.filter((id: string) => !leftEvents.includes(id));
                return [...(leftEvents.length ? [{ ...row, event_ids: leftEvents }] : []), ...(rightEvents.length ? [{ ...row, id: leftEvents.length ? `${row.id}:${newId}` : row.id, shot_id: newId, event_ids: rightEvents }] : [])];
            }
            return [row];
        });
        for (const row of rows(ledger.coverage)) if (Array.isArray(row.shot_ids)) row.shot_ids = row.shot_ids.flatMap((id: string) => id === shot.id ? [id, newId] : [id]);
        patch(shot, operation.firstShotPatch); patch(right, operation.shot);
        shot.subject_usages = sliceUsages(shot, 0, cut); right.subject_usages = sliceUsages(right, 0, duration - cut);
        if (operation.reaction) {
            const speakers = new Set(rows(source.utterances).filter(utterance => right.utterance_refs.some((ref: Row) => ref.utteranceId === utterance.id)).map(utterance => utterance.speakerSubjectId));
            right.subject_usages = rows(right.subject_usages).map(usage => {
                if (!speakers.has(usage.subjectId)) return usage;
                const value: Row = { ...usage, presentation: "offscreen_voice" }; delete value.localStartFrame; delete value.localEndFrame; return value;
            });
            for (const subjectId of speakers) if (!right.subject_usages.some((usage: Row) => usage.subjectId === subjectId)) right.subject_usages.push({ subjectId, presentation: "offscreen_voice", pictureBindingIds: [], referencePurpose: [], continuityFactIds: [], stateRequirements: [] });
        }
        for (const part of [shot, right]) if (Array.isArray(original.outcome_events)) part.outcome_events = original.outcome_events.filter((id: string) => rows(ledger.events).some(event => event.id === id && event.shot_id === part.id));
        shots.splice(index + 1, 0, right); group!.shot_ids.splice(group!.shot_ids.indexOf(shot.id) + 1, 0, newId);
        next.shotInputs[newId] = structuredClone(next.shotInputs[shot.id] || { assetIds: [], keyframePolicy: "none" });
    } else if (operation.action === "merge") {
        const left = requireSelected(), right = shots[index + 1];
        if (!right || right.id !== operation.targetShotId || clip(source, right.id)?.id !== group!.id) reject("SHOT_MERGE_SCOPE", `shots.${left.id}`, "只能合并同一片段内的相邻镜头");
        if (canonicalProduction(left.camera) !== canonicalProduction(right.camera) && ![left.id, right.id].includes(operation.cameraShotId!)) reject("SHOT_MERGE_CAMERA", `shots.${left.id}.camera`, "两镜摄影不同，请明确选择合并后使用哪一个摄影方案");
        if (left.performance?.source_beat_id && right.performance?.source_beat_id && left.performance.source_beat_id !== right.performance.source_beat_id) reject("SHOT_MERGE_PERFORMANCE", `shots.${left.id}.performance`, "两镜主要表演来源不同，请先统一表演设计再合镜");
        const offset = Number(left.duration_frames), rightDuration = Number(right.duration_frames);
        const leftUsages = sliceUsages(left, 0, offset), rightUsages = sliceUsages(right, 0, rightDuration).map(usage => ({ ...usage, localStartFrame: usage.localStartFrame + offset, localEndFrame: usage.localEndFrame + offset }));
        const usages: Row[] = [];
        for (const usage of [...leftUsages, ...rightUsages]) {
            const content = (value: Row) => Object.fromEntries(Object.entries(value).filter(([key]) => !["localStartFrame", "localEndFrame"].includes(key)));
            const previous = usages.find(row => row.localEndFrame === usage.localStartFrame && canonicalProduction(content(row)) === canonicalProduction(content(usage)));
            if (previous) previous.localEndFrame = usage.localEndFrame; else usages.push(usage);
        }
        left.subject_usages = usages;
        left.camera = structuredClone(operation.cameraShotId === right.id ? right.camera : left.camera);
        left.visual = `[0–${offset}帧] ${left.visual || ""}\n[${offset}–${offset + rightDuration}帧] ${right.visual || ""}`;
        left.duration_frames = offset + rightDuration;
        left.audio = operation.firstShotPatch && Object.hasOwn(operation.firstShotPatch, "audio") ? operation.firstShotPatch.audio : mergeAudio(left.audio, right.audio, offset, rightDuration);
        left.utterance_refs = [...rows(left.utterance_refs), ...rows(right.utterance_refs).map(ref => ({ ...ref, localStartFrame: ref.localStartFrame + offset, localEndFrame: ref.localEndFrame + offset }))];
        left.keyframes = [...rows(left.keyframes).map(frame => frame.anchor === "closing" ? { ...frame, anchor: "at_frame", localFrame: offset - 1 } : frame), ...rows(right.keyframes).map(frame => frame.anchor === "opening" || frame.anchor === "composition" ? { ...frame, anchor: "at_frame", localFrame: offset } : frame.anchor === "at_frame" ? { ...frame, localFrame: frame.localFrame + offset } : frame)];
        if (left.performance || right.performance) left.performance = { ...(left.performance || right.performance), events: [...rows(left.performance?.events), ...rows(right.performance?.events).map(event => ({ ...event, start: event.start + offset, end: event.end + offset }))] };
        for (const utterance of rows(source.utterances)) for (const boundary of ["start", "end"]) if (utterance[boundary].shotId === right.id) utterance[boundary] = { shotId: left.id, localFrame: utterance[boundary].localFrame + offset };
        for (const event of rows(ledger.events)) if (event.shot_id === right.id) { event.shot_id = left.id; event.local_frame += offset; }
        for (const key of ["requirements", "coverage"]) for (const row of rows(ledger[key])) {
            if (row.shot_id === right.id) row.shot_id = left.id;
            if (Array.isArray(row.shot_ids)) row.shot_ids = [...new Set(row.shot_ids.map((id: string) => id === right.id ? left.id : id))];
        }
        ledger.requirements = rows(ledger.requirements).filter(row => {
            const original = rows(ledger.requirements).find(candidate => `${candidate.id}:${right.id}` === row.id);
            return !original || canonicalProduction({ ...row, id: original.id }) !== canonicalProduction(original);
        });
        left.outcome_events = [...new Set([...rows(source.shots).filter(row => row.id === left.id || row.id === right.id).flatMap(row => Array.isArray(row.outcome_events) ? row.outcome_events : [])])];
        const rightInput = next.shotInputs[right.id];
        if (rightInput) next.shotInputs[left.id] = { ...rightInput, ...next.shotInputs[left.id], assetIds: [...new Set([...(next.shotInputs[left.id]?.assetIds || []), ...rightInput.assetIds])], ...(next.shotInputs[left.id]?.keyframePolicy === "none" && rightInput.keyframePolicy !== "none" ? { keyframePolicy: rightInput.keyframePolicy, keyframeAssetId: rightInput.keyframeAssetId } : {}) };
        patch(left, operation.firstShotPatch);
        shots.splice(index + 1, 1); group!.shot_ids = group!.shot_ids.filter((id: string) => id !== right.id); delete next.shotInputs[right.id];
    }
    const counters = new Map<string, number>();
    source.shots = shots.map(shot => { const order = counters.get(shot.timeline_id) || 0; counters.set(shot.timeline_id, order + 1); return { ...shot, story_order: order }; });
    reconcileShotClipBoundaries(next, previousClips);
    if (operation.action !== "delete" && canonicalProduction(sound(source)) !== canonicalProduction(originalSound)) reject("SHOT_DIALOGUE_CHANGED", "utterances", "该位置正在承接跨镜连续对白，新增或移动独立镜头会插入声音缺口。请用拆分镜头改变摄影切点；程序保留原对白速度。");
    // Hash the exact JSON source that the existing production transaction persists.
    next.source = JSON.parse(JSON.stringify(source));
    next.sourceHash = crypto.createHash("sha256").update(canonicalProduction(next.source)).digest("hex");
    next.artifacts = next.artifacts.map(artifact => currentCompilationArtifact(next, artifact) ? artifact : { ...artifact, status: "stale" });
    next.executionAuthorized = false;
    Object.assign(director, directorProductionSchema.parse(next));
}
