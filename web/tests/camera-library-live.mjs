import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const root = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".infinite-canvas-root.json"), "utf8"));
const config = JSON.parse(fs.readFileSync(path.join(root.dataDir || path.join(os.homedir(), ".infinite-canvas"), "backend.json"), "utf8"));
const base = process.env.WORKBENCH_WEB_URL || "http://127.0.0.1:3001";
const browser = await chromium.launch({ headless: true });

try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    // 走 Vite 同源代理，让列表与 mp4 都命中真实 Backend（17370）数据。
    await page.addInitScript(({ token }) => {
        localStorage.setItem("backend-url", "http://127.0.0.1:3001");
        localStorage.setItem("backend-token", token);
    }, { token: config.token });

    // 「运镜方式」下拉与弹窗共用这一份清单，页面挂载时只请求一次。
    const libraryLoaded = page.waitForResponse(response => response.url().includes("/camera-library/moves") && response.ok());
    await page.goto(`${base}/tests/camera-library-fixture.html`);
    await libraryLoaded;
    const trigger = page.locator("[data-camera-library-trigger]");
    await trigger.waitFor();

    // 按钮必须落在「景别」同一行的右侧空格（截图红框位置），而不是挤到下一行。
    const framing = page.locator('label').filter({ hasText: "景别" }).first();
    const framingBox = await framing.boundingBox();
    const triggerBox = await trigger.boundingBox();
    assert.ok(framingBox && triggerBox, "景别与镜头库入口都应可见");
    assert.ok(Math.abs(framingBox.y - triggerBox.y) < 8, `两者应同一行（y=${framingBox.y} / ${triggerBox.y}）`);
    assert.ok(triggerBox.x > framingBox.x + framingBox.width, "镜头库入口应在景别右侧");

    const movement = page.locator("[data-camera-movement]");
    const movementSelect = movement.getByRole("combobox");
    // 运镜方式改成单选，不再是可编辑文本框；旧稿手填值继续显示且提示可重新选择。
    assert.equal(await movement.getByRole("textbox").count(), 0, "运镜方式不应再有自由文本框");
    assert.equal(await movementSelect.count(), 1, "运镜方式应是单个下拉单选");
    await page.waitForFunction(() => (document.querySelector("[data-camera-movement]")?.textContent || "").includes("一镜到底"));
    assert.ok((await movement.innerText()).includes("旧稿手填"), "旧稿自定义值需提示来源");

    // 改成单选不能顺手改写旧稿：未操作时既没有草稿变更，也不该触发保存。
    assert.equal(await page.getByLabel("草稿内容").textContent(), "", "旧稿值不应被单选自动重写");
    assert.equal(await page.getByRole("button", { name: "保存镜头并同步", exact: true }).isDisabled(), true);

    const selectFromDropdown = async (query, title) => {
        await movementSelect.click();
        await movementSelect.fill(query);
        const option = page.locator(`.ant-select-item-option[title="${title}"]`);
        await option.waitFor();
        await option.click();
    };

    // 直接在下拉里选 003：选项来自镜头库，选中同时写 movement 与 previs_id。
    await selectFromDropdown("003", "#003 横摇 / Pan");
    await page.waitForFunction(() => (document.querySelector("[data-camera-library-trigger]")?.textContent || "").includes("当前 Previs：003"));
    assert.ok((await movement.innerText()).includes("横摇 / Pan"), "下拉应显示镜头库里的镜头");
    assert.ok(!(await movement.innerText()).includes("旧稿手填"), "选了镜头库后不应再显示旧值提示");
    const draft = JSON.parse(await page.getByLabel("草稿内容").textContent() || "null");
    assert.equal(draft.value.camera.movement, "横摇 / Pan");
    assert.equal(draft.value.camera.previs_id, "003");

    // 清空单选必须同时解绑 Previs ID，不能留下指向旧镜头的绑定。
    await movement.hover();
    await movement.getByRole("button", { name: "Clear" }).click();
    await page.waitForFunction(() => !(document.querySelector("[data-camera-library-trigger]")?.textContent || "").includes("当前 Previs"));
    const clearedDraft = JSON.parse(await page.getByLabel("草稿内容").textContent() || "null");
    assert.equal(clearedDraft.value.camera.movement, "");
    assert.equal(clearedDraft.value.camera.previs_id, "");
    await selectFromDropdown("003", "#003 横摇 / Pan");
    await page.waitForFunction(() => (document.querySelector("[data-camera-library-trigger]")?.textContent || "").includes("当前 Previs：003"));

    // 打开镜头库：预选必须跟着下拉的选择走，说明两处共用同一对字段。
    await page.getByRole("button", { name: "浏览镜头库", exact: true }).click();
    await page.locator("[data-camera-library-modal]").waitFor();
    await page.waitForFunction(() => document.querySelectorAll("[data-camera-library-move]").length === 132);
    await page.waitForFunction(() => document.querySelector('[data-camera-library-move="003"]')?.getAttribute("aria-pressed") === "true");
    assert.equal(await page.locator("[data-camera-library-move]").count(), 132);
    assert.ok((await page.locator("[data-camera-library-modal]").innerText()).includes("132 / 132 段"));
    assert.equal(await page.locator("[data-camera-library-movement]").innerText(), "横摇 / Pan");
    assert.equal(await page.locator("[data-camera-library-detail] input").count(), 0, "弹窗不再手填运镜方式");

    // 搜索与分类筛选都基于真实清单数据。
    await page.getByPlaceholder("搜索编号 / 中文名 / 英文名").fill("眩晕");
    const searchCount = await page.locator("[data-camera-library-move]").count();
    assert.ok(searchCount > 0 && searchCount < 132, `搜索应缩小结果，实际 ${searchCount}`);
    await page.getByPlaceholder("搜索编号 / 中文名 / 英文名").fill("");
    await page.getByRole("button", { name: /基础运镜/ }).click();
    assert.equal(await page.locator("[data-camera-library-move]").count(), 8);
    assert.equal(await page.locator("[data-camera-library-move]").first().getAttribute("data-camera-library-move"), "001");

    // 选中 001：右侧大预览必须从 Backend 真正加载出 1080p mp4，写入值由镜头派生。
    await page.locator('[data-camera-library-move="001"]').click();
    const preview = page.locator("[data-camera-library-detail] video");
    await preview.waitFor();
    assert.ok((await preview.getAttribute("src") || "").includes("01_dolly_in.mp4"));
    await page.waitForFunction(() => {
        const video = document.querySelector("[data-camera-library-detail] video");
        return video instanceof HTMLVideoElement && video.readyState >= 2 && video.videoWidth === 1920 && video.videoHeight === 1080;
    }, undefined, { timeout: 20000 });
    assert.equal(await page.locator("[data-camera-library-movement]").innerText(), "推 / Dolly In");

    await page.getByRole("button", { name: "选用此镜头", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("[data-camera-library-modal]").length === 0);
    assert.ok((await movement.innerText()).includes("推 / Dolly In"), "弹窗选用后下拉同步更新");
    assert.ok((await trigger.innerText()).includes("当前 Previs：001"));

    // 保存补丁必须带上 movement 与 acheng skill 的 previs_id。
    await page.getByRole("button", { name: "保存镜头并同步", exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('[aria-label="保存内容"]')?.textContent || "").includes("previs_id"));
    const patch = JSON.parse(await page.getByLabel("保存内容").textContent());
    assert.equal(patch.camera.movement, "推 / Dolly In");
    assert.equal(patch.camera.previs_id, "001");
    assert.equal(patch.camera.framing, "MS");

    // 保存后重新打开镜头库，按 previs_id 预选 001。
    await page.getByRole("button", { name: "浏览镜头库", exact: true }).click();
    await page.locator("[data-camera-library-modal]").waitFor();
    await page.waitForFunction(() => document.querySelector('[data-camera-library-move="001"]')?.getAttribute("aria-pressed") === "true");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, moves: 132, searchMatches: searchCount, categoryMatches: 8, preview: "1920x1080", saved: patch.camera }));
} finally {
    await browser.close();
}
