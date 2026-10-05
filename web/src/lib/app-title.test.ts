import assert from "node:assert/strict";
import test from "node:test";
import { setApplicationTitle, setAttentionTitle } from "./app-title";

test("pending title survives a language change and restores the current application title", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
    const document = { title: "Canvas" };
    Object.defineProperty(globalThis, "document", { configurable: true, value: document });
    try {
        setApplicationTitle("无限画布"); setAttentionTitle("待确认 2");
        assert.equal(document.title, "待确认 2 · 无限画布");
        setApplicationTitle("Infinite Canvas");
        assert.equal(document.title, "待确认 2 · Infinite Canvas");
        setAttentionTitle(""); assert.equal(document.title, "Infinite Canvas");
    } finally {
        setAttentionTitle("");
        if (descriptor) Object.defineProperty(globalThis, "document", descriptor); else delete (globalThis as any).document;
    }
});
