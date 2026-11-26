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
    // 两个挂载点：完整创作台（hero）、全屏对话页停靠 composer（overlay）。
    // 空会话点「新对话」直接回到创作台，不再挂载内嵌空工作台的 composer；运行时至多渲染一个。
    assert.equal((home.match(/<CreativeLaunchPad\s/g) || []).length, 2);
    assert.match(home, /variant="thread"/);
    assert.match(home, /<CreativeLaunchPad/);
    assert.match(home, /onGenerated=\{recordLaunch\}/);
    assert.match(home, /historyCount=\{totalLaunchCount\}/);
    assert.ok(home.indexOf("<CreativeLaunchPad") < home.indexOf("{!hasWork && creationActions}"), "pad sits above the existing entry cards");
    assert.match(home, /data-testid="home-workbench"/, "existing home structure is preserved");
});

test("Enter submits the composer; Shift+Enter and IME composition stay safe", () => {
    const pad = read("./creative-launch-pad.tsx");
    // 影策 shouldSubmitOnEnter 语义：仅 Enter 提交；Shift+Enter 换行；输入法组字（isComposing / keyCode 229）放行。
    assert.match(pad, /function shouldSubmitOnEnter\(/);
    assert.match(pad, /if \(event\.key !== "Enter" \|\| event\.shiftKey\) return false;/);
    assert.match(pad, /event\.nativeEvent\.isComposing \|\| event\.keyCode === 229\) return false;/);
    // textarea 按键接上判断：命中即 preventDefault 并提交，且提交中不再重复触发。
    assert.match(pad, /if \(!shouldSubmitOnEnter\(event\)\) return;/);
    assert.match(pad, /if \(draft\.trim\(\) && hydrated && !submitting\) start\(true\);/);
});

test("generation stays in the home conversation workbench; canvas entry is explicit", () => {
    const pad = read("./creative-launch-pad.tsx");
    const generationBlock = pad.slice(pad.indexOf("const startGeneration"), pad.indexOf("const fillExample"));
    assert.ok(generationBlock.length > 0, "startGeneration must exist");
    // 对齐影策：提交后不跳转、也不建画布，进画布是点「新建画布」的显式动作。
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
    assert.match(generationLib, /conversationOnly \? undefined : canvas\.createProject/);
    assert.match(generationLib, /\.\.\.\(existingProject\?\.nodes \|\| \[\]\)/);
    const feed = read("./creative-generation-feed.tsx");
    // 对话形态：工具栏（新对话 + 历史 + 新建画布）+ 消息流 + 停靠 composer 槽位。
    assert.match(feed, /data-testid="creative-thread-workbench"/);
    assert.match(feed, /data-testid="creative-thread-toolbar"/);
    assert.match(feed, /data-testid="creative-thread-new"/);
    assert.match(feed, /data-testid="creative-thread-history"/);
    assert.match(feed, /data-testid="creative-thread-continue-canvas"/);
    assert.match(feed, /composer\?/);
    assert.match(feed, /data-testid="creative-thread-empty"/);
    assert.match(feed, /threadActive/);
    assert.match(feed, /\[\.\.\.launches\]\.reverse\(\)/, "thread messages render in chronological order");
    // 「生成动态」历史卡片网格已下线：对话形态仍保留，但旧 section 不得回归。
    assert.doesNotMatch(feed, /data-testid="creative-generation-feed"/, "legacy generation feed must stay retired");
    assert.doesNotMatch(feed, /home\.workbench\.feedTitle/);
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
    // 影策 handoff：点「新建画布」才创建项目并导入成果；已有画布仍可带 nodeId 聚焦。
    assert.match(home, /onCreateCanvas=\{\(\) => void createCanvasFromConversation\(\)\}/);
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

test("home conversations never create a canvas until the explicit New canvas action", () => {
    const pad = read("./creative-launch-pad.tsx");
    const lib = read("../../lib/creative-generation.ts");
    const data = read("./workbench-data.ts");
    const feed = read("./creative-generation-feed.tsx");
    const home = read("./index.tsx");
    // 首页提交走会话级生成：command 不带 projectId/nodeId，也不落画布节点。
    assert.match(pad, /createCanvas: false/);
    assert.match(lib, /createCanvas\?: boolean/);
    assert.match(lib, /const conversationOnly = options\.createCanvas === false && !existingProject/);
    assert.match(lib, /conversationOnly \? undefined : canvas\.createProject/);
    assert.match(lib, /if \(id\) \{/);
    assert.match(lib, /\.\.\.\(id \? \{ projectId: id, nodeId: configNodeId, sourceNodeId: configNodeId \} : \{\}\)/);
    // 会话记录不再强制要求画布 id；结果从任务详情读取。
    assert.match(data, /projectId\?: string/);
    assert.match(data, /export function resolveLaunchOutputs/);
    assert.match(feed, /resolveLaunchOutputs\(task, projectLogs, launch\)/);
    assert.match(feed, /data-canvas-action="create"/);
    assert.match(feed, /onCreateCanvas\?\.\(\)/);
    // 新建画布时才创建项目 + 落成结果节点 + 补生成日志，之后才跳转。
    assert.match(home, /const createCanvasFromConversation = async \(\) =>/);
    assert.match(home, /createBackendGenerationLog\(\{/);
    assert.match(home, /flushCanvasProjectBeforeGeneration\(id\)/);
    assert.match(home, /Promise\.race\(\[/, "backend sync must not block entering the canvas");
    assert.match(home, /onCreateCanvas=\{\(\) => void createCanvasFromConversation\(\)\}/);
    assert.match(home, /canCreateCanvas=\{canCreateCanvas \|\| creatingCanvas\}/);
    for (const file of ["../../i18n/locales/zh-CN.ts", "../../i18n/locales/en-US.ts"]) {
        const source = read(file);
        for (const key of ["feedCreateCanvas:", "threadCanvasPending:", "threadCanvasCreated:"]) assert.ok(source.includes(key), `${file} missing ${key}`);
    }
    assert.ok(!read("../../i18n/locales/zh-CN.ts").includes("继续在画布上编辑"), "stale zh canvas-entry copy must be gone");
    assert.ok(!read("../../i18n/locales/en-US.ts").includes('threadContinueCanvas: "Continue on canvas"'), "stale en canvas-entry copy must be gone");
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
    assert.match(pad, /createProject\(t\("canvas\.defaultTitle"/);
    // 带想法提交不再自动建画布：只有显式「新建空白画布」分支才允许 createProject。
    const withIdeaStart = pad.indexOf("        if (withIdea) {");
    const withIdeaEnd = pad.indexOf("        try {", withIdeaStart);
    assert.ok(withIdeaStart >= 0 && withIdeaEnd > withIdeaStart, "pad must keep an explicit no-canvas branch");
    assert.doesNotMatch(pad.slice(withIdeaStart, withIdeaEnd), /createProject\(/);
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

test("home composer ships the remaining Yingce affordances (voice input disabled): ratio pills, pending card, references, variant, downloads, recent canvases", () => {
    const pad = read("./creative-launch-pad.tsx");
    const feed = read("./creative-generation-feed.tsx");
    const home = read("./index.tsx");
    const data = read("./workbench-data.ts");
    const voice = read("./creative-voice-button.tsx");
    const recent = read("./creative-recent-canvases.tsx");

    // 语音输入暂时停用：首页两个 composer 形态都不渲染麦克风按钮，但组件、通道决策与 API 客户端完整保留，
    // 待接入云端 ASR 后把 VOICE_INPUT_ENABLED / VOICE_ASR_ENABLED 一起改回 true 即可恢复。
    assert.match(pad, /const VOICE_INPUT_ENABLED: boolean = false/);
    assert.match(pad, /const voiceButton = VOICE_INPUT_ENABLED \? \(/);
    assert.match(pad, /\) : null;/);
    assert.match(pad, /\{voiceButton\}/);
    const routes = read("../../../../backend/src/server/audio-transcribe-routes.ts");
    assert.match(routes, /const VOICE_ASR_ENABLED: boolean = false/);
    assert.match(routes, /VOICE_ASR_DISABLED/);
    assert.match(voice, /MediaRecorder\(stream\)/);
    assert.match(voice, /transcribeAudioClip\(/);
    assert.match(voice, /fetchAudioTranscribeStatus\(/);
    assert.match(voice, /resolveVoiceChannel\(/);
    assert.match(voice, /SpeechRecognition/, "Web Speech stays as the fallback path");
    assert.match(voice, /data-voice-channel=\{channel\}/);
    assert.match(voice, /data-voice-state=\{phase\}/);
    assert.match(voice, /creative-voice/);
    const api = read("../../services/backend-api.ts");
    assert.match(api, /AUDIO_TRANSCRIBE_PATH = "\/agent\/audio-transcribe"/);
    assert.match(api, /x-audio-language/);
    // 画幅 / 张数胶囊与设置 popover 共用同一份 overrides 状态。
    assert.match(pad, /creative-quick-params/);
    assert.match(pad, /mediaRatioOptions/);
    assert.match(pad, /creative-ratio-/);
    assert.match(pad, /creative-count-/);
    assert.match(pad, /setOverride\("imageCount"/);
    // 生成中占位卡：画幅比例 + 三段进度 + 耗时。
    assert.match(feed, /creative-media-pending/);
    assert.match(feed, /aspectRatio: String\(mediaAspect/);
    assert.match(feed, /creative-media-pending-frame/, "pending card keeps a ratio frame while filling the message column");
    assert.doesNotMatch(feed, /max-w-\[360px\]/, "pending card must not be capped to a small square");
    assert.match(feed, /max-w-\[1440px\]/, "thread message column must fill the workbench");
    assert.doesNotMatch(feed, /max-w-\[1000px\]/);
    assert.match(feed, /PENDING_STEPS/);
    assert.match(feed, /pendingElapsed/);
    // 引用缩略图 / 生成同款 / 下载。
    assert.match(feed, /creative-thread-references/);
    assert.match(feed, /creative-launch-regenerate/);
    assert.match(feed, /creative-launch-download/);
    assert.match(feed, /backendMediaUrl\(/);
    assert.match(data, /CreativeLaunchReference/);
    assert.match(data, /references\?: CreativeLaunchReference\[\]/);
    assert.match(pad, /referenceSnapshot/);
    assert.match(home, /regenerateLaunch/);
    assert.match(home, /onRegenerate=\{regenerateLaunch\}/);
    assert.match(pad, /injectedDraft\?\.submit/);
    assert.match(pad, /startGeneration\(\{ text: injectedText/);
    // 最近画布：新建卡 + 最近项目卡。
    assert.match(recent, /creative-recent-canvases/);
    assert.match(recent, /creative-recent-create/);
    assert.match(home, /<CreativeRecentCanvases/);
    assert.match(home, /createBlankCanvas/);

    for (const file of ["../../i18n/locales/zh-CN.ts", "../../i18n/locales/en-US.ts"]) {
        const source = read(file);
        for (const key of ["voice:", "voiceListening:", "voiceRecording:", "voiceTranscribing:", "voiceUnsupported:", "voiceAsrHint:", "voiceBrowserHint:", "voiceNoSpeech:", "voiceTranscribeFailed:", "voiceMicError:", "voiceEmpty:", "voiceRecorderUnsupported:", "ratio:", "recent:", "regenerate:", "download:", "resultCount:", "references:", "pendingStepQueue:", "pendingGenerating:", "pendingElapsed:"]) {
            assert.ok(source.includes(key), `${file} missing ${key}`);
        }
    }
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

test("the retired home project directory stays off the creative home page", () => {
    const home = read("./index.tsx");
    // 「剧目和画布」列表已下线，项目入口收敛到页头「剧目/画布」与最近画布卡片。
    assert.doesNotMatch(home, /home\.workbench\.projects/);
    assert.doesNotMatch(home, /home\.workbench\.recentProjects/);
    assert.doesNotMatch(home, /home-projects-loading/);
    assert.doesNotMatch(home, /homePinnedProject/);
    assert.doesNotMatch(home, /<Segmented/);
    assert.match(home, /<CreativeRecentCanvases/);
    assert.match(home, /data-testid="home-resume"/);
    assert.match(home, /to=\{path\}/, "drama/canvas entry cards remain reachable");
});

test("minimal home: no page header band and no frame around the creation hero", () => {
    const home = read("./index.tsx");
    const css = read("../../styles/globals.css");
    // 对齐影策极简首页：页面级 PageHeader（标题 + 剧目/画布/任务/新建画布条）整块下线；
    // 这些入口在全局顶栏 / 导航 / 快捷卡中已有，不重复占一整行。
    assert.doesNotMatch(home, /<PageHeader/, "home page header band must stay retired");
    assert.doesNotMatch(home, /from "@\/components\/layout\/page-header"/);
    assert.doesNotMatch(home, /const pageActions = \(/);
    // “今天想创作什么”直接落在页面背景上：.ch-hero 无边框 / 背景 / 阴影 / 光晕伪元素。
    const heroBlock = css.slice(css.indexOf(".ch-hero {"), css.indexOf(".ch-heading {"));
    assert.doesNotMatch(heroBlock, /border:/);
    assert.doesNotMatch(heroBlock, /background:/);
    assert.doesNotMatch(heroBlock, /box-shadow:/);
    assert.doesNotMatch(css, /\.ch-hero::before/);
    assert.doesNotMatch(css, /\.ch-hero::after/);
    // 新建画布入口仍在创作台快捷卡里，页头下线后功能不丢。
    assert.match(read("./creative-launch-pad.tsx"), /data-testid="creative-quick-blank"/);
});

test("recent outputs read a dedicated media log window, not the 30-log feed window", () => {
    const home = read("./index.tsx");
    const data = read("./use-workbench-data.ts");
    // 最近 30 条日志常被纯文本对话刷满，直接用 data.logs 会让「最近生成」空态。
    assert.match(home, /collectOutputs\(data\.mediaLogs\)/);
    assert.doesNotMatch(home, /collectOutputs\(data\.logs\)/);
    assert.match(home, /data\.loadMoreMedia/);
    assert.match(home, /data\.mediaHasMore/);
    assert.match(data, /limit: mediaLogCount, summary: true/);
    assert.match(data, /collectOutputs\(nextMediaLogs\)\.length/);
    assert.match(data, /mediaLogCount < 180/);
});

test("jumping to a canvas from a recent-output modal closes the result overlays", () => {
    const home = read("./index.tsx");
    const openDestination = home.slice(home.indexOf("const openDestination = "), home.indexOf("const openProject = "));
    assert.match(openDestination, /setPreviewOutput\(null\)/, "跳画布时未关闭结果预览弹窗");
    assert.match(openDestination, /setOutputsOpen\(false\)/, "跳画布时未关闭查看结果弹窗");
});

test("home canvas overlay exposes the production/canvas view switcher", () => {
    const home = read("./index.tsx");
    assert.match(home, /import \{ WorkspaceViewSwitcher \}/, "首页未引入视图切换器");
    assert.match(home, /canSwitchToProduction/, "切换器没有按画布归属判定是否显示");
    // 切换器挂在画布覆盖层可见时；切回制作台先收覆盖层，再进新制作台并按归属带上剧目/分集。
    const switchBlock = home.slice(home.indexOf("const switchToProduction = "), home.indexOf("return (\n        <main"));
    assert.match(switchBlock, /canvasHost\?\.collapse\?\.\(\)/, "切回制作台未收起画布覆盖层");
    assert.match(switchBlock, /\/drama-studio\?/, "切回制作台未导航到新制作台");
    assert.match(switchBlock, /query\.set\("episodeId", overlayEpisode\.episodeId\)/, "分集画布未把分集带到新制作台");
    assert.match(switchBlock, /query\.set\("dramaId", overlayOwner\.id\)/, "共享资产画布未带剧目 id");
    assert.match(home, /<WorkspaceViewSwitcher mode="canvas" onSelect=/, "覆盖层里没有渲染 canvas 态切换器");
});

test("generation results show the full media and the rerun action is explicit", () => {
    const feed = read("./creative-generation-feed.tsx");
    const media = read("./workbench-media.tsx");
    // 单张图/视频整幅展示，不再被 128px 的裁切小方图缩成缩略图。
    assert.match(feed, /CreativeResultGallery/);
    assert.match(feed, /data-display="full"/);
    assert.match(feed, /fit="contain"/);
    assert.match(feed, /onImageSize/);
    assert.doesNotMatch(feed, /h-28 cursor-pointer/, "result tiles must not be cropped thumbnails");
    assert.match(media, /fit\?: "cover" \| "contain"/);
    // 「生成同款」易被理解成复用当前图：改成明确的「再生成一张」+ 悬浮说明。
    assert.match(feed, /regenerateHint/);
    for (const file of ["../../i18n/locales/zh-CN.ts", "../../i18n/locales/en-US.ts"]) {
        const source = read(file);
        assert.match(source, /regenerateHint:/);
        assert.match(source, /clickToPreview:/);
        assert.doesNotMatch(source, /regenerate: "生成同款"|regenerate: "Generate again"/);
    }
});

test("no conversational generation entry auto-creates a canvas", () => {
    const tools = read("../../lib/agent/agent-site-tools.ts");
    const bus = read("../../lib/creative-conversation-bus.ts");
    const home = read("./index.tsx");
    const pad = read("./creative-launch-pad.tsx");
    const feed = read("./creative-generation-feed.tsx");
    const zh = read("../../i18n/locales/zh-CN.ts");
    const en = read("../../i18n/locales/en-US.ts");

    // Agent 面板的生图 / 生视频工具必须与创作台一致：默认会话级生成，只有显式开关才建画布。
    assert.match(tools, /createCanvas: false/);
    assert.match(tools, /input\.createCanvas === true/, "explicit canvas creation must stay available");
    assert.match(tools, /publishCreativeLaunch\(/);
    assert.doesNotMatch(tools, /startCreativeGeneration\(\{ capability: "image", prompt \}\)/, "image tool must not use the create-canvas default");
    assert.doesNotMatch(tools, /startCreativeGeneration\(\{ capability: "video", prompt \}\)/, "video tool must not use the create-canvas default");
    assert.match(bus, /CREATIVE_LAUNCH_EVENT/);
    assert.match(home, /subscribeCreativeLaunches/);
    assert.match(home, /recordLaunchRef\.current = recordLaunch/);
    // 显式落地后同一会话复用已有画布，绝不因为再点一次就又建一张。
    assert.match(home, /if \(activeConversation\.canvasId && projects\.some\(/);
    assert.match(home, /canvasId: id,/);

    // 带想法提交绝不 createProject；只有显式「新建空白画布」才建。
    assert.match(pad, /conversationOnlyHint/);
    const branchStart = pad.indexOf("        if (withIdea) {");
    const branchEnd = pad.indexOf("        try {", branchStart);
    const withIdeaBranch = branchEnd > branchStart ? pad.slice(branchStart, branchEnd) : "";
    assert.ok(withIdeaBranch.length > 0, "pad must keep an explicit no-canvas branch");
    assert.doesNotMatch(withIdeaBranch, /createProject\(/);
    // 对话工作台里每轮结果不再各挂一个「新建画布」入口，整会话只留工具栏一个。
    assert.match(feed, /launch\.projectId \|\| !threadActive/);

    for (const source of [zh, en]) {
        assert.match(source, /conversationOnlyHint:/);
        assert.doesNotMatch(source, /generateHint: "新建一张画布|Creates a canvas and generates right away/);
        assert.doesNotMatch(source, /startHint: "新建一张画布|Create a canvas and hand the idea/);
        assert.match(source, /conversationGenerationStarted:/);
        assert.doesNotMatch(source, /imageGenerate: "生成图片（新画布）"|Generate image \(new canvas\)/);
        assert.doesNotMatch(source, /videoGenerate: "生成视频（新画布）"|Generate video \(new canvas\)/);
    }
});

test("the legacy generation-feed card grid is retired without breaking the thread workbench", () => {
    const home = read("./index.tsx");
    const feed = read("./creative-generation-feed.tsx");
    // 首页非对话态不再挂载历史 feed；跨会话铺平的卡片网格彻底下线。
    assert.doesNotMatch(home, /flatLaunches/);
    assert.doesNotMatch(home, /totalLaunchCount > 0 \?/);
    assert.doesNotMatch(home, /home\.workbench\.feedTitle/);
    assert.doesNotMatch(feed, /data-testid="creative-generation-feed"/);
    assert.doesNotMatch(feed, /home\.workbench\.feedTitle/);
    assert.doesNotMatch(feed, /home\.workbench\.feedHint/);
    assert.doesNotMatch(feed, /data-testid="creative-launch-card"/);
    assert.match(feed, /if \(!threadActive\) return null;/);
    // 对话形态仍是生成进度 / 结果的唯一入口，且只由全屏覆盖层这一处挂载。
    // 空会话点「新对话」回到创作台，绝不在创作台里内联一个没有输入框的空工作台。
    assert.match(feed, /data-testid="creative-thread-workbench"/);
    assert.match(feed, /data-testid="creative-thread-continue-canvas"/);
    assert.match(home, /variant="thread"/);
    assert.equal((home.match(/<CreativeGenerationFeed/g) || []).length, 1);
    assert.match(home, /threadOverlayOpen && \([\s\S]*?<CreativeGenerationFeed/, "thread workbench mounts only inside the full-screen overlay");
    assert.doesNotMatch(home, /threadOverlayOpen \? null : threadActive \? \(/, "no inline empty thread shell outside the overlay");
    // 相邻板块不受影响。
    assert.match(home, /<CreativeRecentCanvases/);
    assert.match(home, /data-testid="home-resume"/);
    assert.match(home, /home\.workbench\.recentOutputs/);
    assert.match(home, /historyCount=\{totalLaunchCount\}/);
    assert.match(home, /onOpenHistory=\{\(\) => \{/);
});


test("settings popovers open below the trigger and the director launcher hides behind its drawer", () => {
    const pad = read("./creative-launch-pad.tsx");
    const position = read("../../components/canvas/canvas-settings-position.ts");
    const panel = read("../../components/canvas/canvas-image-settings-popover.tsx");
    const agentPanel = read("../../components/agent/agent-panel.tsx");

    // 首页创作台的参数按钮位于视口上半部：一律向下弹，避免把面板顶到页面最上沿遮住页头。
    const placements = [...pad.matchAll(/placement="([^"]+)"/g)].map(m => m[1]);
    assert.ok(placements.length >= 4, `expected 4 settings popovers, got ${placements.length}`);
    assert.ok(placements.every(p => p === "bottomRight"), `home settings must open downward: ${placements.join(",")}`);
    // bottom* 只要下方还有空间就向下；仅当下方几乎放不下且上方明显更宽裕时才回退。
    assert.match(position, /below < 120 && above > below/);
    assert.doesNotMatch(position, /!(below >= 260 \|\| below >= above)/);
    assert.match(panel, /canvasSettingsPosition\(buttonRect/);

    // 导演抽屉与右下角悬浮入口同处 workbench canvas overlay 时，明确分层避免露出半截按钮。
    // 新方案把两者一起 portal 到 overlay（独立层级上下文）：launcher z-[1000] / 抽屉 950。
    assert.match(agentPanel, /createPortal\(launcher, workbenchCanvasOverlay\)/);
    assert.match(agentPanel, /createPortal\(chatDialog, workbenchCanvasOverlay\)/);
    assert.match(agentPanel, /workbenchCanvasOverlay \? "z-\[1000\]" : "z-\[80\]"/);
    assert.match(agentPanel, /zIndex: workbenchCanvasOverlay \? 950 : undefined/);
    // 拖动入口不能在 pointerdown 就 setPointerCapture：那会把 click 目标重定向到外层 div，
    // 按钮的 onClick 收不到（真实鼠标点了没反应）。捕获只能在越过拖动阈值后发生。
    const pointerDownBlock = agentPanel.slice(agentPanel.indexOf("const onLauncherPointerDown"), agentPanel.indexOf("const onLauncherPointerMove"));
    assert.doesNotMatch(pointerDownBlock, /setPointerCapture/, "pointerdown 不能捕获指针");
    const moveBlock = agentPanel.slice(agentPanel.indexOf("const onLauncherPointerMove"), agentPanel.indexOf("const endLauncherDrag"));
    assert.match(moveBlock, /try \{ e\.currentTarget\.setPointerCapture/, "只有确认拖动后才捕获指针");
});

test("settings popovers stay compact against Tailwind preflight font-size overrides", () => {
    const css = read("../../styles/globals.css");
    // preflight 把 legend 设为 1.5em(24px)、button/input 设为 inherit(16px)，会盖掉组件上的
    // text-xs/text-sm 工具类；必须在浮层作用域内恢复紧凑字号，否则分组标题比正文大两倍。
    assert.match(css, /\.canvas-image-settings-popover legend\.font-semibold\s*\{[\s\S]{0,140}font-size:\s*12\.5px\s*!important/);
    assert.match(css, /\.canvas-image-settings-popover legend\s*\{[\s\S]{0,140}font-size:\s*11\.5px\s*!important/);
    assert.match(css, /\.canvas-image-settings-popover button,\s*\.canvas-image-settings-popover input\s*\{[\s\S]{0,140}font-size:\s*12\.5px\s*!important/);
    assert.match(css, /\.canvas-image-settings-popover \.text-lg\s*\{[\s\S]{0,140}font-size:\s*15px\s*!important/);
});
