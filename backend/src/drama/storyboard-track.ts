import { isSubjectPromptAssembly, shotStoryboardKeyframe, type EpisodeProductionData } from "@basketikun/canvas-agent/drama/production-contract";

/**
 * 画布 H3 分镜格的**派生视图**。
 *
 * 唯一 owner 是制作稿 `shot.keyframes[]`（制作台里改的就是它）。画布 segment 上的
 * `storyboardShots` / `referenceBindings` 只是这份权威的可执行投影：H3 编辑器与执行器
 * 都只认画布引用（运行快照必须自包含），所以投影必须有，但**不能当第二份权威**去等
 * 「写路径事件」刷新——那样一次被挡住的编译就会让格子长期停在旧图。
 *
 * 这里的函数在**用时**（读取 / 生成准备 / 面板展示）现场从 owner 重算，因此不再需要
 * 写时补丁，也不依赖画布 referenceCatalog 里是否登记过这张新图。
 */

const recordOf = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const rowsOf = (value: unknown): Array<Record<string, any>> => Array.isArray(value) ? value.map(recordOf) : [];

export type StoryboardSlot = { id: string; duration: number; referenceBindingId?: string };
export type StoryboardTrack = {
    duration: number;
    storyboardModeEnabled: true;
    storyboardShots: StoryboardSlot[];
    referenceBindings: Array<Record<string, any>>;
};

type ProductionLike = Pick<Partial<EpisodeProductionData>, "director" | "clipGroups"> & Record<string, unknown>;

const isShotFrameBinding = (reference: Record<string, any>) =>
    ["storyboard", "keyframe"].includes(String(reference.role || ""))
    && (reference.mediaType === "image" || reference.type === "image" || reference.mediaType === undefined);

/** 从制作稿推导某个 Clip 的分镜轨；owner 缺镜头/资产时返回 undefined，由调用方保留原值。 */
export function deriveStoryboardTrack(data: ProductionLike, group: { shotIds: string[] }, existing: Record<string, any> = {}): StoryboardTrack | undefined {
    const director = recordOf(data.director);
    const source = recordOf(director.source);
    const sourceShots = rowsOf(source.shots);
    const shotIds = (Array.isArray(group.shotIds) ? group.shotIds : []).map(String);
    if (!shotIds.length) return undefined;
    const shots = shotIds.map(id => sourceShots.find(shot => String(shot.id) === id));
    if (shots.some(shot => !shot)) return undefined;
    const fps = Number(source.fps_num || 24) / Number(source.fps_den || 1);
    if (!Number.isFinite(fps) || fps <= 0) return undefined;
    const subjectAssembly = isSubjectPromptAssembly(source as Record<string, unknown>);
    const assets = recordOf((director as Record<string, any>).assets);
    const shotInputs = recordOf((director as Record<string, any>).shotInputs);
    const existingSlots = rowsOf(existing.storyboardShots);
    const existingRefs = rowsOf(existing.referenceBindings);
    const existingSlotBindingIds = new Set(existingSlots.map(slot => String(slot.referenceBindingId || "")).filter(Boolean));

    const frameFor = (shot: Record<string, any>) => {
        if (subjectAssembly) return shotStoryboardKeyframe(rowsOf(shot.keyframes)) as Record<string, any> | undefined;
        const input = recordOf(shotInputs[String(shot.id)]);
        if (input.keyframePolicy === "none" || !input.keyframeAssetId) return undefined;
        return { id: `KF:${String(shot.id)}:legacy`, assetId: String(input.keyframeAssetId), sourceNode: input.sourceNode } as Record<string, any>;
    };

    const slotBindings: Array<Record<string, any>> = [];
    const storyboardShots: StoryboardSlot[] = [];
    for (const shot of shots as Array<Record<string, any>>) {
        const frames = Number(shot.duration_frames), start = Number(shot.start_frame), end = Number(shot.end_frame);
        const duration = Number.isFinite(frames) && frames > 0 ? frames / fps
            : Number.isFinite(start) && Number.isFinite(end) && end > start ? (end - start) / fps : 0;
        const frame = frameFor(shot);
        const asset = frame ? recordOf(assets[String(frame.assetId || frame.id || "")]) : {};
        const priorBindingId = String(existingSlots.find(slot => String(slot.id || "") === String(shot.id))?.referenceBindingId
            || asset.canvasReferenceBindingId || "");
        if (!frame || !asset.storageKey) {
            storyboardShots.push({ id: String(shot.id), duration });
            continue;
        }
        const bindingId = priorBindingId || `storyboard:${String(frame.assetId || frame.id || shot.id)}`;
        const prior = existingRefs.find(reference => String(reference.id || "") === bindingId) || {};
        const sourceNodeId = String(asset.nodeId || recordOf(frame.sourceNode).nodeId || prior.sourceNodeId || "");
        slotBindings.push({
            ...prior,
            id: bindingId,
            assetId: String(asset.assetId || prior.assetId || frame.assetId || frame.id || bindingId),
            label: String(prior.label || `Shot ${String(shot.id)} storyboard`),
            role: "storyboard", mediaType: "image", enabled: true, usage: String(prior.usage || "reference"),
            storageKey: String(asset.storageKey),
            ...(sourceNodeId ? { sourceNodeId } : {}),
        });
        storyboardShots.push({ id: String(shot.id), duration, referenceBindingId: bindingId });
    }

    // 只替换「被分镜格占用的图引用」，角色/场景/普通参考原样保留；指向已消失格子的旧分镜图一并清掉。
    const referenceBindings = [
        ...existingRefs.filter(reference => !isShotFrameBinding(reference) || !existingSlotBindingIds.has(String(reference.id || ""))),
        ...slotBindings,
    ];
    return {
        duration: storyboardShots.reduce((sum, slot) => sum + Number(slot.duration || 0), 0),
        storyboardModeEnabled: true,
        storyboardShots,
        referenceBindings,
    };
}

export type DerivedStoryboardTracks = { ownerId: string; revision: number; tracks: Record<string, StoryboardTrack> };

type TrackSnapshot = { ownerId: string; revision: number; snapshot: string; canvasId: string };

/** 读取画布所属制作对象的当前草稿（与 project-store 的 requirements 同源查询，不做缓存）。 */
export function productionDraftForCanvas(db: { db: { prepare(sql: string): { get(...params: any[]): any } } }, projectId: string): TrackSnapshot | undefined {
    const row = db.db.prepare(`SELECT p.episode_id AS ownerId, p.revision, p.draft_json AS snapshot, e.canvas_id AS canvasId
        FROM episode_productions p JOIN drama_episodes e ON e.id=p.episode_id WHERE e.canvas_id=?
        UNION ALL SELECT project_id AS ownerId, revision, draft_json AS snapshot, project_id AS canvasId
        FROM canvas_productions WHERE project_id=?`)
        .get(projectId, projectId) as TrackSnapshot | undefined;
    return row?.snapshot ? row : undefined;
}

/**
 * 按画布现有 Segment 计算派生分镜轨，segmentId → track。
 * 只处理带 `productionClipProjection.targetId` 的编译型 Segment；手工片段保持原样。
 */
export function derivedStoryboardTracks(data: ProductionLike, segments: Array<Record<string, any>>): Record<string, StoryboardTrack> {
    const groups = rowsOf((data as Record<string, any>).clipGroups);
    const tracks: Record<string, StoryboardTrack> = {};
    for (const segment of segments) {
        const targetId = String(recordOf(segment.productionClipProjection).targetId || "");
        if (!targetId) continue;
        const group = groups.find(item => String(item.id || "") === targetId && Array.isArray(item.shotIds));
        // 草稿行不存 clipGroups（读取时才由画布反推），此时用 Segment 自己记录的镜头成员。
        const shotIds = group ? (group.shotIds as string[]).map(String) : String(segment.sourceShotId || "").split("~").filter(Boolean);
        if (!shotIds.length) continue;
        const track = deriveStoryboardTrack(data, { shotIds }, segment);
        if (track) tracks[String(segment.id || targetId)] = track;
    }
    return tracks;
}

/** 把派生轨覆盖到画布 Segment 上（就地修改传入的副本，不写库）。返回真正变化的 Segment ID。 */
export function applyStoryboardTracks(project: Record<string, any>, tracks: Record<string, StoryboardTrack>): string[] {
    const changed: string[] = [];
    for (const node of rowsOf(project.nodes)) {
        const metadata = recordOf(node.metadata);
        if (!Array.isArray(metadata.segments)) continue;
        const segments = metadata.segments as Array<Record<string, any>>;
        let nodeChanged = false;
        for (const segment of segments) {
            const track = tracks[String(segment.id || "")];
            if (!track) continue;
            const sameSlots = JSON.stringify(segment.storyboardShots || []) === JSON.stringify(track.storyboardShots);
            if (sameSlots && JSON.stringify(segment.referenceBindings || []) === JSON.stringify(track.referenceBindings)
                && Number(segment.duration || 0) === track.duration && segment.storyboardModeEnabled === true) continue;
            segment.storyboardModeEnabled = true;
            segment.storyboardShots = track.storyboardShots;
            segment.referenceBindings = track.referenceBindings;
            segment.duration = track.duration;
            changed.push(String(segment.id || ""));
            nodeChanged = true;
        }
        if (nodeChanged) metadata.segments = segments;
    }
    return changed;
}

/** 槽位 → 绑定身份。同一身份只换图（storageKey）是安全的；绑定增删会改 `<Picture N>` 编号。 */
export function storyboardTrackIdentity(track: { storyboardShots?: unknown } | undefined) {
    return (Array.isArray(track?.storyboardShots) ? track!.storyboardShots as Array<Record<string, any>> : [])
        .map(slot => `${String(slot?.id || "")}:${String(slot?.referenceBindingId || "")}`).join("|");
}

/**
 * 生成准备只能吸收「同槽位换图」的派生（编号不变，提示词仍然对得上）。
 * 槽位或绑定身份变了意味着 `<Picture N>` 会重排：必须重新编译，不能拿旧提示词配新参考出片。
 */
export function splitStoryboardTracks(segments: Array<Record<string, any>>, tracks: Record<string, StoryboardTrack>) {
    const applicable: Record<string, StoryboardTrack> = {};
    const stale: string[] = [];
    for (const segment of segments) {
        const id = String(segment.id || "");
        const track = tracks[id];
        if (!track) continue;
        if (storyboardTrackIdentity(segment) === storyboardTrackIdentity(track)) applicable[id] = track;
        else stale.push(id);
    }
    return { applicable, stale };
}

/**
 * 读取路径的统一入口：给画布副本套上「按制作稿现算」的分镜轨。
 * 读失败（无制作对象 / 坏 JSON）时原样返回，绝不因为派生失败而挡住读。
 */
export function withDerivedStoryboardTracks<T extends Record<string, any>>(db: { db: { prepare(sql: string): { get(...params: any[]): any } } }, projectId: string, project: T | null | undefined): { project: T | null | undefined; changed: string[] } {
    if (!project || !Array.isArray((project as Record<string, any>).nodes)) return { project, changed: [] };
    let snapshot: TrackSnapshot | undefined;
    try { snapshot = productionDraftForCanvas(db, projectId); } catch { return { project, changed: [] }; }
    if (!snapshot) return { project, changed: [] };
    let data: ProductionLike;
    try { data = JSON.parse(String(snapshot.snapshot)) as ProductionLike; } catch { return { project, changed: [] }; }
    const segments = rowsOf((project as Record<string, any>).nodes).flatMap(node => rowsOf(recordOf(node.metadata).segments));
    if (!segments.length) return { project, changed: [] };
    const tracks = derivedStoryboardTracks(data, segments);
    if (!Object.keys(tracks).length) return { project, changed: [] };
    return { project, changed: applyStoryboardTracks(project as Record<string, any>, tracks) };
}
