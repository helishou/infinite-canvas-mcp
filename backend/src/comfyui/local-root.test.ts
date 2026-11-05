import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertIndependentMediaRoot, copyComfyInput, resolveComfyRoot } from "./local-root.js";

test("accepts both the launcher directory and its ComfyUI root", (t) => {
    const installation = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-comfy-root-"));
    t.after(() => fs.rmSync(installation, { recursive: true, force: true }));
    const root = path.join(installation, "ComfyUI");
    fs.mkdirSync(path.join(root, "input"), { recursive: true });
    assert.throws(() => resolveComfyRoot(installation), /main.py/);
    fs.writeFileSync(path.join(root, "main.py"), "");
    assert.equal(resolveComfyRoot(installation), root);
    assert.equal(resolveComfyRoot(root), root);
    assert.throws(() => resolveComfyRoot(""), /请输入/);
});

test("ComfyUI deletion leaves original media intact and cache can be recreated", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-comfy-copy-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const media = path.join(directory, "media"), comfy = path.join(directory, "ComfyUI");
    fs.mkdirSync(path.join(media, "input"), { recursive: true });
    fs.mkdirSync(path.join(comfy, "input"), { recursive: true });
    const source = path.join(media, "input", "reference.mp4");
    fs.writeFileSync(source, "original video");
    const name = await copyComfyInput(source, media, comfy);
    assert.equal(fs.readFileSync(path.join(comfy, "input", name), "utf8"), "original video");
    fs.rmSync(comfy, { recursive: true });
    assert.equal(fs.readFileSync(source, "utf8"), "original video");
    fs.mkdirSync(path.join(comfy, "input"), { recursive: true });
    assert.equal(await copyComfyInput(source, media, comfy), name);
    fs.writeFileSync(source, "updated video");
    await copyComfyInput(source, media, comfy);
    assert.equal(fs.readFileSync(path.join(comfy, "input", name), "utf8"), "updated video");
    assert.throws(() => assertIndependentMediaRoot(path.join(comfy, "input"), comfy), /独立/);
    await assert.rejects(copyComfyInput(path.join(directory, "outside.mp4"), media, comfy), /运行媒体/);
});

test("flat input preparation reuses identical files and publishes concurrent copies completely", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-comfy-publish-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const media = path.join(directory, "media"), comfy = path.join(directory, "ComfyUI");
    const input = path.join(comfy, "input");
    fs.mkdirSync(media);
    fs.mkdirSync(input, { recursive: true });
    const source = path.join(media, "reference.png");
    const contents = Buffer.alloc(8 * 1024 * 1024, 0x5a);
    fs.writeFileSync(source, contents);
    const names = await Promise.all(Array.from({ length: 8 }, () => copyComfyInput(source, media, comfy, true)));
    assert.deepEqual(names, Array(8).fill("reference.png"));
    const target = path.join(input, names[0]);
    assert.deepEqual(fs.readFileSync(target), contents);
    const oldTime = new Date("2000-01-01T00:00:00Z");
    fs.utimesSync(target, oldTime, oldTime);
    await copyComfyInput(source, media, comfy, true);
    assert.equal(fs.statSync(target).mtimeMs, oldTime.getTime());
    assert.deepEqual(fs.readdirSync(input), ["reference.png"]);
});

test("failed input publication preserves the existing target and removes its temporary copy", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-comfy-publish-failure-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const media = path.join(directory, "media"), comfy = path.join(directory, "ComfyUI");
    const input = path.join(comfy, "input");
    fs.mkdirSync(media);
    fs.mkdirSync(path.join(input, "reference.png"), { recursive: true });
    const source = path.join(media, "reference.png");
    fs.writeFileSync(source, "reference");
    await assert.rejects(copyComfyInput(source, media, comfy, true));
    assert.equal(fs.statSync(path.join(input, "reference.png")).isDirectory(), true);
    assert.equal(fs.readFileSync(source, "utf8"), "reference");
    assert.deepEqual(fs.readdirSync(input), ["reference.png"]);
});
