import { H3_VIDEO_MEGAPIXELS, H3_VIDEO_RATIOS, h3VideoDimensions, h3OriginalVideoDimensions } from "@basketikun/canvas-agent/plugins/minimax-h3/node-factory";
import { modelWorkflowConfig, resolveModelChannel, type AiConfig } from "@/stores/use-config-store";
import { normalizeVideoSizeValue } from "./video-size";

export function isLocalH3VideoModel(config: AiConfig, model = config.model || config.videoModel) {
    return resolveModelChannel(config, model).kind === "comfyui" && modelWorkflowConfig(config, model).workflows.some((name) => /h3-local-(?:t2va|i2va|fl2va|ref2va)\.json$/i.test(name));
}

export function h3VideoSettingChanges(config: AiConfig, key: string, value: string): Partial<Pick<AiConfig, "size" | "vquality" | "videoSeconds">> {
    if (key === "size") {
        const match = value.match(/^(\d+)x(\d+)$/);
        return { size: value, ...(match ? { vquality: String(Math.min(Number(match[1]), Number(match[2]))) } : {}) };
    }
    if (key === "vquality") {
        const quality = Number(value.replace(/p$/i, ""));
        const match = normalizeVideoSizeValue(config.size).match(/^(\d+)x(\d+)$/);
        if (!match || !Number.isFinite(quality) || quality < 1) return { vquality: value };
        const scale = quality / Math.min(Number(match[1]), Number(match[2]));
        return { vquality: value, size: `${Math.max(1, Math.round(Number(match[1]) * scale))}x${Math.max(1, Math.round(Number(match[2]) * scale))}` };
    }
    return { videoSeconds: value };
}

export function resolveH3VideoSettings(config: AiConfig, options: { originalRatio?: boolean; referenceDimensions?: { width: number; height: number }; aspectRatio?: string; latentAlign?: number } = {}) {
    const seconds = Number(config.videoSeconds || 6);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 15) throw new Error("h3-duration");
    const match = normalizeVideoSizeValue(config.size).match(/^(\d+)x(\d+)$/);
    const original = config.size === "auto" && options.originalRatio && options.referenceDimensions;
    const sourceRatio = original ? original.width / original.height : undefined;
    let aspectRatio = options.aspectRatio && H3_VIDEO_RATIOS[options.aspectRatio] ? options.aspectRatio : "16:9 (Widescreen)";
    if (match) {
        const ratio = Number(match[1]) / Number(match[2]);
        aspectRatio = Object.keys(H3_VIDEO_RATIOS).reduce((best, name) => {
            const score = (key: string) => Math.abs(Math.log(ratio / (H3_VIDEO_RATIOS[key][0] / H3_VIDEO_RATIOS[key][1])));
            return score(name) < score(best) ? name : best;
        });
    }
    const ratio = sourceRatio || H3_VIDEO_RATIOS[aspectRatio][0] / H3_VIDEO_RATIOS[aspectRatio][1];
    const quality = Number(config.vquality.replace(/p$/i, "")) || 720;
    const requestedArea = match ? Number(match[1]) * Number(match[2]) : quality * quality * Math.max(ratio, 1 / ratio);
    const desiredMp = requestedArea / (original ? 1024 * 1024 : 1_000_000);
    const megapixels = H3_VIDEO_MEGAPIXELS.reduce((best, value) => Math.abs(value - desiredMp) < Math.abs(best - desiredMp) ? value : best);
    const dimensions = original ? h3OriginalVideoDimensions(original.width, original.height, megapixels) : h3VideoDimensions(aspectRatio, megapixels, options.latentAlign);
    return { fields: { duration: seconds, aspect_ratio: original ? "原图比例" : aspectRatio, megapixels }, parameters: { size: `${dimensions.width}x${dimensions.height}`, resolution: String(Math.min(dimensions.width, dimensions.height)), seconds: String(seconds) } };
}
