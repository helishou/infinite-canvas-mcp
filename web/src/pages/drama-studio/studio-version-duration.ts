/**
 * 段视频版本的时长真值派生（只读、纯函数）。
 *
 * 口径与影策 take-list 一致：优先真实视频文件时长（generation_logs 产物关联的
 * media_files.duration_ms，由后端 mediaDuration=true 补到 output.durationMs）；
 * 无成片时长时回退到分场镜头帧数按 fps 汇总；两种真值都没有时返回 null，绝不编造。
 */

export type StudioVersionDurationSource = "media-file" | "shots-frames" | null;

export type StudioVersionDuration = {
    durationSec: number | null;
    durationSource: StudioVersionDurationSource;
};

/** 单个视频版本时长：成片媒体时长优先，分场镜头帧数汇总兜底。 */
export function deriveSegmentVersionDuration(outputDurationMs: unknown, shotsDurationSec: number | null): StudioVersionDuration {
    const ms = Number(outputDurationMs);
    if (Number.isFinite(ms) && ms > 0) return { durationSec: ms / 1000, durationSource: "media-file" };
    if (typeof shotsDurationSec === "number" && Number.isFinite(shotsDurationSec) && shotsDurationSec > 0) {
        return { durationSec: shotsDurationSec, durationSource: "shots-frames" };
    }
    return { durationSec: null, durationSource: null };
}

const rows = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const num = (value: unknown): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * 从真实制作稿 source.shots 汇总某段涉及镜头的时长（秒）。
 * shotIds 为空时不猜段时长（返回 null）。fps 取 source.fps_num/fps_den，缺省 24/1。
 */
export function shotsDurationSecOf(source: unknown, shotIds: string[]): number | null {
    const src = record(source);
    if (!src) return null;
    const fpsNum = num(src.fps_num);
    const fpsDen = num(src.fps_den);
    const fps = (fpsNum > 0 ? fpsNum : 24) / (fpsDen > 0 ? fpsDen : 1);
    const selected = new Set(shotIds.map(String).filter(Boolean));
    if (!selected.size || !(fps > 0)) return null;
    let frames = 0;
    let found = false;
    for (const shot of rows(src.shots)) {
        const item = record(shot);
        if (!item || !selected.has(String(item.id))) continue;
        const value = num(item.duration_frames);
        if (value > 0) { frames += value; found = true; }
    }
    return found ? frames / fps : null;
}
