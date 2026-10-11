import { useSyncExternalStore } from "@infinite-canvas/plugin-sdk";

export type H3Locale = "zh-CN" | "en-US";

const labels = {
    parameterPolicy: ["参数来源", "Parameter policy"],
    inheritDefaults: ["沿用保存默认", "Use saved defaults"],
    explicitOverrides: ["使用明确覆盖", "Use explicit overrides"],
    effectiveParameters: ["当前生效值", "Effective parameters"],
    parameterSources: ["展开查看参数与来源", "Show parameters and sources"],
    upscaleOff: ["放大关闭", "Upscale off"],
    checkSavedExecution: ["检查已保存稿的执行配置", "Check saved execution settings"],
    preflightReady: ["参数与参考预检通过", "Parameters and references ready"],
    executionMode: ["运行方式", "Execution mode"],
    executionAuto: ["自动分流", "Automatic routing"],
    executionLocal: ["本地", "Local"],
    executionRunningHub: ["RunningHub", "RunningHub"],
    executionHint: ["本地同时运行 1 个任务；RunningHub 工作流与并发数在 ComfyUI → 运行环境中设置。Motion Context 与分阶段确认使用本地。云端参数以已启用的工作流映射为准。", "Local runs one task at a time. Configure the RunningHub workflow and concurrency under ComfyUI → Runtime. Motion Context and staged confirmation use Local. Cloud parameters follow the enabled workflow mappings."],
    prompt: ["提示词", "Prompt"],
    settings: ["参数设置", "Settings"],
    selectedVideoModel: ["自选视频模型", "Choose video model"],
    selectedVideoModelHint: ["开启后使用下方所选视频模型及其已配置的渠道/工作流；H3 参数按该模型的工作流映射传递。关闭时使用 H3 默认执行流。", "Use the selected video model and its configured channel/workflow. H3 parameters follow that workflow's field mappings. Turn off to use the default H3 execution path."],
    selectedVideoRouteHint: ["自选模式下，执行渠道和工作流由所选视频模型决定。", "The selected video model determines the execution channel and workflow."],
    selectedVideoModelParameters: ["所选模型参数", "Selected model parameters"],
    selectedVideoModelLoading: ["正在读取模型参数…", "Loading model parameters…"],
    selectedVideoModelNoFields: ["该模型没有可编辑的工作流参数；提示词和参考素材仍由 H3 提交。", "This model has no editable workflow fields. H3 still supplies the prompt and references."],
    selectedVideoModelModeWarning: ["此模型不支持当前模式。参数可查看，但运行会被拒绝；请切换模式或模型。", "This model does not support the current mode. Parameters are shown, but runs are rejected; change the mode or model."],
    chooseVideoModel: ["选择视频模型", "Select a video model"],
    noVideoModels: ["请先在模型设置中配置视频模型", "Configure a video model in Model Settings first"],
    settingsScope: ["设置范围", "Settings scope"],
    currentClip: ["当前 Clip", "Current Clip"],
    globalSettings: ["全局配置", "Global settings"],
    clipScopeNotice: ["当前 Clip 模式：下方修改只作用于选中的 Clip。", "Current Clip mode: changes below affect only the selected Clip."],
    globalScopeNotice: ["全局配置已开启：下方每项修改会立即应用到此节点的所有 Clip，也会应用到之后新增的 Clip。提示词和参考素材不受影响。", "Global settings are on: each change below applies immediately to every Clip in this node and to new Clips. Prompts and references stay unchanged."],
    output: ["输出", "Output"],
    video: ["视频", "Video"],
    references: ["参考", "References"],
    image: ["图片", "Image"],
    audio: ["音频", "Audio"],
    summary: ["剧情摘要", "Summary"],
    detailedDescription: ["详细画面描述", "Detailed description"],
    integratedDescription: ["综合画面描述", "Integrated multimodal description"],
    soundscape: ["整体音景", "Overall soundscape"],
    music: ["非画内音乐", "Non-diegetic music"],
    optional: ["可留空", "Optional"],
    addStoryboardReference: ["请先在参考区添加分镜图", "Add storyboard images in References first"],
    cancelGeneration: ["取消生成", "Cancel generation"],
    cancellingGeneration: ["正在取消…", "Cancelling…"],
    cancelScopeHint: ["取消当前生成任务；连续运行时同时停止其后续 Clip", "Cancel this generation task and stop its remaining Clips"],
    cancelUnavailableHint: ["缺少父任务 ID，无法取消；请使用重置操作", "The parent task ID is missing; use reset to recover"],
    generationCancelled: ["已取消生成", "Generation cancelled"],
    generationAlreadyFinished: ["任务已结束", "The task has already finished"],
} as const satisfies Record<string, readonly [string, string]>;

export type H3Label = keyof typeof labels;

export function h3Label(locale: H3Locale, key: H3Label): string {
    return labels[key][locale === "en-US" ? 1 : 0];
}

function currentLocale(): H3Locale {
    return typeof document !== "undefined" && document.documentElement.lang.toLowerCase().startsWith("en") ? "en-US" : "zh-CN";
}

const localeListeners = new Set<() => void>();
let localeObserver: MutationObserver | null = null;

function subscribeLocale(listener: () => void): () => void {
    if (typeof document === "undefined") return () => {};
    localeListeners.add(listener);
    if (!localeObserver) {
        localeObserver = new MutationObserver(() => localeListeners.forEach((notify) => notify()));
        localeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    }
    return () => {
        localeListeners.delete(listener);
        if (!localeListeners.size) {
            localeObserver?.disconnect();
            localeObserver = null;
        }
    };
}

export function useH3Locale(): H3Locale {
    return useSyncExternalStore(subscribeLocale, currentLocale, () => "zh-CN");
}
