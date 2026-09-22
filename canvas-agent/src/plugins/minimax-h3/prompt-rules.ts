// 网页和 MCP 共用的确定性规则；不推断人物身份、服装冲突或剧情。
const INTERNAL_TAGS = new Set(["character-group", "character_identity", "character_turnaround", "character_voice", "motion_reference"]);

export function visualReferenceTags(tags: string[]) {
    return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag && !INTERNAL_TAGS.has(tag.toLowerCase())))];
}

export function promptDetails(values: string[]) {
    return [...new Set(values.flatMap((value) => value.split(/[;；]/u))
        .map((part) => part.trim().replace(/[.;。；]+$/u, "").trim())
        .filter((part) => part && !part.split(/[,，]/u).every((item) => INTERNAL_TAGS.has(item.trim().toLowerCase()))))];
}

export function formatShotTimestamp(raw: string) {
    const value = raw.trim();
    const clock = /^(\d{1,2}):([0-5]\d)(?:\.(\d{1,3}))?$/u.exec(value);
    const seconds = clock ? Number(clock[1]) * 60 + Number(clock[2]) + Number(`0.${clock[3] || "0"}`)
        : /^\d+(?:\.\d{1,3})?s?$/iu.test(value) ? Number(value.replace(/s$/iu, "")) : NaN;
    if (!Number.isFinite(seconds)) return "";
    const ms = Math.round(seconds * 1000);
    return `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

export function validateShotTimeline(shots: Array<{ switchTime?: string }>, duration?: number) {
    let previous = 0;
    shots.forEach((shot, index) => {
        if (!index) return;
        const time = formatShotTimestamp(shot.switchTime || "");
        if (!time) throw new Error(`分镜 ${index + 1} 的切换时间无效，请填写秒数或 MM:SS.mmm。`);
        const [minutes, seconds] = time.split(":").map(Number);
        const current = minutes * 60 + seconds;
        if (current <= previous) throw new Error(`分镜 ${index + 1} 的切换时间必须晚于上一镜。`);
        if (duration !== undefined && Number.isFinite(duration) && current >= duration) {
            throw new Error(`分镜 ${index + 1} 的切换时间必须小于 Clip 时长 ${duration} 秒。`);
        }
        previous = current;
    });
}

export function stripDuplicateTransition(description: string, transition: string) {
    const patterns: Record<string, RegExp> = {
        cut: /^(?:the shot|the camera) (?:hard[- ]cuts|cuts)(?:\s+to\s+|[.,]\s*)/iu,
        dissolve: /^(?:the shot|the image) cross[- ]dissolves(?:\s+to\s+|[.,]\s*)/iu,
        fade_black: /^the shot fades out to black, then fades in[.,]\s*/iu,
        continuous: /^the shot continues[.,]\s*/iu,
    };
    const pattern = patterns[transition];
    let text = description.trim();
    while (pattern?.test(text)) text = text.replace(pattern, "").trim();
    return text;
}

export function validatePromptReferences(text: string, references: Array<{ type: string; bindingId?: string }>, subjectCount?: number) {
    // 台词中的标签可以是实际对白，不把它当引用指令。
    const body = text.replace(/<d>[\s\S]*?<\/d>/giu, "");
    const counts: Record<string, number | undefined> = {
        picture: references.filter((ref) => ref.type === "image").length,
        video: references.filter((ref) => ref.type === "video").length,
        audio: references.filter((ref) => ref.type === "audio").length,
        subject: subjectCount,
    };
    for (const match of body.matchAll(/<(Picture|Video|Audio|Subject)\s+(\d+)>/giu)) {
        const count = counts[match[1].toLowerCase()];
        if (count !== undefined && (Number(match[2]) < 1 || Number(match[2]) > count)) {
            throw new Error(`提示词引用 ${match[0]} 不存在，请核对当前 Clip 的素材和主体编号。`);
        }
    }
    for (const match of body.matchAll(/\{\{\s*ref:\s*([^{}]+?)\s*\}\}/gu)) {
        if (!references.some((ref) => ref.bindingId === match[1].trim())) throw new Error(`提示词引用 ${match[0]} 已失效，请重新绑定素材。`);
    }
}

export function validateDefinitionCoverage(subjects: Array<{ pictures: string[] }>, references: Array<{ tag: string }>, definitions: string, retention: string) {
    const labels = (text: string) => [...text.matchAll(/^(<(?:Subject|Picture|Video|Audio) \d+>)/gmu)].map((match) => match[1]);
    const defined = labels(definitions);
    const retained = labels(retention);
    if (defined.length !== new Set(defined).size || retained.length !== new Set(retained).size ||
        defined.length !== retained.length || defined.some((tag) => !retained.includes(tag))) {
        throw new Error("主体定义与保留分析的引用标签不一致，请重新生成。");
    }
    const sources = subjects.flatMap((subject) => subject.pictures);
    if (references.some((ref) => !defined.includes(ref.tag) && !sources.includes(ref.tag)) ||
        sources.some((tag) => !references.some((ref) => ref.tag === tag))) {
        throw new Error("参考素材与主体来源不一致，请检查当前 Clip 的素材绑定。");
    }
}
