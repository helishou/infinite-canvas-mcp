import skillText from "../storyboard-assets/SKILL.md?raw";
import nsSkillText from "../storyboard-assets/ns-SKILL.md?raw";
import type { H3Ref } from "../types";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { segmentsFor, compactSegmentStarts } from "../hooks/useH3Segments";
import { refsForSegment, segmentRefsPatch } from "./h3-data";

export type StoryboardMode = "ref2va" | "i2va" | "t2va" | "fl2va";
export type StoryboardSkill = "regular_storyboard" | "ns_storyboard";

const modeLabels: Record<StoryboardMode, string> = { ref2va: "多参 Ref2VA", i2va: "I2V 图生视频", t2va: "T2V 文生视频", fl2va: "首尾帧 FL2VA" };

export function validateStoryboardMode(mode: StoryboardMode, images: H3Ref[]) {
    const count = images.length;
    if (mode === "t2va" && count) throw new Error("T2V 文生视频不能使用参考图片");
    if (mode === "i2va" && (count !== 1 || images[0]?.slot !== 1)) throw new Error("I2V 图生视频必须且只能使用图片1");
    if (mode === "fl2va" && (count !== 2 || images[0]?.slot !== 1 || images[1]?.slot !== 2)) throw new Error("首尾帧 FL2VA 必须使用图片1和图片2");
    if (mode === "ref2va" && !count) throw new Error("多参 Ref2VA 至少需要1张参考图片");
}

export function storyboardSkill(mode: StoryboardMode, skill: StoryboardSkill) {
    return skill === "ns_storyboard" ? nsSkillText : skillText;
}

function modeContract(mode: StoryboardMode, count: number) {
    const common = `严格输出${count}段。从段1开始依次编号到段${count}；每个标题行只能写对应的“段N”，不得写“段1到段${count}”或其他文字。段之间用---分隔。每段必须是可直接复制使用的完整官方提示词。相邻两段必须作为一个整体联合设计：先联合规划段N尾镜与段N+1首镜，再分别写入两段。下一段首镜必须继承上一段尾镜的站位关系、前中后景、左右位置、朝向、视线、距离、遮挡、动作阶段、道具状态和180度动作轴；切镜只改变观察位置，不改变世界状态。跨段边界必须形成可剪辑的镜头变化，优先使用动作轴内的正反打、反应镜头，或有动机的景别/机位变化。不得瞬移、越轴、左右互换、重置动作或跳过动作；下一段第一帧必须直接落在上一段尾镜状态，不得重新建立人物站位或让动作重新起势。`;
    if (mode === "ref2va") return `${common}当前模式为 Ref2VA 多参。参考素材只提供身份、外观、场景、道具、风格或动作参考，不锁定任何图片为0.00秒首帧；不得轮播、拼贴或从参考图原始构图/姿势起步。每段00:00直接进入该段目标剧情构图。每段严格依次输出 subject_definitions、summary、retention_analysis、detailed_description、overall_soundscape、non_diegetic_music 六段，并使用 <Subject N>/<Picture N>/<Video N>/<Audio N>。`;
    if (mode === "i2va") return `${common}当前模式为 I2VA 图生视频。每段先写 Picture 1 在0.00秒对应首帧的官方对齐句，再依次输出 integrated_multimodal_description、overall_soundscape、non_diegetic_music；动作必须从首帧状态向后连续发展。`;
    if (mode === "fl2va") return `${common}当前模式为 FL2VA 首尾帧。每段先写 Picture 1 对齐0.00秒、Picture 2 对齐该段结束时刻的官方首尾帧对齐句，再依次输出 integrated_multimodal_description、overall_soundscape、non_diegetic_music；必须描述从首帧到尾帧的连续路径。`;
    return `${common}当前模式为 T2VA 文生视频。不得写任何 Picture、Video、Audio 引用或对齐句；每段严格依次输出 integrated_multimodal_description、overall_soundscape、non_diegetic_music。`;
}

export function storyboardMessages(skill: string, idea: string, count: number, images: H3Ref[], analysis: string, mode: StoryboardMode, duration: number) {
    const counters = { image: 0, video: 0, audio: 0 };
    const manifest = images.map((ref) => {
        const ordinal = ++counters[ref.type];
        const label = ref.type === "image" ? "图片" : ref.type === "video" ? "视频" : "音频";
        return `@${label}${ordinal}：${ref.name || "未命名素材"}`;
    }).join("\n") || "无参考素材";
    return [{ role: "system" as const, content: `严格执行下面的H3官方提示词Skill和当前模式契约，只输出正式结果，不解释。\n\n${skill}` }, { role: "user" as const, content: `当前官方模式：${modeLabels[mode]}\n硬性时长先决条件：每个分镜对应${duration}秒视频。必须按该时长规划动作密度、镜头数量、对白长度、动作收束和段尾状态，不得按默认时长写作。\n${modeContract(mode, count)}\n\n用户想法：\n${idea || "请根据参考素材合理创作。"}\n\n固定上传槽位：\n${manifest}\n\n逐图看图结果：\n${analysis || "无"}\n\n禁止追问。图片编号严格绑定上传槽位，不重排、不编造；用户原有对白必须保留说话人、原意和顺序。` }];
}

export function parseStoryboard(text: string, count: number) {
    console.log("parseStoryboard", { count, text: text.slice(0, 200) });
    const raw = text.replace(/```(?:text)?|```/g, "").trim();
    const matches = [...raw.matchAll(/^\s*段\s*(\d+)\s*[:：-]?\s*/gm)];
    if (matches.some((match, index) => Number(match[1]) !== index + 1)) throw new Error("模型返回的段号存在跳号、重复或顺序错误");
    const segments = matches.map((match, index) => raw.slice(match.index!, matches[index + 1]?.index ?? raw.length).replace(/^-+\s*$/, "").trim());
    const fallbackSegments = segments.length === 1 && count > 1
        ? segments[0].split(/\n\s*-{3,}\s*\n/).map((item) => item.trim()).filter(Boolean)
        : segments;
    if (fallbackSegments.length !== count) throw new Error(`模型返回${fallbackSegments.length}段，但要求${count}段`);
    const global = raw.match(/^全局提示词\s*[:：]([\s\S]*?)(?=^\s*段\s*1\b)/m)?.[1]?.trim() || "";
    return { global, segments: fallbackSegments, raw };
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

async function imageReferenceUrl(ref: H3Ref) {
    if (ref.url.startsWith("data:")) return ref.url;
    const candidates = [ref.url, ref.storageKey ? `/media/${encodeURIComponent(ref.storageKey)}` : ""].filter(Boolean);
    let response: Response | undefined;
    let lastError = "";
    for (const candidate of candidates) {
        try {
            const current = await fetch(candidate, { mode: "cors", cache: "no-store" });
            if (current.ok) { response = current; break; }
            lastError = `HTTP ${current.status}`;
        } catch (error) {
            // 浏览器 fetch 跨域失败时，error.message 通常是 "Failed to fetch"。
            // 把候选 URL 的 host 部分带出来，便于定位是哪个域的 CORS / 网络问题。
            const message = error instanceof Error ? error.message : String(error);
            let host = "";
            try { host = new URL(candidate).host; } catch {}
            lastError = host ? `${message}（源 ${host}）` : message;
        }
    }
    if (!response) throw new Error(`读取图片失败（${lastError || "地址不可访问"}）`);
    const blob = await response.blob();
    return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("图片转换失败"));
        reader.readAsDataURL(blob);
    });
}

export async function generateSmartStoryboard(ctx: CanvasNodeContext, refs: H3Ref[]) {
    const numbered = { image: 0, video: 0, audio: 0 };
    const orderedRefs = refs.filter((ref) => ref.url).map((ref) => ({ ...ref, slot: ref.slot || ++numbered[ref.type] }));
    const images = orderedRefs.filter((ref) => ref.type === "image");
    const duration = Number(ctx.node.metadata?.duration || 5);
    const count = Math.max(1, Math.min(12, Number(ctx.node.metadata?.smartStoryboardCount || 3)));
    const mode = String(ctx.node.metadata?.smartStoryboardMode || "ref2va") as StoryboardMode;
    const skillId = String(ctx.node.metadata?.smartStoryboardSkill || "regular_storyboard") as StoryboardSkill;
    // 进度消息只能写 smartStoryboardError（智能分镜自己的字段），禁止碰 errorDetails——
    // 那是生成任务的错误字段，底部状态栏会加「失败：」前缀展示；此前把进度写进去，
    // 节点带着旧的 error 状态时就出现「失败：参考图分析完成，正在生成智能分镜…」的错乱红标。
    ctx.updateMetadata({ smartStoryboardStatus: "loading", smartStoryboardError: "正在分析参考图并生成智能分镜…" });
    try {
        if (duration < 1 || duration > 15) throw new Error("视频时长必须为1到15秒");
        validateStoryboardMode(mode, images);
        const analysisParts: string[] = [];
        for (const [index, image] of images.entries()) {
            ctx.updateMetadata({ smartStoryboardStatus: "loading", smartStoryboardError: `正在分析参考图 ${index + 1}/${images.length}…` });
            const imageUrl = await imageReferenceUrl(image);
            const slot = image.slot || index + 1;
            let result;
            const imageMeta = { index, slot, name: image.name, isDataUrl: imageUrl.startsWith("data:"), dataUrlBytes: imageUrl.length };
            console.log("generateSmartStoryboard analyze", imageMeta);
            try {
                result = await ctx.ai.generateText(`你现在只分析一张参考图片，固定编号是@图片${slot}。严格分类为人物图、场景图、产品或道具图三类之一，并提取身份、外观、服装、姿态、空间结构、光线、时间天气及其在连续视频中的参考职责。只返回分析正文，不要追问。`, { references: [{ url: imageUrl, name: image.name }], system: "你是 H3 逐图视觉分析器。严格按图片槽位编号分析，不改编号，不编造图片内容。" });
            } catch (error) {
                // 视觉分析失败通常有 3 种根因，原生 message 经常太简短
                // （比如浏览器 CORS 直接抛 "Failed to fetch"，看不出是 baseUrl 还是
                // image_url 触发的）。把 ctx.ai 元信息、错误名和栈底也带出来。
                const raw = error instanceof Error ? error.message : String(error);
                const errorName = error instanceof Error ? error.name : "";
                const aiDefaults = (() => {
                    try {
                        return {
                            textModel: ctx.ai.defaultModel("text"),
                            imageModel: ctx.ai.defaultModel("image"),
                        };
                    } catch { return {}; }
                })();
                console.error("generateSmartStoryboard analyze failed", { ...imageMeta, errorName, raw, aiDefaults, stack: error instanceof Error ? error.stack : undefined });
                throw new Error(`分析参考图 ${index + 1}/${images.length}（${image.name || `图片${slot}`}，${imageMeta.dataUrlBytes} 字节）失败：${raw}${errorName && errorName !== "Error" ? ` (${errorName})` : ""}`);
            }
            analysisParts.push(`@图片${slot}（${image.name}）：\n${result.text.trim()}`);
        }
        const allowedRefs = mode === "t2va"
            ? []
            : mode === "i2va" || mode === "fl2va"
                ? images
                : orderedRefs;
        const messages = storyboardMessages(storyboardSkill(mode, skillId), String(ctx.node.metadata?.smartStoryboardIdea || ctx.node.metadata?.prompt || ""), count, allowedRefs, analysisParts.join("\n\n"), mode, duration);
        ctx.updateMetadata({ smartStoryboardStatus: "loading", smartStoryboardError: "参考图分析完成，正在生成智能分镜…" });
        const modelRefs = await Promise.all(allowedRefs.filter((ref) => ref.type === "image").map(async (ref) => ({ ...ref, url: await imageReferenceUrl(ref) })));
        let result;
        try {
            result = await ctx.ai.generateText(messages[1].content, {
                system: messages[0].content,
                references: modelRefs.map((ref) => ({ url: ref.url, name: ref.name })),
            });
        } catch (error) {
            const raw = error instanceof Error ? error.message : String(error);
            const errorName = error instanceof Error ? error.name : "";
            const aiDefaults = (() => {
                try {
                    return { textModel: ctx.ai.defaultModel("text") };
                } catch { return {}; }
            })();
            console.error("generateSmartStoryboard body failed", { errorName, raw, aiDefaults, imageCount: modelRefs.length, stack: error instanceof Error ? error.stack : undefined });
            throw new Error(`生成智能分镜正文失败：${raw}${errorName && errorName !== "Error" ? ` (${errorName})` : ""}`);
        }
        const parsed = parseStoryboard(result.text, count);
        const taskMode = mode === "t2va" ? "t2v" : mode === "i2va" ? "i2v" : mode === "fl2va" ? "fl2v" : "r2v";
        const metadata = ctx.getNode(ctx.node.id)?.metadata || ctx.node.metadata || {};
        const continuityEnabled = metadata.smartStoryboardContinuityEnabled !== false;
        const existing = segmentsFor(metadata);
        const selected = existing.find((segment) => segment.id === String(metadata.selectedSegmentId || "")) || existing[existing.length - 1];
        const selectedIndex = selected ? Math.max(0, existing.findIndex((segment) => segment.id === selected.id)) : existing.length - 1;
        // 调试日志：智能分镜合并 segments 前的关键状态。保留 console.log 方便用户复现
        // 问题时直接看 selected/existing/insertAt 等真实值（之前靠猜很容易看走眼）。
        console.log("[smart-storyboard] merge", {
            existingLength: existing.length,
            existingIds: existing.map((segment) => segment.id),
            existingPrompts: existing.map((segment) => String(segment.prompt || "").slice(0, 40)),
            metadataSelectedId: String(metadata.selectedSegmentId || ""),
            selectedId: selected?.id,
            selectedPrompt: String(selected?.prompt || "").slice(0, 80),
            selectedIndex,
        });
        // 新生成的 smart 分段是 fresh start：只继承用户在 modal 里传入的 refs（图片为主），
        // 不再自动从 selected 段拉 video/audio。selected 的 result 视频不应被当成"参考"塞进
        // 新段，否则会复用到 ComfyUI 输入、且新段 outputs 列表会"莫名其妙"出现旧视频。
        const inheritedRefs = refs.filter((ref) => ref.url);
        // 从 selected 继承设置参数（modelName/loraName/mode/...），但显式置空运行时
        // 字段，避免历史 result/results 通过 spread 渗到新段。
        const inherited = selected
            ? { ...selected, ...segmentRefsPatch(inheritedRefs), result: "", resultStorageKey: undefined, results: [], status: "idle", progress: 0, runtimeTaskId: "" }
            : { ...segmentRefsPatch(inheritedRefs), duration, taskMode, status: "idle" as const, result: "", resultStorageKey: undefined, results: [], progress: 0, runtimeTaskId: "" };
        const created = parsed.segments.map((prompt, index) => ({ ...inherited, id: `smart-${Date.now()}-${index}`, prompt: parsed.global ? `全局提示词：\n${parsed.global}\n\n${prompt}` : prompt, duration, taskMode, motionContextEnabled: continuityEnabled, result: "", results: [], status: "idle" }));
        const insertAt = selectedIndex < 0 ? existing.length : selectedIndex + 1;
        const segments = compactSegmentStarts([...existing.slice(0, insertAt), ...created, ...existing.slice(insertAt)]);
        console.log("[smart-storyboard] merged", {
            mergedLength: segments.length,
            mergedIds: segments.map((segment) => segment.id),
            mergedPrompts: segments.map((segment) => String(segment.prompt || "").slice(0, 40)),
            selectedKept: segments[selectedIndex]?.id === selected?.id,
            selectedAfterPrompt: String(segments[selectedIndex]?.prompt || "").slice(0, 80),
        });
        // 切勿回写节点级 prompt：created 段各自已带独立 prompt（见上），
        // 而 segmentsFor 会让「没有自己 segment.prompt 的旧段」回退到 metadata.prompt，
        // 回写会把原 selected（如 clip1）的提示词被新段1污染。保持原样即可。
        // 成功后保持用户原选中段，不要强制跳到 created[0]：否则用户选中 clip4 生成三段后，
        // UI 会瞬间选中新生成的第一段，Prompt 面板显示第一段提示词，视觉上就像
        // 「clip4 的提示词被替换成了分镜第一段」。新段插在 clip4 之后，用户可自行点击查看。
        ctx.updateMetadata({ segments, selectedSegmentId: selected?.id || created[0]?.id, smartStoryboardGlobal: parsed.global, smartStoryboardRaw: parsed.raw, smartStoryboardVisionAnalysis: analysisParts.join("\n\n"), smartStoryboardOutputBudget: storyboardOutputBudget(count), smartStoryboardStatus: "success", smartStoryboardError: "" });
    } catch (error) {
        // 阶段化错误信息：让用户从一行文字判断是哪一步失败、底层原因是什么。
        // 智能分镜流程长(参考图分析 -> LLM 提示词 -> 解析 -> 写入 segments)，
        // 单看 "智能分镜生成失败" + 原始 message 经常无法判断到底是
        // 1) 没配 text 模型 / Codex 端未连接
        // 2) 模型不支持 image_url vision
        // 3) 视觉分析阶段 HTTP 502/超时
        // 4) 模型输出不符合"段N"格式
        // 5) 解析阶段段数不匹配
        const raw = error instanceof Error ? error.message : String(error);
        const stage = (() => {
            const msg = raw;
            if (msg.includes("视频时长必须")) return "参数校验";
            if (msg.startsWith("分析参考图 ")) return "逐图视觉分析";
            if (msg.startsWith("生成智能分镜正文失败")) return "分镜提示词生成";
            if (msg.includes("段号存在") || msg.includes("模型返回") || msg.includes("但要求")) return "分镜解析";
            if (msg.includes("读取图片失败") || msg.includes("地址不可访问")) return "参考图加载";
            if (msg.startsWith("T2V") || msg.startsWith("I2V") || msg.startsWith("首尾帧") || msg.startsWith("多参")) return "模式校验";
            if (msg.includes("AI 配置未就绪") || msg.includes("aiConfigRequired") || msg.includes("未配置") || msg.includes("model")) return "AI 配置";
            return "生成";
        })();
        ctx.updateMetadata({ smartStoryboardStatus: "error", smartStoryboardError: `[${stage}] ${raw}` });
    }
}
