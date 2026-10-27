import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    // Even an accidental fixture regression cannot touch the real Backend.
    const testOrigin = new URL(process.env.CANVAS_TEST_URL || "http://localhost:3001").origin;
    await page.route("**/*", route => {
        const url = new URL(route.request().url());
        return url.origin === testOrigin ? route.continue() : route.abort();
    });
    await page.goto(`${process.env.CANVAS_TEST_URL || "http://localhost:3001"}/tests/agent-model-switch.html`);
    await page.waitForFunction(() => window.modelSwitchFixture?.read().connected);
    const read = () => page.evaluate(() => window.modelSwitchFixture.read());
    const draft = state => ({ prompt: state.prompt, attachments: state.attachments, references: state.references, skill: state.skill });
    const initial = draft(await read());
    const choose = async name => {
        await page.getByRole("combobox", { name: /CLI model|API model|API two/ }).click();
        await page.getByRole("option", { name, exact: true }).click();
    };
    const settled = () => page.waitForFunction(() => !window.modelSwitchFixture.read().loading);
    await choose("API model");
    await settled();
    let state = await read();
    assert.deepEqual(state.resets, ["api::model"]);
    assert.match(state.thread, /^llm-/);
    assert.deepEqual(draft(state), initial);
    assert.equal(state.turns, 0);
    assert.equal(state.messages.length, 0);

    await choose("API two");
    assert.equal((await read()).resets.length, 1);
    await page.evaluate(() => window.modelSwitchFixture.busy(true));
    await choose("CLI model");
    state = await read();
    assert.equal(state.model, "api::two");
    assert.equal(state.resets.length, 1);
    await page.evaluate(() => window.modelSwitchFixture.busy(false));

    await page.evaluate(() => window.modelSwitchFixture.fail(true));
    await choose("CLI model");
    await settled();
    state = await read();
    assert.match(state.thread, /^llm-/);
    assert.deepEqual(draft(state), initial);
    await page.evaluate(() => window.modelSwitchFixture.fail(false));
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await settled();
    state = await read();
    assert.match(state.thread, /^codex-/);
    assert.deepEqual(draft(state), initial);
    assert.equal(state.turns, 0);

    await page.evaluate(() => { window.modelSwitchFixture.language("en-US"); window.modelSwitchFixture.delay(); });
    await choose("API model");
    await page.waitForFunction(() => window.modelSwitchFixture.read().loading);
    assert.deepEqual(draft(await read()), initial);
    await page.evaluate(() => window.modelSwitchFixture.release());
    await settled();
    assert.match((await read()).thread, /^llm-/);
    await page.evaluate(() => window.modelSwitchFixture.mismatch());
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await settled();
    state = await read();
    assert.match(state.thread, /^codex-/);
    assert.deepEqual(draft(state), initial);
    assert.equal(state.turns, 0);
    assert.deepEqual(errors, []);
    console.log("PASS: bidirectional runtime switching, same-runtime reuse, text/images/references/Skill preservation, busy protection, creation failure and retry, SSE-before-response, delayed creation, Chinese/English and no model submission");
} finally { await browser.close(); }
