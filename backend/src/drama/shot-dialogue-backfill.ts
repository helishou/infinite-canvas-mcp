/**
 * 老剧目对白回填：把原文引号台词（逐字）回填到 director.source。
 *
 * 这是纯逻辑模块，不碰 DB / 文件系统，便于单测。维护脚本
 * maintenance/backfill-shot-dialogues.ts 负责读真值源、备份、写入。
 *
 * 回填三条真值链（缺一不可，否则 runPrompts 仍读不到台词）：
 *  1. shots[].dialogues          —— auto-voice.ts 仍读的旧对白位（保留兼容）；
 *  2. source.utterances[]        —— runPrompts(pipeline.ts) 读的台词真值；
 *  3. shots[].utterance_refs[]   —— utterance 必须被 shot 引用（v2 契约要求）。
 *
 * 关键修复：不只补「缺失」台词，而是「原文逐字优先」。LLM 改写/编造的 utterance
 * （如「咱们把洞房再布置一回吧」代替原文「再入洞房」）必须被同镜位的原文逐字台词替换，
 * 否则用户听到的仍是错台词。dialogueKey 逐字比对区分「已是原文」(保留) 与「改写版」(替换)。
 *
 * 归属规则（保守可信）：
 *  1. 台词逐字（去标点/空白后）出现在某镜头 visual 里 -> 直接归属该镜头；
 *  2. 其余被叙述化的台词，用「台词 2-gram 关键字 vs visual」重叠打分，
 *     并用动态规划保证台词顺序与镜头顺序单调一致；
 *  3. 已经被逐字台词占用的镜头，对叙述化台词扣分，避免挤进同一镜头。
 * 说话人：镜头 visual 头部「场N｜内景·…｜夜｜沈砚、赵孟坚｜…」的人物栏，
 * 结合原文台词前一句出现的角色名推断；无法确定时退回镜头唯一/首位人物。
 */

export interface ShotLike {
    id?: string;
    visual?: unknown;
    dialogues?: unknown;
    utterance_refs?: unknown;
    duration_frames?: unknown;
    [key: string]: unknown;
}

export interface UtteranceLike {
    id?: string;
    speakerSubjectId?: string;
    speakerName?: string;
    text?: string;
    delivery?: string;
    voiceover?: boolean;
    start?: { shotId?: string; localFrame?: number; [key: string]: unknown };
    end?: { shotId?: string; localFrame?: number; [key: string]: unknown };
    [key: string]: unknown;
}

export interface SubjectLike {
    id?: string;
    kind?: string;
    entityRef?: { kind?: string; id?: string; [key: string]: unknown };
    [key: string]: unknown;
}

export interface RegistryEntryLike {
    id?: string;
    name?: string;
    [key: string]: unknown;
}

/** verbatim-first（默认）：同镜位改写版被原文逐字台词替换；preserve-existing：只补不覆盖。 */
export type UtteranceStrategy = "verbatim-first" | "preserve-existing";

export interface DialogueAssignment {
    lineIndex: number;
    text: string;
    speaker: string;
    shotIndex: number;
    shotId: string;
    method: "exact-visual" | "keyword-overlap";
    score: number;
}

export interface BackfillResult {
    assignments: DialogueAssignment[];
    /** 回填后的镜头浅拷贝（dialogues 与 utterance_refs 已写入），原数组不被修改。 */
    shots: ShotLike[];
    /** 回填后的完整 source.utterances（原文逐字优先，改写版已被替换）。 */
    utterances: UtteranceLike[];
    added: number;
    /** 新增 / 替换 / 保留 / 丢弃的 utterance 数（分别记账，便于维护脚本审计）。 */
    addedUtterances: number;
    replacedUtterances: number;
    retainedUtterances: number;
    droppedUtterances: number;
    /** 原文里已经在现有镜头对白中逐字出现的台词数（跳过）。 */
    alreadyPresent: number;
}

/** 与影策 dialogue_check.go / 前端 dialogueKey 完全一致的规范化。 */
const DIALOGUE_PUNCT = /[\s"'“”"''「」『』《》〈〉,，。.!！?？:：;；、\u2014\u2026\-·]/g;
export function dialogueKey(line: string): string {
    return String(line || "").replace(DIALOGUE_PUNCT, "").toLowerCase();
}

/** 前端 quotedSourceLines 的等价实现：原文引号台词，去重、过滤元指令。 */
export function quotedSourceLines(text: string): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    const re = /[「『“"]([^「」『』“”"]{2,120})[」』”"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(String(text || "")))) {
        const line = m[1].trim();
        const key = dialogueKey(line);
        if (!key || seen.has(key)) continue;
        if (/第.章|本节|此处|如下|台词如下|旁白说明/.test(line)) continue;
        seen.add(key);
        result.push(line);
    }
    return result;
}

/** 前端 missingDialogue 的等价实现：未逐字出现在镜头台词里的原文台词。 */
export function missingDialogue(sourceLines: string[], shotLines: string[]): string[] {
    const all = shotLines.map(dialogueKey).join("");
    return sourceLines.filter(line => {
        const key = dialogueKey(line);
        return Boolean(key) && !all.includes(key);
    });
}

/** 把原文按「第 N 章」拆章，返回正文（含章标题整行剔除）。兼容阿拉伯/中文数字。 */
export function splitChapters(source: string): Array<{ no: number; title: string; body: string }> {
    const chapters: Array<{ no: number; title: string; body: string }> = [];
    const lines = String(source || "").split(/\r?\n/);
    const header = /^\s*第\s*([0-9零〇一二三四五六七八九十百]+)\s*章/;
    let cur: { no: number; title: string; body: string } | null = null;
    for (const line of lines) {
        const m = line.match(header);
        if (m) {
            if (cur) chapters.push(cur);
            cur = { no: cnToNumber(m[1]), title: line.trim(), body: "" };
        } else if (cur) cur.body += line + "\n";
    }
    if (cur) chapters.push(cur);
    return chapters;
}

function cnToNumber(raw: string): number {
    if (/^[0-9]+$/.test(raw)) return Number(raw);
    const map: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (raw in map) return map[raw];
    if (raw === "十") return 10;
    const ten = raw.indexOf("十");
    if (ten >= 0) {
        const high = ten > 0 ? (map[raw[ten - 1]] || 1) : 1;
        const low = ten + 1 < raw.length ? (map[raw[ten + 1]] || 0) : 0;
        return high * 10 + low;
    }
    return Number(raw) || 0;
}

function visuals(shots: ShotLike[]): string[] {
    return shots.map(s => {
        const v = s?.visual;
        return typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
    });
}

function grams(key: string): string[] {
    const out: string[] = [];
    for (let i = 0; i + 2 <= key.length; i++) out.push(key.slice(i, i + 2));
    return out;
}

/** 镜头人物栏：visual 形如「场1｜内景·开封府书房｜夜｜沈砚、赵孟坚｜…」。 */
function shotCharacters(shot: ShotLike, registryNames: string[]): string[] {
    const v = typeof shot?.visual === "string" ? shot.visual : "";
    const parts = v.split(/[｜|]/);
    let names: string[] = [];
    if (parts.length >= 4) {
        names = parts[3].split(/[、,，/]/).map(x => x.trim()).filter(Boolean);
    }
    if (!names.length) {
        for (const name of registryNames) if (name && v.includes(name)) names.push(name);
    }
    return names.filter(name => !/^(内景|外景|日|夜|黄昏|清晨|场\d+)$/.test(name));
}

function speakerFor(line: string, shot: ShotLike, chapterText: string, registryNames: string[]): string {
    const candidates = shotCharacters(shot, registryNames);
    if (!candidates.length) return "";
    if (candidates.length === 1) return candidates[0];
    // 在原文里找到该台词，取其前文一小段；选离台词最近、且属于本镜头人物的角色。
    const at = chapterText.indexOf(line);
    const before = at >= 0 ? chapterText.slice(Math.max(0, at - 80), at) : "";
    let best = ""; let bestPos = -1;
    for (const name of candidates) {
        const pos = before.lastIndexOf(name);
        if (pos > bestPos) { bestPos = pos; best = name; }
    }
    if (best) return best;
    // 兜底：原文前文出现的任何登记角色，若属于本镜头人物则用之。
    for (const name of registryNames) {
        if (candidates.includes(name) && before.lastIndexOf(name) >= 0) return name;
    }
    return candidates[0];
}

/**
 * 说话人名字 → utterance 的合法身份字段。
 * 按 character_registry.name 匹配实体 id，再按 subject_registry.entityRef.id 找稳定 Subject；
 * 找不到 Subject 时用实体 id；完全无法确定时退回 speakerName（utteranceSchema 支持）。
 */
function speakerIdentity(name: string, characterRegistry: RegistryEntryLike[], subjectRegistry: SubjectLike[]): Pick<UtteranceLike, "speakerSubjectId" | "speakerName"> {
    const trimmed = String(name || "").trim();
    if (!trimmed) return { speakerName: "旁白" };
    const character = characterRegistry.find(c => String(c?.name || "").trim() === trimmed);
    const entityId = character ? String(character?.id || "").trim() : "";
    if (entityId) {
        const subject = subjectRegistry.find(s => String(s?.entityRef?.id || "") === entityId && String(s?.entityRef?.kind || "character") === "character");
        if (subject?.id) return { speakerSubjectId: String(subject.id) };
        return { speakerSubjectId: entityId };
    }
    return { speakerName: trimmed };
}

function durationOf(shot: ShotLike): number {
    const raw = Number(shot?.duration_frames);
    return Number.isFinite(raw) && raw > 1 ? Math.floor(raw) : 96;
}

/** 台词在镜中后段（20%~90%）按条数等分，整数帧、严格递增且不越过镜头长度。 */
function frameWindow(duration: number, index: number, count: number): { start: number; end: number } {
    const lo = Math.floor(duration * 0.2);
    const hi = Math.max(lo + 1, Math.floor(duration * 0.9));
    const step = Math.max(1, Math.floor((hi - lo) / Math.max(1, count)));
    const start = Math.min(hi - 1, lo + index * step);
    const end = Math.min(duration, Math.max(start + 1, lo + (index + 1) * step));
    return { start, end };
}

function utteranceText(u: UtteranceLike): string {
    return String(u?.text ?? "");
}

function utteranceShotId(u: UtteranceLike): string {
    const start = u?.start as Record<string, unknown> | undefined;
    return String(start?.shotId ?? start?.shot_id ?? (u as Record<string, unknown>)?.shot_id ?? "");
}

function utteranceRef(shotId: string, utterance: UtteranceLike, duration: number): Record<string, unknown> | null {
    const id = String(utterance?.id || "");
    if (!id) return null;
    const text = utteranceText(utterance);
    const startRaw = Number(utterance?.start?.localFrame);
    const endRaw = Number(utterance?.end?.localFrame);
    const start = Number.isFinite(startRaw) ? Math.max(0, Math.min(duration - 1, Math.floor(startRaw))) : Math.floor(duration * 0.2);
    const sameEnd = String(utterance?.end?.shotId || "") === shotId;
    const end = sameEnd && Number.isFinite(endRaw)
        ? Math.max(start + 1, Math.min(duration, Math.floor(endRaw)))
        : Math.min(duration, Math.max(start + 1, Math.floor(duration * 0.9)));
    return {
        utteranceId: id,
        role: "speaker",
        localStartFrame: start,
        localEndFrame: end,
        textStart: 0,
        textEnd: Array.from(text).length,
    };
}

const EXACT_BONUS = 100;
const EXACT_SHOT_PENALTY = 3; // 已被逐字台词占用的镜头，对叙述化台词轻微扣分

interface ScoreCtx {
    visKeys: string[];
    exactShots: Set<number>;
    lineGrams: string[][];
    lineKeys: string[];
}

function scoreLine(lineIndex: number, shotIndex: number, ctx: ScoreCtx): number {
    const lk = ctx.lineKeys[lineIndex];
    const vk = ctx.visKeys[shotIndex];
    if (!lk || !vk) return 0;
    const gs = ctx.lineGrams[lineIndex];
    const overlap = gs.reduce((n, g) => n + (vk.includes(g) ? 1 : 0), 0);
    if (vk.includes(lk)) return EXACT_BONUS + overlap;
    let score = overlap;
    if (ctx.exactShots.has(shotIndex)) score -= EXACT_SHOT_PENALTY;
    return score;
}

/** 单调动态规划：把 lines 按顺序映射到 shots（允许多个台词同一镜头），最大化总得分。 */
export function alignLinesToShots(lines: string[], shots: ShotLike[], minAnchorKeyLength = 4): number[] {
    const n = lines.length, m = shots.length;
    if (!n || !m) return new Array(n).fill(-1);
    const visKeys = visuals(shots).map(dialogueKey);
    const lineKeys = lines.map(dialogueKey);
    const lineGrams = lineKeys.map(grams);
    // 只有「足够长、像一句台词」的逐字锚点才占用镜头；短被引词（如「周举子」）
    // 只是名词，不该让它所在的镜头对相邻的叙述化台词产生排他惩罚。
    const exactShots = new Set<number>();
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
        if (lineKeys[i].length >= minAnchorKeyLength && visKeys[j] && visKeys[j].includes(lineKeys[i])) exactShots.add(j);
    }
    const ctx: ScoreCtx = { visKeys, exactShots, lineKeys, lineGrams };
    const dp: number[][] = Array.from({ length: n }, () => new Array(m).fill(-Infinity));
    const parent: number[][] = Array.from({ length: n }, () => new Array(m).fill(-1));
    for (let j = 0; j < m; j++) dp[0][j] = scoreLine(0, j, ctx);
    for (let i = 1; i < n; i++) {
        for (let j = 0; j < m; j++) {
            let bestK = -1, bestVal = -Infinity;
            for (let k = 0; k <= j; k++) {
                if (dp[i - 1][k] >= bestVal) { bestVal = dp[i - 1][k]; bestK = k; } // 并列取较大的 k（倾向靠后的镜头）
            }
            dp[i][j] = scoreLine(i, j, ctx) + (bestVal === -Infinity ? 0 : bestVal);
            parent[i][j] = bestK;
        }
    }
    let bestJ = 0;
    for (let j = 1; j < m; j++) if (dp[n - 1][j] >= dp[n - 1][bestJ]) bestJ = j;
    const result = new Array<number>(n).fill(-1);
    let j = bestJ;
    for (let i = n - 1; i >= 0; i--) { result[i] = j; j = i > 0 ? parent[i][j] : -1; }
    return result;
}

type UtteranceMerge = {
    byShot: Map<number, UtteranceLike[]>;
    unpositioned: UtteranceLike[];
    /** 被原文逐字台词覆盖的镜头（只有这些镜头需要重建 utterance_refs）。 */
    coveredShots: Set<number>;
    added: number;
    replaced: number;
    retained: number;
    dropped: number;
};

/**
 * 按镜位合并原文逐字台词与已有 utterances：
 *  - 已有逐字台词（dialogueKey 命中）→ 原样保留（幂等、不覆盖）；
 *  - 同镜位的改写版/编造台词 → 用原文逐字台词替换其 text（保留 id/帧窗）；
 *  - 镜位没有原文台词的 utterance → 原样保留；
 *  - 同镜位多余的改写版 → 丢弃（否则错台词仍会被念出来）。
 */
function mergeUtterances(input: {
    lines: string[];
    targets: number[];
    shots: ShotLike[];
    existing: UtteranceLike[];
    speakerByLineKey: Map<string, string>;
    characterRegistry: RegistryEntryLike[];
    subjectRegistry: SubjectLike[];
    strategy: UtteranceStrategy;
}): UtteranceMerge {
    const { lines, targets, shots, existing, speakerByLineKey, characterRegistry, subjectRegistry, strategy } = input;
    const sourceKeys = new Set(lines.map(dialogueKey));
    const linesByShot = new Map<number, string[]>();
    lines.forEach((text, i) => {
        const shotIndex = targets[i];
        if (shotIndex == null || shotIndex < 0 || shotIndex >= shots.length) return;
        const arr = linesByShot.get(shotIndex) || [];
        arr.push(text);
        linesByShot.set(shotIndex, arr);
    });

    const shotIndexById = new Map<string, number>();
    shots.forEach((s, i) => { const id = String(s?.id || ""); if (id) shotIndexById.set(id, i); });
    const existingByShot = new Map<number, UtteranceLike[]>();
    const unpositioned: UtteranceLike[] = [];
    existing.forEach(u => {
        const idx = shotIndexById.get(utteranceShotId(u));
        if (idx == null) { unpositioned.push({ ...u }); return; }
        const arr = existingByShot.get(idx) || [];
        arr.push({ ...u });
        existingByShot.set(idx, arr);
    });

    const usedIds = new Set<string>(existing.map(u => String(u?.id || "")).filter(Boolean));
    const identityCache = new Map<string, ReturnType<typeof speakerIdentity>>();
    const identityFor = (text: string) => {
        const name = speakerByLineKey.get(dialogueKey(text)) || "旁白";
        let identity = identityCache.get(name);
        if (!identity) { identity = speakerIdentity(name, characterRegistry, subjectRegistry); identityCache.set(name, identity); }
        return identity;
    };
    const nextId = (base: string): string => {
        let id = base, suffix = 2;
        while (usedIds.has(id)) id = `${base}:${suffix++}`;
        usedIds.add(id);
        return id;
    };

    const byShot = new Map<number, UtteranceLike[]>();
    const coveredShots = new Set<number>();
    let added = 0, replaced = 0, retained = 0, dropped = 0;
    shots.forEach((shot, shotIndex) => {
        const shotId = String(shot?.id || "");
        const candidateTexts = linesByShot.get(shotIndex) || [];
        const pool = existingByShot.get(shotIndex) || [];
        if (!candidateTexts.length) { byShot.set(shotIndex, pool); return; }
        coveredShots.add(shotIndex);
        const duration = durationOf(shot);
        const out: UtteranceLike[] = [];

        candidateTexts.forEach((text, k) => {
            const key = dialogueKey(text);
            const matchIdx = pool.findIndex(u => dialogueKey(utteranceText(u)) === key);
            if (matchIdx >= 0) {
                out.push(pool.splice(matchIdx, 1)[0]);
                retained += 1;
                return;
            }
            if (strategy === "verbatim-first") {
                // 优先拿「文本不属于任何原文台词」的 utterance 当作改写版来替换。
                let reuseIdx = pool.findIndex(u => !sourceKeys.has(dialogueKey(utteranceText(u))));
                if (reuseIdx < 0) reuseIdx = 0;
                if (reuseIdx < pool.length) {
                    const old = pool.splice(reuseIdx, 1)[0];
                    const identity = identityFor(text);
                    const next: UtteranceLike = { ...old, text, voiceover: false };
                    delete next.speakerSubjectId;
                    delete next.speakerName;
                    Object.assign(next, identity);
                    if (!String(next.id || "")) next.id = nextId(`UTT:${shotId || `S${shotIndex}`}:${k + 1}`);
                    out.push(next);
                    replaced += 1;
                    return;
                }
            }
            const window = frameWindow(duration, k, candidateTexts.length);
            out.push({
                id: nextId(`UTT:${shotId || `S${shotIndex}`}:${k + 1}`),
                ...identityFor(text),
                text,
                voiceover: false,
                start: { shotId: shotId, localFrame: window.start },
                end: { shotId: shotId, localFrame: window.end },
            });
            added += 1;
        });

        // 同镜位多余的改写版不能留在真值里（否则 runPrompts 仍会读到错台词）；
        // 逐字原文（哪怕归属到别的镜头）一律保留，绝不删用户原文。
        for (const leftover of pool) {
            if (strategy === "verbatim-first" && !sourceKeys.has(dialogueKey(utteranceText(leftover)))) {
                dropped += 1;
                continue;
            }
            out.push(leftover);
        }
        byShot.set(shotIndex, out);
    });

    return { byShot, unpositioned, coveredShots, added, replaced, retained, dropped };
}

/**
 * 主入口：对 shots 回填缺失的原文台词，并产出 runPrompts 可读的 utterances + utterance_refs。
 * dialogues 只回填「现有镜头对白里还没逐字出现」的台词（天然幂等，兼容 auto-voice）；
 * utterance 则按「原文逐字优先」合并，替换同镜位的 LLM 改写版。
 */
export function backfillShots(opts: {
    chapterText: string;
    shots: ShotLike[];
    characterRegistryNames?: string[];
    characterRegistry?: RegistryEntryLike[];
    subjectRegistry?: SubjectLike[];
    utterances?: UtteranceLike[];
    utteranceStrategy?: UtteranceStrategy;
}): BackfillResult {
    const { chapterText, shots } = opts;
    const characterRegistry = opts.characterRegistry || [];
    const subjectRegistry = opts.subjectRegistry || [];
    const strategy: UtteranceStrategy = opts.utteranceStrategy === "preserve-existing" ? "preserve-existing" : "verbatim-first";
    const registryNames = Array.from(new Set([
        ...(opts.characterRegistryNames || []),
        ...characterRegistry.map(r => String(r?.name || "")),
    ].filter(Boolean)));
    const lines = quotedSourceLines(chapterText);
    const existing = opts.utterances || [];
    const emptyResult = (): BackfillResult => ({
        assignments: [],
        shots: shots.map(s => ({ ...s })),
        utterances: existing.map(u => ({ ...u })),
        added: 0, addedUtterances: 0, replacedUtterances: 0, retainedUtterances: 0, droppedUtterances: 0,
        alreadyPresent: lines.length,
    });
    if (!lines.length) return emptyResult();

    const existingLines = shots.flatMap(s => {
        const ds = Array.isArray(s?.dialogues) ? s.dialogues as Array<Record<string, unknown>> : [];
        return ds.map(d => String(d?.text || ""));
    });
    const missing = missingDialogue(lines, existingLines);

    // 只把缺失的原文台词送进对齐（dialogues 回填保持旧行为），但用「全部原文台词」
    // 的顺序位置保证单调关系稳定。
    const missingIdx = missing.map(text => lines.indexOf(text));
    const ordered = [...missingIdx].sort((a, b) => a - b);
    const orderedTexts = ordered.map(i => lines[i]);
    const targets = alignLinesToShots(orderedTexts, shots);

    const assignments: DialogueAssignment[] = [];
    const addedCount = new Map<number, number>();
    orderedTexts.forEach((text, k) => {
        const shotIndex = targets[k];
        if (shotIndex == null || shotIndex < 0 || shotIndex >= shots.length) return;
        const shot = shots[shotIndex];
        const vis = typeof shot?.visual === "string" ? shot.visual : "";
        const exact = Boolean(dialogueKey(vis) && dialogueKey(vis).includes(dialogueKey(text)));
        assignments.push({
            lineIndex: ordered[k],
            text,
            speaker: speakerFor(text, shot, chapterText, registryNames),
            shotIndex,
            shotId: String(shot?.id || ""),
            method: exact ? "exact-visual" : "keyword-overlap",
            score: exact ? EXACT_BONUS : 0,
        });
        addedCount.set(shotIndex, (addedCount.get(shotIndex) || 0) + 1);
    });

    // 全部原文台词都要对齐到镜头：改写版的替换依据是「镜位 + 逐字比对」，
    // 不能依赖 dialogues 是否缺失（ep3 的 shots.dialogues 就是空的）。
    const targetsAll = alignLinesToShots(lines, shots);
    const assignmentByLineIndex = new Map(assignments.map(a => [a.lineIndex, a]));
    const speakerByLineKey = new Map<string, string>();
    lines.forEach((text, i) => {
        const shotIndex = targetsAll[i];
        if (shotIndex == null || shotIndex < 0 || shotIndex >= shots.length) return;
        const assigned = assignmentByLineIndex.get(i);
        const name = assigned?.speaker || speakerFor(text, shots[shotIndex], chapterText, registryNames);
        speakerByLineKey.set(dialogueKey(text), name || registryNames[0] || "旁白");
    });

    const merged = mergeUtterances({
        lines,
        targets: targetsAll,
        shots,
        existing,
        speakerByLineKey,
        characterRegistry,
        subjectRegistry,
        strategy,
    });

    const nextShots = shots.map((s, idx) => {
        const next: ShotLike = { ...s };
        const count = addedCount.get(idx) || 0;
        if (count) {
            const ds = Array.isArray(s?.dialogues) ? (s.dialogues as Array<Record<string, unknown>>).map(d => ({ ...d })) : [];
            for (const a of assignments.filter(x => x.shotIndex === idx)) {
                ds.push({ speaker: a.speaker, text: a.text });
            }
            next.dialogues = ds;
        }
        // 只有被原文台词覆盖的镜头才重建 utterance_refs；其它镜头保留原引用不动。
        if (merged.coveredShots.has(idx)) {
            const refs = (merged.byShot.get(idx) || [])
                .map(u => utteranceRef(String(s?.id || ""), u, durationOf(s)))
                .filter((r): r is Record<string, unknown> => Boolean(r));
            next.utterance_refs = refs;
        }
        return next;
    });

    const utterances = shots.flatMap((_, idx) => merged.byShot.get(idx) || []).concat(merged.unpositioned);
    return {
        assignments,
        shots: nextShots,
        utterances,
        added: assignments.length,
        addedUtterances: merged.added,
        replacedUtterances: merged.replaced,
        retainedUtterances: merged.retained,
        droppedUtterances: merged.dropped,
        alreadyPresent: lines.length - missing.length,
    };
}
