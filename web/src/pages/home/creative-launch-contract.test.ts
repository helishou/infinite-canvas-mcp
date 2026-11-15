import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

function creativePadBlock(relative: string): string {
    const source = read(relative);
    const start = source.indexOf("    creativePad: {");
    const end = source.indexOf("    landing: {", start);
    assert.ok(start >= 0 && end > start, `${relative} must declare a creativePad namespace before landing`);
    return source.slice(start, end);
}

function localeKeys(block: string): string[] {
    return [...block.matchAll(/^\s{8,}([A-Za-z][A-Za-z0-9]*):/gm)].map(match => match[1]).sort();
}

test("the home page mounts exactly one creative launch pad", () => {
    const home = read("./index.tsx");
    assert.match(home, /import \{ CreativeLaunchPad \} from "\.\/creative-launch-pad"/);
    // 三个挂载点：完整创作台（hero）、全屏对话页停靠 composer（overlay）、内嵌对话工作台 composer（空会话内嵌形态）。
    // 运行时互斥：overlay 打开时 hero 隐藏；同一时刻至多渲染一个。
    assert.equal((home.match(/<CreativeLaunchPad\s/g) || []).length, 3);
    assert.match(home, /variant="thread"/);
    assert.match(home, /<CreativeLaunchPad/);
    assert.match(home, /onGenerated=\{recordLaunch\}/);
    assert.match(home, /historyCount=\{totalLaunchCount\}/);
    assert.ok(home.indexOf("<CreativeLaunchPad") < home.indexOf("{!hasWork && creationActions}"), "pad sits above the existing entry cards");
    assert.match(home, /data-testid="home-workbench"/, "existing home structure is preserved");
});

test("generation stays in the home conversation workbench; canvas entry is explicit", () => {
    const pad = read("./creative-launch-pad.tsx");
    const generationBlock = pad.slice(pad.indexOf("const startGeneration"), pad.indexOf("const fillExample"));
    assert.ok(generationBlock.length > 0, "startGeneration must exist");
    // 对齐影策：提交后不跳转（影策在原地切对话形态），进画布是「继续在画布上编辑」的显式动作。
    assert.ok(!/navigate\(`\/canvas\/\$\{encodeURIComponent\(projectId\)\}`\)/.test(generationBlock), "startGeneration must not auto-navigate to the canvas");
    assert.match(generationBlock, /onGenerated\?\.\(\{/);
    assert.match(generationBlock, /taskId,/);
    // 影策 thread-composer：启动台支持 thread 停靠形态，与 home 形态共用提交逻辑。
    assert.match(pad, /variant\?: "home" \| "thread"/);
    assert.match(pad, /data-testid="creative-launch-pad-thread"/);
    // 导演模式：composer 伪模式，模型取设置里的「导演引擎」，后端走 hermes 导演 agent。
    assert.match(pad, /type PadMode = CreativeMode \| "director"/);
    assert.match(pad, /fetchSettings\(\)/);
    assert.match(pad, /agentModel/);
    // 会话内多轮共享生成上下文：提交追加到活动会话的同一张画布。
    assert.match(pad, /projectId: sharedProjectId,/);
    const generationLib = read("../../lib/creative-generation.ts");
    assert.match(generationLib, /projectId\?: string/);
    assert.match(generationLib, /existingProject \? existingProject\.id : canvas\.createProject/);
    assert.match(generationLib, /\.\.\.\(existingProject\?\.nodes \|\| \[\]\)/);
    const feed = read("./creative-generation-feed.tsx");
    // 对话形态：工具栏（新对话 + 历史 + 继续在画布上编辑）+ 消息流 + 停靠 composer 槽位。
    assert.match(feed, /data-testid="creative-thread-workbench"/);
    assert.match(feed, /data-testid="creative-thread-toolbar"/);
    assert.match(feed, /data-testid="creative-thread-new"/);
    assert.match(feed, /data-testid="creative-thread-history"/);
    assert.match(feed, /data-testid="creative-thread-continue-canvas"/);
    assert.match(feed, /composer\?/);
    assert.match(feed, /data-testid="creative-thread-empty"/);
    assert.match(feed, /threadActive/);
    assert.match(feed, /\[\.\.\.launches\]\.reverse\(\)/, "thread messages render in chronological order");
    // 历史形态与既有 feed 断言保留。
    assert.match(feed, /data-testid="creative-generation-feed"/);
    assert.match(feed, /launchStatus\(task, projectLogs\)/);
    assert.match(feed, /onOpenProject\(launch\.projectId\)/);
    assert.match(feed, /onDismiss\(launch\.taskId\)/);
    const home = read("./index.tsx");
    assert.match(home, /<CreativeGenerationFeed/);
    assert.match(home, /threadActive/);
    assert.match(home, /variant="thread"/);
    // 对齐影策：对话形态是全屏页——fixed 覆盖层接管视口 + 返回按钮收起。
    assert.match(home, /data-testid="home-thread-overlay"/);
    assert.match(home, /threadOverlayOpen && \(/);
    assert.match(home, /document\.body\.style\.overflow = "hidden"/);
    assert.match(home, /onBack=\{\(\) => setThreadActivePersisted\(false\)\}/);
    assert.match(feed, /data-testid="creative-thread-back"/);
    // 多会话：conversations 持久化 + 历史抽屉 + 重命名/删除。
    assert.match(home, /readCreativeConversations\(homeStorage, Date\.now\(\)\)/);
    assert.match(home, /writeCreativeConversations\(homeStorage,/);
    assert.match(home, /home-thread-active/);
    assert.match(home, /startNewConversation/);
    assert.match(home, /data-testid="creative-history-drawer"/);
    assert.match(home, /deleteConversation/);
    assert.match(home, /renameConversation/);
    // 影策 handoff：继续画布带 nodeId 聚焦本次生成节点。
    assert.match(home, /onContinueCanvas=\{\(projectId, nodeId\) => void continueEditing\(projectId, nodeId\)\}/);
    assert.match(home, /nodeId \? `\?nodeId=/);
    const data = read("./workbench-data.ts");
    assert.match(data, /CREATIVE_CONVERSATION_STORAGE_KEY/);
    assert.match(data, /appendConversationLaunch/);
    assert.match(data, /migrateLaunchesToConversation/);
    // 共享画布：会话记录 canvasId，后续提交复用；消息按节点隔离日志。
    assert.match(data, /canvasId\?: string/);
    assert.match(data, /canvasId: conversation\.canvasId \|\| launch\.projectId/);
    assert.match(feed, /log\.nodeId === launch\.nodeId/);
    assert.match(home, /sharedProjectId=\{activeConversation\?\.canvasId\}/);
});

test("generation feed copy ships in both locales without stale navigate-away wording", () => {
    const feedKeys = ["feedTitle", "feedHint", "feedOpenCanvas", "feedDismiss", "feedConfirmHint", "feedNoOutputs", "feedTextCopy", "feedTextCopied", "feedTextCopyFailed"];
    for (const file of ["../../i18n/locales/zh-CN.ts", "../../i18n/locales/en-US.ts"]) {
        const source = read(file);
        for (const key of feedKeys) assert.ok(source.includes(`${key}:`), `${file} missing ${key}`);
    }
    assert.ok(!read("../../i18n/locales/zh-CN.ts").includes("已提交生成，正在进入画布"), "stale zh copy must be gone");
    assert.ok(!read("../../i18n/locales/en-US.ts").includes("Generation submitted — opening the canvas"), "stale en copy must be gone");
});

test("launch pad wires the reference picker and a real canvas creation path", () => {
    const pad = read("./creative-launch-pad.tsx");
    assert.match(pad, /<ReferenceAssetPicker/);
    assert.match(pad, /creative-add-reference/);
    assert.match(pad, /creative-start/);
    assert.match(pad, /createProject\(title\)/);
    assert.match(pad, /toAgentAttachments\(references\)/);
    assert.match(pad, /agent\.setAgentState\(\{ prompt: text/);
    assert.match(pad, /navigate\(`\/canvas\//);
});

test("reference picker keeps facets, multi-select, upload and confirm", () => {
    const picker = read("../../components/canvas/reference-asset-picker.tsx");
    assert.match(picker, /countReferenceFacets/);
    assert.match(picker, /toggleReferenceSelection/);
    assert.match(picker, /paginateReferences/);
    assert.match(picker, /uploadImage\(file, \{ category: "library" \}\)/);
    assert.match(picker, /addAsset\(\{/);
    assert.match(picker, /reference-selected-count/);
    assert.match(picker, /reference-confirm/);
    assert.match(picker, /onConfirm\(selectedItems\)/);
});

test("zh-CN and en-US ship the same creativePad key set", () => {
    const zh = creativePadBlock("../../i18n/locales/zh-CN.ts");
    const en = creativePadBlock("../../i18n/locales/en-US.ts");
    const zhKeys = localeKeys(zh);
    const enKeys = localeKeys(en);
    assert.ok(zhKeys.length > 40, `expected a full key set, got ${zhKeys.length}`);
    assert.deepEqual(enKeys, zhKeys, "a missing translation would render the raw key in the UI");
    for (const required of ["picker", "examples", "modes", "placeholders", "confirm", "selected", "registeredOnly"]) {
        assert.ok(zhKeys.includes(required), `missing key ${required}`);
    }
});

test("launch pad exposes the model's canvas custom settings and forwards them to generation", () => {
    const pad = read("./creative-launch-pad.tsx");
    for (const popover of ["CanvasImageSettingsPopover", "CanvasVideoSettingsPopover", "CanvasAudioSettingsPopover", "CanvasTextSettingsPopover"]) {
        assert.match(pad, new RegExp(`<${popover}`), `pad must render ${popover}`);
    }
    assert.match(pad, /comfyParams=\{comfyParams\}/);
    assert.match(pad, /runTargetOverride=\{imageRunTarget\}/);
    assert.match(pad, /runTargetOverride=\{videoRunTarget\}/);
    assert.match(pad, /referenceCount=\{imageReferenceCount\}/);
    const generationBlock = pad.slice(pad.indexOf("const startGeneration"), pad.indexOf("const fillExample"));
    assert.match(generationBlock, /comfyParams,/);
    assert.match(generationBlock, /imageRunTarget,/);
    assert.match(generationBlock, /videoRunTarget,/);

    const lib = read("../../lib/creative-generation.ts");
    assert.match(lib, /params: comfyParams, runTarget: options\.imageRunTarget/);
    assert.match(lib, /params: comfyParams, runTarget: options\.videoRunTarget/);
    assert.match(lib, /params: \{ \.\.\.audioParams, \.\.\.comfyParams \}/);
    assert.match(lib, /comfyParams \? \{ comfyParams \}/);
    assert.match(lib, /imageRunTarget: options\.imageRunTarget/);
    assert.match(lib, /videoRunTarget: options\.videoRunTarget/);
});
