import skillText from "../storyboard-assets/SKILL.md?raw";
import nsSkillText from "../storyboard-assets/ns-SKILL.md?raw";
import baseReference from "../storyboard-assets/references/base-en.txt?raw";
import refReference from "../storyboard-assets/references/ref-en.txt?raw";
import type { H3Ref } from "../types";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";

export type StoryboardMode = "ref2va" | "i2va" | "t2va" | "fl2va";
export type StoryboardSkill = "regular_storyboard" | "ns_storyboard";

const modeLabels: Record<StoryboardMode, string> = { ref2va: "多参 Ref2VA", i2va: "I2V 图生视频", t2va: "T2V 文生视频", fl2va: "首尾帧 FL2VA" };

export function validateStoryboardMode(mode: StoryboardMode, images: H3Ref[]) {
    const count = images.length;
    if (mode === "t2va" && count) throw new Error("T2V 文生视频不能使用参考图片");
    if (mode === "i2va" && count !== 1) throw new Error("I2V 图生视频必须且只能使用图片1");
    if (mode === "fl2va" && count !== 2) throw new Error("首尾帧 FL2VA 必须使用图片1和图片2");
    if (mode === "ref2va" && !count) throw new Error("多参 Ref2VA 至少需要1张参考图片");
}

export function storyboardSkill(mode: StoryboardMode, skill: StoryboardSkill) {
    if (skill === "ns_storyboard") return nsSkillText;
    return `${skillText}\n\n---\n\n# Embedded reference\n\n${mode === "ref2va" ? refReference : baseReference}`;
}

function modeContract(mode: StoryboardMode, count: number) {
    const common = `严格输出${count}段。从段1开始依次编号到段${count}；每个标题行只能写对应的“段N”，不得写其他文字。段之间用---分隔。每段必须是可直接复制使用的完整官方提示词。相邻两段必须联合设计，下一段首镜继承上一段尾镜的站位、景别、动作阶段、道具状态、光线和轴线；不得瞬移、越轴、重置动作或跳过动作。`;
    if (mode === "ref2va") return `${common}当前模式为Ref2VA多参。参考素材只提供身份、外观、场景、道具、风格或动作参考，不锁定任何Picture为0.00秒首帧。每段严格依次输出subject_definitions、summary、retention_analysis、detailed_description、overall_soundscape、non_diegetic_music六段，使用<Subject N>/<Picture N>。`;
    if (mode === "i2va") return `${common}当前模式为I2VA图生视频。每段先写@图片1对应Picture 1在0.00秒的官方首帧对齐句，再输出integrated_multimodal_description、overall_soundscape、non_diegetic_music。`;
    if (mode === "fl2va") return `${common}当前模式为FL2VA首尾帧。每段先写Picture 1对齐0.00秒、Picture 2对齐结束时刻的官方首尾对齐句，再输出integrated_multimodal_description、overall_soundscape、non_diegetic_music。`;
    return `${common}当前模式为T2VA文生视频。不得写任何Picture、Video、Audio引用或对齐句；每段输出integrated_multimodal_description、overall_soundscape、non_diegetic_music。`;
}

export function storyboardMessages(skill: string, idea: string, count: number, images: H3Ref[], analysis: string, mode: StoryboardMode, duration: number) {
    const manifest = images.map((image, index) => `@图片${index + 1}：${image.name}`).join("\n") || "无图片";
    return [{ role: "system" as const, content: `严格执行下面的H3官方提示词Skill和当前模式契约，只输出正式结果，不解释。\n\n${skill}` }, { role: "user" as const, content: `当前官方模式：${modeLabels[mode]}\n硬性时长先决条件：每个分镜对应${duration}秒视频。\n${modeContract(mode, count)}\n\n用户想法：\n${idea || "请根据参考素材合理创作。"}\n\n固定上传槽位：\n${manifest}\n\n逐图看图结果：\n${analysis || "无"}\n\n禁止追问。图片编号严格绑定上传槽位，不重排、不编造；用户原有对白必须保留说话人、原意和顺序。` }];
}

export function parseStoryboard(text: string, count: number) {
    const raw = text.replace(/```(?:text)?|```/g, "").trim();
    const matches = [...raw.matchAll(/^\s*段\s*(\d+)\s*[:：]?\s*$/gm)];
    if (matches.some((match, index) => Number(match[1]) !== index + 1)) throw new Error("模型返回的段号存在跳号、重复或顺序错误");
    const segments = matches.map((match, index) => raw.slice(match.index!, matches[index + 1]?.index ?? raw.length).replace(/^-+\s*$/, "").trim());
    if (segments.length !== count) throw new Error(`模型返回${segments.length}段，但要求${count}段`);
    const global = raw.match(/^全局提示词\s*[:：]([\s\S]*?)(?=^\s*段\s*1\b)/m)?.[1]?.trim() || "";
    return { global, segments, raw };
}

export const storyboardOutputBudget = (count: number) => Math.min(24000, 4200 + 1800 * Math.max(1, Math.min(12, count)));

export function readStoryboardUpload(file: File): Promise<H3Ref> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ url: String(reader.result || ""), type: "image", name: file.name });
        reader.onerror = () => reject(reader.error || new Error("参考图片读取失败"));
        reader.readAsDataURL(file);
    });
}

export async function generateSmartStoryboard(ctx: CanvasNodeContext, refs: H3Ref[]) {
    const images = refs.filter((ref) => ref.type === "image");
    const duration = Number(ctx.node.metadata?.duration || 5);
    const count = Math.max(1, Math.min(12, Number(ctx.node.metadata?.smartStoryboardCount || 3)));
    const mode = String(ctx.node.metadata?.smartStoryboardMode || "ref2va") as StoryboardMode;
    const skillId = String(ctx.node.metadata?.smartStoryboardSkill || "regular_storyboard") as StoryboardSkill;
    ctx.updateMetadata({ status: "loading", errorDetails: "正在分析参考图并生成智能分镜…" });
    try {
        if (duration < 1 || duration > 15) throw new Error("视频时长必须为1到15秒");
        validateStoryboardMode(mode, images);
        const analysisParts: string[] = [];
        for (const [index, image] of images.entries()) {
            const result = await ctx.ai.generateText(`你现在只分析一张参考图片，固定编号是@图片${index + 1}。严格分类为人物图、场景图、产品或道具图三类之一，并提取身份、外观、服装、姿态、空间结构、光线、时间天气及其在连续视频中的参考职责。只返回分析正文，不要追问。`, { references: [{ url: image.url, name: image.name }], system: "你是南风 H3 逐图视觉分析器。严格按图片槽位编号分析，不改编号，不编造图片内容。" });
            analysisParts.push(`@图片${index + 1}（${image.name}）：\n${result.text.trim()}`);
        }
        const messages = storyboardMessages(storyboardSkill(mode, skillId), String(ctx.node.metadata?.prompt || ""), count, images, analysisParts.join("\n\n"), mode, duration);
        const result = await ctx.ai.generateText(messages[1].content, { system: messages[0].content });
        const parsed = parseStoryboard(result.text, count);
        const taskMode = mode === "t2va" ? "t2v" : mode === "i2va" ? "i2v" : mode === "fl2va" ? "fl2v" : "r2v";
        const segments = parsed.segments.map((prompt, index) => ({ id: `smart-${Date.now()}-${index}`, prompt, duration, taskMode, status: "idle" }));
        ctx.updateMetadata({ segments, prompt: segments[0].prompt, smartStoryboardGlobal: parsed.global, smartStoryboardRaw: parsed.raw, smartStoryboardVisionAnalysis: analysisParts.join("\n\n"), smartStoryboardOutputBudget: storyboardOutputBudget(count), status: "success", errorDetails: "" });
    } catch (error) {
        ctx.updateMetadata({ status: "error", errorDetails: error instanceof Error ? error.message : String(error) });
    }
}
