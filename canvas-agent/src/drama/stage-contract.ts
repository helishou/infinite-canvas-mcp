import { episodeHasScript } from "./production-contract.js";

/**
 * 剧目级阶段合同：选题 → 大纲 → 剧本 → 资产 → 分镜 → 视频。
 *
 * 只做派生，不新增第二份真值：
 * - 预约前四段看剧目级字段（topic / outline / outlineDetail / 分集剧本）；
 * - 资产、分镜、视频看每个分集既有的 productionStage 游标（script/assets/spatial/shots/keyframes/clips）。
 *
 * 后端 /drama/:dramaId/stage 与 agent 的 drama_stage_status 共用这一份判定，
 * 界面步骤条也从这里取，避免"页面说完成、agent 说没写"。
 */

export const dramaStageNames = ["topic", "outline", "script", "assets", "shots", "video"] as const;
export type DramaStageName = (typeof dramaStageNames)[number];

/** 每段对应的技能文件：agent 读它再动手，不凭记忆编流程。 */
export const DRAMA_STAGE_SKILLS: Record<DramaStageName, { skill: string; path: string; hint: string }> = {
    topic: { skill: "acheng-director", path: ".agents/skills/acheng-director/references/10-scriptwriter-engine.md", hint: "定题材、受众、调性、体量与画风" },
    outline: { skill: "acheng-director", path: ".agents/skills/acheng-director/references/11-story-architecture.md", hint: "写故事线、时空背景、角色、三幕与结局" },
    script: { skill: "acheng-director", path: ".agents/skills/acheng-director/references/10-scriptwriter-engine.md", hint: "按集写分场剧本大纲，集间承接" },
    assets: { skill: "canvas-video-production-sop", path: ".agents/skills/canvas-video-production-sop/references/60-assets-and-keyframes.md", hint: "角色/场景资产图与引用绑定" },
    shots: { skill: "canvas-video-production-sop", path: ".agents/skills/canvas-video-production-sop/references/120-precompile-shot-visibility-audit.md", hint: "拆分镜、分镜图提示词与可见性核对" },
    video: { skill: "canvas-video-production-sop", path: ".agents/skills/canvas-video-production-sop/references/canvas-clip-production.md", hint: "逐段生成 H3 视频并核对产出" },
};

export type DramaStageTopic = {
    themes?: readonly string[];
    theme?: string;
    logline?: string;
    episodes?: number;
    artStyle?: string;
    gender?: string;
    tones?: readonly string[];
};

export type DramaStageOutlineDetail = {
    worldContext?: string;
    threeActs?: readonly string[];
    ending?: string;
    characters?: readonly string[];
};

/** 分集在制作侧的真实游标（来自 episode_productions.draft_json.settings.productionStage）。 */
export type DramaStageEpisode = {
    episodeNumber: number;
    fullPlot?: string | null;
    synopsis?: string | null;
    stage?: { current?: string; done?: readonly string[] } | null;
};

export type DramaStageInput = {
    topic: DramaStageTopic;
    outline: string;
    outlineDetail: DramaStageOutlineDetail;
    episodes: readonly DramaStageEpisode[];
    /** 共享资产画布里已就绪的资产数；仅作参考信息，不参与完成判定（以分集游标为准）。 */
    assetCount?: number;
};

export type DramaStageState = {
    key: DramaStageName;
    done: boolean;
    /** 这一段的缺口，按可执行粒度写，agent 直接照做。 */
    gaps: string[];
    /** 进度分子/分母：分集类阶段是「做完的集数 / 总集数」，其余是 0/1。 */
    doneCount: number;
    total: number;
};

const text = (value: unknown) => String(value ?? "").trim();

const themeOk = (topic: DramaStageTopic) => (topic.themes?.length || 0) > 0 || Boolean(text(topic.theme));
const outlineOk = (input: DramaStageInput) =>
    Boolean(text(input.outline)) && Boolean(text(input.outlineDetail.worldContext)) && (input.outlineDetail.threeActs?.length || 0) >= 3 && Boolean(text(input.outlineDetail.ending));

const doneStages = (episode: DramaStageEpisode) => new Set(Array.isArray(episode.stage?.done) ? episode.stage!.done! : []);
const stageReached = (episode: DramaStageEpisode, key: string) => episode.stage?.current === key || doneStages(episode).has(key);

/** 六段状态，全部由数据派生。 */
export function dramaStageStates(input: DramaStageInput): DramaStageState[] {
    const episodes = input.episodes || [];
    const written = episodes.filter(episode => episodeHasScript(episode)).length;
    const scriptsGaps = episodes.filter(episode => !episodeHasScript(episode)).map(episode => `第 ${episode.episodeNumber} 集还没写剧本大纲`);
    const assetsEpisodes = episodes.filter(episode => stageReached(episode, "assets") || stageReached(episode, "spatial"));
    const shotsEpisodes = episodes.filter(episode => stageReached(episode, "shots") || stageReached(episode, "keyframes"));
    const videoEpisodes = episodes.filter(episode => stageReached(episode, "clips"));

    const topicGaps = [
        ...(themeOk(input.topic) ? [] : ["还没有选题题材"]),
        ...(text(input.topic.logline) ? [] : ["还没有一句话故事"]),
        ...((input.topic.episodes || 0) > 0 ? [] : ["还没定集数"]),
    ];
    const outlineGaps = [
        ...(text(input.outline) ? [] : ["还没有全剧故事线"]),
        ...(text(input.outlineDetail.worldContext) ? [] : ["缺时空背景"]),
        ...((input.outlineDetail.threeActs?.length || 0) >= 3 ? [] : ["三幕与节奏不满三幕"]),
        ...(text(input.outlineDetail.ending) ? [] : ["缺结局和卡点"]),
    ];
    const assetsGaps = [
        ...(episodes.length ? [] : ["还没有分集"]),
        ...episodes.filter(episode => !assetsEpisodes.includes(episode)).map(episode => `第 ${episode.episodeNumber} 集还没进入资产阶段`),
    ];
    const shotsGaps = [
        ...(episodes.length ? [] : ["还没有分集"]),
        ...episodes.filter(episode => !shotsEpisodes.includes(episode)).map(episode => `第 ${episode.episodeNumber} 集还没到分镜阶段`),
    ];
    const videoGaps = [
        ...(episodes.length ? [] : ["还没有分集"]),
        ...episodes.filter(episode => !videoEpisodes.includes(episode)).map(episode => `第 ${episode.episodeNumber} 集还没有成片段落`),
    ];

    const states: DramaStageState[] = [
        { key: "topic", done: topicGaps.length === 0, gaps: topicGaps, doneCount: topicGaps.length ? 0 : 1, total: 1 },
        { key: "outline", done: outlineOk(input) && outlineGaps.length === 0, gaps: outlineGaps, doneCount: outlineGaps.length ? 0 : 1, total: 1 },
        { key: "script", done: episodes.length > 0 && written === episodes.length, gaps: episodes.length ? scriptsGaps : ["还没有分集"], doneCount: written, total: episodes.length || 1 },
        { key: "assets", done: episodes.length > 0 && assetsGaps.length === 0, gaps: assetsGaps, doneCount: assetsEpisodes.length, total: episodes.length || 1 },
        { key: "shots", done: episodes.length > 0 && shotsGaps.length === 0, gaps: shotsGaps, doneCount: shotsEpisodes.length, total: episodes.length || 1 },
        { key: "video", done: episodes.length > 0 && videoGaps.length === 0, gaps: videoGaps, doneCount: videoEpisodes.length, total: episodes.length || 1 },
    ];
    return states;
}

/** 当前阶段 = 最靠前的未完成段；全完成时返回 null。 */
export function dramaCurrentStage(states: readonly DramaStageState[]): DramaStageName | null {
    return states.find(state => !state.done)?.key ?? null;
}

export type DramaNextAction = {
    stage: DramaStageName | null;
    action: string;
    skill: string;
    skillPath: string;
    gaps: string[];
    /** 给人看的一行：下一步做啥、用哪份技能。 */
    line: string;
};

/** 下一步做什么 + 该读哪份技能；阶段全完成时给"进入制作"的指引。 */
export function dramaNextAction(states: readonly DramaStageState[]): DramaNextAction {
    const current = dramaCurrentStage(states);
    if (!current) {
        return {
            stage: null,
            action: "六段都完成了，进入制作台逐集出片",
            skill: "canvas-video-production-sop",
            skillPath: ".agents/skills/canvas-video-production-sop/SKILL.md",
            gaps: [],
            line: "下一步：进入制作台逐集出片 · 技能：canvas-video-production-sop",
        };
    }
    const state = states.find(item => item.key === current)!;
    const meta = DRAMA_STAGE_SKILLS[current];
    const action = state.gaps[0] ? state.gaps[0] : meta.hint;
    return {
        stage: current,
        action,
        skill: meta.skill,
        skillPath: meta.path,
        gaps: state.gaps,
        line: `下一步：${action} · 技能：${meta.skill}（${meta.path}）`,
    };
}

/** 注入给 agent 的阶段块；每轮刷新，agent 不用猜自己在哪一段。 */
export function renderDramaStageContext(input: {
    dramaName: string;
    dramaId: string;
    states: readonly DramaStageState[];
}): string {
    const next = dramaNextAction(input.states);
    const rows = input.states.map((state, index) => {
        const mark = state.done ? "完成" : state.key === next.stage ? "当前" : "未开始";
        const progress = state.total > 1 ? ` (${state.doneCount}/${state.total})` : "";
        const gap = state.gaps.length ? ` · 缺口：${state.gaps.slice(0, 3).join("；")}` : "";
        return `${index + 1}. ${state.key}${progress} — ${mark}${gap}`;
    });
    return [
        "## 当前剧目阶段（每轮刷新，以这里为准，不要凭上下文推断）",
        `剧目：${input.dramaName}（dramaId=${input.dramaId}）`,
        ...rows,
        `**${next.line}**`,
        "回复末尾固定两行：`下一步：…` 和 `技能：…`；只允许推进当前阶段，不要跨段抢做。",
    ].join("\n");
}

/** 阶段动作的可读标签：页面和 agent 回执都用同一份措辞。 */
export const DRAMA_STAGE_ACTIVITY: Record<DramaStageName, string> = {
    topic: "正在写选题",
    outline: "正在写大纲",
    script: "正在写剧本",
    assets: "正在做资产",
    shots: "正在拆分镜",
    video: "正在出片",
};

/**
 * 从一次工具调用反推它落在哪一段。
 * 用途：页面上实时显示「导演正在做什么」，不依赖模型自报。
 * 读类工具（stage_status / get_planning / get_episode）返回 null，不算在干活。
 */
export function stageForToolCall(tool: string, args: Record<string, unknown> = {}): { stage: DramaStageName; label: string } | null {
    const name = String(tool || "");
    const stage = (key: DramaStageName) => ({ stage: key, label: DRAMA_STAGE_ACTIVITY[key] });

    if (name === "drama_update_planning") {
        const keys = Object.keys(args).filter(key => key !== "dramaId" && key !== "expectedUpdatedAt");
        if (keys.includes("outline") || keys.includes("outlineDetail")) return stage("outline");
        if (keys.includes("topic")) return stage("topic");
        if (keys.includes("sourceScript")) return stage("topic");
        return null;
    }
    if (name === "drama_update_episode" && "fullPlot" in args) return stage("script");
    if (name === "drama_create_episode") return stage("script");
    if (/asset/.test(name) && /create|edit|bind|generate|update/.test(name)) return stage("assets");
    if (/storyboard|shot|frame|keyframe/.test(name)) return stage("shots");
    if (/generate_video|h3_|clip|segment/.test(name)) return stage("video");
    return null;
}
