/**
 * 影策节奏系统忠实移植：纯函数、无副作用、无外部依赖。
 *
 * 来源（逐行移植，未自创简化版）：
 *   E:/影策本地版/app/backend/internal/production/timing.go
 *     :10-14   常量 MinShotMs / DialoguePadMs / DefaultShotMs
 *     :21-39   DurationOptions / Bounds
 *     :41-74   SnapVideoSeconds
 *     :76-86   NormalizeName
 *     :120-123 MinSegmentShots / MaxSegmentShots
 *     :132-184 SegmentShotsForVideo
 *     :186-207 rebalanceTrailingSegment
 *     :209-227 segmentTitle
 *   E:/影策本地版/app/backend/internal/production/storyboard.go
 *     :11-62   枚举常量（Pacing* / Dialogue* / Segment* / MaxStoryboardShotSeconds / 时长范围）
 *     :86-102  SegmentLimits / TargetSeconds
 *     :104-186 clampInt / Normalized / normalizedDialogueFloat / normalizedDialogueInt / normalizedDirectionLevel
 *     :188-213 StoryboardSettings.SegmentLimits（规则 + 模型档位合成实际约束）
 *     :215-239 pacingRule / pacingRules / BoundsMs / AverageShotSeconds
 *     :241-276 dialogueRule / dialogueRules / dialogue / CharsPerSecond 等
 *     :288-322 ShotMs / ImportedShotMs / SpokenMs / fitDialogue
 *     :336-344 NormalizeTransition
 *
 * Go→JS 语义差异处理见文件末尾注释。
 */

// ---------------------------------------------------------------------------
// 枚举常量（storyboard.go:11-62）
// ---------------------------------------------------------------------------

/** 镜头节奏五档（storyboard.go:13-17）。 */
export const PacingRapid = "rapid";
export const PacingFast = "fast";
export const PacingStandard = "standard";
export const PacingRelaxed = "relaxed";
export const PacingSlow = "slow";

/** 对白密度预设档（storyboard.go:22-26）。 */
export const DialogueDense = "dense";
export const DialogueStandard = "standard";
export const DialogueSparse = "sparse";
export const DialogueCustom = "custom";

/** 剧情段切分模式（storyboard.go:50-55）。 */
export const SegmentAuto = "auto";
export const SegmentFixed = "fixed";
export const SegmentRange = "range";

/** 转场（storyboard.go:39-41）。 */
export const TransitionAuto = "auto";
export const TransitionCut = "cut";
export const TransitionBlack = "fadeblack";
export const TransitionWhite = "fadewhite";

/** 镜头时长常量（timing.go:10-14; storyboard.go:57-61）。 */
export const MinShotMs = 1500;
export const DialoguePadMs = 500;
export const DefaultShotMs = 3000;
export const MinSegmentShots = 3;
export const MaxSegmentShots = 9;
export const MaxStoryboardShotSeconds = 60;
export const MinSegmentSeconds = 4;
export const MaxSegmentSeconds = 60;
/** 单集镜头数上限（parse.go:164 MaxScriptShots）。 */
export const MaxScriptShots = 240;

/** 对白自定义可设范围与默认档（storyboard.go:28-37, 47-48, 19-20）。 */
export const DefaultCharsPerSecond = 4.5;
export const MinCharsPerSecond = 2.0;
export const MaxCharsPerSecond = 8.0;
export const MinLineSeconds = 1.5;
export const MaxLineSeconds = 20.0;
export const MinLineRuneLimit = 4;
export const MaxLineRuneLimit = 40;
export const MinLinePauseMs = 100;
export const MaxLinePauseMs = 2000;
export const MinDirectionLevel = 1;
export const MaxDirectionLevel = 10;
export const DefaultPerformanceLevel = 7;
export const DefaultCameraLevel = 3;
export const DefaultTransitionMs = 150;

// ---------------------------------------------------------------------------
// 类型（与 Go struct 字段同名，便于 1:1 移植调用方语义）
// ---------------------------------------------------------------------------

/** pacingRule（storyboard.go:216-220）。 */
export interface PacingRule {
    minMs: number;
    maxMs: number;
    average: number;
    label: string;
}

/** dialogueRule（storyboard.go:244-249）。 */
export interface DialogueRule {
    charsPerSecond: number;
    lineSeconds: number;
    maxRunes: number;
    pauseMs: number;
}

/** SegmentLimits（storyboard.go:87-93）。 */
export interface SegmentLimits {
    Mode: string;
    MinMs: number;
    MaxMs: number;
}

/** DurationOptions（timing.go:22-27）。 */
export interface DurationOptions {
    Values: number[];
    Min: number;
    Max: number;
    Step: number;
}

/** Segment（timing.go:126-130）；End 不含。 */
export interface Segment {
    Start: number;
    End: number;
    Title: string;
}

/** span(start, end) 求和函数（timing.go:142-148）。 */
export type SpanFn = (start: number, end: number) => number;

/** StoryboardSettings（storyboard.go:64-84）。 */
export interface StoryboardSettings {
    SegmentMode: string;
    SegmentSeconds: number;
    SegmentMinSeconds: number;
    SegmentMaxSeconds: number;
    Pacing: string;
    Dialogue: string;
    SpeechRate: number;
    LineSeconds: number;
    LineMaxRunes: number;
    LinePauseMs: number;
    Transition: string;
    TransitionMs: number;
    Performance: number;
    CameraMotion: number;
}

/** 与 Go 零值结构体等价的空设置（供 Partial 入参补齐）。 */
const ZERO_SETTINGS: StoryboardSettings = {
    SegmentMode: "",
    SegmentSeconds: 0,
    SegmentMinSeconds: 0,
    SegmentMaxSeconds: 0,
    Pacing: "",
    Dialogue: "",
    SpeechRate: 0,
    LineSeconds: 0,
    LineMaxRunes: 0,
    LinePauseMs: 0,
    Transition: "",
    TransitionMs: 0,
    Performance: 0,
    CameraMotion: 0,
};

// ---------------------------------------------------------------------------
// 规则表（storyboard.go:222-228 / :251-255）
// ---------------------------------------------------------------------------

/** pacingRules 五档：minMs / maxMs / average / label（storyboard.go:222-228）。 */
export const pacingRules: Record<string, PacingRule> = {
    [PacingRapid]: {
        minMs: MinShotMs,
        maxMs: 3000,
        average: 2.0,
        label: "极快节奏：1.5–3 秒短镜连切，冲突与反转处密集切换，几乎不用长镜头",
    },
    [PacingFast]: {
        minMs: MinShotMs,
        maxMs: 4000,
        average: 2.5,
        label: "快节奏：多用 2–4 秒短镜，冲突处密集切换",
    },
    [PacingStandard]: {
        minMs: 2000,
        maxMs: 6000,
        average: 3.5,
        label: "标准节奏：2–5 秒为主，关键台词可放到 6 秒",
    },
    [PacingRelaxed]: {
        minMs: 2500,
        maxMs: 8000,
        average: 4.5,
        label: "舒缓节奏：3–6 秒为主，情绪戏可放到 8 秒",
    },
    [PacingSlow]: {
        minMs: 3000,
        maxMs: 10000,
        average: 5.5,
        label: "慢节奏：4–8 秒为主，可用长镜头与空镜营造情绪",
    },
};

/** dialogueRules 三档：charsPerSecond / lineSeconds / maxRunes / pauseMs（storyboard.go:251-255）。 */
export const dialogueRules: Record<string, DialogueRule> = {
    [DialogueDense]: { charsPerSecond: DefaultCharsPerSecond, lineSeconds: 3, maxRunes: 12, pauseMs: 300 },
    [DialogueStandard]: { charsPerSecond: DefaultCharsPerSecond, lineSeconds: 4.5, maxRunes: 16, pauseMs: DialoguePadMs },
    [DialogueSparse]: { charsPerSecond: DefaultCharsPerSecond, lineSeconds: 7, maxRunes: 20, pauseMs: DialoguePadMs },
};

// ---------------------------------------------------------------------------
// 小型工具（storyboard.go:104-106 / :167-186）
// ---------------------------------------------------------------------------

/** clampInt：max(low, min(high, value))（storyboard.go:104-106）。 */
function clampInt(value: number, low: number, high: number): number {
    return Math.max(low, Math.min(high, value));
}

/** normalizedDialogueFloat（storyboard.go:168-176）。 */
function normalizedDialogueFloat(value: number, fallback: number, low: number, high: number, fill: boolean): number {
    if (!(value > 0)) {
        if (!fill) return 0;
        value = fallback;
    }
    return Math.round(Math.max(low, Math.min(high, value)) * 10) / 10;
}

/** normalizedDialogueInt（storyboard.go:178-186）。 */
function normalizedDialogueInt(value: number, fallback: number, low: number, high: number, fill: boolean): number {
    if (value <= 0) {
        if (!fill) return 0;
        value = fallback;
    }
    return clampInt(value, low, high);
}

/** normalizedDirectionLevel（storyboard.go:160-165）。 */
function normalizedDirectionLevel(level: number, fallback: number): number {
    if (level <= 0) return fallback;
    return clampInt(level, MinDirectionLevel, MaxDirectionLevel);
}

/** 节奏档归一化：非法值按 rapid（storyboard.go:130-134）。 */
function normalizePacing(pacing: string): string {
    return pacingRules[pacing] ? pacing : PacingRapid;
}

/** 对白档归一化：非法值按 dense（storyboard.go:135-139）。自定义档由调用方传规则表。 */
function normalizeDialogue(mode: string): string {
    return dialogueRules[mode] ? mode : DialogueDense;
}

/** 取对白规则；未知档按 dense（storyboard.go:258-263 的预设分支）。 */
export function dialogueRuleFor(mode: string): DialogueRule {
    return dialogueRules[normalizeDialogue(mode)];
}

/** 自定义对白四参数（对应 StoryboardSettings 的 SpeechRate / LineSeconds / LineMaxRunes / LinePauseMs）。 */
export interface CustomDialogueParams {
    /** 语速：每秒字数（charsPerSecond）。 */
    speechRate?: number;
    /** 单句台词目标秒数（LineEverySeconds）。 */
    lineSeconds?: number;
    /** 单句台词字数上限（MaxLineRunes）。 */
    lineMaxRunes?: number;
    /** 台词后的气口毫秒（DialoguePauseMs）。 */
    linePauseMs?: number;
}

/**
 * 用 Normalized 的 custom 分支把四个自定义参数夹到影策合法范围并补齐缺省值，
 * 产出可直接喂给 fitDialogue/ShotMs 的 DialogueRule（不重复实现校验逻辑）。
 */
export function customDialogueRule(params: CustomDialogueParams = {}): DialogueRule {
    const s = Normalized({
        Dialogue: DialogueCustom,
        SpeechRate: params.speechRate ?? 0,
        LineSeconds: params.lineSeconds ?? 0,
        LineMaxRunes: params.lineMaxRunes ?? 0,
        LinePauseMs: params.linePauseMs ?? 0,
    });
    return {
        charsPerSecond: s.SpeechRate,
        lineSeconds: s.LineSeconds,
        maxRunes: s.LineMaxRunes,
        pauseMs: s.LinePauseMs,
    };
}

/** 取节奏规则；未知档按 rapid（storyboard.go:232 / :238）。 */
export function pacingRuleFor(pacing: string): PacingRule {
    return pacingRules[normalizePacing(pacing)];
}

// ---------------------------------------------------------------------------
// Normalized（storyboard.go:108-158）
// ---------------------------------------------------------------------------

/** Normalized 的 Go 零值等价物 + 逐条默认值（storyboard.go:108-158）。 */
export function Normalized(settings: Partial<StoryboardSettings>): StoryboardSettings {
    const s: StoryboardSettings = { ...ZERO_SETTINGS, ...settings };
    switch (s.SegmentMode) {
        case SegmentFixed:
        case SegmentRange:
        case SegmentAuto:
            break;
        default:
            s.SegmentMode = SegmentFixed;
    }
    // 三种模式的数值都保留，切换模式时不丢用户填过的值（storyboard.go:114-123）。
    if (s.SegmentSeconds <= 0) s.SegmentSeconds = 10;
    if (s.SegmentMinSeconds <= 0) s.SegmentMinSeconds = 8;
    if (s.SegmentMaxSeconds <= 0) s.SegmentMaxSeconds = 15;
    s.SegmentSeconds = clampInt(s.SegmentSeconds, MinSegmentSeconds, MaxSegmentSeconds);
    s.SegmentMinSeconds = clampInt(s.SegmentMinSeconds, MinSegmentSeconds, MaxSegmentSeconds);
    s.SegmentMaxSeconds = clampInt(s.SegmentMaxSeconds, MinSegmentSeconds, MaxSegmentSeconds);
    if (s.SegmentMinSeconds > s.SegmentMaxSeconds) {
        const tmp = s.SegmentMinSeconds;
        s.SegmentMinSeconds = s.SegmentMaxSeconds;
        s.SegmentMaxSeconds = tmp;
    }
    s.Pacing = normalizePacing(s.Pacing);
    // 自定义档由调用方自己传规则；这里保留 custom，非法值按 dense。
    if (!dialogueRules[s.Dialogue] && s.Dialogue !== DialogueCustom) s.Dialogue = DialogueDense;
    const custom = s.Dialogue === DialogueCustom;
    const base = dialogueRules[DialogueStandard];
    s.SpeechRate = normalizedDialogueFloat(s.SpeechRate, base.charsPerSecond, MinCharsPerSecond, MaxCharsPerSecond, custom);
    s.LineSeconds = normalizedDialogueFloat(s.LineSeconds, base.lineSeconds, MinLineSeconds, MaxLineSeconds, custom);
    s.LineMaxRunes = normalizedDialogueInt(s.LineMaxRunes, base.maxRunes, MinLineRuneLimit, MaxLineRuneLimit, custom);
    s.LinePauseMs = normalizedDialogueInt(s.LinePauseMs, Math.trunc(base.pauseMs), MinLinePauseMs, MaxLinePauseMs, custom);
    switch (s.Transition) {
        case TransitionCut:
        case TransitionBlack:
        case TransitionWhite:
            break;
        default:
            s.Transition = TransitionAuto;
    }
    if (s.TransitionMs <= 0) s.TransitionMs = DefaultTransitionMs;
    s.TransitionMs = clampInt(s.TransitionMs, DefaultTransitionMs, 1500);
    s.Performance = normalizedDirectionLevel(s.Performance, DefaultPerformanceLevel);
    s.CameraMotion = normalizedDirectionLevel(s.CameraMotion, DefaultCameraLevel);
    return s;
}

// ---------------------------------------------------------------------------
// 时长规则（storyboard.go:230-239 / :288-322）
// ---------------------------------------------------------------------------

/** BoundsMs：返回镜头时长下限与上限（storyboard.go:231-234）。 */
export function BoundsMs(pacing: string): [number, number] {
    const rule = pacingRuleFor(pacing);
    return [rule.minMs, rule.maxMs];
}

/** AverageShotSeconds：估算镜头数与费用用的平均镜头长度（storyboard.go:237-239）。 */
export function AverageShotSeconds(pacing: string): number {
    return pacingRuleFor(pacing).average;
}

/**
 * ShotTarget：按单集时长估算应有镜头数（storyboard.go:278-281）。
 * round(秒数 / 平均镜头秒数)，夹到 [4, MaxScriptShots]。
 */
export function ShotTarget(episodeSeconds: number, pacing: string = PacingRapid): number {
    if (!(episodeSeconds > 0)) return 4;
    return clampInt(Math.round(episodeSeconds / AverageShotSeconds(pacing)), 4, MaxScriptShots);
}

/**
 * LineTarget：一集至少应有的台词/旁白条数（storyboard.go:283-286）。
 * max(1, round(秒数 / 单句台词秒数))。
 */
export function LineTarget(episodeSeconds: number, dialogueMode: string = DialogueDense): number {
    if (!(episodeSeconds > 0)) return 1;
    const lineSeconds = dialogueRuleFor(dialogueMode).lineSeconds;
    return Math.max(1, Math.round(episodeSeconds / lineSeconds));
}

/**
 * SpokenMs：说完一句台词所需时长（含气口）；空台词为 0（storyboard.go:309-315）。
 * 注意 Go 在 TrimSpace 后才统计 rune 数，且 int64(...) 在加 pauseMs 之前截断。
 */
export function SpokenMs(dialogue: string, rule: DialogueRule = dialogueRules[DialogueDense]): number {
    const text = dialogue.trim();
    if (text === "") return 0;
    const runes = Array.from(text).length;
    return Math.trunc((runes / rule.charsPerSecond) * 1000) + rule.pauseMs;
}

/** fitDialogue：台词比 target 长则拉长到说完，上限 60s（storyboard.go:317-322）。 */
export function fitDialogue(
    target: number,
    dialogue: string,
    rule: DialogueRule = dialogueRules[DialogueDense],
): number {
    const spoken = SpokenMs(dialogue, rule);
    if (spoken > target) target = Math.min(spoken, MaxStoryboardShotSeconds * 1000);
    return target;
}

/**
 * ShotMs：剧本建议按节奏夹到上下限，台词只会拉长不截断（storyboard.go:289-296）。
 * hintSeconds <= 0 时 target = DefaultShotMs；夹紧后再 fitDialogue。
 */
export function ShotMs(
    hintSeconds: number,
    dialogue: string,
    pacing: string = PacingRapid,
    dialogueMode: string = DialogueDense,
    rule?: DialogueRule,
): number {
    const [low, high] = BoundsMs(pacing);
    let target = Math.round(hintSeconds * 1000);
    if (target <= 0) target = DefaultShotMs;
    return fitDialogue(Math.max(low, Math.min(high, target)), dialogue, rule ?? dialogueRuleFor(dialogueMode));
}

/**
 * ImportedShotMs：用户写的秒数自由 1–60s，不按 pacing 夹；没写按节奏估算（storyboard.go:300-306）。
 */
export function ImportedShotMs(
    seconds: number,
    dialogue: string,
    pacing: string = PacingRapid,
    dialogueMode: string = DialogueDense,
    rule?: DialogueRule,
): number {
    if (seconds <= 0) return ShotMs(0, dialogue, pacing, dialogueMode, rule);
    const target = Math.max(1000, Math.min(MaxStoryboardShotSeconds * 1000, Math.round(seconds * 1000)));
    return fitDialogue(target, dialogue, rule ?? dialogueRuleFor(dialogueMode));
}

// ---------------------------------------------------------------------------
// DurationOptions / SnapVideoSeconds（timing.go:21-74）
// ---------------------------------------------------------------------------

/** DurationOptions.Bounds：返回模型单次可生成的最短与最长秒数（timing.go:30-39）。 */
export function durationBounds(options: DurationOptions): [number, number] {
    if (options.Values.length === 0) {
        return [Math.max(options.Min, 0), Math.max(options.Max, 0)];
    }
    let low = options.Values[0];
    let high = options.Values[0];
    for (const value of options.Values.slice(1)) {
        low = Math.min(low, value);
        high = Math.max(high, value);
    }
    return [Math.max(low, 0), Math.max(high, 0)];
}

/** SnapVideoSeconds：选不短于镜头时长的最小可用秒数（timing.go:42-74）。 */
export function SnapVideoSeconds(shotMs: number, options: DurationOptions): number {
    let need = Math.ceil(shotMs / 1000);
    if (need < 1) need = 1;
    const candidates: number[] = [...options.Values];
    if (candidates.length === 0 && options.Max > 0) {
        let step = options.Step;
        if (step <= 0) step = 1;
        let start = options.Min;
        if (start <= 0) start = step;
        // Go: for value := start; value <= options.Max && len(candidates) < 64; value += step
        for (let value = start; value <= options.Max && candidates.length < 64; value += step) {
            candidates.push(value);
        }
    }
    if (candidates.length === 0) {
        return need <= 5 ? 5 : 10;
    }
    candidates.sort((a, b) => a - b); // Go sort.Ints 是数值升序，JS 默认按字典序，必须传比较器
    for (const value of candidates) {
        if (value >= need) return value;
    }
    return candidates[candidates.length - 1];
}

// ---------------------------------------------------------------------------
// SegmentLimits / TargetSeconds / SegmentLimits 推导（storyboard.go:86-102, :188-213）
// ---------------------------------------------------------------------------

/** TargetSeconds：一段的典型时长（storyboard.go:96-102）。Go int() 截断 → Math.trunc。 */
export function TargetSeconds(limits: SegmentLimits): number {
    switch (limits.Mode) {
        case SegmentRange:
            return Math.trunc((limits.MinMs + limits.MaxMs) / 2000);
        default:
            return Math.trunc(limits.MaxMs / 1000);
    }
}

/** 把剧情段规则与视频模型档位合成实际约束（storyboard.go:191-213）。 */
export function segmentLimits(settings: Partial<StoryboardSettings>, model: DurationOptions): SegmentLimits {
    const s = Normalized(settings);
    const [modelMin, modelMax] = durationBounds(model);
    const capped = (seconds: number): number => {
        let value = seconds;
        if (modelMax > 0 && value > modelMax) value = modelMax;
        return Math.max(value, modelMin) * 1000;
    };
    switch (s.SegmentMode) {
        case SegmentFixed: {
            const n = capped(s.SegmentSeconds);
            return { Mode: SegmentFixed, MinMs: n, MaxMs: n };
        }
        case SegmentRange: {
            const high = capped(s.SegmentMaxSeconds);
            return { Mode: SegmentRange, MinMs: Math.min(capped(s.SegmentMinSeconds), high), MaxMs: high };
        }
        default: {
            const limits: SegmentLimits = {
                Mode: SegmentAuto,
                MinMs: modelMin * 1000,
                MaxMs: modelMax * 1000,
            };
            if (limits.MaxMs > 0) limits.MinMs = Math.min(limits.MinMs, limits.MaxMs);
            return limits;
        }
    }
}

// ---------------------------------------------------------------------------
// NormalizeName / segmentTitle（timing.go:76-86 / :209-227）
// ---------------------------------------------------------------------------

/** Go unicode.IsSpace 的 White_Space 集合（不含 U+FEFF，与 JS \s 略有差异）。 */
const GO_SPACE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;
/** Go unicode.IsPunct 对应 Unicode 类别 P。 */
const GO_PUNCT = /\p{P}/u;

/** NormalizeName：小写 + 去空白 + 去标点（timing.go:77-86）。 */
export function NormalizeName(value: string): string {
    let out = "";
    for (const ch of Array.from(value.trim().toLowerCase())) {
        if (GO_SPACE.test(ch) || GO_PUNCT.test(ch)) continue;
        out += ch;
    }
    return out;
}

/** segmentTitle：段内依次出现的场景名，最多 3 个（timing.go:210-227）。 */
export function segmentTitle(scenes: string[]): string {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const scene of scenes) {
        const name = scene.trim();
        const key = NormalizeName(scene);
        if (name === "" || seen.has(key)) continue;
        seen.add(key);
        if (names.length < 3) names.push(name);
    }
    return names.length === 0 ? "剧情段" : names.join(" / ");
}

// ---------------------------------------------------------------------------
// SegmentShotsForVideo / rebalanceTrailingSegment（timing.go:132-207）
// ---------------------------------------------------------------------------

/**
 * SegmentShotsForVideo：按分镜规则把镜头切成剧情段（timing.go:138-184）。
 * - MaxMs 溢出 / 满 9 镜 / 场景切换（当前段须已达 MinMs）断开；fixed 模式不在场景切换处断开。
 * - 不足下限或镜头过少的段，在不超上限时并入前一段。
 * - 尾段不足下限时从前段挪最少镜头补足。
 */
export function SegmentShotsForVideo(scenes: string[], durations: number[], limits: SegmentLimits): Segment[] {
    if (scenes.length === 0 || durations.length !== scenes.length) return [];

    const span: SpanFn = (start, end) => {
        let total = 0;
        for (let i = start; i < end; i++) total += durations[i];
        return total;
    };
    const sceneBreaks = limits.Mode !== SegmentFixed;
    const runs: Segment[] = [];
    let start = 0;
    let total = 0;
    for (let k = 0; k < scenes.length; k++) {
        if (k > start) {
            const over = limits.MaxMs > 0 && total + durations[k] > limits.MaxMs;
            const full = k - start >= MaxSegmentShots;
            const sceneChange =
                sceneBreaks &&
                NormalizeName(scenes[k]) !== NormalizeName(scenes[k - 1]) &&
                total >= limits.MinMs;
            if (over || full || sceneChange) {
                runs.push({ Start: start, End: k, Title: "" });
                start = k;
                total = 0;
            }
        }
        total += durations[k];
    }
    runs.push({ Start: start, End: scenes.length, Title: "" });

    const merged: Segment[] = [];
    for (const run of runs) {
        const last = merged.length - 1;
        if (last >= 0) {
            const prev = merged[last];
            const short =
                run.End - run.Start < MinSegmentShots ||
                prev.End - prev.Start < MinSegmentShots ||
                span(run.Start, run.End) < limits.MinMs;
            const fits =
                (limits.MaxMs <= 0 || span(prev.Start, run.End) <= limits.MaxMs) &&
                run.End - prev.Start <= MaxSegmentShots;
            if (short && fits) {
                merged[last].End = run.End;
                continue;
            }
        }
        merged.push({ ...run });
    }

    // Go 原地修改 segments；这里返回克隆段数组，保持模块纯函数（算法逐行一致）。
    const balanced = rebalanceTrailingSegment(merged, span, limits);
    for (const seg of balanced) {
        seg.Title = segmentTitle(scenes.slice(seg.Start, seg.End));
    }
    return balanced;
}

/**
 * rebalanceTrailingSegment：尾段不足下限时，从前段末尾挪最少镜头过来（timing.go:188-207）。
 * 挪完前段仍不低于下限且至少留一镜，尾段不超上限/镜头上限才生效；否则不改动。
 * 纯函数版：克隆输入段数组后修改并返回，不改动调用方传入的对象。
 */
export function rebalanceTrailingSegment(segments: Segment[], span: SpanFn, limits: SegmentLimits): Segment[] {
    const out = segments.map((seg) => ({ ...seg }));
    const last = out.length - 1;
    if (last < 1 || limits.MinMs <= 0 || span(out[last].Start, out[last].End) >= limits.MinMs) {
        return out;
    }
    const prev = out[last - 1];
    const tail = out[last];
    for (let start = tail.Start - 1; start > prev.Start; start--) {
        const moved = span(start, tail.End);
        if ((limits.MaxMs > 0 && moved > limits.MaxMs) || tail.End - start > MaxSegmentShots) {
            return out;
        }
        if (span(prev.Start, start) < limits.MinMs) {
            return out;
        }
        if (moved >= limits.MinMs) {
            out[last - 1].End = start;
            out[last].Start = start;
            return out;
        }
    }
    return out;
}

/** NormalizeTransition（storyboard.go:336-344）：把剧本给出的转场归一。 */
export function NormalizeTransition(value: string): string {
    switch (value.trim().toLowerCase()) {
        case TransitionBlack:
        case "black":
        case "黑场":
        case "黑场过渡":
        case "fade":
        case "淡入淡出":
            return TransitionBlack;
        case TransitionWhite:
        case "white":
        case "flash":
        case "闪白":
            return TransitionWhite;
    }
    return TransitionCut;
}

/*
 * Go→JS 语义差异处理汇总：
 * - len([]rune(s)) → Array.from(s).length（按 Unicode 码点计，中文/emoji 与 Go rune 一致）。
 * - math.Round → Math.round；int64(float) 的向零截断 → Math.trunc（SpokenMs、TargetSeconds）。
 * - Go 内建 max/min → Math.max / Math.min（clamp、Bounds、Snap 全部逐处对应）。
 * - sort.Ints 数值升序 → candidates.sort((a,b)=>a-b)（JS 默认字典序会错排 5/10）。
 * - unicode.IsSpace → 显式 Go White_Space 集合（不含 U+FEFF，避免 JS \s 多删）；
 *   unicode.IsPunct → \p{P}（Unicode 类别 P）。TrimSpace → String.prototype.trim。
 * - Go 的 rebalanceTrailingSegment 原地改 []Segment；JS 版克隆后修改并返回新数组，
 *   以保证模块无副作用；切分结果完全相同，SegmentShotsForVideo 使用其返回值。
 * - Go map 查表不存在返回零值：这里 pacingRules/dialogueRules 用 Record<string, T>，
 *   BoundsMs/AverageShotSeconds/dialogueRuleFor 先做档位归一化（非法值 → rapid/dense）。
 */
