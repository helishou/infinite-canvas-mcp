import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    for (const lang of ["zh-CN", "en-US"]) for (const theme of ["dark", "light"]) {
        await page.goto(`${process.env.CANVAS_TEST_WEB || "http://127.0.0.1:3001"}/tests/generation-status.html?lang=${lang}&theme=${theme}`);
        const empty = page.getByTestId("empty");
        await empty.waitFor();
        const success = lang === "zh-CN" ? "已完成" : "Completed";
        const failure = lang === "zh-CN" ? "执行失败" : "Failed";
        assert.match(await empty.innerText(), lang === "zh-CN" ? /共 0 个任务/ : /0 tasks:/);
        assert.ok((await empty.innerText()).includes(success));
        const mixed = await page.getByTestId("mixed").innerText();
        assert.match(mixed, lang === "zh-CN" ? /共 4 个任务，排队 1，运行中 1，成功 1，失败 1/ : /4 tasks: 1 queued, 1 running, 1 succeeded, 1 failed/);
        assert.ok(mixed.includes(success));
        for (const id of ["error", "transport", "missing"]) {
            const text = await page.getByTestId(id).innerText();
            assert.ok(text.includes(failure), text);
            assert.doesNotMatch(text, /共 0 个任务|0 tasks:/);
        }
        assert.match(await page.getByTestId("error").innerText(), /fetch failed/);
        assert.match(await page.getByTestId("transport").innerText(), /Transport closed/);
        assert.doesNotMatch(await page.getByTestId("unavailable").innerText(), /共 0 个任务|0 tasks:/);
        const labels = lang === "zh-CN" ? ["编译排队中", "编译运行中", "编译受阻", "编译失败", "编译中断", "编译成功"] : ["Compilation queued", "Compilation running", "Compilation blocked", "Compilation failed", "Compilation interrupted", "Compilation succeeded"];
        for (const [index, status] of ["queued", "running", "blocked", "failed", "interrupted", "succeeded"].entries()) assert.ok((await page.getByTestId("compile-" + status).innerText()).includes(labels[index]));
        const blocked = page.getByTestId("compile-blocked");
        assert.match(await blocked.innerText(), /SH1.visual/);
        await blocked.locator("summary").click();
        assert.match(await blocked.innerText(), /compile-original/);
        assert.match(await page.getByTestId("diagnostics").innerText(), lang === "zh-CN" ? /读取编译诊断/ : /Read compilation diagnostics/);
        assert.match(await page.getByTestId("targets").innerText(), lang === "zh-CN" ? /读取编译目标/ : /Read compilation targets/);
    }
    assert.deepEqual(errors, []);
    console.log("Generation status cards passed in Chinese/English and dark/light themes");
} finally { await browser.close(); }
