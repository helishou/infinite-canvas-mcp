/**
 * 对白逐字核查（纯函数）——移植自影策
 * E:/影策本地版/app/backend/internal/production/dialogue_check.go。
 *
 * 规则与 Go 源码逐条对应：
 * - dialogueKey  ← dialogueKey（只保留文字与数字，忽略大小写/标点/空白）
 * - quotedLines  ← quotedLines（引号台词提取，600 rune 窗口、长度门槛），再套同一文件的
 *                  uniqueDialogue（去重 + 被长句包含的片段不重复计）与 isStoryboardMetaKey（元指令过滤）
 * - missingDialogue ← MissingDialogue（镜头台词按顺序拼接后逐句 Contains，长句拆镜不算缺失）
 *
 * 不改原文、不写库、不调模型；调用方自行负责把 shot.dialogues 的 text 取出来喂给 missingDialogue。
 */

/** 只保留文字与数字，用于忽略标点、空白和镜头间拆分的比较。 */
export function dialogueKey(value: string): string {
    return String(value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * 分镜/剧本的元字段标题，不是说话人（Go: storyboardMetaKeys）。
 * 被引号包住的元标题（如「场景」）同样不算台词。
 */
const STORYBOARD_META_KEYS = new Set([
    "场景", "场", "场次", "时间", "地点", "人物", "角色", "出场", "出场人物",
    "景别", "运镜", "镜头", "镜号", "画面", "动作", "时长", "备注", "字幕",
    "音效", "音乐", "bgm", "转场", "道具", "服装", "环境", "光线", "内景",
    "外景", "标题", "梗概", "简介", "剧情", "钩子", "悬念", "主题", "机位",
    "构图", "特效", "提示词", "说明", "注", "集数", "本集", "第一幕", "幕",
]);

/** “第3场”“第1集”“镜头5”这类编号标题不是台词（Go: isStoryboardMetaKey）。 */
export function isStoryboardMetaKey(name: string): boolean {
    const key = String(name ?? "").trim().toLowerCase();
    if (STORYBOARD_META_KEYS.has(key)) return true;
    return key.startsWith("第") || key.startsWith("镜头") || key.startsWith("场景");
}

/**
 * 同 key 去重；被更长的台词完整包含的片段（如剧本行内又带引号）不重复计数。
 * 逐字移植 Go 的 uniqueDialogue。
 */
export function uniqueDialogue(lines: readonly string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const line of lines) {
        const key = dialogueKey(line);
        if (!key || seen.has(key)) continue;
        let contained = false;
        for (const other of result) {
            if (dialogueKey(other).includes(key)) {
                contained = true;
                break;
            }
        }
        if (contained) continue;
        seen.add(key);
        result.push(line);
    }
    return result;
}

/** 开引号 → 闭引号（Go: quotePairs）。同时覆盖中文双引号与直角引号。 */
const QUOTE_PAIRS: Record<string, string> = {
    "\u201C": "\u201D", // “ → ”
    "「": "」",
    "『": "』",
    '"': '"', // " → "
};

const SENTENCE_PUNCTUATION = /[，。！？…!?,~～、；]/;

/**
 * 提取原文引号内的台词，按出现顺序去重并过滤元指令。
 *
 * 长度门槛照抄 Go：key 少于 2 字不要；少于 4 字且不带句读的引号多是专有名词或强调
 * （所谓的“天才”），不算台词。引号最多向后找 600 个字符，防止未闭合引号吞掉整篇。
 */
export function quotedLines(text: string): string[] {
    const chars = Array.from(String(text ?? ""));
    const lines: string[] = [];
    for (let i = 0; i < chars.length; i += 1) {
        const closing = QUOTE_PAIRS[chars[i]];
        if (!closing) continue;
        let end = -1;
        for (let j = i + 1; j < chars.length && j - i < 600; j += 1) {
            if (chars[j] === closing) {
                end = j;
                break;
            }
        }
        if (end < 0) continue;
        const content = chars.slice(i + 1, end).join("").trim();
        i = end; // 跳过整段引号，避免 closing 被当成下一个 opening
        const key = dialogueKey(content);
        if (Array.from(key).length < 2) continue;
        if (Array.from(key).length < 4 && !SENTENCE_PUNCTUATION.test(content)) continue;
        if (isStoryboardMetaKey(content)) continue;
        lines.push(content);
    }
    return uniqueDialogue(lines);
}

/**
 * 返回没有在镜头台词里逐字出现的原文台词。
 * 镜头台词按顺序拼接后比较，所以把长句拆到多个镜头仍算保留（Go: MissingDialogue）。
 */
export function missingDialogue(sourceLines: readonly string[], shotDialogues: readonly string[]): string[] {
    const all = (shotDialogues || []).map(dialogueKey).join("");
    const missing: string[] = [];
    for (const line of sourceLines || []) {
        const key = dialogueKey(line);
        if (key && !all.includes(key)) missing.push(line);
    }
    return missing;
}
