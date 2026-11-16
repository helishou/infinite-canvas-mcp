/**
 * 角色设定图（四视图／三视图）的布局契约。
 *
 * 对齐本仓技能模块 `.agents/skills/acheng-director/references/60-assets-and-keyframes.md`：
 * ①正面脸及肩部（锁骨以上）②右侧脸及肩部（锁骨以上）③无头正面服装全身（锁骨以下到鞋底）
 * ④完整背面全身（后脑到鞋底）；2×2 网格、等宽双列、顶行占 1/3 高、底行占 2/3；
 * 同一人同比例同服装同姿势同光线，双手空手下垂，禁手持武器道具，图内无文字水印。
 * 只写「四视图」四个字，生成端会自由排成 1×4 或四张一样，所以做成可校验契约由 Backend 强制。
 */

/** 需要按设定图排版时才算的角色图：提示词或节点标题里出现这些说法。 */
const TURNAROUND_HINTS = /四视图|三视图|设定图|人物卡|turnaround|character\s*sheet|model\s*sheet/i;

/** 四格必备内容：每一项给了中英别名，命中任一即算写入。 */
const REQUIRED_PANELS: Array<{ key: string; test: RegExp; label: string }> = [
    { key: "face_front", test: /正面脸部|正面脸|正脸|front\s*face/i, label: "正面脸及肩部" },
    { key: "face_side", test: /右侧脸|侧脸|right[-\s]*profile|profile\s*above/i, label: "右侧脸及肩部" },
    { key: "body_front", test: /无头|headless|锁骨以下/i, label: "无头正面全身" },
    { key: "body_back", test: /背面全身|完整背面|back\s*full[\s-]*body/i, label: "完整背面全身" },
];

/** 2×2 网格与上下三分：顶行 1/3、底行 2/3。 */
const GRID_RULES: Array<{ test: RegExp; label: string }> = [
    { test: /2\s*[×x*]\s*2|2\s*行\s*2\s*列|双列两行|two\s*by\s*two/i, label: "2×2 网格" },
    { test: /三分之一|1\/3|one\s*third/i, label: "顶行占 1/3 高度" },
];

/** 去掉道具：四视图必须空手。 */
const CLEAN_HANDS = /空手|无手持|not\s*holding|empty\s*hands|hands?\s*empty/i;

/** 2×2 板接近 4:3，太窄会把两列压扁。 */
const MIN_ASPECT = 1.15;

export function isTurnaroundAsset(text: string | null | undefined): boolean {
    return TURNAROUND_HINTS.test(String(text || ""));
}

/** 缺哪几格；返回空数组表示布局合格。 */
export function turnaroundLayoutIssues(prompt: string | null | undefined): string[] {
    const text = String(prompt || "");
    if (!text.trim()) return [...REQUIRED_PANELS.map(item => item.label), ...GRID_RULES.map(item => item.label), "空手不带武器"];
    const missing = REQUIRED_PANELS.filter(item => !item.test.test(text)).map(item => item.label);
    missing.push(...GRID_RULES.filter(item => !item.test.test(text)).map(item => item.label));
    if (!CLEAN_HANDS.test(text)) missing.push("空手不带武器");
    return missing;
}

/** 设定图还要求横版；竖条或方图会把两列压扁。 */
export function turnaroundAspectIssue(width: number | undefined, height: number | undefined): string | undefined {
    const w = Number(width || 0), h = Number(height || 0);
    if (!w || !h) return undefined;
    if (w / h >= MIN_ASPECT) return undefined;
    return `角色四视图要横版（宽高比 ≥ ${MIN_ASPECT}），当前 ${w}×${h}`;
}

/** 拼给生成端的固定排版段；已写过就不重复追加，避免提示词越滚越长。 */
export const TURNAROUND_LAYOUT_CLAUSE =
    "Character turnaround sheet, 2x2 grid with two equal columns: the top row takes one third of the image height and holds two bust panels above the clavicle — a frontal face panel and a right-profile face panel; "
    + "the bottom row takes two thirds of the height and holds a headless frontal costume panel from clavicle to soles, and a complete back full-body panel from the back of the head to the soles. "
    + "All four panels show the same character with the same proportions, costume, hairstyle, standing pose and lighting; hands empty and hanging naturally, no weapon or prop, no text, no labels, no watermark.";

export function applyTurnaroundLayout(prompt: string | null | undefined): string {
    const text = String(prompt || "").trim();
    if (!text) return TURNAROUND_LAYOUT_CLAUSE;
    if (turnaroundLayoutIssues(text).length === 0) return text;
    return `${text}\n\n${TURNAROUND_LAYOUT_CLAUSE}`;
}
