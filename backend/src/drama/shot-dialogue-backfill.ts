/**
 * 老剧目对白回填：把原文引号台词保守地回填到 director.source.shots[].dialogues。
 *
 * 这是纯逻辑模块，不碰 DB / 文件系统，便于单测。维护脚本
 * maintenance/backfill-shot-dialogues.ts 负责读真值源、备份、写入。
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
    [key: string]: unknown;
}

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
    /** 回填后的镜头浅拷贝（dialogues 已写入），原数组不被修改。 */
    shots: ShotLike[];
    added: number;
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

/**
 * 主入口：对 shots 回填缺失的原文台词。
 * 只回填「现有镜头对白里还没逐字出现」的台词，天然幂等。
 */
export function backfillShots(opts: {
    chapterText: string;
    shots: ShotLike[];
    characterRegistryNames?: string[];
}): BackfillResult {
    const { chapterText, shots } = opts;
    const registryNames = (opts.characterRegistryNames || []).filter(Boolean);
    const lines = quotedSourceLines(chapterText);
    const existingLines = (shots as ShotLike[]).flatMap(s => {
        const ds = Array.isArray(s?.dialogues) ? s.dialogues as Array<Record<string, unknown>> : [];
        return ds.map(d => String(d?.text || ""));
    });
    const missing = missingDialogue(lines, existingLines);
    if (!missing.length) return { assignments: [], shots: shots.map(s => ({ ...s })), added: 0, alreadyPresent: lines.length };

    // 只把缺失的原文台词送进对齐，但用「全部原文台词」的顺序位置保证单调关系稳定。
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

    const nextShots = shots.map((s, idx) => {
        const count = addedCount.get(idx) || 0;
        if (!count) return { ...s };
        const ds = Array.isArray(s?.dialogues) ? (s.dialogues as Array<Record<string, unknown>>).map(d => ({ ...d })) : [];
        for (const a of assignments.filter(x => x.shotIndex === idx)) {
            ds.push({ speaker: a.speaker, text: a.text });
        }
        return { ...s, dialogues: ds };
    });

    return {
        assignments,
        shots: nextShots,
        added: assignments.length,
        alreadyPresent: lines.length - missing.length,
    };
}
