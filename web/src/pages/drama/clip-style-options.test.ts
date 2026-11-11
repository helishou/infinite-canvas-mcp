import assert from "node:assert/strict";
import test from "node:test";
import { clipStyleCatalog } from "./clip-style-options";

const custom = { id: "custom-f7144ab2-7545-442b-9d5c-6e50253c05cc", label: "柔焦", text: "Soft focus." };
const translate = (key: string, options?: { defaultValue: string }) => ({ "director.workspace.clipStyleNone": "None", "director.studio.clipStyleMissing": "Unavailable style" }[key] || options?.defaultValue || key);

test("custom styles use the registered name in the selected option and adoption text", () => {
    const catalog = clipStyleCatalog({ styleTemplates: [custom] }, translate);
    assert.equal(catalog.name(custom.id), "柔焦");
    assert.deepEqual(catalog.options.find(item => item.value === custom.id), { value: custom.id, label: "柔焦" });
    assert.equal(clipStyleCatalog({ styleTemplates: [{ ...custom, label: "Renamed style" }] }, translate).name(custom.id), "Renamed style");
});

test("overridden built-in names survive localization and missing styles never expose IDs or translation keys", () => {
    const catalog = clipStyleCatalog({ styleTemplates: [{ ...custom, id: "soft-light", label: "My soft light" }], deletedStyleTemplateIds: ["japanese-ccd"] }, translate);
    assert.equal(catalog.name("soft-light"), "My soft light");
    assert.equal(catalog.name(custom.id), "Unavailable style");
    assert.equal(catalog.name(null), "None");
    assert.equal(catalog.options.some(item => item.value === "japanese-ccd"), false);
});
