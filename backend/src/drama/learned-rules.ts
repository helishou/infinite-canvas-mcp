import { enabledRulesForCategories, RULE_CATEGORY_LABELS, type RuleCategory } from "@basketikun/canvas-agent/rules/store";

/**
 * 按环节读取已启用的长期规则。general 由 store 自动带上，其余只取声明的类别。
 * 规则是软约束文本，不推导成模型参数；参数仍由制作设置决定。
 */
export async function learnedRulesCompact(categories: RuleCategory[], maxChars = 1200) {
    const rules = await enabledRulesForCategories(categories);
    if (!rules.length) return "";
    const parts: string[] = [];
    let used = 0;
    for (const rule of rules) {
        const part = `${RULE_CATEGORY_LABELS[rule.category]}：${rule.statement}${rule.detail ? `（${rule.detail}）` : ""}`;
        if (used + part.length > maxChars) break;
        parts.push(part);
        used += part.length;
    }
    return parts.join("；");
}
