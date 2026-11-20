import type { StudioProductionState } from "./use-studio-data";

/**
 * 影策「全剧第一集出现前的四步卡」的本地真值派生（纯函数，便于单测）。
 * 真值来源：productionState（本地派生状态机）+ source_chapters 章节元信息 + 共享资产 + 第 1 集成片。
 * 没有真值的数字一律不显示，不写 0 占位。
 */

export type GenesisChapterTruth = {
    /** source_chapters 行数（章节数） */
    count: number;
    /** source_chapters.chars 之和（章节正文真实字符数） */
    wordCount: number;
};

export type StudioGenesisInput = {
    productionState: StudioProductionState;
    /** 本地前端暂停态（按剧目持久化在 localStorage，真实用户状态） */
    paused: boolean;
    /** 章节真值；null = 没有真值（章节还没切/查询失败），此时不显示字数 */
    chapterTruth: GenesisChapterTruth | null;
    /** 共享画布已有角色/场景/道具资产（作品圣经建档） */
    bibleReady: boolean;
    /** 实际分集数（productionState.planCursor） */
    episodeCount: number;
    /** 第 1 集有成片：draft.director.workflow.finalResource.storageKey 真值 */
    firstSampleReady: boolean;
};

export type GenesisStep = {
    key: "read" | "bible" | "adapt" | "sample";
    label: string;
    done: boolean;
    active: boolean;
};

export type GenesisCopy = {
    paused: boolean;
    /** draft = 还没开始制作（对应影策 status === "draft"） */
    draft: boolean;
    icon: "pause" | "orb";
    heading: string;
    description: string;
};

/** 对齐影策 drama-shared.formatCount（万 / 千分位），只吃真值数字。 */
export function formatGenesisCount(value: number): string {
    if (!Number.isFinite(value) || value < 0) return "0";
    if (value >= 10_000) return `${(value / 10_000).toFixed(value >= 100_000 ? 0 : 1)}万`;
    return Math.floor(value).toLocaleString("zh-CN");
}

export function deriveGenesisSteps(input: StudioGenesisInput): GenesisStep[] {
    const { productionState, chapterTruth, bibleReady, episodeCount, firstSampleReady } = input;
    const hasChapterTruth = Boolean(chapterTruth && chapterTruth.count > 0);
    const label = hasChapterTruth
        ? `读取小说 · ${formatGenesisCount(chapterTruth!.count)} 章 ${formatGenesisCount(chapterTruth!.wordCount)} 字`
        : productionState.chapterCount > 0
            ? `读取小说 · ${formatGenesisCount(productionState.chapterCount)} 章`
            : "读取小说";
    return [
        // 影策语义：读入小说是开工前置步骤，恒定 done；字数只在有真值时出现。
        { key: "read", label, done: true, active: false },
        { key: "bible", label: "建立作品圣经：角色、道具、场景与画面规则", done: bibleReady, active: !bibleReady },
        { key: "adapt", label: "分集改编：每集开场钩子与结尾悬念", done: episodeCount > 0, active: bibleReady && episodeCount === 0 },
        { key: "sample", label: "第 1 集样片：剧本、段提示词与段视频", done: firstSampleReady, active: false },
    ];
}

export function deriveGenesisCopy(input: StudioGenesisInput): GenesisCopy {
    const { productionState, paused, episodeCount } = input;
    const isPaused = paused || productionState.status === "paused";
    const draft = productionState.stage === "plan" && episodeCount === 0 && productionState.doneCount === 0;
    if (!isPaused) {
        return {
            paused: false, draft, icon: "orb",
            heading: "正在把小说改编成短剧",
            description: "这一步通常需要一两分钟。你可以离开页面，进度会在服务端继续。",
        };
    }
    const action = draft ? "开始制作" : "继续制作";
    return {
        paused: true, draft, icon: "pause",
        heading: draft ? "准备好就可以开始" : "制作已暂停",
        description: `${productionState.pauseReason || "系统会自动完成改编、建档、分镜与成片。"}点击右上角“${action}”。`,
    };
}

/** 渲染态：与 className is-done / is-active 完全同源，playwright 读 data-step-state 即可断言。 */
export function genesisStepState(step: GenesisStep, paused: boolean): "done" | "active" | "idle" {
    if (step.done) return "done";
    if (step.active && !paused) return "active";
    return "idle";
}
