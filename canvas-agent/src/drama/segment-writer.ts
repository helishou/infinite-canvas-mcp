/**
 * 段视频提示词撰写（纯函数，移植影策 production/segment_writer.go）。
 *
 * 影策 prompts 阶段：每段一次文本 LLM 写完整视频提示词，发给多镜头视频模型；
 * 本地此前只有 composeSegmentPrompt 的机械拼稿，没有「让模型撰写」能力。
 * 本模块提供：写作 system/user 模板（含参考图 header 预算）、清洗与参考图编号归一。
 * 模型回包由调用方写回画布 H3 clip.prompt（视频生成真正读取的字段）。
 */

export type SegmentWriterShot = {
    /** 镜头内序号对应的起止秒（素材稿时间码以此为准）。 */
    startSec: number;
    endSec: number;
    /** 画面内容。 */
    visual: string;
    /** 运镜/摄影。 */
    camera?: string;
    /** 本镜动作（影策 action）：画面里发生的具体动作，与静态构图分开。 */
    action?: string;
    /** 本镜起幅画面（影策 imagePrompt）：站位、朝向、表情、构图、光线、环境。 */
    imagePrompt?: string;
    /** 本镜镜内动作与运镜的时序（影策 videoPrompt），写清起止。 */
    videoPrompt?: string;
    /** 本镜对应原文小句（影策 sourceQuote），作为剧情依据交给写作模型。 */
    sourceQuote?: string;
    /** 台词（逐字保留）。单条兼容字段；多句优先读 dialogues。 */
    dialogue?: string;
    /** 说话人。单条兼容字段。 */
    speaker?: string;
    /** 本镜全部台词（逐字保留，按镜内先后顺序）。一个镜头 2–3 句时全部写入，优先于 dialogue/speaker。 */
    dialogues?: Array<{ text: string; speaker?: string }>;
    /** 本镜头参考图编号（1 起），用于「参考图N」。 */
    references?: number[];
};

export type SegmentWriterInput = {
    index: number;          // 0 起
    count: number;
    title: string;
    totalSec: number;
    shots: SegmentWriterShot[];
    style?: string;         // 表演风格
    cameraMotion?: string;  // 运镜风格
    aspectRatio?: string;
    artStyle?: string;      // 画风
    language?: string;
    maxChars?: number;      // 视频模型提示词硬上限，0/缺省=不设
    previousEnding?: string;
    /** 首帧来自上一段尾帧（尾帧接续能力本地已有）。 */
    firstFrame?: boolean;
    /** 并行独立出片（不依赖上一段画面）。 */
    independent?: boolean;
    skillName?: string;
    skillPath?: string;
    skillContent?: string;
    /** 本段参考图数量，用于勾选/校验引用编号。 */
    referenceCount?: number;
    /** 本段参考图清单（「参考图N：名称（类型）」），由后端从 asset_plan 派生。 */
    referenceLegend?: string[];
    /** 本段没有任何真参考图绑定：模板必须禁用“参考图N”编号写法。 */
    noReferenceBindings?: boolean;
    /**
     * 输出格式：material=中文素材稿结构（默认，旧链路）；h3-six-section=MiniMax H3 原生六段式英文。
     * 当 prompt 步骤选用 H3 提示词技能时由 pipeline 传入 h3-six-section，让所选技能的格式要求真正生效。
     */
    outputFormat?: "material" | "h3-six-section";
};

export const SEGMENT_WRITER_SYSTEM =
    "你是 AI 短剧的分镜导演兼表演指导，专门为多镜头视频生成模型撰写整段视频提示词。" +
    "你写的提示词会被原样发送给视频模型，所以必须具体到站位、朝向、表情与表演、台词的语气、手部与道具归属、运镜和每个时间片的动作，" +
    "禁止空泛形容。人物要像在演戏而不是摆拍，台词要像在说话而不是朗读。只输出提示词正文，不要任何解释、标题前缀或代码块。";

/** H3 六段式英文提示词的 system：对齐 MiniMax H3 原生 r2v 协议与 ep2 已验证格式。 */
export const H3_SIX_SECTION_SYSTEM =
    "You are a cinematographer writing a MiniMax H3 reference-to-video (r2v) prompt for one multi-shot segment. " +
    "Output ONLY the six-section plain-text prompt, English body, with the exact English section names and no explanation, code block or markdown. " +
    "Write shootable, concrete description: framing, subject placement, micro-actions, lighting, props, camera motion and per-beat timing. " +
    "Write every spoken line with the official H3 dialogue protocol: `<Subject N> (S1) says with <voice>: <d>[Chinese] exact line</d>`. Keep the Chinese line verbatim inside <d>; never paraphrase, drop or translate it.";

export const SEGMENT_CONDENSE_SYSTEM =
    "你是 AI 短剧的视频提示词编辑。你只做精简：在不改变镜头结构、台词与表演的前提下删去重复和冗余描述，" +
    "让提示词符合视频模型的字数上限。只输出精简后的提示词正文，不要任何解释、标题前缀或代码块。";

const secText = (sec: number) => `${Number(sec || 0).toFixed(1)}`;
const nonEmpty = (v: string | undefined, fallback: string) => (v && v.trim() ? v.trim() : fallback);
const MAX_SKILL_RUNES = 16000;
const truncate = (s: string, n: number) => Array.from(s).length <= n ? s : Array.from(s).slice(0, n).join("");

/** 参考图编号归一：@参考图1 / 参考图 1 → 参考图1。 */
export function normalizeReferenceTokens(text: string): string {
    return text.replace(/@?参考图\s*([0-9]+)/g, "参考图$1");
}

/** 返回超出 1..count 的非法参考图引用（去重，按出现顺序）。 */
export function unknownReferenceTokens(text: string, count: number): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const re = /@?参考图\s*([0-9]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
        const n = Number(m[1]);
        const label = `参考图${m[1]}`;
        if ((Number.isFinite(n) && n >= 1 && n <= count) || seen.has(label)) continue;
        seen.add(label);
        out.push(label);
    }
    return out;
}

/** 去掉模型偶尔包裹的代码块、前后空白与「第一行：」前缀，并归一参考图引用。 */
export function cleanWrittenPrompt(text: string): string {
    let t = String(text || "").trim();
    if (t.startsWith("```")) {
        const nl = t.indexOf("\n");
        if (nl >= 0) t = t.slice(nl + 1);
        t = t.replace(/```\s*$/, "").trim();
    }
    t = t.replace(/^第一行：/, "").trim();
    return normalizeReferenceTokens(t);
}

/**
 * 素材稿：时间码 + 台词 + 参考图编号，是写作与时间码校验的唯一依据。
 * 台词逐字来自 shots，模型不得改写。
 */
export function buildSegmentDraft(shots: SegmentWriterShot[], noReferenceBindings = false): string {
    // 一句台词一行：台词：speaker：“text”。多句来自 dialogues；单条 dialogue/speaker 路径保留兼容。
    const dialogueLine = (text: string, speaker: string) =>
        `台词：${speaker ? `${speaker}：` : ""}“${text}”`;
    return shots.map((s) => {
        const refs = noReferenceBindings ? [] : (s.references || []).filter((n) => Number.isFinite(n) && n > 0).map((n) => `参考图${n}`);
        const head = `${secText(s.startSec)}–${secText(s.endSec)}秒`;
        // 素材稿要把分镜的真实信息全交出去：只给「画面」一句时，写作模型只能复述这一句，
        // 起幅构图、镜内运动、原文依据全部丢失（ep1 的 32 字镜头就是这么来的）。
        // 字段顺序按写作模型的使用顺序：起幅 → 动作 → 镜内运动 → 原文依据。
        const parts = [
            s.camera && `运镜：${s.camera.trim()}`,
            s.visual && `画面：${s.visual.trim()}`,
            s.action && `动作：${s.action.trim()}`,
            s.imagePrompt && `起幅：${s.imagePrompt.trim()}`,
            s.videoPrompt && `镜内运动：${s.videoPrompt.trim()}`,
            s.sourceQuote && `原文依据：${s.sourceQuote.trim()}`,
        ].filter(Boolean) as string[];
        if (refs.length) parts.push(`参考：${refs.join("、")}`);
        const many = (Array.isArray(s.dialogues) ? s.dialogues : [])
            .map(d => ({ text: String(d?.text || "").trim(), speaker: String(d?.speaker || "").trim() }))
            .filter(d => d.text);
        // 无台词才写「绝对无台词」；多句时每句独立一行，绝不做长度截断或只取第一句。
        const lines = many.length
            ? many.map(d => dialogueLine(d.text, d.speaker))
            : (() => {
                const text = String(s.dialogue || "").trim();
                return [text ? dialogueLine(text, String(s.speaker || "").trim()) : "台词：绝对无台词"];
            })();
        return `${head}｜${parts.join("；")}\n${lines.join("\n")}`;
    }).join("\n");
}

/** 参考图说明 header 的字符预算：每个参考图带有固定开销，避免正文挤占视频模型上限。 */
export function segmentPromptBudget(maxChars: number | undefined, referenceCount: number): number {
    if (!maxChars || maxChars <= 0) return 0;
    const header = Math.max(0, referenceCount) * 28 + 40;
    return Math.max(200, maxChars - header);
}

function firstFrameRule(input: SegmentWriterInput, noRefs = false): string {
    const look = noRefs ? "以已设定的角色形象为准" : "以参考图为准";
    if (input.firstFrame) {
        return `请求会附带第${input.index}段视频的最后一帧作为本段首帧图（尾帧接续）。先写一句“首帧即第${input.index}段视频最后一帧”，再依据上一段结尾写清这一帧里每个人物的位置、朝向、姿态与道具接触，后续动作从这一帧自然延续；然后写渲染质感与画风、本段前中后段的视觉变化、明确禁止项（无额外滤镜噪点、无游戏 UI、无字幕水印、无全屏闪白等）`;
    }
    if (input.index > 0 && input.independent) {
        return "本段独立生成，没有首帧图：依据上一段结尾写清首帧画面里每个人物的位置、朝向、姿态与道具接触，人物外貌${look}；然后写渲染质感与画风、本段前中后段的视觉变化与明确禁止项";
    }
    return "本段是开场，没有首帧图：写清首帧画面里每个人物的位置、朝向、姿态与道具接触，人物外貌${look}；然后写渲染质感与画风、本段前中后段的视觉变化与明确禁止项";
}

/**
 * H3 六段式 user prompt：把素材稿/参考清单交给 LLM，要求按 MiniMax H3 原生 r2v 六段结构输出英文。
 * 与 ep2 已验证格式对齐，保证台词逐字、参考图编号、时间码不丢。
 */
function buildH3SixSectionUserPrompt(input: SegmentWriterInput, draft: string, noRefs: boolean, budget: number): string {
    const cont = input.index > 0 && !input.independent && !input.firstFrame;
    let b = "";
    b += `Write the MiniMax H3 r2v prompt for segment ${input.index + 1} of ${input.count} ("${input.title}"), ${secText(input.totalSec)}s, ${input.shots.length} shot(s). Body in English.\n\n`;
    if (budget > 0) b += `LENGTH: keep the whole prompt under ${budget} characters (video model hard limit). Cut decoration first, never cut dialogue, timecodes, shot blocks or picture tokens.\n\n`;
    if (input.skillContent && input.skillContent.trim()) {
        b += `WRITING SKILL — follow its structure and method strictly (it overrides any other structure notes):\n<skill>\n${truncate(input.skillContent.trim(), MAX_SKILL_RUNES)}\n</skill>\n\n`;
    }
    if (!noRefs && input.referenceLegend?.length) {
        b += `REFERENCE PICTURES (use these exact tokens, define each once in subject_definitions, never skip or renumber):\n${input.referenceLegend.map((line) => `- ${line}`).join("\n")}\n\n`;
    }
    if (cont && input.previousEnding?.trim()) {
        b += `CONTINUITY: no hard cut. Start from the previous segment's ending physical state:\n${input.previousEnding.trim()}\n\n`;
    }
    b += "OUTPUT EXACTLY SIX SECTIONS, each name alone on its line ending with a colon, blank line between sections, in this order:\n";
    b += "subject_definitions:\n";
    b += "  One line per subject in the lock list: `<Subject N> is the character <name> in <Picture N>` (or scene/prop with its asset name). Use <Subject N> as the label; <Picture N> is the identity reference inside. Define every picture, never skip or renumber. The character names come from the source draft's 台词 speaker names — use those exact names so dialogue can be attributed.\n";
    b += "summary:\n";
    b += "  Start with [Ref2VA], then a 1-3 sentence overview of the action, then a short list of reference relations (<Picture N> = ...).\n";
    b += "retention_analysis:\n";
    b += "  One entry per reference picture: `<Picture N> (shots):` then fully_preserved | partially_preserved and one line saying what stays fixed vs what follows the action.\n";
    b += "detailed_description:\n";
    b += "  Style sentence first, then one block per shot: `[Shot K] START–ENDs —` framing, placement, lighting, micro-actions, camera motion, and every spoken line in official H3 form `<Subject N> (S1) says with <voice>: <d>[Chinese] exact line</d>`. Keep the shot count, order, timecodes and dialogue from the source draft unchanged.\n";
    b += "overall_soundscape:\n";
    b += "  Ambient and action sounds, concrete and audible.\n";
    b += "non_diegetic_music:\n";
    b += "  Music cue or N/A.\n\n";
    b += "HARD RULES:\n";
    b += "1. Dialogue: copy every Chinese line verbatim from the source draft's 台词 lines, in order, wrapped as <d>[Chinese] exact line</d> and attributed to a locked subject as `<Subject N> (S1) says with <voice>: <d>[Chinese] exact line</d>`. Never rewrite, add, drop or translate the spoken words.\n";
    b += "2. Keep each shot's start/end seconds and shot order identical to the source draft; do not add or remove shots.\n";
    b += "3. Reference tokens: use only the picture numbers listed above; write <Picture N>, never 参考图N.\n";
    b += noRefs
        ? "4. No reference pictures are bound: do NOT write <Picture N> or any picture token; describe looks from the established character design.\n"
        : "4. Every listed reference picture must be defined in subject_definitions and used consistently by its number.\n";
    b += "5. Output ONLY the six plain-text sections. No markdown, no code block, no Chinese section names, no explanation.\n";
    if (input.style || input.cameraMotion) {
        b += `\nPERFORMANCE / CAMERA: ${nonEmpty(input.style, "")} ${nonEmpty(input.cameraMotion, "")}\n`;
    }
    b += `\nSOURCE DRAFT (seconds, shots, dialogue — preserve verbatim):\n${draft}\n`;
    return b;
}

/** 撰写提示词（system 固定，user 含格式与本段素材）。outputFormat 决定素材稿或 H3 六段式。 */
export function buildSegmentWriterPrompt(input: SegmentWriterInput): { system: string; user: string } {
    const noRefs = Boolean(input.noReferenceBindings);
    const draft = buildSegmentDraft(input.shots, noRefs);
    const budget = segmentPromptBudget(input.maxChars, noRefs ? 0 : (input.referenceCount || 0));
    // H3 六段式：所选 prompt 技能要求 H3 原生 r2v 格式时走这里（与 ep2 已验证格式一致）。
    // 这样技能里的「输出六段英文」要求真正主导输出，而不是被下方素材稿模板压制。
    if (input.outputFormat === "h3-six-section") {
        return { system: H3_SIX_SECTION_SYSTEM, user: buildH3SixSectionUserPrompt(input, draft, noRefs, budget) };
    }
    let b = "";
    b += `请为第 ${input.index + 1} 段（全集共 ${input.count} 段）撰写完整视频提示词。本段 ${secText(input.totalSec)} 秒，${input.shots.length} 个镜头。\n\n`;
    if (budget > 0) b += `【篇幅】全文不超过 ${budget} 个字符（含标点、空格与换行）。这是视频模型的硬上限，超出会被拒绝；宁可写短，不要写满。\n\n`;
    if (input.skillContent && input.skillContent.trim()) {
        b += `【写作技能：${input.skillName || "视频提示词写作"}】\n遵循下面的写作方法与结构；下方【输出格式】作补充，篇幅与硬性规则始终适用。\n<skill>\n${truncate(input.skillContent.trim(), MAX_SKILL_RUNES)}\n</skill>\n\n`;
    }
    b += `【表演与运镜】\n${nonEmpty(input.style, "人物表演自然，情绪变化落在线条与呼吸上，不摆拍")}\n${nonEmpty(input.cameraMotion, "运镜有明确动机，稳而有分寸")}\n禁止：面无表情、表情僵硬、眼神呆滞、只动嘴不动脸、朗读腔或播音腔、人物像摆拍一样站着不动。\n\n`;
    if (!noRefs && input.referenceLegend?.length) {
        b += `【参考图清单】\n${input.referenceLegend.map((line) => `- ${line}`).join("\n")}\n只能使用上面列出的参考图编号，素材稿「参考：参考图N」里的 N 必须来自这份清单。\n\n`;
    }
    b += "【输出格式】严格按以下结构与顺序书写，栏目名原样保留：\n";
    if (input.index > 0 && !input.independent && !input.firstFrame) {
        b += `严格从第${input.index}段视频末尾的实际站位、朝向、动作和情绪状态继续，不重新摆位\n`;
    }
    b += `第${input.index + 1}段视频《${input.title}·点题副标题》——一句话概括本段的戏剧转折\n`;
    b += `${secText(input.totalSec)}秒｜${nonEmpty(input.aspectRatio, "9:16")}｜${nonEmpty(input.artStyle, "写实电影感")}｜${nonEmpty(input.language, "中文")}对白｜无字幕｜${input.shots.length}个主镜头\n\n`;
    b += `【视觉与首帧】\n${firstFrameRule(input, noRefs)}；${noRefs ? "外貌服装以已设定的角色形象为准，不要复述完整外貌" : "外貌服装以参考图为准，不要复述完整外貌"}。\n\n`;
    b += `【场景布局、人物站位与机位轴线】\n空间锁定（场景名${noRefs ? "" : "并标注参考图编号"}）；主戏剧轴线与画面左右关系；人物从哪走到哪；不越轴、不穿模。\n\n`;
    b += `【角色、手部、衣物和道具归属】\n每个出场角色一行：姓名${noRefs ? "" : "（参考图N）"} + 一句识别特征 + 本段情绪状态与变化；道具${noRefs ? "" : "（参考图N）"}写清在谁的哪只手。\n\n`;
    b += "【道具与物理时空规则】\n只写本段关键道具、特效与物理现象及时间码；没有就写一句本段的动作约束。\n\n";
    b += "【光源与声音】\n光源一句；“声线规格”逐个写说话角色的音色与本段情绪下的说话方式；环境音与关键音效标注时间码。\n\n";
    b += "然后每个镜头一块，镜头之间空一行：\n【起—止秒｜镜头一：四字镜头名·点题】\n焦段 + 景别，运镜方式（方向、速度与动机）。\n起—止：按 2–3 秒切成时间片，逐片写清动作、面部表情变化、肢体反应与镜头运动。\n角色名（此刻的情绪 + 说话方式）：“台词”。台词前写开口前的表情反应，说完写听者的反应。每个镜头写动作音或环境音。\n\n";
    if (input.index < input.count - 1 && !input.independent) {
        b += `最后一个镜头的末0.5秒动作收住、镜头停稳，写清此刻每个人物的位置、朝向和情绪状态，作为第${input.index + 2}段的接续起点；人物保留呼吸、眨眼等细微动态，不要写“全场凝固”“完全静止”“硬定格”。\n`;
    }
    b += "\n【硬性规则】\n";
    b += "1. 时间码精确到 0.01 秒，从 00.00 连续覆盖到本段结束，每个镜头的起止与素材稿完全一致，不得增删镜头。\n";
    b += "2. 台词逐字使用素材稿中的台词，不得改写、增加或删减；没有台词的镜头写“绝对无台词”。\n";
    b += noRefs
        ? "3. 只使用素材稿中的角色、道具与场景，首次出现只写姓名；本段没有绑定任何参考图，禁止出现“参考图”字样或任何参考图编号（含“参考图1”“参考图1-5”这类写法），外貌服装以已设定的角色形象为准，不要编造冲突外貌。\n"
        : "3. 只使用素材稿中的角色、道具与场景，首次出现写“名称（参考图N）”，编号严格用素材稿给出的编号；外貌以参考图为准，不要编造冲突外貌。\n";
    b += "4. 对白由视频模型直接生成声音与口型：每句台词标明说话人情绪与说话方式，并写出说话时的面部表情；不要另写配音或字幕要求。\n";
    b += "5. 每个镜头的动作必须是镜头能拍到的可见动作，内心活动改写为表情、眼神和肢体反应；每个时间片都要有人在动。\n";
    b += "6. 直接输出提示词正文，格式说明里的括号与描述性文字不要输出。\n";
    if (budget > 0) b += `7. 全文不超过 ${budget} 个字符；写不下时依次删减：重复画风与禁止项、与镜头块重复的站位服装描述、堆叠修饰词；镜头块、时间码、台词、${noRefs ? "表演描写" : "参考图编号与表演描写"}不能删。\n`;
    if (input.previousEnding && input.previousEnding.trim()) b += `\n【上一段结尾】\n${input.previousEnding.trim()}\n`;
    b += `\n【本段素材稿】\n${draft}\n`;
    return { system: SEGMENT_WRITER_SYSTEM, user: b };
}

/** 精简 H3 六段式提示词（超上限时用）：保留六段名、台词、时间码、Picture 编号，只压描述。 */
export function buildH3SixSectionCondensePrompt(text: string, maxChars: number): string {
    const target = Math.max(1, Math.floor(maxChars * 0.9));
    return `This MiniMax H3 six-section prompt has ${Array.from(text).length} characters and exceeds the video model limit of ${maxChars}. Condense to about ${target} characters, never exceed ${maxChars}.\n\n` +
        "KEEP EXACTLY:\n1. The six section names (subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music) each on its own line with colon.\n" +
        "2. Every shot block [Shot K] with its start-end timecodes; do not add/remove/merge shots.\n" +
        "3. Every dialogue line verbatim inside its <d>[Chinese] ...</d> wrapper with the <Subject N> (S1) attribution.\n" +
        "4. Every <Picture N> token unchanged.\n\n" +
        "CUT FIRST: repeated style/lighting phrases, redundant adjectives, description overlapping between sections. Do not change the plot or add content.\n\n<prompt>\n" + text.trim() + "\n</prompt>\n";
}

/** 精简提示词（超上限时用，不截断）。 */
export function buildSegmentCondensePrompt(text: string, maxChars: number, noReferenceBindings = false): string {
    const target = Math.max(1, Math.floor(maxChars * 0.9));
    return `下面这段视频提示词共 ${Array.from(text).length} 个字符，超过视频模型上限 ${maxChars} 个字符（含标点、空格与换行）。请精简到 ${target} 个字符左右，绝对不能超过 ${maxChars} 个字符。\n\n` +
        "【必须原样保留】\n1. 第一行承接说明、段标题行与参数行。\n2. 所有栏目名与镜头块及起止时间码；不得增删合并镜头。\n3. 每一句台词逐字保留，说话人、情绪与说话方式保留。\n" +
        (noReferenceBindings
            ? "4. 不得出现“参考图”字样或任何参考图编号；外貌服装以已设定的角色形象为准。\n"
            : "4. 每个“参考图N”编号写法不变。\n") +
        "5. 表情、眼神、肢体反应与运镜描写（可压缩措辞，不能删）。\n\n" +
        "【优先删减】\n1. 重复的画风、质感与禁止项只留一处。\n2. 栏目里与镜头块重复的站位、服装、外貌、光线。\n3. 堆叠形容词与同义反复。\n\n不要新增内容，不要改写剧情。\n\n<prompt>\n" + text.trim() + "\n</prompt>\n";
}
