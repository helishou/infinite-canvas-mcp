/**
 * 导演包（`.mmxpack.zip`）互通层：与导演大师的 `minimax-h3-director-pack` v1 同格式。
 *
 * 包里只有三样东西（对着 `E01.mmxpack.zip` 实测）：
 *   pack.json                          { format, formatVersion, taskType, widgets, output }
 *   timeline.json                      { global, output, segments[], shots[] }
 *   shared_params/shared_params.json   { commonEnabled, commonCollapsed, prompt, refs, refAudios, refVideos }
 *   asset_groups/NN/group.json         = 该段镜像（id/prompt/…/refs[]）+ 同级 PictureN.png
 *
 * 这里只做纯数据：把画布制作稿编成这四份，或把包解回可落库的镜头行；
 * 落库、编译、上画布由调用方按既有制作稿链路做（我们不另开一条写库路径）。
 */

export const DIRECTOR_PACK_FORMAT = "minimax-h3-director-pack";
export const DIRECTOR_PACK_VERSION = 1;
export const DIRECTOR_PACK_TASK_TYPE = "r2v — 参考主体生视频(Reference to Video)";

export type DirectorPackOutput = { width: number; height: number; fps: number; continuityEnabled: boolean; continuityOverlapFrames: number };
export type DirectorPackRef = { index: number; fileName: string; type: "input"; subfolder: string; imageFile: string };
export type DirectorPackSegment = {
    id: string;
    prompt: string;
    negativePrompt: string;
    durationSec: number;
    frameCount: number;
    length: number;
    start: number;
    taskType: string;
    refs: DirectorPackRef[];
    refAudios: string[];
    refVideos: string[];
    continuityFromPrev: boolean;
};
export type DirectorPackTimeline = {
    global: { commonEnabled: boolean; commonCollapsed: boolean; prompt: string; refs: DirectorPackRef[]; refAudios: string[]; refVideos: string[]; taskType: string };
    output: DirectorPackOutput;
    segments: DirectorPackSegment[];
    shots: unknown[];
};
export type DirectorPack = {
    pack: { format: string; formatVersion: number; taskType: string; widgets: { task_type: string }; output: DirectorPackOutput };
    timeline: DirectorPackTimeline;
    sharedParams: DirectorPackTimeline["global"];
    groups: Array<{ index: number; segment: DirectorPackSegment; images: Array<{ name: string; bytes: Uint8Array }> }>;
};

/** 草稿里的 camera/景别可能是对象（编译器产出的运镜计划），直接 String() 会变 [object Object]。 */
export function textOf(value: unknown): string {
    if (typeof value === "string") return value.trim();
    if (!value || typeof value !== "object") return "";
    const record = value as Record<string, unknown>;
    const pick = ["description", "label", "text", "summary", "shotSize", "shot_size", "framing", "movement", "angle"]
        .map((key) => record[key])
        .filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
    return pick.length ? pick[0].trim() : "";
}

const num = (value: unknown, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

/** 画布制作稿的一个 Clip → 导演包的一段。`prompt` 用编译好的分镜提示词，没有就按镜头拼。 */
export function segmentFromShotGroup(input: {
    index: number;
    id: string;
    prompt: string;
    durationSec: number;
    fps: number;
    start: number;
    continuityFromPrev?: boolean;
}): DirectorPackSegment {
    const fps = Math.max(1, Math.round(input.fps || 24));
    const durationSec = Math.max(0.1, Math.round(num(input.durationSec, 0) * 100) / 100);
    const frameCount = Math.round(durationSec * fps);
    return {
        id: input.id,
        prompt: String(input.prompt || "").trim(),
        negativePrompt: "",
        durationSec,
        frameCount,
        length: frameCount,
        start: Math.max(0, Math.round(num(input.start, 0))),
        taskType: DIRECTOR_PACK_TASK_TYPE,
        refs: [],
        refAudios: [],
        refVideos: [],
        continuityFromPrev: Boolean(input.continuityFromPrev),
    };
}

/** 分镜正文按累计时间拼成「0–6秒：…」这种导演大师的段提示词格式。 */
export function composeSegmentPrompt(shots: Array<{ visual?: unknown; camera?: unknown; durationSec?: number }>, fps = 24): string {
    if (!shots.length) return "";
    const fpsValue = Math.max(1, Math.round(fps));
    let cursorFrames = 0;
    return shots.map((shot) => {
        const frames = Math.max(1, Math.round(num(shot.durationSec, 0) * fpsValue));
        const from = Math.round(cursorFrames / fpsValue);
        const to = Math.round((cursorFrames + frames) / fpsValue);
        cursorFrames += frames;
        const body = [textOf(shot.camera), textOf(shot.visual)].filter(Boolean).join("。");
        return `${from}–${to}秒：${body}`;
    }).join("\n");
}

export function buildDirectorPack(input: {
    title: string;
    output: DirectorPackOutput;
    segments: DirectorPackSegment[];
}): DirectorPack {
    const output = { ...input.output, fps: Math.max(1, Math.round(input.output.fps || 24)) };
    const global = { commonEnabled: false, commonCollapsed: false, prompt: "", refs: [], refAudios: [], refVideos: [], taskType: DIRECTOR_PACK_TASK_TYPE };
    const timeline: DirectorPackTimeline = { global, output, segments: input.segments, shots: [] };
    return {
        pack: {
            format: DIRECTOR_PACK_FORMAT,
            formatVersion: DIRECTOR_PACK_VERSION,
            taskType: DIRECTOR_PACK_TASK_TYPE,
            widgets: { task_type: DIRECTOR_PACK_TASK_TYPE },
            output,
        },
        timeline,
        sharedParams: global,
        groups: input.segments.map((segment, index) => ({ index: index + 1, segment, images: [] })),
    };
}

/** 解包：吃 zip 里那几份 json（图片按组收着，调用方愿意导入就上传）。 */
export function parseDirectorPack(files: {
    pack: Record<string, unknown>;
    timeline: Record<string, unknown>;
    sharedParams?: Record<string, unknown>;
    groups?: Map<number, { segment: Record<string, unknown>; images: Array<{ name: string; bytes: Uint8Array }> }>;
}): DirectorPack {
    const format = String(files.pack.format || "");
    if (format && format !== DIRECTOR_PACK_FORMAT) throw new Error(`不是导演包：format=${format}`);
    const version = num(files.pack.formatVersion, 0);
    if (version && version > DIRECTOR_PACK_VERSION) throw new Error(`导演包版本 ${version} 高于当前支持的 ${DIRECTOR_PACK_VERSION}`);
    const timeline = files.timeline as Record<string, unknown>;
    const output = (timeline.output || files.pack.output || {}) as Record<string, unknown>;
    const segmentsRaw = Array.isArray(timeline.segments) ? timeline.segments as Array<Record<string, unknown>> : [];
    const segments: DirectorPackSegment[] = segmentsRaw.map((raw, index) => {
        const durationSec = Math.max(0.1, num(raw.durationSec, num(raw.length, 0) / Math.max(1, num(output.fps, 24))));
        return {
            id: String(raw.id || `sh_import_${index + 1}`),
            prompt: String(raw.prompt || ""),
            negativePrompt: String(raw.negativePrompt || ""),
            durationSec,
            frameCount: Math.round(num(raw.frameCount, durationSec * Math.max(1, num(output.fps, 24)))),
            length: Math.round(num(raw.length, durationSec * Math.max(1, num(output.fps, 24)))),
            start: Math.round(num(raw.start, 0)),
            taskType: String(raw.taskType || DIRECTOR_PACK_TASK_TYPE),
            refs: (Array.isArray(raw.refs) ? raw.refs : []) as DirectorPackRef[],
            refAudios: (Array.isArray(raw.refAudios) ? raw.refAudios : []) as string[],
            refVideos: (Array.isArray(raw.refVideos) ? raw.refVideos : []) as string[],
            continuityFromPrev: Boolean(raw.continuityFromPrev),
        };
    });
    const outputValue: DirectorPackOutput = {
        width: Math.round(num(output.width, 1280)),
        height: Math.round(num(output.height, 720)),
        fps: Math.max(1, Math.round(num(output.fps, 24))),
        continuityEnabled: output.continuityEnabled !== false,
        continuityOverlapFrames: Math.round(num(output.continuityOverlapFrames, 22)),
    };
    const global = (files.sharedParams || timeline.global || {}) as Record<string, unknown>;
    const sharedParams = { commonEnabled: Boolean(global.commonEnabled), commonCollapsed: Boolean(global.commonCollapsed), prompt: String(global.prompt || ""), refs: (Array.isArray(global.refs) ? global.refs : []) as DirectorPackRef[], refAudios: (Array.isArray(global.refAudios) ? global.refAudios : []) as string[], refVideos: (Array.isArray(global.refVideos) ? global.refVideos : []) as string[], taskType: String(global.taskType || DIRECTOR_PACK_TASK_TYPE) };
    return {
        pack: { format: DIRECTOR_PACK_FORMAT, formatVersion: DIRECTOR_PACK_VERSION, taskType: DIRECTOR_PACK_TASK_TYPE, widgets: { task_type: DIRECTOR_PACK_TASK_TYPE }, output: outputValue },
        timeline: { global: sharedParams, output: outputValue, segments, shots: Array.isArray(timeline.shots) ? timeline.shots : [] },
        sharedParams,
        groups: segments.map((segment, index) => ({ index: index + 1, segment, images: files.groups?.get(index + 1)?.images || [] })),
    };
}

/**
 * 包里的段落 → 可直接喂给分镜计划器的镜头行。
 *
 * 导演大师一段的提示词本身就是「0–6秒：…
6–12秒：…」的镜头串；整段塞进一个镜头会让
 * 画布编译时再套一层时间轴（变成「0–6秒：0–6秒：…」）。所以按行拆成镜头，
 * 时长取行首区间，正文去掉前缀 —— 结构、节奏都保住。
 */
export type PackShotRow = { title: string; visual: string; camera: string; seconds: number; group: number; segmentId: string };

export function packSegmentsToShotRows(segments: DirectorPackSegment[], fps = 24): PackShotRow[] {
    const fpsValue = Math.max(1, Math.round(fps));
    const rows: PackShotRow[] = [];
    segments.forEach((segment, group) => {
        const prompt = String(segment.prompt || "").trim();
        if (!prompt) return;
        const beats = splitTimedLines(prompt);
        if (!beats.length) {
            const seconds = Math.max(0.5, Math.round((segment.frameCount || Math.round(segment.durationSec * fpsValue)) / fpsValue * 10) / 10);
            rows.push({ title: `第 ${rows.length + 1} 段`, visual: prompt, camera: "", seconds, group, segmentId: segment.id });
            return;
        }
        for (const beat of beats) {
            rows.push({ title: `第 ${rows.length + 1} 段`, visual: beat.visual, camera: beat.camera, seconds: beat.seconds, group, segmentId: segment.id });
        }
    });
    return rows;
}

/**
 * 按导演包原始的段边界重排 Clip 分组。
 *
 * 分镜计划器按 `clipSeconds` 贪心切片，导入 25 段会切成 43 段；用户再导出就不是 1:1 了。
 * 这里不动镜头，只按「来自哪一段」重新切 Clip —— 顺序不变、每段里装回原来的那些镜头。
 */
export function regroupPlanByPackSegments<T extends { shots: Array<{ id: string }>; segments: Array<{ id: string; shot_ids: string[]; mode: string }>; totalFrames: number; totalSeconds: number; diagnostics: string[] }>(
    plan: T,
    groupOfShot: number[],
    segmentIds: string[] = [],
): T {
    const order = plan.shots.map((shot) => shot.id);
    const runs: Array<{ group: number; shotIds: string[] }> = [];
    order.forEach((shotId, index) => {
        const group = groupOfShot[index] ?? index;
        const last = runs[runs.length - 1];
        if (last && last.group === group) last.shotIds.push(shotId);
        else runs.push({ group, shotIds: [shotId] });
    });
    const pool = plan.segments.map((segment) => segment.id);
    const mode = plan.segments[0]?.mode || "T2VA";
    const segments = runs.map((run, index) => ({
        id: segmentIds[run.group] || pool[index] || `seg_pack_${index + 1}`,
        shot_ids: run.shotIds,
        mode,
    }));
    return { ...plan, segments } as T;
}

const TIMED_LINE = /^\s*(\d+(?:\.\d+)?)\s*[–\-~至]\s*(\d+(?:\.\d+)?)\s*秒\s*[：:]\s*/;

/** 把「0–6秒：正文」逐行拆开；一行都没有时间前缀时返回空数组（调用方按整段一个镜头处理）。 */
export function splitTimedLines(prompt: string): Array<{ visual: string; camera: string; seconds: number }> {
    const lines = String(prompt || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const beats: Array<{ visual: string; camera: string; seconds: number }> = [];
    for (const line of lines) {
        const match = TIMED_LINE.exec(line);
        if (!match) continue;
        const from = Number(match[1]);
        const to = Number(match[2]);
        const body = line.slice(match[0].length).trim();
        if (!body) continue;
        const seconds = Math.max(0.5, Math.round((to - from) * 10) / 10);
        beats.push({ visual: body, camera: "", seconds });
    }
    return beats;
}

/** 写回画布时用的 fps 与总时长，方便页面对齐制作稿设置。 */
export function packSummary(pack: DirectorPack) {
    const segments = pack.timeline.segments;
    const totalSeconds = segments.reduce((sum, segment) => sum + segment.durationSec, 0);
    const withRefs = segments.filter((segment) => segment.refs.length > 0).length;
    return { segmentCount: segments.length, totalSeconds: Math.round(totalSeconds * 10) / 10, withRefs, output: pack.timeline.output };
}
