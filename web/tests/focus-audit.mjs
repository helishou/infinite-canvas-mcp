// 焦点可见性审计：用真实键盘 Tab 遍历，检查每个可聚焦元素是否有可见焦点指示。
// 只看静态样式会误判——focus-visible 只在键盘导航时生效，所以必须按 Tab 走一遍。
// 用法：node web/tests/focus-audit.mjs [--base ...] [--max 40]
import { chromium } from "playwright";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const base = argOf("--base", "http://localhost:3001").replace(/\/$/, "");
const maxTabs = Number(argOf("--max", "40"));
const routes = ["/", "/projects", "/assets", "/prompts", "/workflows", "/config", "/diagnostics/mcp"];

const browser = await chromium.launch();
const rows = [];

for (const route of routes) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${base}${route}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector("h1", { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const seen = new Set();
    const missing = [];
    let visited = 0;

    // 从页面顶部开始，用 Tab 逐个走。用 focus-visible 的实测样式判断，不读源码。
    await page.evaluate(() => document.body.focus());
    for (let index = 0; index < maxTabs; index += 1) {
        await page.keyboard.press("Tab");
        const info = await page.evaluate(() => {
            const el = document.activeElement;
            if (!el || el === document.body) return null;
            const style = getComputedStyle(el);
            const hasOutline = style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
            // antd 把焦点环画在包装器上（输入框 2px 外扩阴影 + 边框变主题色），
            // 只看 input 自身会误判成"没有焦点指示"。
            const wrapper = el.closest(".ant-input-affix-wrapper, .ant-select, .ant-input-number, .ant-picker, .ant-checkbox-wrapper, .ant-radio-wrapper, .ant-segmented");
            const wrapperShadow = wrapper ? getComputedStyle(wrapper).boxShadow : "none";
            const wrapperOutline = wrapper ? getComputedStyle(wrapper).outlineStyle : "none";
            const hasShadow = (style.boxShadow !== "none" && style.boxShadow !== "")
                || (wrapperShadow !== "none" && wrapperShadow !== "")
                || (wrapperOutline !== "none");
            const name = (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 20);
            const key = `${el.tagName}.${String(el.className || "").slice(0, 50)}|${name}`;
            return {
                key,
                tag: el.tagName.toLowerCase(),
                cls: String(el.className || "").slice(0, 56),
                name,
                hasOutline,
                hasShadow,
                outline: `${style.outlineStyle} ${style.outlineWidth}`,
                shadow: (wrapperShadow !== "none" && wrapperShadow ? `wrapper:${wrapperShadow}` : style.boxShadow).slice(0, 46),
            };
        });
        if (!info) break;
        if (seen.has(info.key)) continue;
        seen.add(info.key);
        visited += 1;
        if (!info.hasOutline && !info.hasShadow) missing.push(info);
    }

    rows.push({ route, visited, missing: missing.length, samples: missing.slice(0, 5) });
    await context.close();
}

await browser.close();

console.table(rows.map((item) => ({ 路由: item.route, 遍历元素: item.visited, 无焦点指示: item.missing })));
const total = rows.reduce((sum, item) => sum + item.missing, 0);
console.log(`\n合计无焦点指示：${total}`);

for (const item of rows) {
    if (!item.samples.length) continue;
    console.log(`\n${item.route}`);
    for (const sample of item.samples) console.log(`  ${sample.tag}.${sample.cls}  "${sample.name}"  outline=${sample.outline}`);
}

if (total > 0) process.exitCode = 1;
