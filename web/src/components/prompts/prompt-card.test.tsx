import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import type { Prompt } from "@/services/api/prompts";
import { PromptCard } from "./prompt-card";

const prompt: Prompt = {
    id: "prompt-a", sourceId: "custom", title: "A saved prompt", category: "My prompts", githubUrl: "",
    prompt: "Original prompt text", description: "Preview description", preview: "", coverUrl: "", referenceImageUrls: [], tags: ["portrait"],
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z",
};

function renderCard(props: Partial<Parameters<typeof PromptCard>[0]> = {}) {
    const i18n = createInstance();
    void i18n.init({ lng: "en-US", initAsync: false, resources: { "en-US": { translation: { common: { copy: "Copy" }, prompts: { workspace: { source: "Source", managePrompt: "Manage prompt" } } } } } });
    return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(PromptCard, { item: prompt, onOpen: () => undefined, onCopy: () => undefined, ...props })));
}

test("library cards separate text actions from item management and retain source attribution", () => {
    const html = renderCard({ actionLabel: "Copy prompt text", extraAction: createElement("button", null, "Save text asset"), managementAction: createElement("button", null, "Delete") });
    assert.match(html, /Source.*My prompts/);
    assert.match(html, /Copy prompt text/);
    assert.match(html, /Save text asset/);
    assert.match(html, /data-resource-group="prompt-management"/);
    assert.ok(html.indexOf("Save text asset") < html.indexOf('data-resource-group="prompt-management"'));
    assert.ok(html.indexOf('data-resource-group="prompt-management"') < html.indexOf("Delete"));
});

test("compact selection cards expose a named action instead of relying only on the cover", () => {
    const html = renderCard({ compact: true, actionLabel: "Use prompt", actionType: "primary" });
    assert.match(html, /Use prompt/);
    assert.match(html, /data-resource-group="prompt-use"/);
    assert.match(html, /ant-btn-primary/);
    assert.doesNotMatch(html, /data-resource-group="prompt-management"/);
});

test("existing compact consumers without an action label retain their cover-only behavior", () => {
    const html = renderCard({ compact: true });
    assert.match(html, /A saved prompt/);
    assert.doesNotMatch(html, /data-resource-group="prompt-use"/);
});
