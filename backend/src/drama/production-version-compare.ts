/**
 * 版本快照结构化对比（只读）。
 *
 * 真值来源只有 episode_production_versions.snapshot_json 本身：所有计数、ID、
 * 提示词指纹、成片 storageKey 都从 JSON 解析得到，没有回退到猜测或外部表。
 * 该文件是纯函数，不访问数据库，便于用真实快照副本做单测。
 */
import crypto from "node:crypto";

type Obj = Record<string, unknown>;

export type VersionRef = { version: number; stage: string; createdAt: string };

/**
 * 成片时长真值回调：按 storageKey 查 media_files.duration_ms。
 * 纯函数模块刻意不访问数据库，由调用方（production service）注入；查不到返回 null，绝不编造。
 */
export type MediaDurationLookup = (storageKey: string) => number | null;
/** durationSec 的来源：成片文件时长 / 分场镜头帧数汇总 / 两种真值都缺失。 */
export type VersionDurationSource = "media-file" | "shots-frames" | null;
export type VersionSnapshotInput = VersionRef & { snapshot: unknown; lookupMediaDurationMs?: MediaDurationLookup };

export type VersionSnapshotSummary = {
    /** v2-director = 正式 director.source 结构；legacy = 仅顶层旧数组；empty = 空快照。 */
    format: "v2-director" | "legacy" | "empty";
    sceneCount: number;
    shotCount: number;
    segmentCount: number;
    keyframeCount: number;
    /** 成片 clip 产物（artifact.kind === "h3"）数量。 */
    h3ClipCount: number;
    promptCount: number;
    /** 按 artifact.id 排序后对全部 prompt 文本取的 sha256；null = 无 prompt。 */
    promptsHash: string | null;
    sourceHash: string | null;
    /** director.workflow.finalResource.storageKey；快照没写就是 null（真值缺失，不编造）。 */
    finalStorageKey: string | null;
    /**
     * 版本成片时长（秒）：优先 director.workflow.finalResource.storageKey 关联的
     * media_files.duration_ms；无成片则回退 shots[].duration_frames / fps 汇总。
     * 两种真值都缺失时为 null，绝不编造。
     */
    durationSec: number | null;
    /** durationSec 的取值来源；null = 无真值。 */
    durationSource: VersionDurationSource;
    /** 分场镜头帧数汇总秒数（无论是否采用成片时长都真实派生，便于与成片时长对照）。 */
    shotsDurationSec: number | null;
    shotIds: string[];
    segmentIds: string[];
    promptIds: string[];
};

export type CountDimension = { key: string; label: string; from: number; to: number; delta: number; changed: boolean };
export type NumberDimension = { key: string; label: string; from: number | null; to: number | null; delta: number | null; changed: boolean };
export type StringDimension = { key: string; label: string; from: string | null; to: string | null; changed: boolean };
export type FieldChange = { field: string; from: string; to: string };
export type EntityChange = { id: string; fields: FieldChange[] };
export type PromptChange = { id: string; fromHash: string; toHash: string };

/** 逐clip成片真值（来自 clip_video_versions 表，不是快照推断）。 */
export type VersionClipVideo = {
    clipId: string;
    segmentId: string;
    title: string;
    storageKey: string;
    durationMs: number | null;
    source: string | null;
    generationLogId: string | null;
    status: string | null;
};
export type ClipVideoChange = {
    clipId: string;
    title: string;
    from: VersionClipVideo | null;
    to: VersionClipVideo | null;
    state: "added" | "removed" | "storageKeyChanged" | "durationChanged" | "regenMetadata";
    storageKeyChanged: boolean;
    durationChanged: boolean;
};
export type ClipVideoDiff = {
    /** 该版本是否真的记录过逐clip成片（旧快照无记录，不伪造）。 */
    recordedFrom: boolean;
    recordedTo: boolean;
    fromCount: number;
    toCount: number;
    added: string[];
    removed: string[];
    changed: ClipVideoChange[];
};

export type VersionDiff = {
    episodeId: string;
    from: VersionRef;
    to: VersionRef;
    changed: boolean;
    dimensions: {
        scenes: CountDimension;
        shots: CountDimension;
        segments: CountDimension;
        keyframes: CountDimension;
        h3Clips: CountDimension;
        prompts: CountDimension;
        /** 版本成片时长（秒）对比；任一侧无真值时对应为 null。 */
        durationSec: NumberDimension;
        finalStorageKey: StringDimension;
        sourceHash: StringDimension;
        promptsHash: StringDimension;
    };
    shots: { added: string[]; removed: string[]; changed: EntityChange[] };
    segments: { added: string[]; removed: string[]; changed: EntityChange[] };
    prompts: { added: string[]; removed: string[]; changed: PromptChange[] };
    /** 逐clip成片真值 diff：成片 storageKey 是否更换、时长是否变化。 */
    clipVideos: ClipVideoDiff;
};

const recordOf = (value: unknown): Obj | null => value && typeof value === "object" && !Array.isArray(value) ? value as Obj : null;
const arrayOf = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
const sha256 = (value: string): string => crypto.createHash("sha256").update(value).digest("hex");

/** 键排序的 JSON 序列化，保证同一对象每次得到相同指纹/比较结果。 */
export function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    const entries = Object.entries(value as Obj).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

const PREVIEW_CHARS = 240;
function preview(value: unknown): string {
    const serialized = stableStringify(value);
    return serialized.length > PREVIEW_CHARS ? `${serialized.slice(0, PREVIEW_CHARS)}…[${serialized.length} chars]` : serialized;
}

type Extracted = {
    summary: VersionSnapshotSummary;
    shots: Map<string, unknown>;
    segments: Map<string, unknown>;
    prompts: Map<string, string>;
};

function firstNonEmpty(...candidates: unknown[][]): unknown[] {
    return candidates.find((candidate) => candidate.length > 0) ?? [];
}

/**
 * 时长真值派生：成片 media_files.duration_ms 优先，镜头帧数/fps 汇总兜底。
 * fps 取 source.fps_num/fps_den（默认 24/1）；帧数缺失或 fps<=0 时不产出真值。
 */
function deriveDuration(source: Obj, finalStorageKey: string | null, lookup?: MediaDurationLookup): {
    durationSec: number | null; durationSource: VersionDurationSource; shotsDurationSec: number | null;
} {
    const fpsNum = Number(source.fps_num);
    const fpsDen = Number(source.fps_den);
    const fps = (Number.isFinite(fpsNum) && fpsNum > 0 ? fpsNum : 24) / (Number.isFinite(fpsDen) && fpsDen > 0 ? fpsDen : 1);
    let frames = 0;
    let hasFrames = false;
    for (const shot of arrayOf(source.shots)) {
        const value = Number(recordOf(shot)?.duration_frames);
        if (Number.isFinite(value) && value > 0) { frames += value; hasFrames = true; }
    }
    const shotsDurationSec = hasFrames && fps > 0 ? frames / fps : null;
    if (finalStorageKey && lookup) {
        const durationMs = lookup(finalStorageKey);
        if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0) {
            return { durationSec: durationMs / 1000, durationSource: "media-file", shotsDurationSec };
        }
    }
    if (shotsDurationSec !== null && shotsDurationSec > 0) {
        return { durationSec: shotsDurationSec, durationSource: "shots-frames", shotsDurationSec };
    }
    return { durationSec: null, durationSource: null, shotsDurationSec };
}

function extract(snapshot: unknown, lookup?: MediaDurationLookup): Extracted {
    const root = recordOf(snapshot) ?? {};
    const director = recordOf(root.director) ?? {};
    const source = recordOf(director.source) ?? {};
    const workflow = recordOf(director.workflow) ?? {};
    const artifacts = arrayOf(director.artifacts);

    const shots = firstNonEmpty(arrayOf(source.shots), arrayOf(root.shots));
    const segments = firstNonEmpty(arrayOf(source.segments), arrayOf(root.clipGroups));
    const scenes = firstNonEmpty(arrayOf(source.script_scenes), arrayOf(root.scenes));
    const keyframes = recordOf(root.keyframes) ?? {};

    const shotMap = new Map<string, unknown>();
    for (const shot of shots) {
        const id = text(recordOf(shot)?.id);
        if (id) shotMap.set(id, shot);
    }
    const segmentMap = new Map<string, unknown>();
    for (const segment of segments) {
        const item = recordOf(segment);
        const id = text(item?.id) || text(item?.segmentId);
        if (id) segmentMap.set(id, segment);
    }

    const promptMap = new Map<string, string>();
    let h3ClipCount = 0;
    for (const artifact of artifacts) {
        const item = recordOf(artifact);
        if (!item) continue;
        const kind = text(item.kind).toLowerCase();
        if (kind === "h3" || kind === "video") h3ClipCount++;
        const prompt = text(item.prompt);
        if (!prompt) continue;
        const id = text(item.id) || `${kind}:${text(item.targetId)}`;
        if (id) promptMap.set(id, prompt);
    }
    const promptIds = [...promptMap.keys()].sort();
    const promptsHash = promptIds.length
        ? sha256(stableStringify(promptIds.map((id) => [id, promptMap.get(id) ?? ""])))
        : null;
    const finalResource = recordOf(workflow.finalResource);
    const finalStorageKey = text(finalResource?.storageKey) || null;
    const duration = deriveDuration(source, finalStorageKey, lookup);

    const format: VersionSnapshotSummary["format"] = Object.keys(source).length > 0
        ? "v2-director"
        : (shots.length > 0 || scenes.length > 0 ? "legacy" : "empty");

    return {
        summary: {
            format,
            sceneCount: scenes.length,
            shotCount: shotMap.size,
            segmentCount: segmentMap.size,
            keyframeCount: Object.keys(keyframes).length,
            h3ClipCount,
            promptCount: promptMap.size,
            promptsHash,
            sourceHash: text(director.sourceHash) || text(source.sourceHash) || null,
            finalStorageKey,
            durationSec: duration.durationSec,
            durationSource: duration.durationSource,
            shotsDurationSec: duration.shotsDurationSec,
            shotIds: [...shotMap.keys()].sort(),
            segmentIds: [...segmentMap.keys()].sort(),
            promptIds,
        },
        shots: shotMap,
        segments: segmentMap,
        prompts: promptMap,
    };
}

/** 从单个 snapshot_json 解析出可对比摘要；坏 JSON 交给调用方报错。lookup 由调用方注入以读取成片 media_files.duration_ms。 */
export function summarizeVersionSnapshot(snapshot: unknown, lookup?: MediaDurationLookup): VersionSnapshotSummary {
    return extract(snapshot, lookup).summary;
}

function countDimension(key: string, label: string, from: number, to: number): CountDimension {
    return { key, label, from, to, delta: to - from, changed: from !== to };
}
function numberDimension(key: string, label: string, from: number | null, to: number | null): NumberDimension {
    return { key, label, from, to, delta: from !== null && to !== null ? to - from : null, changed: from !== to };
}
function stringDimension(key: string, label: string, from: string | null, to: string | null): StringDimension {
    return { key, label, from, to, changed: from !== to };
}

function compareEntities(from: Map<string, unknown>, to: Map<string, unknown>): { added: string[]; removed: string[]; changed: EntityChange[] } {
    const added = [...to.keys()].filter((id) => !from.has(id)).sort();
    const removed = [...from.keys()].filter((id) => !to.has(id)).sort();
    const changed: EntityChange[] = [];
    for (const id of [...from.keys()].sort()) {
        if (!to.has(id)) continue;
        const before = from.get(id);
        const after = to.get(id);
        if (stableStringify(before) === stableStringify(after)) continue;
        const beforeRecord = recordOf(before) ?? {};
        const afterRecord = recordOf(after) ?? {};
        const fields = [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])].sort()
            .filter((field) => stableStringify(beforeRecord[field]) !== stableStringify(afterRecord[field]))
            .map((field) => ({ field, from: preview(beforeRecord[field]), to: preview(afterRecord[field]) }));
        changed.push({ id, fields });
    }
    return { added, removed, changed };
}

function comparePrompts(from: Map<string, string>, to: Map<string, string>): { added: string[]; removed: string[]; changed: PromptChange[] } {
    const added = [...to.keys()].filter((id) => !from.has(id)).sort();
    const removed = [...from.keys()].filter((id) => !to.has(id)).sort();
    const changed = [...from.keys()].sort()
        .filter((id) => to.has(id) && from.get(id) !== to.get(id))
        .map((id) => ({ id, fromHash: sha256(from.get(id) ?? ""), toHash: sha256(to.get(id) ?? "") }));
    return { added, removed, changed };
}

/** 逐clip成片 diff：storageKey 变化即「成片更换」；时长/重生成凭证单列，未记录的 clip 不臆造。 */
export function compareClipVideos(from: VersionClipVideo[], to: VersionClipVideo[]): ClipVideoDiff {
    const a = new Map(from.map((item) => [item.clipId, item]));
    const b = new Map(to.map((item) => [item.clipId, item]));
    const added = [...b.keys()].filter((id) => !a.has(id)).sort();
    const removed = [...a.keys()].filter((id) => !b.has(id)).sort();
    const changed: ClipVideoChange[] = [];
    for (const id of [...a.keys()].sort()) {
        if (!b.has(id)) continue;
        const before = a.get(id)!;
        const after = b.get(id)!;
        const storageKeyChanged = before.storageKey !== after.storageKey;
        const durationChanged = before.durationMs !== after.durationMs;
        const regenMetadata = before.generationLogId !== after.generationLogId || before.source !== after.source;
        if (!storageKeyChanged && !durationChanged && !regenMetadata) continue;
        const state: ClipVideoChange["state"] = storageKeyChanged ? "storageKeyChanged"
            : durationChanged ? "durationChanged" : "regenMetadata";
        changed.push({ clipId: id, title: after.title || before.title, from: before, to: after, state, storageKeyChanged, durationChanged });
    }
    return { recordedFrom: from.length > 0, recordedTo: to.length > 0, fromCount: from.length, toCount: to.length, added, removed, changed };
}

/** 两个真实版本快照的结构化 diff，全部字段都由 snapshot_json 派生。 */
export function compareVersionSnapshots(
    episodeId: string,
    from: VersionSnapshotInput,
    to: VersionSnapshotInput,
    fromClipVideos: VersionClipVideo[] = [],
    toClipVideos: VersionClipVideo[] = [],
): VersionDiff {
    const a = extract(from.snapshot, from.lookupMediaDurationMs);
    const b = extract(to.snapshot, to.lookupMediaDurationMs);
    const sa = a.summary;
    const sb = b.summary;
    const shots = compareEntities(a.shots, b.shots);
    const segments = compareEntities(a.segments, b.segments);
    const prompts = comparePrompts(a.prompts, b.prompts);
    const clipVideos = compareClipVideos(fromClipVideos, toClipVideos);
    const dimensions = {
        scenes: countDimension("scenes", "场次", sa.sceneCount, sb.sceneCount),
        shots: countDimension("shots", "镜头", sa.shotCount, sb.shotCount),
        segments: countDimension("segments", "段", sa.segmentCount, sb.segmentCount),
        keyframes: countDimension("keyframes", "关键帧", sa.keyframeCount, sb.keyframeCount),
        h3Clips: countDimension("h3Clips", "成片 clip", sa.h3ClipCount, sb.h3ClipCount),
        prompts: countDimension("prompts", "提示词", sa.promptCount, sb.promptCount),
        durationSec: numberDimension("durationSec", "成片时长（秒）", sa.durationSec, sb.durationSec),
        finalStorageKey: stringDimension("finalStorageKey", "成片 storageKey", sa.finalStorageKey, sb.finalStorageKey),
        sourceHash: stringDimension("sourceHash", "制作源稿指纹", sa.sourceHash, sb.sourceHash),
        promptsHash: stringDimension("promptsHash", "提示词集合指纹", sa.promptsHash, sb.promptsHash),
    };
    const changed = Object.values(dimensions).some((dimension) => dimension.changed)
        || shots.added.length > 0 || shots.removed.length > 0 || shots.changed.length > 0
        || segments.added.length > 0 || segments.removed.length > 0 || segments.changed.length > 0
        || prompts.added.length > 0 || prompts.removed.length > 0 || prompts.changed.length > 0
        || clipVideos.added.length > 0 || clipVideos.removed.length > 0 || clipVideos.changed.length > 0;
    return {
        episodeId,
        from: { version: from.version, stage: from.stage, createdAt: from.createdAt },
        to: { version: to.version, stage: to.stage, createdAt: to.createdAt },
        changed,
        dimensions,
        shots,
        segments,
        prompts,
        clipVideos,
    };
}
