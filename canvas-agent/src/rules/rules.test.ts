import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// 先隔离配置目录，再动态加载模块：CONFIG_DIR 在 store/config 模块加载时冻结。
const root = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-learned-rules-"));
process.env.INFINITE_CANVAS_AGENT_CONFIG_DIR = root;
const store = await import("./store.js");
const learn = await import("./learn.js");
const autolearn = await import("./auto-learn.js");

test("候选默认停用未复核，采纳后才启用，且按类别去重", async () => {
    const added = await store.addRuleCandidates([
        { title: "分镜要留呼吸", statement: "每个情绪转折至少给一个停顿镜头。", category: "storyboard" },
        { title: "提示词别堆词", statement: "提示词只写可见动作，不堆风格词。", category: "prompt" },
        { title: "重复项", statement: "每个情绪转折至少给一个停顿镜头！", category: "storyboard" },
    ], "thread-1");
    assert.equal(added.length, 2, "语义相同的候选只保留一条");
    const state = await store.readLearnedRules();
    assert.equal(state.rules.length, 2);
    assert.ok(state.rules.every((rule) => !rule.enabled && !rule.reviewed));
    assert.equal(state.autoLearn, true);

    const accepted = await store.reviewRule(added[0].id, "accept");
    assert.equal(accepted?.enabled, true);
    assert.equal(accepted?.reviewed, true);
    await store.setRuleEnabled(added[1].id, true);
    const storyboard = await store.enabledRulesForCategories(["storyboard"]);
    assert.deepEqual(storyboard.map((rule) => rule.title), ["分镜要留呼吸"]);
    const prompt = await store.enabledRulesForCategories(["prompt"]);
    assert.deepEqual(prompt.map((rule) => rule.title), ["提示词别堆词"]);

    await store.setRuleEnabled(added[0].id, false);
    assert.equal((await store.enabledRulesForCategories(["storyboard"])).length, 0);
    await store.reviewRule(added[1].id, "ignore");
    assert.equal((await store.readLearnedRules()).rules.length, 1);
});

test("类别路由只取本环节规则，通用规则始终带上", () => {
    const rules = [
        { ...base, id: "g", title: "通用", statement: "对白保留原话", category: "general" as const },
        { ...base, id: "s", title: "分镜", statement: "切镜写清承接", category: "storyboard" as const },
        { ...base, id: "p", title: "提示词", statement: "提示词写可见结果", category: "prompt" as const },
    ];
    const storyboard = store.enabledRulesFor(["storyboard"], rules);
    assert.deepEqual(storyboard.map((rule) => rule.id), ["g", "s"]);
    const prompt = store.enabledRulesFor(["prompt"], rules);
    assert.deepEqual(prompt.map((rule) => rule.id), ["g", "p"]);
    const context = store.formatRulesContext(storyboard);
    assert.match(context, /已启用的长期规则/);
    assert.match(context, /分镜：切镜写清承接/);
    assert.doesNotMatch(context, /提示词写可见结果/);
});

test("按用户输入与阶段推断类别，推断不出时只带通用", () => {
    assert.ok(store.selectRuleCategories("以后分镜景别别全用近景").includes("storyboard"));
    assert.ok(store.selectRuleCategories("提示词里不要写抽象形容词").includes("prompt"));
    assert.ok(store.selectRuleCategories("继续").length === 0);
    assert.ok(store.selectRuleCategories("", "shots").includes("continuity"));
});

test("只从明确修改意图中提炼，草稿按 schema 校验", () => {
    assert.equal(learn.shouldLearnFromMessage("今天天气不错"), false);
    assert.equal(learn.shouldLearnFromMessage("以后所有分镜都要有明确落幅"), true);
    const draft = learn.parseRuleDraft(JSON.stringify({
        summary: "提炼了一条",
        rules: [{ title: "落幅", statement: "每个镜头写清落幅", detail: "", category: "storyboard", evidence: "以后分镜都要有明确落幅" }],
    }));
    assert.equal(draft.rules[0].category, "storyboard");
    assert.deepEqual(learn.ruleDraftToCandidates(draft)[0], {
        title: "落幅", statement: "每个镜头写清落幅", category: "storyboard", evidence: "以后分镜都要有明确落幅",
    });
    assert.throws(() => learn.parseRuleDraft("不是 JSON"));
});

test("轮末自动提炼只写候选，且调用方提供的结构化输出可直接落地", async () => {
    const result = await autolearn.learnFromTurn({
        messages: [{ role: "user", text: "以后所有分镜都要写清落幅" }, { role: "assistant", text: "已调整分镜" }],
        threadId: "verify-auto",
        structured: async () => ({
            summary: "提炼一条分镜规则",
            rules: [{ title: "自动落幅", statement: "自动验证：每镜写清落幅。", detail: "", category: "storyboard", evidence: "以后所有分镜都要写清落幅" }],
        }),
    });
    assert.equal(result.added, 1);
    const state = await store.readLearnedRules();
    const candidate = state.rules.find((rule) => rule.title === "自动落幅");
    assert.ok(candidate);
    assert.equal(candidate.enabled, false);
    assert.equal(candidate.reviewed, false);

    const skipped = await autolearn.learnFromTurn({
        messages: [{ role: "user", text: "今天天气不错" }],
        threadId: "verify-auto",
        structured: async () => { throw new Error("不该调用模型"); },
    });
    assert.equal(skipped.added, 0);
});

test("规则块拼在阶段块之后，空规则不改原文", () => {
    const prompt = "帮我写第 3 集";
    assert.equal(autolearn.withLearnedRulesContext(prompt, ""), prompt);
    const wrapped = autolearn.withLearnedRulesContext(prompt, "## 当前阶段\n分镜");
    assert.match(wrapped, /## 当前阶段\n分镜\n\n---\n用户请求：帮我写第 3 集/);
});

const base = {
    statement: "",
    enabled: true,
    reviewed: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
};
