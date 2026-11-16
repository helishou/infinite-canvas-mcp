import { chromium } from "playwright";

const BASE = process.env.CANVAS_TEST_URL || "http://127.0.0.1:3001";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
// 记录所有向后端发出的写请求（生成链路必然 POST）。
const writes = [];
page.on("request", req => {
    const method = req.method();
    if (method === "POST" || method === "PUT") writes.push(`${method} ${req.url()}`);
});

await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
const draft = page.locator("[data-testid='creative-draft']");
await draft.waitFor({ timeout: 25000 });
await page.waitForTimeout(1500); // hydrated

const genCalls = () => writes.filter(u => u.includes("/canvas/generation")).length;

// --- 1) Shift+Enter 不应发送，应换行 ---
await draft.fill("第一行");
writes.length = 0;
await draft.press("Shift+Enter");
await page.waitForTimeout(400);
const shiftVal = await draft.inputValue();
const shiftCalls = genCalls();
console.log("shift+enter:", JSON.stringify({ hasNewline: shiftVal.includes("\n"), value: shiftVal, genCalls: shiftCalls }));

// --- 2) 输入法组字中的 Enter（模拟 isComposing / keyCode 229）不应发送 ---
await draft.fill("组字中");
writes.length = 0;
await draft.evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true }));
});
await page.waitForTimeout(400);
console.log("composing enter genCalls:", genCalls());

// --- 3) 纯 Enter 应发送（触发生成请求） ---
await draft.fill("一只戴宇航头盔的猫，赛博朋克风格");
writes.length = 0;
await draft.press("Enter");
await page.waitForTimeout(1500);
const afterEnterVal = await draft.inputValue();
const enterCalls = genCalls();
console.log("plain enter:", JSON.stringify({ genCalls: enterCalls, draftCleared: afterEnterVal === "", remaining: afterEnterVal.slice(0, 30), allWrites: writes.slice(0, 6) }));

console.log("errors", JSON.stringify(errors));
await browser.close();
