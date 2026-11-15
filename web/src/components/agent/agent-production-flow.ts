/**
 * 「总流程」的制作阶段流程：六段阶段本身从源稿游标 `settings.productionStage` 来（单一真值，见
 * canvas-video-production-sop/references/production-stage-order.md），这里只补每一段展开后的子步。
 *
 * 子步都用仓库内技能自己的说法，不新造名词：
 * - script  ← acheng-director/references/10-scriptwriter-engine.md、11-story-architecture.md（复用 OUTLINE_STAGES）
 * - assets  ← acheng-director/references/60-assets-and-keyframes.md「角色身份资产默认：先单张、再四视图」，modules/assets
 * - spatial ← canvas-video-production-sop/references/spatial-anchor-continuity.md「四层职责 / 轴线与反打 / 影调基准 / 三种锚点来源」
 * - shots   ← acheng-director/modules/shots（场次绑定、逐镜摄影字段、动作桥接、景别分布体检、120 复核）
 * - keyframes ← 同 60 号文件的关键帧工作模式与绑定验收
 * - clips   ← canvas-video-production-sop/references/canvas-compilation.md「预检与发布」、canvas-production-runs.md、canvas-clip-production.md
 *
 * 子步状态只看本轮文案有没有提到、写没写完（展示口径），绝不回写制作真值。
 */
import { PRODUCTION_STAGE_KEYS, stageStates, type ProductionStageKey, type ProductionStageValue } from "@/pages/drama/production-progress";
import { OUTLINE_STAGES } from "./agent-outline-flow";
import { substepTone, toneStatusKey, type FlowTone } from "./agent-flow-status";

export type StageSubstep = { label: string; en: string; keywords: string[] };

export const STAGE_SUBSTEPS: Record<ProductionStageKey, StageSubstep[]> = {
    script: OUTLINE_STAGES.map((stage) => ({ label: stage.label, en: stage.en, keywords: stage.keywords })),
    assets: [
        { label: "资产清单 asset_plan", en: "Asset plan", keywords: ["资产清单", "asset_plan", "资产规划", "资产卡"] },
        { label: "角色身份图", en: "Identity still", keywords: ["身份图", "全身", "identity", "身份源"] },
        { label: "角色四视图", en: "Turnaround sheet", keywords: ["四视图", "四格", "基准板", "turnaround"] },
        { label: "场景图", en: "Scene plates", keywords: ["场景图", "场景登记", "环境图"] },
        { label: "道具与参考绑定", en: "Props & bindings", keywords: ["道具", "参考绑定", "asset_cards"] },
    ],
    spatial: [
        { label: "分区与动线", en: "Zones & blocking", keywords: ["分区", "动线", "站位", "位置"] },
        { label: "轴线与反打方向", en: "Axis & reverse angles", keywords: ["轴线", "反打", "越轴", "朝向"] },
        { label: "影调与色彩基准", en: "Tone & color baseline", keywords: ["影调", "色彩", "基准", "色板"] },
        { label: "边界锚点图", en: "Boundary anchors", keywords: ["锚点", "尾帧", "截图", "空间简图"] },
    ],
    shots: [
        { label: "场次与场景绑定", en: "Scenes bound", keywords: ["场次", "scene_id", "source_scene_id", "场景绑定"] },
        { label: "逐镜拆分", en: "Shot breakdown", keywords: ["拆分", "分镜", "镜号", "shots"] },
        { label: "景别与运镜", en: "Framing & camera", keywords: ["景别", "机位", "运镜", "焦点"] },
        { label: "时长与对白帧窗", en: "Duration & dialogue", keywords: ["时长", "帧窗", "duration", "对白"] },
        { label: "动作桥接", en: "Action bridging", keywords: ["桥接", "尾态", "起态", "连续性"] },
        { label: "景别分布体检", en: "Framing balance", keywords: ["景别分布", "framing"] },
        { label: "120 复核", en: "120 audit", keywords: ["120", "复核", "可见性"] },
    ],
    keyframes: [
        { label: "选帧位", en: "Pick frames", keywords: ["首帧", "尾帧", "关键帧", "帧位"] },
        { label: "关键帧提示词", en: "Keyframe prompts", keywords: ["关键帧提示词", "提示词", "@图片"] },
        { label: "出图与归档", en: "Generate & archive", keywords: ["归档", "出图", "生成"] },
        { label: "绑定与验收", en: "Bind & accept", keywords: ["绑定", "验收", "采用"] },
    ],
    clips: [
        { label: "预检与发布", en: "Preflight & publish", keywords: ["预检", "发布", "就绪", "readiness"] },
        { label: "编译", en: "Compile", keywords: ["编译", "compile"] },
        { label: "翻译", en: "Translate", keywords: ["翻译", "translate"] },
        { label: "提交生成", en: "Submit render", keywords: ["提交", "排队", "渲染", "render"] },
        { label: "成片验收", en: "Accept clips", keywords: ["验收", "回看", "成片", "采用"] },
    ],
};

export type ProductionFlowRow = {
    /** 父行是 1..6，子行是 4.1、4.2 */
    index: string;
    /** 父行给 i18n key，子行给现成文案 */
    labelKey?: string;
    label?: string;
    tone: FlowTone;
    statusKey: string;
    depth: 0 | 1;
};

/** 游标缺失（老项目/未初始化）返回空数组：界面据此不显示，而不是假装停在第一步。 */
export function productionFlowRows(stage: ProductionStageValue, texts: readonly string[], busy: boolean, english = false): ProductionFlowRow[] {
    const states = stageStates(stage);
    if (!states.length) return [];
    const rows: ProductionFlowRow[] = [];
    states.forEach((item, order) => {
        const tone: FlowTone = item.state === "done" ? "done" : item.state === "current" ? "running" : "pending";
        rows.push({ index: String(order + 1), labelKey: `drama.production.progress.stage.${item.key}`, tone, statusKey: toneStatusKey(tone), depth: 0 });
        if (item.state !== "current" || !busy) return;
        STAGE_SUBSTEPS[item.key].forEach((substep, subOrder) => {
            const subTone = substepTone(texts, substep.keywords);
            rows.push({
                index: `${order + 1}.${subOrder + 1}`,
                label: english ? substep.en : substep.label,
                tone: subTone,
                statusKey: toneStatusKey(subTone),
                depth: 1,
            });
        });
    });
    return rows;
}

export const PRODUCTION_STAGE_ORDER = PRODUCTION_STAGE_KEYS;
