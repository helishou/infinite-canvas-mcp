// 一次性迁移：把页面外壳/表单里的 Tailwind 静态灰阶换成主题 token。
// 画布节点内部（canvas-node.tsx）与独立视觉页（not-found）保持原样：它们的颜色写在图片/自绘背景上，
// 跟随主题变量反而会失去对比度。
//
// 用法：
//   node scripts/migrate-token-colors.mjs --dry   只统计，不写文件
//   node scripts/migrate-token-colors.mjs         实际替换
import { readFileSync, writeFileSync } from "node:fs";
import { globSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const dry = process.argv.includes("--dry");
const EXCLUDE = [
    "web/src/components/canvas/canvas-node.tsx",
    "web/src/pages/not-found/index.tsx",
];

/** 成对写法（浅色 + dark 变体）整体换成一个 token，先于单选规则执行。 */
const PAIRS = [
    // 第二阶段：浅色侧已换成 token 后，剩余的 dark:*stone* 全部是冗余（token 自己会跟随主题）。
    // 顺序放在最前，避免先被下面的单选规则拆散。
    [/dark:!?(?:text|bg|border|ring|divide|placeholder)-stone-\d{2,3}(?:\/\d{1,3})?\s?/g, ""],
    [/text-stone-500 dark:text-stone-400/g, "text-muted-foreground"],
    [/text-stone-600 dark:text-stone-300/g, "text-muted-foreground"],
    [/text-stone-400 dark:text-stone-300/g, "text-muted-foreground"],
    [/text-stone-900 dark:text-stone-100/g, "text-foreground"],
    [/text-stone-800 dark:text-stone-200/g, "text-foreground"],
    [/border-stone-200 dark:border-stone-700/g, "border-border"],
    [/border-stone-300 dark:border-stone-700/g, "border-border"],
    [/border-stone-300 dark:border-stone-800/g, "border-border"],
    [/border-stone-200 dark:border-stone-800/g, "border-border"],
    [/!border-stone-200 dark:!border-stone-700/g, "!border-border"],
    [/bg-stone-50 dark:bg-stone-900/g, "bg-muted"],
    [/bg-stone-100 dark:bg-stone-900/g, "bg-muted"],
    [/bg-stone-100 dark:bg-stone-800/g, "bg-muted"],
    [/bg-stone-50 dark:bg-stone-800/g, "bg-muted"],
    [/dark:bg-stone-900 dark:/g, "dark:"],
];

/** 单选残留。顺序重要：带变体前缀的长的先替换。 */
const SINGLES = [
    ["hover:text-stone-950", "hover:text-foreground"],
    ["hover:text-stone-900", "hover:text-foreground"],
    ["hover:text-stone-800", "hover:text-foreground"],
    ["hover:text-stone-700", "hover:text-foreground"],
    ["hover:text-stone-600", "hover:text-muted-foreground"],
    ["hover:text-stone-300", "hover:text-foreground"],
    ["hover:text-stone-100", "hover:text-foreground"],
    ["text-stone-950", "text-foreground"],
    ["text-stone-900", "text-foreground"],
    ["text-stone-800", "text-foreground"],
    ["text-stone-700", "text-foreground"],
    ["text-stone-600", "text-muted-foreground"],
    ["text-stone-500", "text-muted-foreground"],
    ["text-stone-400", "text-muted-foreground"],
    ["text-stone-300", "text-muted-foreground"],
    ["hover:bg-stone-100", "hover:bg-muted"],
    ["hover:bg-stone-800", "hover:bg-muted"],
    ["hover:bg-stone-50", "hover:bg-muted/60"],
    ["bg-stone-100", "bg-muted"],
    ["bg-stone-50", "bg-muted"],
    ["bg-stone-200", "bg-muted"],
    ["bg-stone-800", "bg-muted"],
    ["bg-stone-900/40", "bg-muted/40"],
    ["bg-stone-900", "bg-muted"],
    ["bg-stone-950", "bg-background"],
    ["hover:border-stone-400", "hover:border-foreground/30"],
    ["hover:border-stone-300", "hover:border-border"],
    ["border-stone-400", "border-border"],
    ["border-stone-300", "border-border"],
    ["border-stone-200", "border-border"],
    ["border-stone-100", "border-border"],
    ["divide-stone-200", "divide-border"],
    ["divide-stone-700", "divide-border"],
    ["ring-stone-200", "ring-border"],
    ["ring-stone-700", "ring-border"],
];

const files = globSync("web/src/**/*.tsx", { cwd: root })
    .map((file) => file.replace(/\\/g, "/"))
    .filter((file) => !EXCLUDE.includes(file));

const totals = new Map();
const changed = [];
const afterByFile = new Map();

for (const rel of files) {
    const path = join(root, rel);
    const before = readFileSync(path, "utf8");
    let after = before;

    for (const [pattern, replacement] of PAIRS) {
        const hits = (after.match(pattern) || []).length;
        if (!hits) continue;
        after = after.replace(pattern, replacement);
        totals.set(`${pattern.source} → ${replacement}`, (totals.get(`${pattern.source} → ${replacement}`) || 0) + hits);
    }
    for (const [from, to] of SINGLES) {
        const hits = after.split(from).length - 1;
        if (!hits) continue;
        after = after.split(from).join(to);
        totals.set(`${from} → ${to}`, (totals.get(`${from} → ${to}`) || 0) + hits);
    }

    if (after !== before) {
        changed.push(rel);
        if (!dry) writeFileSync(path, after, "utf8");
        afterByFile.set(rel, after);
    }
}

// 迁移后仍残留的灰阶：需要人工判断，不能用规则硬套。
// 注意用"迁移后"的内容判断，否则 dry-run 会把已能自动处理的部分也列出来。
const leftovers = [];
for (const rel of files) {
    const text = afterByFile.get(rel);
    if (!text) continue;
    const matches = text.match(/(?:[a-z-]+:)?!?(?:text|bg|border|ring|divide|placeholder)-(?:stone|gray|zinc|neutral)-\d{2,3}(?:\/\d{1,3})?/g);
    if (matches) leftovers.push({ file: rel, classes: [...new Set(matches)] });
}

console.log(`扫描 ${files.length} 个 tsx，命中 ${changed.length} 个文件${dry ? "（dry-run，未写入）" : ""}\n`);
console.table([...totals.entries()].map(([规则, 次数]) => ({ 规则, 次数 })).sort((a, b) => b.次数 - a.次数));
if (leftovers.length) {
    console.log("\n仍需人工判断：");
    for (const item of leftovers) console.log(`  ${relative(root, join(root, item.file))}: ${item.classes.join(", ")}`);
}
