import { BASE_H3_NODE_METADATA } from './node-factory.js';

export const H3_DEFAULTS_KEY = 'plugin:minimax-h3:defaults:v1';
export type H3ParameterSource = 'request' | 'clip' | 'node' | 'nodeParams' | 'defaults' | 'builtIn';
const plannedKeys = new Set(['mode', 'taskMode', 'duration', 'aspectRatio', 'tailFrameContinuation', 'motionContextEnabled', 'motionContextNoiseEnabled', 'seed', 'noiseSeed', 'noiseSeedMode']);

/** The preview and executor resolve exactly the same saved settings. Never mutate the input. */
export function resolveH3Runtime(segment: Record<string, unknown>, override: Record<string, unknown>, metadata: Record<string, unknown>, defaults: Record<string, unknown>) {
    const nodeParams = record(metadata.comfyParams);
    const useDefaults = (segment.h3ParameterPolicy ?? metadata.h3ParameterPolicy) === 'defaults';
    const manualKeys = new Set(Array.isArray(segment.h3ParameterOverrides) ? segment.h3ParameterOverrides.map(String) : []);
    const sources: Record<string, H3ParameterSource> = {};
    const values: Record<string, unknown> = {};
    const layers: Array<[H3ParameterSource, Record<string, unknown>]> = [['request', override], ['clip', segment], ['node', metadata], ['nodeParams', nodeParams], ['defaults', defaults], ['builtIn', BASE_H3_NODE_METADATA]];
    for (const key of H3_PARAM_KEYS) {
        const selected = layers.find(([source, layer]) => {
            // Saved global defaults must not silently connect unrelated Clips.
            if (source === 'defaults' && ['motionContextEnabled', 'tailFrameContinuation'].includes(key)) return false;
            const projection = record(segment.productionClipProjection);
            const explicitStyle = key === 'styleTemplateId' && source === 'clip' && (!segment.productionClipProjection || projection.styleTemplateDeclared === true);
            return !(useDefaults && !plannedKeys.has(key) && !explicitStyle && !manualKeys.has(key) && ['clip', 'node', 'nodeParams'].includes(source)) && layer[key] !== undefined && (key === 'styleTemplateId' || layer[key] !== null);
        });
        if (selected) { values[key] = selected[1][key]; sources[key] = selected[0]; }
    }
    // steps is an execution alias; videoSteps is the persisted domain field.
    if (override.steps === undefined && values.videoSteps !== undefined) { values.steps = values.videoSteps; sources.steps = sources.videoSteps; }
    delete values.videoSteps;
    const parameterIssues: string[] = [];
    if (values.tailFrameContinuation === true && values.motionContextEnabled === true) parameterIssues.push('尾帧参考与潜空间续写的保存值同时开启，请先在 Clip 设置中选择一种衔接方式并保存');
    const requestedSlots = Array.isArray(values.loraSlots) && values.loraSlots.length ? values.loraSlots as Array<Record<string, unknown>> : values.loraName ? [{ name: values.loraName, strength: values.loraStrength ?? 1, enabled: true }] : [];
    for (const slot of requestedSlots) if (slot.enabled !== false && slot.name && slot.strength !== undefined && (!Number.isFinite(Number(slot.strength)) || Number(slot.strength) < H3_LORA_STRENGTH_MIN || Number(slot.strength) > H3_LORA_STRENGTH_MAX)) parameterIssues.push(`LoRA ${slot.name} 的强度超出当前 H3 节点已声明的范围 ${H3_LORA_STRENGTH_MIN}–${H3_LORA_STRENGTH_MAX}，拒绝静默夹紧`);
    if (!Number.isFinite(Number(values.megapixels)) || Number(values.megapixels) <= 0) parameterIssues.push('H3 分辨率必须为有效正数');
    if (sources.loraSlots === 'builtIn' && values.loraName) values.loraSlots = normalizeH3LoraSlots({ ...values, loraSlots: undefined });
    const params = normalizeH3Params({ ...values, ...override }, false);
    delete params.videoSteps;
    const requestedMode = override.mode ?? override.taskMode ?? params.mode ?? params.taskMode;
    params.mode = params.taskMode = canonicalH3TaskMode(requestedMode);
    if (sources.loraSlots === 'builtIn' && String(values.loraName || '').trim()) sources.loraSlots = sources.loraName;
    return { params, sources, parameterIssues, policy: useDefaults ? 'defaults' as const : 'overrides' as const };
}

export function canonicalH3TaskMode(value: unknown): string {
    const aliases: Record<string, string> = { t2va: 't2v', i2va: 'i2v', fl2va: 'fl2v', l2va: 'l2v', ref2v: 'ref2va' };
    const mode = String(value || 'ref2va').toLowerCase();
    return aliases[mode] || mode;
}

/** A deliberate field edit remains effective even when the Clip otherwise follows defaults. */
export function withH3ParameterEdits(segment: Record<string, unknown>, patch: Record<string, unknown>) {
    // Save the companion field too, so inherited defaults cannot re-enable it.
    if (patch.tailFrameContinuation === true) patch = { ...patch, motionContextEnabled: false };
    else if (patch.motionContextEnabled === true) patch = { ...patch, tailFrameContinuation: false };
    if (patch.steps !== undefined && patch.videoSteps === undefined) patch = { ...patch, videoSteps: patch.steps };
    const keys = new Set(Array.isArray(segment.h3ParameterOverrides) ? segment.h3ParameterOverrides.map(String) : []);
    if (patch.h3ParameterPolicy === 'defaults' && !Object.hasOwn(patch, 'h3ParameterOverrides')) keys.clear();
    else for (const key of Object.keys(patch)) if ((H3_PARAM_KEYS as readonly string[]).includes(key)) keys.add(key);
    return Object.keys(patch).some(key => (H3_PARAM_KEYS as readonly string[]).includes(key)) || Object.hasOwn(patch, 'h3ParameterPolicy')
        ? { ...patch, h3ParameterOverrides: [...keys] } : patch;
}

export function canonicalH3AspectRatio(value: unknown) {
    const match = /^\s*(\d+)\s*:\s*(\d+)/.exec(String(value || ''));
    if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) return null;
    const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
    const width = Number(match[1]), height = Number(match[2]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return null;
    const divisor = gcd(width, height);
    return `${width / divisor}:${height / divisor}`;
}

/** Reference numbering may change; the authored dialogue/action prose must survive byte for byte. */
export function h3PromptContent(prompt: string) {
    return prompt.replace(/<(Picture|Subject|Video|Audio)\s*\d+>/gi, (_, kind: string) => `<${kind.toLowerCase()} #>`);
}

export function h3ExpectedDialogues(source: Record<string, unknown>, shotIds: string[]) {
    const shots = Array.isArray(source.shots) ? source.shots.map(record) : [];
    const beats = new Set(shots.filter(shot => shotIds.includes(String(shot.id))).flatMap(shot => Array.isArray(shot.story_beat_ids) ? shot.story_beat_ids.map(String) : []));
    const blocks = Array.isArray(source.script_scenes) ? source.script_scenes.map(record) : [];
    return blocks.filter(block => block.kind === 'dialogue' && (Array.isArray(block.beat_ids) ? block.beat_ids.map(String) : [String(block.id)]).some(id => beats.has(id))).map(block => {
        const text = String(block.text || '').trim(), speaker = String(block.speaker || '');
        const prefix = [speaker + '：', speaker + ':'].find(value => speaker && text.startsWith(value));
        return { blockId: String(block.id), speaker, text: prefix ? text.slice(prefix.length).trim() : text };
    });
}

/** NanFeng V15 uses decimal MP and a 16px grid multiplied by latent alignment. */
export function estimateH3Dimensions(params: Record<string, unknown>, secondPass = false) {
    const ratio = canonicalH3AspectRatio(params.aspectRatio);
    const mp = Number(secondPass ? params.latentUpscaleMegapixels : params.megapixels);
    if (!ratio || !Number.isFinite(mp) || mp <= 0) return null;
    const [rw, rh] = ratio.split(':').map(Number);
    const grid = 16 * Math.max(1, Number(params.latentUpscaleAlign || 2));
    const scale = Math.sqrt(mp * 1_000_000 / (rw * rh));
    return { width: Math.ceil(rw * scale / grid) * grid, height: Math.ceil(rh * scale / grid) * grid, aspectRatio: ratio, megapixels: mp, grid, kind: 'workflow-estimate' as const };
}

export function h3StoryboardIssues(segment: Record<string, unknown>, expected?: Array<{ id: string; duration: number }>) {
    const shots = Array.isArray(segment.storyboardShots) ? segment.storyboardShots.map(record) : [];
    const bindings = Array.isArray(segment.referenceBindings) ? segment.referenceBindings.map(record) : [];
    const ids = shots.map(shot => String(shot.id || ''));
    const issues: string[] = [];
    if (!shots.length && !expected?.length) return issues;
    if (ids.some(id => !id) || new Set(ids).size !== ids.length) issues.push('分镜轨必须使用唯一、稳定的镜头 ID');
    for (const shot of shots) {
        if (shot.referenceBindingId) {
            const binding = bindings.find(ref => ref.id === shot.referenceBindingId && ref.enabled !== false);
            if (!binding || binding.role !== 'storyboard') issues.push(`镜头 ${shot.id} 缺少有效 storyboard 绑定`);
        }
        if (!(Number(shot.duration) > 0)) issues.push(`镜头 ${shot.id} 缺少正时长`);
    }
    if (expected?.length) {
        if (JSON.stringify(ids) !== JSON.stringify(expected.map(shot => shot.id))) issues.push('分镜轨镜头顺序或覆盖范围与正式镜头表不一致');
        for (const shot of expected) if (Math.abs(Number(shots.find(item => item.id === shot.id)?.duration) - shot.duration) > 1e-6) issues.push(`镜头 ${shot.id} 的分镜轨时长与正式镜头表不一致`);
    }
    if (shots.length && Math.abs(shots.reduce((sum, shot) => sum + Number(shot.duration || 0), 0) - Number(segment.duration)) > 1e-6) issues.push('分镜轨总时长与 Clip 时长不一致');
    return issues;
}

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

export const H3_PARAM_KEYS = [
    "minimaxEngine",
    "selectedVideoModelEnabled", "selectedVideoModel", "selectedVideoModelFieldValues",
    "mode", "taskMode", "styleTemplateId", "duration", "aspectRatio", "megapixels", "videoSteps", "steps", "denoise", "noiseSeedMode", "noiseSeed", "seed",
    "modelName", "textEncoder", "textEncoderType", "textEncoderDevice", "videoVae", "audioVae", "precision", "sageAttention", "allowCompile", "sizeMultiple", "sampler", "scheduler",
    "loraSlots", "constantTriggerWord", "lockAudio", "audioDrive", "audioDriveFile", "audioDriveMarkers", "audioDriveSegmentImages", "audioDriveSegmentStoryboards", "audioDriveCreative", "audioDriveExclude", "audioDriveStart", "audioDriveEnd",
    "solAttnEnabled", "solAttnTau", "solAttnThresholdType", "solAttnExactMode", "solAttnDenseSteps", "solAttnStepOff", "solAttnSinkTokens",
    "t8Enabled", "t8ResidualThreshold", "t8StartPercent", "t8EndPercent", "t8MaxConsecutiveHits", "t8CacheDevice", "t8MetricStride", "t8Verbose",
    "sigmaEnabled", "videoSigmaShift", "audioSigmaShift", "sigmaMode", "lowSigmaStart", "lowSigmaEnd", "sigmaRefineSteps", "sigmaCurve", "manualSigma", "dualSampling", "dualSamplingRatio", "dualSampler",
    "secondPassEnabled", "firstPassSteps", "secondPassSteps", "secondPassMegapixels", "secondPassUpscaleMethod", "secondPassDenoise", "secondPassSampler", "secondPassScheduler", "secondPassModel", "secondPassSigma",
    "dedicatedAttention", "startupMode", "faceRefineEnabled", "faceRefineDetector", "faceRefineConfidence", "faceRefineCropFactor", "faceRefineCanvasSize", "faceRefineDenoise", "faceRefineSteps", "faceRefineSampler", "faceRefineScheduler", "faceRefinePasteRegion", "faceRefineMaskDilation", "faceRefineFeather", "faceRefineColourMatch", "faceRefineBlend", "confirmationMode", "seamFaceFadeFrames", "seamColourMatch", "seamAudioCrossfadeMs", "lowMemoryAttentionHeads", "reservedVramGb", "runtimeReserveEnabled", "uniBlockSwapEnabled", "uniBlockSwapBlocks", "keepModelCache",
    "latentUpscaleEnabled", "latentUpscaleConfirmationMode", "h3FirstSteps", "h3SecondSteps", "h3FullSigma", "v81ManualSigma", "latentUpscaleModel", "latentUpscaleMegapixels", "latentUpscaleAlign", "latentUpscalePrecision",
    "realtimePreviewEnabled", "realtimePreviewLongEdge", "realtimePreviewFrames", "realtimePreviewFps", "realtimePreviewJpegQuality",
    "rtxEnabled", "rtxResizeMode", "rtxScale", "rtxWidth", "rtxHeight", "rtxQuality",
    "slaEnabled", "slaSparsity", "slaBlockSize", "slaMinSequence", "slaDenseLastSteps", "slaProtectAudio", "slaDenseSteps", "slaBackend", "slaDisableFp16Accum", "slaStabilizeMotion",
    "emptyFiveMinuteTimeline", "taeh3Enabled", "contextLength", "audioContextLength", "continuationTask", "continuationAudioRefineEnabled", "continuationSeamNoiseEnabled", "continuationSeamNoiseMode", "continuationSeamNoise", "continuationSeamNoiseSeed", "continuationSeamNoiseRamp", "continuationAudioDenoise", "continuationAudioSteps", "continuationAudioSampler", "continuationAudioScheduler", "trtVideoVaeEnabled", "trtDecoderEngine", "trtEncoderEngine", "dlssUpscaleMode", "dlssFrameInterpolationEnabled", "dlssVideoUpscaleMode", "dlssVideoRequireNeuralUpscaling", "dlssVideoNrPreset", "dlssVideoNrStyle", "dlssVideoNrIntensity", "dlssVideoLocalToneStrength", "dlssVideoLocalStructureStrength", "dlssVideoSkinStructureStrength", "dlssVideoAutomaticMask", "dlssVideoModelPreset", "dlssVideoEncodingQuality", "dlssVideoCodec", "dlssVideoContainer", "dlssVideoRename", "dlssVideoCustomSuffix", "dlssVideoHdrMode", "dlssVideoOutputDetailStrength", "dlssFgOutputFps", "dlssFgEngine", "dlssFgEncodingQuality", "dlssFgVideoCodec", "dlssFgContainer", "dlssFgRename", "dlssFgCustomSuffix", "dlssFgHdrMode", "erSolverType", "erMaxStage", "erEta", "erSNoise",
    "refImageSize", "referenceLongEdge", "loraName", "loraStrength", "teAccel", "noDub", "noCaption", "audioMode", "audioDenoiseStrength", "addSourceAsReference", "promptPrimaryAudioOrdinal", "strictPromptTags",
    "referenceVideoPolicy", "trimIn", "trimOut", "motionContextEnabled", "tailFrameContinuation", "motionContextNoiseEnabled", "motionContextNoiseAlpha", "motionContextNoiseAlphaEnd", "motionContextNoiseRampFrames", "combatLoraWeight", "cinematicLoraWeight",
] as const;

export type H3LoraSlot = { name: string; strength: number; enabled: boolean };

const MAX_H3_SEED = Number.MAX_SAFE_INTEGER;

/**
 * 与本机 NanFengH3MultiReferenceGeneratorV15 的「LoRA{N}强度」声明对齐：
 * FLOAT min -4.0、max 10.0、step 0.05；ComfyUI 进程重载节点后 object_info 才会更新。
 * 超出范围时 ComfyUI 会在 /prompt 阶段整体拒绝（HTTP 400
 * prompt_outputs_failed_validation / value_bigger_than_max），任务连队列都进不去，
 * 只对超出 V15 声明范围的值在编译期夹紧，而不是等 ComfyUI 报错。
 * 注意：走 LoraLoader/LoraLoaderModelOnly 的老路径范围是 ±100，这里只约束 V15 原生节点。
 */
export const H3_LORA_STRENGTH_MIN = -4;
export const H3_LORA_STRENGTH_MAX = 10;

export function clampH3LoraStrength(value: unknown, fallback = 1) {
    const strength = Number(value);
    if (!Number.isFinite(strength)) return fallback;
    return Math.min(H3_LORA_STRENGTH_MAX, Math.max(H3_LORA_STRENGTH_MIN, strength));
}

export function parseH3Seed(value: unknown) {
    const seed = Number(value);
    return Number.isSafeInteger(seed) && seed >= 0 && seed <= MAX_H3_SEED ? seed : undefined;
}

export function randomH3Seed() {
    return Math.max(1, Math.floor(Math.random() * MAX_H3_SEED));
}

/**
 * Normalize the two historical LoRA representations into the slot list that
 * the V15 node actually consumes. An empty array is the legacy "not migrated"
 * value; a non-empty array (including disabled/empty slots) is authoritative.
 */
export function normalizeH3LoraSlots(params: Record<string, unknown>) {
    const clampSlots = (slots: unknown[]) => (slots as Array<Record<string, unknown>>).map((slot) => {
        if (!slot || typeof slot !== "object") return slot;
        return slot.strength === undefined || slot.strength === null
            ? slot
            : { ...slot, strength: clampH3LoraStrength(slot.strength) };
    });
    if (Array.isArray(params.loraSlots) && params.loraSlots.length > 0) return clampSlots(params.loraSlots);
    const name = String(params.loraName || "").trim();
    if (!name) return Array.isArray(params.loraSlots) ? clampSlots(params.loraSlots) : [];
    return [{ name, strength: clampH3LoraStrength(params.loraStrength ?? 1), enabled: true } satisfies H3LoraSlot];
}

/**
 * Make the effective seed visible in the task snapshot before the prompt is
 * built. Keep a seed already resolved in the run plan; fill zero/empty values
 * for legacy inputs. New runs reroll random seeds per Clip in CanvasH3Runner,
 * so repeated graph construction and second-pass confirmation stay stable.
 */
export function normalizeH3Params(params: Record<string, unknown>, generateRandomSeed = false) {
    const next: Record<string, unknown> = { ...params };
    const seed = parseH3Seed(next.seed) ?? parseH3Seed(next.noiseSeed);
    const rawMode = String(next.noiseSeedMode || "").toLowerCase();
    const mode = rawMode === "fixed" ? "fixed" : rawMode === "random" ? "random" : seed === undefined || seed === 0 ? "random" : "fixed";
    next.noiseSeedMode = mode;
    const effectiveSeed = mode === "random" && (seed === undefined || seed === 0)
        ? (generateRandomSeed ? randomH3Seed() : seed)
        : seed;
    if (effectiveSeed !== undefined) {
        next.seed = effectiveSeed;
        next.noiseSeed = effectiveSeed;
    }
    next.loraSlots = normalizeH3LoraSlots(next);
    return next;
}

export function resolveH3Seed(params: Record<string, unknown>) {
    const normalized = normalizeH3Params(params, true);
    return parseH3Seed(normalized.seed) ?? randomH3Seed();
}

/** A Clip's Motion Context switch owns the edge to the next Clip. */
export function h3MotionGroup(count: number, selected: number, outgoing: (index: number) => boolean) {
    if (selected < 0 || selected >= count) return null;
    let head = selected;
    let tail = selected;
    while (head > 0 && outgoing(head - 1)) head--;
    while (tail + 1 < count && outgoing(tail)) tail++;
    return head === tail ? null : { head, tail };
}
