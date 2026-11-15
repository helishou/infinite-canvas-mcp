import assert from "node:assert/strict";
import test, { after } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const testRoot = await mkdtemp(path.join(os.tmpdir(), "canvas-transcribe-test-"));
process.env.INFINITE_CANVAS_DATA_DIR = testRoot;
process.env.INFINITE_CANVAS_MEDIA_DIR = path.join(testRoot, "media");
after(() => rm(testRoot, { recursive: true, force: true }));
const { BackendDatabase } = await import("../db.js");
const { createStores } = await import("../stores/index.js");
const { SubtitleTranscribeBackend, parseWhisperJson, resolveWhisperRuntime } = await import("./subtitle-transcribe.js");

/** Shape observed from a real `python -m whisper --word_timestamps True --output_format json` run. */
const REAL_WHISPER_JSON = {
    text: "快把软件给'RE但是",
    segments: [
        {
            id: 0, start: 6.54, end: 10.08, text: "快把软件给'RE", no_speech_prob: 0.5560739,
            words: [
                { word: "快", start: 6.54, end: 7.94, probability: 0.0056 },
                { word: "把", start: 7.94, end: 9.34, probability: 0.0184 },
                { word: "软", start: 9.34, end: 10.08, probability: 0.0451 },
                { word: "件", start: 10.08, end: 10.08, probability: 0.3166 },
                { word: "给", start: 10.08, end: 10.08, probability: 0.0505 },
                { word: "'RE", start: 10.08, end: 10.08, probability: 7.5e-7 },
            ],
        },
        { id: 1, start: 10.08, end: 10.08, text: "", no_speech_prob: 0.556, words: [] },
    ],
    language: "Chinese",
};

function fixture() {
    const db = new BackendDatabase(":memory:");
    const stores = createStores(db);
    const backend = new SubtitleTranscribeBackend(stores.tasks, stores.media);
    return { db, stores, backend };
}

async function settle(stores: ReturnType<typeof createStores>, id: string) {
    let task = stores.tasks.get(id)!;
    while (["queued", "running"].includes(task.status)) {
        await new Promise(resolve => setTimeout(resolve, 20));
        task = stores.tasks.get(id)!;
    }
    return task;
}

test("parseWhisperJson keeps real word timestamps and the no-speech signal", () => {
    const parsed = parseWhisperJson(REAL_WHISPER_JSON);
    assert.equal(parsed.language, "Chinese");
    assert.equal(parsed.words.length, 6);
    assert.equal(parsed.words[0].word, "快");
    assert.equal(parsed.words[0].start, 6.54);
    assert.ok(parsed.words[0].probability < 0.01, "low-confidence recognition must stay visible");
    assert.ok(parsed.noSpeechProbability > 0.5);
});

test("parseWhisperJson drops malformed words instead of inventing timestamps", () => {
    const parsed = parseWhisperJson({ segments: [{ words: [
        { word: "好", start: 1, end: 2, probability: 0.9 },
        { word: "", start: 2, end: 3 },
        { word: "坏", start: 5, end: 4 },
        { word: "负", start: -1, end: 1 },
    ] }], text: "" });
    assert.equal(parsed.words.length, 1);
    assert.equal(parsed.words[0].word, "好");
    assert.equal(parseWhisperJson(null).words.length, 0);
});

test("resolveWhisperRuntime honours explicit overrides and env without hard-coding one machine", () => {
    const previous = process.env.WHISPER_MODEL;
    try {
        process.env.WHISPER_MODEL = "large-v3";
        assert.equal(resolveWhisperRuntime({}).model, "large-v3");
        assert.equal(resolveWhisperRuntime({ model: "small", language: "zh", fp16: false }).model, "small");
        assert.equal(resolveWhisperRuntime({ model: "small", language: "zh", fp16: false }).language, "zh");
        assert.equal(resolveWhisperRuntime({ model: "small", language: "zh", fp16: false }).fp16, false);
        assert.equal(resolveWhisperRuntime({ pythonPath: "C:/custom/python.exe" }).pythonPath, "C:/custom/python.exe");
    } finally {
        if (previous === undefined) delete process.env.WHISPER_MODEL; else process.env.WHISPER_MODEL = previous;
    }
});

test("start rejects empty or oversized clip lists before creating any task", () => {
    const { db, stores, backend } = fixture();
    try {
        assert.throws(() => backend.start({ storageKeys: [] }, "empty"), /至少一个已生成的视频/);
        assert.throws(() => backend.start({ storageKeys: Array.from({ length: 65 }, (_, index) => `key-${index}`) }, "oversized"), /最多校准 64 段/);
        assert.equal(stores.tasks.list({}).length, 0);
    } finally { db.close(); }
});

test("an unknown storageKey fails the task with an actionable error and never fabricates a transcript", async () => {
    const { db, stores, backend } = fixture();
    try {
        const task = backend.start({ storageKeys: ["missing-video"] }, "unknown-media");
        const final = await settle(stores, task.id);
        assert.equal(final.status, "failed");
        assert.match(String(final.error), /媒体不存在或已删除/);
        assert.equal(final.result, null);
    } finally { db.close(); }
});

test("a missing Whisper runtime reports how to configure it, after real ffmpeg audio extraction", { timeout: 60000 }, async () => {
    const { db, stores, backend } = fixture();
    const directory = await mkdtemp(path.join(os.tmpdir(), "canvas-transcribe-fixture-"));
    try {
        const video = path.join(directory, "source.mp4");
        await promisify(execFile)(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000",
            "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", video]);
        const stored = stores.media.store(await readFile(video), { name: "source.mp4", mimeType: "video/mp4" });
        const task = backend.start({ storageKeys: [stored.storageKey], pythonPath: "E:/definitely/not/a/python.exe" }, "missing-python");
        const final = await settle(stores, task.id);
        assert.equal(final.status, "failed");
        assert.match(String(final.error), /WHISPER_PYTHON/);
    } finally {
        db.close();
        await rm(directory, { recursive: true, force: true });
    }
});
