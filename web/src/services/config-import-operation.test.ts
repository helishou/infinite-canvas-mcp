import assert from "node:assert/strict";
import test from "node:test";
import { commitConfigImport, ConfigImportFailure, validateConfigImport } from "./config-import-operation";
import { defaultConfig, defaultWebdavSyncConfig, importConfigConfirmed, importWebdavConfirmed, useConfigStore } from "../stores/use-config-store";
import { importPromptSourcesConfirmed, usePromptSourceStore } from "../stores/use-prompt-source-store";

const valid = () => ({ app: "infinite-canvas", version: 1, config: { ...defaultConfig }, webdav: { ...defaultWebdavSyncConfig }, promptSources: { sources: [], schedule: { intervalMinutes: 0, lastFetchedAt: "" } } });
test("all domains validate before writing, preserving false, zero and arbitrary workflow parameter values", () => {
    const data = valid(); data.config.localComfyuiEnabled = false;
    assert.equal(validateConfigImport(data, defaultConfig, defaultWebdavSyncConfig), true);
    for (const value of [null, [], { ...data, webdav: { url: null } }, { ...data, promptSources: { sources: [null], schedule: {} } }, { ...data, config: { channels: [{ id: "a", models: null }] } }]) assert.equal(validateConfigImport(value, defaultConfig, defaultWebdavSyncConfig), false);
});
test("partial import reports confirmed and pending domains without echoing credential-bearing errors", async () => {
    const calls: string[] = [];
    await assert.rejects(commitConfigImport([
        { domain: "config", save: async () => { calls.push("config"); } },
        { domain: "webdav", save: async () => { throw new Error("private-key"); } },
        { domain: "prompts", save: async () => { calls.push("prompts"); } },
    ]), error => {
        assert.ok(error instanceof ConfigImportFailure);
        assert.deepEqual(error.completed, ["config"]); assert.deepEqual(error.pending, ["webdav", "prompts"]);
        assert.doesNotMatch(error.message, /private-key/); return true;
    });
    assert.deepEqual(calls, ["config"]);
});
test("real import queues await requests, survive rejection and preserve newer local edits", async () => {
    const originalFetch = globalThis.fetch;
    const original = useConfigStore.getState();
    const originalPrompts = usePromptSourceStore.getState();
    const calls: { url: string; body: any; resolve: (value: Response) => void }[] = [];
    globalThis.fetch = async (url, init) => new Promise<Response>(resolve => calls.push({ url: String(url), body: JSON.parse(String(init?.body)), resolve }));
    const until = async (count: number) => { for (let i=0; i<100 && calls.length<count; i++) await new Promise(resolve => setTimeout(resolve, 2)); assert.equal(calls.length, count); };
    try {
        const first = importConfigConfirmed({ ...defaultConfig, systemPrompt: "first" });
        await until(1); assert.equal(useConfigStore.getState().config, original.config);
        calls[0].resolve(Response.json({ ok: true })); await first;
        const second = importConfigConfirmed({ ...defaultConfig, systemPrompt: "second" }); await until(2);
        calls[1].resolve(Response.json({ error: "failure" }, { status: 500 })); await assert.rejects(second);
        assert.equal(useConfigStore.getState().config.systemPrompt, "first");
        const third = importConfigConfirmed({ ...defaultConfig, systemPrompt: "third" }); await until(3);
        const newer = { ...useConfigStore.getState().config, systemPrompt: "newer edit" }; useConfigStore.setState({ config: newer });
        calls[2].resolve(Response.json({ ok: true })); await third; assert.equal(useConfigStore.getState().config, newer);
        const webdav = importWebdavConfirmed({ ...defaultWebdavSyncConfig, directory: "mock" }); await until(4);
        calls[3].resolve(Response.json({ error: "failure" }, { status: 500 })); await assert.rejects(webdav); assert.equal(useConfigStore.getState().webdav, original.webdav);
        const prompts = importPromptSourcesConfirmed({ sources: [], schedule: { intervalMinutes: 0, lastFetchedAt: "" } }); await until(5);
        calls[4].resolve(Response.json({ ok: true })); await prompts; assert.equal(usePromptSourceStore.getState().schedule.intervalMinutes, 0);
        // Existing save is slow; edits while import is queued stop that stale import.
        usePromptSourceStore.getState().updateSchedule("intervalMinutes", 30); await until(6);
        const queued = importPromptSourcesConfirmed({ sources: [], schedule: { intervalMinutes: 60, lastFetchedAt: "" } });
        const rejected = assert.rejects(queued, /CHANGED_DURING_IMPORT/);
        usePromptSourceStore.getState().updateSchedule("intervalMinutes", 360);
        calls[5].resolve(Response.json({ ok: true })); await rejected;
        assert.equal(usePromptSourceStore.getState().schedule.intervalMinutes, 360);
        await until(7); assert.equal(calls[6].body.value.schedule.intervalMinutes, 360);
        calls[6].resolve(Response.json({ ok: true }));
        await new Promise(resolve => setTimeout(resolve, 0));
        // Later domains use the snapshot taken before the first domain started.
        const snapshot = useConfigStore.getState().webdav;
        useConfigStore.setState({ webdav: { ...snapshot, directory: "edited-during-first-domain" } });
        await assert.rejects(importWebdavConfirmed(defaultWebdavSyncConfig, snapshot), /CHANGED_DURING_IMPORT/);
        assert.equal(calls.length, 7);
        assert.equal(useConfigStore.getState().webdav.directory, "edited-during-first-domain");
    } finally { globalThis.fetch = originalFetch; useConfigStore.setState(original); usePromptSourceStore.setState(originalPrompts); }
});
