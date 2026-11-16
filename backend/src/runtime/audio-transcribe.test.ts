import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
    AUDIO_TRANSCRIBE_MAX_BYTES,
    AUDIO_TRANSCRIBE_MAX_SECONDS,
    audioTranscribeCapability,
    mapWhisperLanguage,
    resolveLocalWhisperModel,
    validateAudioUpload,
} from "./audio-transcribe.js";
import { resolveWhisperRuntime } from "./subtitle-transcribe.js";

test("audio upload validation rejects empty, oversized and unsupported input before spawning a process", () => {
    assert.throws(() => validateAudioUpload(Buffer.alloc(0), "audio/webm"), (error: unknown) =>
        error instanceof Error && (error as { code?: string }).code === "INVALID_AUDIO_INPUT");
    assert.throws(() => validateAudioUpload(Buffer.alloc(AUDIO_TRANSCRIBE_MAX_BYTES + 1), "audio/webm"), (error: unknown) =>
        error instanceof Error && (error as { code?: string }).code === "AUDIO_TOO_LARGE");
    assert.throws(() => validateAudioUpload(Buffer.from("x"), "application/pdf"), (error: unknown) =>
        error instanceof Error && (error as { code?: string }).code === "UNSUPPORTED_AUDIO_FORMAT");
    assert.deepEqual(validateAudioUpload(Buffer.from("x"), "audio/webm;codecs=opus"), { mimeType: "audio/webm", extension: "webm" });
    assert.deepEqual(validateAudioUpload(Buffer.from("x"), ""), { mimeType: "application/octet-stream", extension: "bin" });
    assert.deepEqual(validateAudioUpload(Buffer.from("x"), "audio/flac"), { mimeType: "audio/flac", extension: "flac" });
});

test("Whisper language hints only emit languages the tokenizer knows", () => {
    assert.equal(mapWhisperLanguage("zh-CN"), "Chinese");
    assert.equal(mapWhisperLanguage("zh"), "Chinese");
    assert.equal(mapWhisperLanguage("Chinese"), "Chinese");
    assert.equal(mapWhisperLanguage("en-US"), "English");
    assert.equal(mapWhisperLanguage("en"), "English");
    assert.equal(mapWhisperLanguage("fr"), undefined, "unknown locales must fall back to auto detection");
    assert.equal(mapWhisperLanguage("auto"), undefined);
    assert.equal(mapWhisperLanguage(undefined), undefined);
});

test("local Whisper model resolution prefers --model_dir over the download cache", () => {
    const runtime = resolveWhisperRuntime({ modelDir: path.join("E:", "definitely-missing-whisper-models"), model: "not-a-real-whisper-model" });
    assert.deepEqual(resolveLocalWhisperModel(runtime), {});
});

test("capability probe is honest and exposes the limits the UI consumes", () => {
    const capability = audioTranscribeCapability();
    assert.equal(capability.ok, true);
    assert.equal(capability.engine, "local-whisper");
    assert.equal(typeof capability.available, "boolean");
    assert.equal(capability.maxBytes, AUDIO_TRANSCRIBE_MAX_BYTES);
    assert.equal(capability.maxSeconds, AUDIO_TRANSCRIBE_MAX_SECONDS);
    if (capability.available) {
        assert.ok(capability.modelPath, "an available channel must point at a real model file");
        assert.equal(capability.reason, undefined);
    } else {
        assert.ok(capability.reason && capability.reason.length > 0, "an unavailable channel must explain why");
    }
});

test("missing python or model turns the channel off with an actionable reason", () => {
    const missingPython = audioTranscribeCapability({ pythonPath: path.join("E:", "no-such-python.exe") });
    assert.equal(missingPython.available, false);
    assert.match(missingPython.reason || "", /WHISPER_PYTHON/);

    const missingModel = audioTranscribeCapability({ model: "not-a-real-whisper-model" });
    assert.equal(missingModel.available, false);
    assert.match(missingModel.reason || "", /WHISPER_MODEL_DIR|模型/);
});
