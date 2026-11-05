type Row = Record<string, any>;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value : [];

/** Display ordinals belong to the current authored order, never to an ID suffix. */
export function productionNumbering(source: Row) {
    const sourceShots = [...rows(source.shots)].sort((left, right) => Number(left.story_order ?? 0) - Number(right.story_order ?? 0));
    const shotById = new Map(sourceShots.map((shot, index) => [String(shot.id), { shot, shotNumber: index + 1 }]));
    const fps = Number(source.fps_num || 24) / Number(source.fps_den || 1);
    const clips = rows(source.segments).map((segment, index) => {
        const shots = (Array.isArray(segment.shot_ids) ? segment.shot_ids : []).map((id: string, localIndex: number) => {
            const entry = shotById.get(String(id));
            return { shotId: String(id), shotNumber: entry?.shotNumber ?? null, shotInClip: localIndex + 1,
                title: String(entry?.shot.title || ""), duration: Number(entry?.shot.duration_frames ?? (Number(entry?.shot.end_frame) - Number(entry?.shot.start_frame))) / fps || 0 };
        });
        return { segmentId: String(segment.id), clipNumber: index + 1, title: String(segment.title || segment.summary || shots.map((shot: { title: string }) => shot.title).join(" / ")),
            shotCount: shots.length, duration: shots.reduce((total: number, shot: { duration: number }) => total + shot.duration, 0), shots };
    });
    return { clips, shots: sourceShots.map((shot, index) => {
        const memberships = clips.flatMap(clip => clip.shots.filter((entry: { shotId: string }) => entry.shotId === String(shot.id)).map((entry: { shotInClip: number }) => ({ segmentId: clip.segmentId, clipNumber: clip.clipNumber, shotInClip: entry.shotInClip })));
        return { shotId: String(shot.id), shotNumber: index + 1, title: String(shot.title || ""), memberships };
    }) };
}

export type ProductionNumbering = ReturnType<typeof productionNumbering>;
export type ProductionTargetSelector = { targetId?: string; clipNumber?: number; shotNumber?: number; shotInClip?: number };

export function resolveProductionTarget(source: Row, view: string, selector: ProductionTargetSelector): string {
    const { targetId, clipNumber, shotNumber, shotInClip } = selector;
    if (targetId) {
        if (clipNumber !== undefined || shotNumber !== undefined || shotInClip !== undefined) throw new Error("TARGET_SELECTOR_CONFLICT: 稳定 ID 与展示编号只能选一种定位方式");
        return targetId;
    }
    for (const number of [clipNumber, shotNumber, shotInClip]) if (number !== undefined && (!Number.isInteger(number) || number < 1)) throw new Error("TARGET_SELECTOR_INVALID: 编号必须是从 1 开始的整数");
    const numbering = productionNumbering(source);
    if (view === "clip_workbench" && clipNumber !== undefined && shotNumber === undefined && shotInClip === undefined) {
        const clip = numbering.clips[clipNumber - 1];
        if (clip) return clip.segmentId;
    } else if (view === "shot_workbench") {
        if (shotNumber !== undefined && clipNumber === undefined && shotInClip === undefined) {
            const shot = numbering.shots[shotNumber - 1];
            if (shot) return shot.shotId;
        } else if (clipNumber !== undefined && shotInClip !== undefined && shotNumber === undefined) {
            const shot = numbering.clips[clipNumber - 1]?.shots[shotInClip - 1];
            if (shot) return shot.shotId;
        }
    }
    throw new Error("TARGET_SELECTOR_INVALID: 请指定有效 targetId，或 Clip 的 clipNumber，或镜头的 shotNumber / clipNumber + shotInClip；编号从 1 开始");
}
