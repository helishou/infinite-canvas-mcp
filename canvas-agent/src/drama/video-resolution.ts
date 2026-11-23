/**
 * 剧目级视频分辨率（videoResolution）真下发映射。
 *
 * 影策真值：VideoResolutionField 写 DramaProduction.settings_json.videoResolution，
 * 档位是「短边像素」(480p/720p/1080p)，横竖由作品画幅决定。
 *
 * 本地 H3 段视频出片没有裸 `size` 参数：真实分辨率由 H3 节点的
 * `aspectRatio` + `megapixels` 决定（H3_PARAM_KEYS，resolveH3Runtime 解析），
 * 一采尺寸 = estimateH3Dimensions（二进制 MP、grid 32，与 NanFengH3 V15 一致）。
 * 因此剧目级档位必须落到这两个真实字段，写进 Clip 保存值后才真正影响出片；
 * 仅走请求 params 会被 h3-runner 的 H3_UI_PARAMETER_MISMATCH 守卫挡下（设计如此，
 * 防止 MCP/外部调用静默改面板与出片）。本模块给出档位→真实 H3 参数的唯一换算，
 * 前端展示与后端下发共用，保证「显示值 == 出片值」。
 */
import { canonicalH3AspectRatio, estimateH3Dimensions } from "../plugins/minimax-h3/runtime-params.js";
import { H3_VIDEO_MEGAPIXELS } from "../plugins/minimax-h3/video-settings.js";

/** 剧目级分辨率档位：短边像素（对齐影策 480p/720p/1080p）。 */
export const DRAMA_VIDEO_RESOLUTION_TIERS = ["480p", "720p", "1080p"] as const;
export type DramaVideoResolutionTier = (typeof DRAMA_VIDEO_RESOLUTION_TIERS)[number];

/** 剧目级画幅：横屏 / 竖屏（对齐影策 final-view aspectRatioValue 9:16 竖屏）。 */
export const DRAMA_VIDEO_ASPECT_RATIOS = ["16:9", "9:16"] as const;
export type DramaVideoAspectRatio = (typeof DRAMA_VIDEO_ASPECT_RATIOS)[number];

export function isDramaVideoResolutionTier(value: unknown): value is DramaVideoResolutionTier {
    return DRAMA_VIDEO_RESOLUTION_TIERS.includes(String(value) as DramaVideoResolutionTier);
}

export function isDramaVideoAspectRatio(value: unknown): value is DramaVideoAspectRatio {
    return DRAMA_VIDEO_ASPECT_RATIOS.includes(String(value) as DramaVideoAspectRatio);
}

/** 档位短边像素；"720"/"720P" 也归一为 720p。 */
export function dramaVideoResolutionShortSide(value: unknown): number | null {
    const text = String(value ?? "").trim().toLowerCase();
    const match = /^(\d+)\s*p?$/.exec(text);
    if (!match) return null;
    const short = Number(match[1]);
    return Number.isFinite(short) && short > 0 ? short : null;
}

/** 档位展示标签：720p（短边）· 1280x720（估算实际出片尺寸，随画幅联动）。 */
export function formatDramaVideoResolution(tier: string, aspectRatio: string): string {
    const effective = dramaVideoResolutionToH3(tier, aspectRatio);
    return effective ? `${tier} · ${effective.size}` : `${tier}`;
}

/**
 * 档位 + 画幅 → 真实 H3 出片参数。
 * 返回 null 表示档位非法或画幅非法（调用方应回退到模型默认，不填假开关）。
 *
 * 档位给短边，画幅给长宽比：720p + 9:16 = 短边 720、长边 1280；
 * MR=短边*长边/1024²，取最接近的合法 H3 megapixels 档，再由
 * estimateH3Dimensions 得出原生一采 width×height。
 */
export function dramaVideoResolutionToH3(tier: unknown, aspectRatio: unknown): {
    aspectRatio: DramaVideoAspectRatio;
    megapixels: number;
    size: string;
    resolution: string;
    shortSide: number;
} | null {
    const shortSide = dramaVideoResolutionShortSide(tier);
    if (shortSide === null) return null;
    const ratio = canonicalH3AspectRatio(aspectRatio) || "16:9";
    const isPortrait = ratio === "9:16" || Number(ratio.split(":")[0]) < Number(ratio.split(":")[1]);
    const canonical: DramaVideoAspectRatio = isPortrait ? "9:16" : "16:9";
    const [rw, rh] = canonical.split(":").map(Number);
    const longSide = Math.round(shortSide * (Math.max(rw, rh) / Math.min(rw, rh)));
    const desiredMp = (shortSide * longSide) / (1024 * 1024);
    const megapixels = H3_VIDEO_MEGAPIXELS.reduce((best, value) => Math.abs(value - desiredMp) < Math.abs(best - desiredMp) ? value : best);
    const dims = estimateH3Dimensions({ aspectRatio: canonical, megapixels });
    if (!dims) return null;
    return {
        aspectRatio: canonical,
        megapixels,
        size: `${dims.width}x${dims.height}`,
        resolution: String(Math.min(dims.width, dims.height)),
        shortSide,
    };
}

/**
 * 画幅 + 像素量 → 真实宽高。
 *
 * 引擎「H3 展开流」暴露的是 width/height 直连像素字段，不认 aspectRatio/megapixels
 * （dry_run 实测 params_ignored=['aspectRatio','megapixels']）；画幅只有换算成宽高才进得去。
 * 换算必须复用 estimateH3Dimensions 这个唯一真值，不得自行推导：
 * 手写公式与库在 0.3/0.6/0.8/1.0/1.5/2.0 各档都会差 16px，面板显示就会与出片不符。
 * megapixels 缺省按 0.4MP（与 H3 节点默认一致）。
 */
export function dramaVideoPixels(aspectRatio: unknown, megapixels: unknown): { width: number; height: number } | null {
    const ratio = canonicalH3AspectRatio(aspectRatio);
    if (!ratio) return null;
    const mp = Number(megapixels);
    const dims = estimateH3Dimensions({ aspectRatio: ratio, megapixels: Number.isFinite(mp) && mp > 0 ? mp : 0.4 });
    return dims ? { width: dims.width, height: dims.height } : null;
}
