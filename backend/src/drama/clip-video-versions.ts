/**
 * 逐clip成片真值链（只读画布 + 写 clip_video_versions）。
 *
 * 查证结论：episode_production_versions.snapshot_json 的 director.artifacts 里 h3 clip 只有
 * id/kind/targetId/prompt/sha256/sourceHash/status/references/receipt，没有任何成片 storageKey；
 * 快照里唯一的成片地址是整集 director.workflow.finalResource.storageKey。逐段成片真值只存在于
 * 画布节点 metadata.segments[].resultStorageKey（results[] 里带 storageKey/generationLogId），
 * 真实 mp4 归档在 media_files（duration_ms 为真值）。因此发布版本时按 clip 捕获画布当前段结果，
 * 按 (episode_id, version, clip_id) 落库，供版本对比逐 clip 判定成片是否更换。
 *
 * 本模块只认真实存在的值：storageKey 必须来自段结果，durationMs 必须来自 media_files；
 * 查不到就写 null，不按时间、标题或其它版本回填，不生成占位地址。
 */
import type { BackendDatabase } from "../db.js";

export type ClipVideoTruth = {
    /** 制作稿 clip 的稳定 ID = 画布段 productionClipProjection.targetId（无则段 ID）。 */
    clipId: string;
    /** 画布 H3 段 ID（真值所在位置）。 */
    segmentId: string;
    title: string;
    storageKey: string;
    /** media_files.duration_ms 的真实值；未归档为 null。 */
    durationMs: number | null;
    source: string | null;
    generationLogId: string | null;
    status: string | null;
};

const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

/**
 * 捕获该集当前画布所有 H3 段的成片真值。按 clipId 去重（同一 clip 可能落多个 H3 节点），
 * 优先保留带 generationLogId 的结果；全部只读，不修改画布。
 */
export function captureCanvasClipVideos(db: BackendDatabase, episodeId: string): ClipVideoTruth[] {
    const episode = db.db.prepare("SELECT canvas_id FROM drama_episodes WHERE id=?").get(episodeId) as { canvas_id?: string } | undefined;
    const canvasId = text(episode?.canvas_id);
    if (!canvasId) return [];
    const nodeRows = db.db.prepare("SELECT node_json FROM canvas_nodes WHERE project_id=?").all(canvasId) as Array<{ node_json: string }>;
    const found = new Map<string, ClipVideoTruth>();
    for (const nodeRow of nodeRows) {
        let node: Record<string, unknown>;
        try { node = JSON.parse(nodeRow.node_json) as Record<string, unknown>; }
        catch { continue; }
        const metadata = node.metadata && typeof node.metadata === "object" ? node.metadata as Record<string, unknown> : {};
        const segments = Array.isArray(metadata.segments) ? metadata.segments : [];
        for (const raw of segments) {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
            const segment = raw as Record<string, unknown>;
            const storageKey = text(segment.resultStorageKey);
            if (!storageKey) continue;
            const projection = segment.productionClipProjection && typeof segment.productionClipProjection === "object"
                ? segment.productionClipProjection as Record<string, unknown> : {};
            const clipId = text(projection.targetId) || text(segment.id);
            if (!clipId) continue;
            const media = db.db.prepare("SELECT duration_ms FROM media_files WHERE storage_key=?").get(storageKey) as { duration_ms?: number | null } | undefined;
            const results = Array.isArray(segment.results) ? segment.results.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
            const chosen = results.find((item) => text(item.storageKey) === storageKey) ?? null;
            const generationLogId = text(chosen?.generationLogId);
            const truth: ClipVideoTruth = {
                clipId,
                segmentId: text(segment.id),
                title: text(segment.title),
                storageKey,
                durationMs: typeof media?.duration_ms === "number" ? media.duration_ms : null,
                source: text(chosen?.source) || (generationLogId ? "generation" : null),
                generationLogId: generationLogId || null,
                status: text(segment.status) || null,
            };
            const previous = found.get(clipId);
            if (!previous || (!previous.generationLogId && truth.generationLogId)) found.set(clipId, truth);
        }
    }
    return [...found.values()].sort((a, b) => a.clipId.localeCompare(b.clipId));
}

/** 发布版本时把捕获到的逐clip成片真值按版本落库；同版本重复写入为幂等 upsert。 */
export function recordClipVideoVersions(db: BackendDatabase, episodeId: string, version: number, rows: ClipVideoTruth[], createdAt = new Date().toISOString()): number {
    const upsert = db.db.prepare(`INSERT INTO clip_video_versions
        (episode_id, version, clip_id, segment_id, title, storage_key, duration_ms, source, generation_log_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(episode_id, version, clip_id) DO UPDATE SET
            segment_id=excluded.segment_id, title=excluded.title, storage_key=excluded.storage_key,
            duration_ms=excluded.duration_ms, source=excluded.source, generation_log_id=excluded.generation_log_id,
            status=excluded.status, updated_at=excluded.updated_at`);
    for (const row of rows) {
        upsert.run(episodeId, version, row.clipId, row.segmentId, row.title, row.storageKey,
            row.durationMs, row.source, row.generationLogId, row.status, createdAt, createdAt);
    }
    return rows.length;
}

const rowToTruth = (row: Record<string, unknown>): ClipVideoTruth => ({
    clipId: text(row.clip_id), segmentId: text(row.segment_id), title: text(row.title),
    storageKey: text(row.storage_key),
    durationMs: typeof row.duration_ms === "number" ? row.duration_ms : null,
    source: typeof row.source === "string" ? row.source : null,
    generationLogId: typeof row.generation_log_id === "string" ? row.generation_log_id : null,
    status: typeof row.status === "string" ? row.status : null,
});

/** 读指定版本已记录的逐clip成片真值；没有记录返回空数组（旧版本诚实显示「无记录」）。 */
export function readClipVideoVersions(db: BackendDatabase, episodeId: string, versions: number[]): Map<number, ClipVideoTruth[]> {
    const result = new Map<number, ClipVideoTruth[]>();
    for (const version of versions) result.set(version, []);
    if (!versions.length) return result;
    const placeholders = versions.map(() => "?").join(",");
    const rows = db.db.prepare(`SELECT version, clip_id, segment_id, title, storage_key, duration_ms, source, generation_log_id, status
        FROM clip_video_versions WHERE episode_id=? AND version IN (${placeholders}) ORDER BY clip_id`)
        .all(episodeId, ...versions) as Array<Record<string, unknown> & { version: number }>;
    for (const row of rows) result.get(row.version)?.push(rowToTruth(row));
    return result;
}

/** 该集各版本已记录的逐clip成片条数（给版本列表显示，不推断历史缺失的记录）。 */
export function countClipVideoVersions(db: BackendDatabase, episodeId: string): Map<number, number> {
    const rows = db.db.prepare("SELECT version, COUNT(*) AS count FROM clip_video_versions WHERE episode_id=? GROUP BY version")
        .all(episodeId) as Array<{ version: number; count: number }>;
    return new Map(rows.map((row) => [row.version, Number(row.count)]));
}
