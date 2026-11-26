import { findChannelModel } from "./model-workflow.js";

/**
 * 视频模型能力字段（影策 DramaModelOption 的同名五项 + promptMaxChars）的本地真值读取与登记派生。
 *
 * 原则：字段缺省 = 未知/不限制，设置页不得据此告警；没有真实来源时不臆造默认值。
 * 真值只有两个来源：
 *   1. 已登记在 ai.config.channels[].models[] 上的显式值（登记脚本写入或设置页用户登记）；
 *   2. 引擎 /v1/models 自愿上报的同名字段（原样透传，读不到就是 undefined）。
 * 另外 videoCapabilitiesFromWorkflowPackage() 供登记脚本从真实工作流派生真值，
 * 只认字段 options / 输出节点 audio 绑定这类图上确实存在的证据。
 * 实测（2026-11，引擎 127.0.0.1:8300 /v1/models 与 /v1/models/{id}）：引擎只上报
 * capability/media_inputs/routing/workflows/fields/parameter_spec，没有分辨率档位，
 * 尺寸是连续 megapixels number 字段，prompt 字段也没有长度上限；故这两个能力不臆造。
 */

export type ModelVideoCapabilities = {
  videoRatios?: string[];
  videoResolutions?: string[];
  generateAudio?: boolean;
  tailFrameChain?: boolean;
  maxVideoSeconds?: number;
  /** 模型级提示词字数硬上限（影策 VideoReferenceConfig.PromptMaxChars，按码点/RuneCount 计）。 */
  promptMaxChars?: number;
};

/** 生成链超限拒绝的统一错误码。 */
export const PROMPT_TOO_LONG = "PROMPT_TOO_LONG";

export type PromptLengthCheck =
  | { ok: true; chars: number; maxChars: number | undefined }
  | { ok: false; code: typeof PROMPT_TOO_LONG; chars: number; maxChars: number; message: string };

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items.length === value.length ? items.slice() : undefined;
}

function booleanOf(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * 画幅选项归一到影策/DramaModelOption 契约的裸 "16:9" 形式。
 * H3 下拉选项是 "16:9 (Widescreen)" 这类带后缀写法，直接登记会让设置页按
 * "16:9" 比对时永远不匹配、误报「不支持画幅」。只保留能解析出比例的项，
 * "原图比例" 这种非比例选项不属于 videoRatios 的可枚举取值，不登记。
 */
function canonicalRatios(value: unknown): string[] | undefined {
  const options = stringArray(value);
  if (!options) return undefined;
  const out: string[] = [];
  for (const option of options) {
    const match = /^(\d+)\s*:\s*(\d+)/.exec(option.trim());
    if (!match) continue;
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (!a || !b) continue;
    const gcd = (x: number, y: number): number => (y ? gcd(y, x % y) : x);
    const divisor = gcd(a, b);
    const canonical = `${a / divisor}:${b / divisor}`;
    if (!out.includes(canonical)) out.push(canonical);
  }
  return out;
}

/** 从一个记录里原样读取全部能力字段（兼容引擎 snake_case 与影策 camelCase）。
 * 只做类型校验与画幅归一，不做任何猜测/补默认；非法或缺失的键一律不返回。
 */
export function normalizeVideoCapabilities(record: unknown): ModelVideoCapabilities {
  if (!isRecord(record)) return {};
  const out: ModelVideoCapabilities = {};
  const ratios = canonicalRatios(record.videoRatios ?? record.video_ratios);
  if (ratios?.length) out.videoRatios = ratios;
  const resolutions = stringArray(record.videoResolutions ?? record.video_resolutions);
  if (resolutions) out.videoResolutions = resolutions;
  const generateAudio = booleanOf(record.generateAudio ?? record.generate_audio);
  if (generateAudio !== undefined) out.generateAudio = generateAudio;
  const tailFrameChain = booleanOf(record.tailFrameChain ?? record.tail_frame_chain);
  if (tailFrameChain !== undefined) out.tailFrameChain = tailFrameChain;
  const maxVideoSeconds = positiveNumber(record.maxVideoSeconds ?? record.max_video_seconds);
  if (maxVideoSeconds !== undefined) out.maxVideoSeconds = maxVideoSeconds;
  const promptMaxChars = positiveInt(record.promptMaxChars ?? record.prompt_max_chars);
  if (promptMaxChars !== undefined) out.promptMaxChars = promptMaxChars;
  return out;
}

/** 从 ai.config 的当前模型读显式登记值；模型未登记或缺字段时返回空对象。 */
export function videoCapabilitiesOf(aiConfig: unknown, modelValue: string): ModelVideoCapabilities {
  const found = findChannelModel(aiConfig, String(modelValue || ""));
  return found ? normalizeVideoCapabilities(found.model) : {};
}

/** 剧目设置留空（跟随默认）时，按全局 ai.config.videoModel 解析；显式选择不受影响。 */
export function resolveConfiguredVideoModel(aiConfig: unknown, modelValue: string): string {
  const explicit = String(modelValue || "").trim();
  if (explicit) return explicit;
  return String((aiConfig as { videoModel?: unknown } | null | undefined)?.videoModel || "").trim();
}

type WorkflowFieldLike = { id?: unknown; name?: unknown; type?: unknown; options?: unknown; max?: unknown; maximum?: unknown };
type WorkflowNodeLike = { inputs?: unknown };

const ASPECT_FIELD = /aspect|画幅|比例|ratio/i;
const RESOLUTION_FIELD = /resolution|分辨率|档位/i;
const DURATION_FIELD = /duration|时长|秒/i;

function fieldsOf(pkg: Record<string, any>): WorkflowFieldLike[] {
  const fields = pkg.config?.fields;
  return Array.isArray(fields) ? fields.filter(isRecord) as WorkflowFieldLike[] : [];
}

function fieldLabel(field: WorkflowFieldLike): string {
  return `${String(field.id || "")} ${String(field.name || "")}`;
}

function optionsOf(field: WorkflowFieldLike): string[] | undefined {
  return stringArray(field.options);
}

/**
 * 从「登记用工作流包」派生真值。只认图上确实存在的事实：
 * - videoRatios：画面比例下拉字段的 options（登记脚本写出来的真实选项）；
 * - videoResolutions：分辨率下拉字段的 options（没有下拉档位时不填，H3 用连续百万像素，故缺省）；
 * - generateAudio：输出节点把音频连进成片（inputs.audio 是 [节点, 序号]）才算 true，没有则 false；
 * - tailFrameChain：工作流声明了图片输入字段就能图生视频（有 fields 但无图片字段时 false）；
 * - maxVideoSeconds：时长字段显式写了 max/maximum 才登记，没有上限声明时缺省。
 * - promptMaxChars：仅当登记包显式写了 promptMaxChars 才登记；text 字段的 max 不算。
 * 没有任何证据的项返回 undefined —— 交由「缺省不告警」处理。
 */
export function videoCapabilitiesFromWorkflowPackage(pkg: unknown): ModelVideoCapabilities {
  if (!isRecord(pkg)) return {};
  const fields = fieldsOf(pkg);
  const out: ModelVideoCapabilities = {};

  const aspect = fields.find((field) => ASPECT_FIELD.test(fieldLabel(field)) && optionsOf(field));
  const ratios = aspect ? canonicalRatios(optionsOf(aspect)) : undefined;
  if (ratios?.length) out.videoRatios = ratios;

  const resolution = fields.find((field) => RESOLUTION_FIELD.test(fieldLabel(field)) && optionsOf(field));
  const resolutions = resolution ? optionsOf(resolution) : undefined;
  if (resolutions) out.videoResolutions = resolutions;

  const workflow = isRecord(pkg.workflow) ? pkg.workflow : {};
  const hasVideoOutput = Object.values(workflow).some((node) => isRecord(node) && isNodePair((node as WorkflowNodeLike).inputs, "images"));
  const hasAudioOutput = Object.values(workflow).some((node) => isRecord(node) && isNodePair((node as WorkflowNodeLike).inputs, "audio"));
  // 只对确实是视频输出的工作流判定音频：出片节点接了音频=有声，没接=确实无声。
  // 没有视频输出（例如图片工作流）就不写这个字段，避免把无关模型误标成「无声」。
  if (hasVideoOutput) out.generateAudio = hasAudioOutput;

  if (fields.length > 0) out.tailFrameChain = fields.some((field) => String(field.type || "").toLowerCase() === "image");

  const duration = fields.find((field) => DURATION_FIELD.test(fieldLabel(field)));
  if (duration) {
    const max = positiveNumber(duration.max ?? duration.maximum);
    if (max !== undefined) out.maxVideoSeconds = max;
  }

  // 字数上限只认显式声明：登记脚本/工作流包写了 promptMaxChars 才登记。
  // 普通 text 字段的 max/maximum 是 UI 输入约束，不是模型字数上限，不能拿来当真值。
  const config = isRecord(pkg.config) ? pkg.config : {};
  const promptMaxChars = positiveInt(config.promptMaxChars ?? pkg.promptMaxChars);
  if (promptMaxChars !== undefined) out.promptMaxChars = promptMaxChars;
  return out;
}

/** 按 Unicode 码点计长度，与影策 RuneCount / Array.from(...).length 对齐（emoji 算 1）。 */
export function promptCodePoints(prompt: unknown): number {
  const text = typeof prompt === "string" ? prompt : prompt === undefined || prompt === null ? "" : String(prompt);
  return Array.from(text).length;
}

/**
 * 生成链准入校验：登记了上限才硬拦，缺省/非法上限保持原有行为（不限制）。
 * 超限返回明确错误码而不是静默截断——截断会毁掉台词和镜头时间码。
 */
export function checkPromptLength(prompt: unknown, maxChars: number | undefined): PromptLengthCheck {
  const chars = promptCodePoints(prompt);
  const limit = positiveInt(maxChars);
  if (limit === undefined) return { ok: true, chars, maxChars: undefined };
  if (chars <= limit) return { ok: true, chars, maxChars: limit };
  return {
    ok: false,
    code: PROMPT_TOO_LONG,
    chars,
    maxChars: limit,
    message: `提示词共 ${chars} 个字符，超过模型上限 ${limit} 个字符（含标点、空格与换行，按码点计）；请精简后重试，不会自动截断。`,
  };
}

/** 直接按当前配置里的模型登记值校验，供生成链在提交视频任务前调用。 */
export function checkVideoPromptLength(aiConfig: unknown, modelValue: string, prompt: unknown): PromptLengthCheck {
  return checkPromptLength(prompt, videoCapabilitiesOf(aiConfig, modelValue).promptMaxChars);
}

function throwIfTooLong(result: PromptLengthCheck): void {
  if (result.ok) return;
  throw Object.assign(new Error(result.message), { code: result.code, chars: result.chars, maxChars: result.maxChars });
}

/** 超限即抛错，错误对象带 code=PROMPT_TOO_LONG，供路由/任务转为明确拒绝响应。 */
export function assertPromptWithinLimit(prompt: unknown, maxChars: number | undefined): void {
  throwIfTooLong(checkPromptLength(prompt, maxChars));
}

/** 配置驱动版：读取段视频模型登记的 promptMaxChars 后硬校验。 */
export function assertVideoPromptWithinLimit(aiConfig: unknown, modelValue: string, prompt: unknown): void {
  throwIfTooLong(checkVideoPromptLength(aiConfig, modelValue, prompt));
}

function isNodePair(inputs: unknown, key: string): boolean {
  if (!isRecord(inputs)) return false;
  const value = inputs[key];
  return Array.isArray(value) && value.length >= 1 && typeof value[0] === "string" && value[0].trim().length > 0;
}
