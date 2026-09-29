import { useSyncExternalStore } from "@infinite-canvas/plugin-sdk";

export type H3Locale = "zh-CN" | "en-US";

const labels = {
    prompt: ["提示词", "Prompt"],
    settings: ["参数设置", "Settings"],
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
