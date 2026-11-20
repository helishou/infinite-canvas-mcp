import { findChannelModel } from "./model-workflow.js";

/**
 * 段级「参考音频上限 maxAudios」权威读取（影策 profile.MaxAudios 的本地等价）。
 *
 * 影策真值链：video.references.maxAudios → profile.MaxAudios → 模型选项 / 请求预演，
 * 提交前 drama_reference_controls.go / dramaSegmentAudioReferences 按该上限校验并跳过超限项。
 * 本地真值放在 ai.config.channels[].models[].maxAudios：这是模型配置里的可填字段，
 * 由模型登记脚本 / 渠道导入写入真实能力（引擎 /v1/models 的 media_inputs.audios，
 * 或 H3 原生 V15 节点的「音频1..3」槽位），缺省时按下面明确标注的默认值回落。
 * 执行链（auto-voice / h3-runner / 制作台 UI）一律从这里读，不再散落写死 3 / 0。
 */

/**
 * H3 原生 V15 节点（NanFengH3MultiReferenceGeneratorV15）确有 3 个参考音频槽位：
 * media-engine/src/comfyui/bridge.ts 的 pickNativeSlots(native, "音频", 3)。
 * 这是本地视频模型没有显式声明 maxAudios 时的真实回落值，不是拍脑袋的常量上限。
 */
export const DEFAULT_VIDEO_MAX_AUDIOS = 3;

/** 只有 reference-to-video 模式允许提交参考音频（影策 MaxAudios=0 的模式照此）。 */
export function isAudioReferenceMode(taskMode: unknown): boolean {
    return String(taskMode || "").toLowerCase() === "ref2va";
}

/** 只接受非负安全整数；非法声明按「未声明」处理，绝不静默夹紧成 3。 */
export function normalizeMaxAudios(value: unknown): number | undefined {
    if (typeof value !== "number" && typeof value !== "string") return undefined;
    if (String(value).trim() === "") return undefined;
    const count = Number(value);
    return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

/**
 * 引擎模型详情里的真实音频输入槽位数。引擎暴露 media_inputs.audios 时以它为准；
 * 没暴露（例如本地注册工作流只有图片字段）时返回 undefined，让调用方用配置/默认值。
 */
export function maxAudiosFromEngineInfo(info: unknown): number | undefined {
    const record = info && typeof info === "object" && !Array.isArray(info) ? info as Record<string, any> : {};
    const media = record.media_inputs ?? record.mediaInputs;
    if (!media || typeof media !== "object" || Array.isArray(media)) return undefined;
    const audios = (media as Record<string, unknown>).audios;
    if (Array.isArray(audios)) return audios.length;
    return normalizeMaxAudios(audios);
}

/** 从模型配置读取显式声明的 maxAudios；未声明返回 undefined。 */
export function modelMaxAudiosOf(aiConfig: unknown, modelValue: string): number | undefined {
    const found = findChannelModel(aiConfig, String(modelValue || ""));
    if (!found) return undefined;
    return normalizeMaxAudios((found.model as Record<string, unknown>).maxAudios);
}

/** 当前模型的参考音频上限：显式配置优先，否则按 H3 原生默认值。 */
export function resolveModelMaxAudios(aiConfig: unknown, modelValue: string): number {
    return modelMaxAudiosOf(aiConfig, modelValue) ?? DEFAULT_VIDEO_MAX_AUDIOS;
}

export type MaxAudiosResolver = (modelValue: string) => number;

/** 从 ai.config 造一个按模型解析上限的函数；在编译/执行链入口传一次。 */
export function aiConfigMaxAudiosResolver(aiConfig: unknown): MaxAudiosResolver {
    return (modelValue) => resolveModelMaxAudios(aiConfig, modelValue);
}

/** 老调用方/单测未注入配置时的回落解析器（等价于显式声明缺省时的默认值）。 */
export const defaultMaxAudiosResolver: MaxAudiosResolver = () => DEFAULT_VIDEO_MAX_AUDIOS;

/**
 * 本次运行的实际上限：非 ref2va 模式一律 0（影策），ref2va 按当前选用模型读。
 */
export function effectiveAudioLimit(resolver: MaxAudiosResolver, modelValue: string, taskMode: unknown): number {
    if (!isAudioReferenceMode(taskMode)) return 0;
    return Math.max(0, Math.floor(resolver(String(modelValue || ""))));
}

/**
 * 影策式超限跳过：保留开口顺序在前的引用，其余交给调用方写 Note 后不发送。
 * 与 deriveAutoVoiceGroupIds 的截断共用同一上限，保证编译期与运行时一致。
 */
export function capAudioReferences<T>(refs: T[], limit: number): { kept: T[]; skipped: T[] } {
    const safe = Math.max(0, Math.floor(Number(limit) || 0));
    return { kept: refs.slice(0, safe), skipped: refs.slice(safe) };
}
