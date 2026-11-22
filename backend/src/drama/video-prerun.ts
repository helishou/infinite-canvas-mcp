/**
 * 视频批量生成前的只读体检（纯算法层，忠实移植影策 cloudAgentHandleCanvasPreflight 的静态检查）。
 *
 * 影策在批量提交前做一次「只读体检」：不创建任务、不预留积分，结果只是建议。
 * 本模块对应它的静态检查部分：
 *   1. 参考连线可用性（media_files 是否入库、文件是否存在/非空）；
 *   2. 提示词 <Picture N> 标签与参考图绑定的一致性（影策 @图片N 的本地形式）；
 *   3. 提示词空 / 超过 16000 字符；
 *   4. video 无参考图=警告、image 无参考=警告；
 *   5. 时长/参数是否合理；
 *   6. 带模型时的无扣费准入：本地没有计价实现，显式标注跳过，绝不伪造报价或创建任务。
 *
 * 纯函数：不 import DB / fs / service，媒体就绪状态由调用方（路由层）注入，便于单测穷举分支。
 */
export const PRERUN_PROMPT_MAX_CHARS = 16000;
/** H3 单段时长上限（秒）；超出只警告，不阻止生成。 */
export const PRERUN_MAX_DURATION_SECONDS = 60;

export type PrerunMediaState = {
    /** media_files 里是否登记了该 storageKey。 */
    found: boolean;
    /** 物理文件存在且大小 > 0。 */
    fileExists: boolean;
    bytes?: number;
    mimeType?: string;
    /** 不可读时的补充原因（如文件路径）。 */
    detail?: string;
};

export type PrerunReference = {
    id?: string;
    label: string;
    storageKey: string;
    /** image / video / audio；缺省按 image（H3 的 <Picture N> 槽位）。 */
    mediaType?: string;
    enabled?: boolean;
    role?: string;
    /** 调用方注入的媒体就绪状态；缺省视为未提供（error）。 */
    media?: PrerunMediaState;
};

export type PrerunSegment = {
    nodeId: string;
    segmentId: string;
    title?: string;
    prompt: string;
    /** 秒。0/undefined/非有限值视为未设置（warning）。 */
    duration?: number;
    model?: string;
    references: PrerunReference[];
};

export type PrerunItem = {
    index: number;
    nodeId: string;
    segmentId: string;
    title: string;
    status: "ok" | "warning" | "error";
    issues?: string[];
    /** 影策 spec：模型 + 时长等可读规格。 */
    spec?: string;
    /** 影策 quote：本地无计价，标注跳过，不伪造数字。 */
    quote?: string;
    note?: string;
};

export type PrerunReport = {
    ok: boolean;
    failed: number;
    warnings: number;
    total: number;
    items: PrerunItem[];
    episodeId?: string;
    notes: string[];
    summary: string;
    next: string;
};

export type PrerunInput = {
    episodeId?: string;
    segments: PrerunSegment[];
    mode?: "video" | "image";
    /** 段级模型未单独给出时的兜底模型（带模型触发跳过试算标注）。 */
    model?: string;
    /** 本地无计价/准入试算，显式标注；不影响体检结论。 */
    pricingSkipped?: boolean;
    /** 仅测试/兼容用：覆盖提示词字符上限，默认 16000。 */
    maxPromptChars?: number;
    /**
     * 本集资产页是否已有可用参考图（director.assets 存在 storageKey 且媒体就绪）。
     * 用于识别「参考图已就绪却没绑进段」的断链：此时 video 段 0 绑定不能再只警告放行，
     * 必须判 error，否则 T2VA + 空绑定会一路走到生成，参考图永远不进视频。
     * 真·纯 T2V 剧目（资产页本就没有图）不受影响，仍按警告处理。
     */
    hasAvailableAssets?: boolean;
};

const truncateRunes = (text: string, limit: number) => {
    const chars = Array.from(String(text ?? ""));
    return chars.length <= limit ? chars.join("") : `${chars.slice(0, limit).join("")}…`;
};

const isImage = (reference: PrerunReference) => !reference.mediaType || String(reference.mediaType).toLowerCase() === "image";

/** 与 web 端 pictureReferenceUsage 同一口径：<Picture\s*(\d+)\s*>，忽略大小写。 */
export function pictureOrdinals(prompt: string): number[] {
    const used = new Set<number>();
    for (const match of String(prompt ?? "").matchAll(/<Picture\s*(\d+)\s*>/gi)) used.add(Number(match[1]));
    return [...used].sort((a, b) => a - b);
}

/**
 * 影策式逐段体检。返回新对象，不修改输入；error 优先于 warning（与 fail/warn 的 level 语义一致）。
 */
export function planVideoPrerun(input: PrerunInput): PrerunReport {
    const limit = Number.isFinite(input.maxPromptChars) ? Number(input.maxPromptChars) : PRERUN_PROMPT_MAX_CHARS;
    const mode = input.mode || "video";
    const items: PrerunItem[] = [];
    let failed = 0;
    let warned = 0;

    for (const [index, segment] of input.segments.entries()) {
        let level: "ok" | "warning" | "error" = "ok";
        const issues: string[] = [];
        const fail = (message: string) => { issues.push(truncateRunes(message, 160)); level = "error"; };
        const warn = (message: string) => {
            issues.push(truncateRunes(message, 160));
            if (level === "ok") level = "warning";
        };

        const references = (Array.isArray(segment.references) ? segment.references : []).filter(ref => ref && ref.enabled !== false);
        const imageReferences = references.filter(isImage);

        // 1. 参考连线可用性：与影策 cloudAgentMediaReference 同款，失败即 error。
        //    只为「可用」的引用计数，与影策 counts[field]++ 只在成功分支执行一致。
        const fieldCounts = { images: 0, videos: 0, audios: 0 };
        for (const reference of references) {
            const label = truncateRunes(String(reference.label || reference.storageKey || "未命名参考"), 30);
            const media = reference.media;
            let reason = "";
            if (!media) reason = "未提供媒体就绪状态";
            else if (!String(reference.storageKey || "").trim()) reason = "没有 storageKey";
            else if (!media.found) reason = `媒体文件未入库（${reference.storageKey}）`;
            else if (!media.fileExists) reason = `文件不存在${media.detail ? `：${media.detail}` : ""}`;
            else if (!(Number(media.bytes) > 0)) reason = "文件为空";
            if (reason) fail(`参考《${label}》还不能用：${reason}`);
            else if (isImage(reference)) fieldCounts.images++;
            else if (String(reference.mediaType).toLowerCase() === "video") fieldCounts.videos++;
            else fieldCounts.audios++;
        }

        // 2. <Picture N> 标签与参考图绑定一致性（影策扫 @图片N/@视频N/@音频N 的本地形式）。
        const prompt = String(segment.prompt ?? "");
        const used = pictureOrdinals(prompt);
        for (const ordinal of used) {
            if (ordinal > fieldCounts.images) fail(`提示词里的 <Picture ${ordinal}> 没有对应的参考连线`);
        }
        if (imageReferences.length > 0 && used.length === 0) {
            fail(`已绑定 ${imageReferences.length} 张参考图，但提示词没有 <Picture N> 标签，参考图不会进入视频`);
        } else if (used.length > 0 && used.length < imageReferences.length) {
            const unused = Array.from({ length: imageReferences.length }, (_, i) => i + 1).filter(ordinal => !used.includes(ordinal));
            warn(`本段绑定了 ${imageReferences.length} 张参考图，提示词未引用 <Picture ${unused.join(">、<Picture ")}>，这些参考图可能不进入视频`);
        }

        // 3. 提示词长度（影策阈值 16000 字符，按 Unicode 码点计）。
        if (!prompt.trim()) fail("提示词为空");
        if (Array.from(prompt).length > limit) fail(`提示词超过 ${limit} 字符`);

        // 4. 无参考图判定（影策 video/image 两种 mode）。
        if (mode === "video" && imageReferences.length === 0) {
            if (input.hasAvailableAssets) {
                // 资产页已有可用参考图，段却 0 绑定 = 「参考图就绪但没绑进段」断链。
                // 这是最该拦截的组合：放行会让参考图永远不进视频（对齐用户"参考图压根没进视频"投诉）。
                fail("本集已有可用参考图，但本段没有绑定任何参考图；参考图不会进入视频，请先在画布为本段绑定参考资产后重新体检");
            } else {
                warn("没有参考图，将按文生视频提交，人物和场景一致性靠提示词");
            }
        }
        if (mode === "image" && references.length === 0) warn("没有资产参考，跨镜头一致性可能不稳定");

        // 5. 时长/参数合理性：只警告，不伪造限制。
        const duration = Number(segment.duration || 0);
        if (!Number.isFinite(duration) || duration <= 0) warn("时长未设置或无效，将使用默认值");
        else if (duration > PRERUN_MAX_DURATION_SECONDS) warn(`时长 ${duration} 秒超出常见范围（${PRERUN_MAX_DURATION_SECONDS} 秒），请确认`);

        const model = String(segment.model || input.model || "");
        const spec = [model, duration > 0 && Number.isFinite(duration) ? `${duration}秒` : ""].filter(Boolean).join(" · ");
        const item: PrerunItem = {
            index,
            nodeId: String(segment.nodeId || ""),
            segmentId: String(segment.segmentId || ""),
            title: truncateRunes(String(segment.title || `第 ${index + 1} 段`), 60),
            status: level,
        };
        if (issues.length) item.issues = issues;
        if (spec) item.spec = spec;
        if (model) item.quote = "跳过：本地无计价准入，不产生费用";
        if (model || input.pricingSkipped) item.note = "本地无计价/准入试算，跳过；体检不创建任务、不扣费";
        items.push(item);
        const finalStatus: string = level;
        if (finalStatus === "error") failed++;
        else if (finalStatus === "warning") warned++;
    }

    const notes: string[] = [];
    if (input.model || input.pricingSkipped) notes.push("本地无计价/准入试算，已跳过（不创建任务、不预留积分、不扣费）");
    const summary = `体检：${failed} 失败 / ${warned} 警告（共 ${items.length} 条）`;
    const next = failed === 0
        ? "可以生成：先用少量段试跑；条目多或模型新时建议先只选一段生成"
        : "先修正失败项（补提示词、补参考图绑定、等待参考图生成完成），再重新体检";
    return { ok: failed === 0, failed, warnings: warned, total: items.length, items, episodeId: input.episodeId, notes, summary, next };
}
