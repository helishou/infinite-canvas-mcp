import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildStoryboardPromptSections } from "../services/storyboard-prompt";
import type { H3Segment, H3SubjectDefinition } from "../types";

// Bundle the actual editor context without mounting React or exposing a test-only production API.
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(new URL("../../../sdk/package.json", import.meta.url));
const { build } = require("esbuild");
const result = await build({
    stdin: { contents: 'export { storyboardGenerationContext } from "./H3PromptSection";', resolveDir: here, loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
    plugins: [{
        name: "editor-context-test",
        setup(builder: any) {
            builder.onLoad({ filter: /H3PromptSection\.tsx$/ }, async ({ path }: { path: string }) => ({
                contents: `${await readFile(path, "utf8")}\nexport { storyboardGenerationContext };`, loader: "tsx",
            }));
            builder.onResolve({ filter: /\?raw$/ }, ({ path, resolveDir }: { path: string; resolveDir: string }) => ({ path: resolve(resolveDir, path.slice(0, -4)), namespace: "raw" }));
            builder.onLoad({ filter: /.*/, namespace: "raw" }, async ({ path }: { path: string }) => ({ contents: `export default ${JSON.stringify(await readFile(path, "utf8"))};`, loader: "js" }));
        },
    }],
});
const bundled = { exports: {} as { storyboardGenerationContext: (...args: any[]) => any } };
new Function("require", "module", "exports", result.outputFiles[0].text)(createRequire(new URL("./H3PromptSection.tsx", import.meta.url)), bundled, bundled.exports);
const { storyboardGenerationContext } = bundled.exports;

function generate(voiceOnly = false, subjectOverrides?: H3SubjectDefinition[]) {
    const character = {
        id: "character-1", type: "character", title: "沈侯",
        metadata: {
            characterName: "沈侯", characterDescription: "不应自动注入的角色背景和性格",
            characterImages: [{ outfit: "朝服", outfitDescription: "深蓝色朝服" }],
        },
    };
    const group = {
        id: "group-1", characterNodeId: character.id, characterName: "沈侯", subjectId: character.id,
        outfits: [{ id: "outfit-1", name: "朝服", url: "outfit.png", enabled: !voiceOnly }],
        outfitEnabled: !voiceOnly, voiceEnabled: voiceOnly,
        voice: { url: "voice.wav", name: "声线", description: "低沉平稳的声线" },
    };
    const segment = {
        id: "clip-1", h3CharacterGroups: { [group.id]: group },
        referenceBindings: [{
            id: "reference-1", assetId: "asset-1", label: voiceOnly ? "声线" : "朝服",
            role: voiceOnly ? "character_voice" : "character_turnaround", mediaType: voiceOnly ? "audio" : "image",
            url: voiceOnly ? "voice.wav" : "outfit.png", enabled: true, usage: "reference", tags: [],
            sourceNodeId: character.id, groupId: group.id, subjectId: character.id,
            ...(voiceOnly ? {} : { outfitId: "outfit-1", description: "角色正面全身" }),
        }],
    } as H3Segment;
    const context = storyboardGenerationContext(
        { getNode: (id: string) => id === character.id ? character : undefined }, segment,
        { openingDescription: "", summary: "", soundscape: "", music: "N/A" },
        [{ id: "shot-1", description: "沈侯开口。", switchTime: "", transitionType: "cut" }], [], {}, { subjectOverrides },
    );
    return { context, sections: buildStoryboardPromptSections(context.subjects, context.references, context.shots) };
}

test("分镜图片角色定义不注入角色节点描述，保留参考与服装信息", () => {
    const { context, sections } = generate();
    assert.doesNotMatch(JSON.stringify(context.content), /不应自动注入/);
    assert.doesNotMatch(sections.subjectDefinitions, /不应自动注入/);
    assert.match(sections.subjectDefinitions, /沈侯/);
    assert.match(sections.subjectDefinitions, /<Picture 1>/);
    assert.match(sections.subjectDefinitions, /角色正面全身/);
    assert.match(sections.subjectDefinitions, /深蓝色朝服/);
});

test("仅声线角色定义不注入角色节点描述，保留声线与主体映射", () => {
    const { context, sections } = generate(true);
    assert.doesNotMatch(JSON.stringify(context.content), /不应自动注入/);
    assert.doesNotMatch(sections.subjectDefinitions, /不应自动注入/);
    assert.match(sections.subjectDefinitions, /<Subject 1> is 沈侯/);
    assert.match(sections.subjectDefinitions, /<Audio 1>.*<Subject 1>/);
    assert.match(sections.subjectDefinitions, /低沉平稳的声线/);
});

test("分镜手动实体描述仍保留", () => {
    const { sections } = generate(false, [{ id: "character-1", name: "沈侯", profile: "手动填写的角色说明", pictures: ["<Picture 1>"], outfits: [] }]);
    assert.match(sections.subjectDefinitions, /手动填写的角色说明/);
    assert.doesNotMatch(sections.subjectDefinitions, /不应自动注入/);
});
