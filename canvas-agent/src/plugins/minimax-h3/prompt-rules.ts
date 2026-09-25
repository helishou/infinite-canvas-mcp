// 网页和 MCP 共用的确定性规则；不推断人物身份、服装冲突或剧情。
const INTERNAL_TAGS = new Set(["character-group", "character_identity", "character_turnaround", "character_voice", "motion_reference"]);
// 归档用的编号/批次/锚点标记（如 EP01、S01-02、group-ep01-storyboard-new-batch-v1、hard-composition-anchor），
// 只有检索价值、没有画面语义，写进提示词就是噪声。
const INTERNAL_TAG_PATTERNS = [/^(?:group|asset|binding|slot)[-_]/iu, /^ep\d/iu, /^s\d{1,3}[-_]\d{1,3}/iu, /^v\d+[-_]/iu, /[-_]anchor$/iu, /[-_]batch[-_]/iu];

export function visualReferenceTags(tags: string[]) {
    return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => {
        if (!tag) return false;
        const normalized = tag.toLowerCase();
        return !INTERNAL_TAGS.has(normalized) && !INTERNAL_TAG_PATTERNS.some((pattern) => pattern.test(normalized));
    }))];
}

/** 素材名指纹：去掉扩展名、标点与空白，用于判断描述是否只是素材名的回显。 */
export function referenceNameKey(value: string) {
    return String(value || "")
        .toLowerCase()
        .replace(/\.(?:png|jpe?g|webp|gif|bmp|tiff?|mp4|mov|webm|wav|mp3|m4a|flac)$/u, " ")
        .replace(/[\s·•|:/\\_+.,，。;；!！?？\-—~()（）[\]{}"'’“”]+/gu, "")
        .trim();
}

/**
 * 摘要/标签只是素材名（文件名、label）的回显时对视频模型毫无语义，写进提示词只会污染。
 * names 传素材 label / 绑定名 / 文件名。
 */
export function isReferenceNameEcho(value: string, names: unknown[]) {
    const key = referenceNameKey(value);
    if (!key) return true;
    return names
        .map((name) => referenceNameKey(String(name ?? "")))
        .filter((name) => name.length >= 4)
        .some((name) => name === key || (Math.min(name.length, key.length) >= 8 && (name.includes(key) || key.includes(name))));
}

// 编译期注入的分镜图 cue 句。旧提示词被解析回可编辑正文后会带着这些句子，
// 再次编译时又叠一层，正文里因此出现成对的重复句；编译前先剥掉所有副本。
const GENERATED_STORYBOARD_CUES = [
    /^Use the approved .+? from <Picture\s+(\d+)> as (?:the visual anchor|the target composition reference) for this shot\.\s*/iu,
    /^Use the approved .+? from <Picture\s+(\d+)> as the shot-entry keyframe and composition anchor for this shot\.\s*After the keyframe, keep the camera setup and spatial relationship stable while allowing natural performance\.\s*/iu,
];

export function stripStoryboardCues(description: string) {
    let body = String(description || "");
    for (;;) {
        const next = GENERATED_STORYBOARD_CUES.reduce((text, pattern) => text.replace(pattern, ""), body);
        if (next === body) return body;
        body = next;
    }
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
        : /^(?:\d+(?:\.\d+)?|\.\d+)s?$/iu.test(value) ? Number(value.replace(/s$/iu, "")) : NaN;
    if (!Number.isFinite(seconds)) return "";
    const ms = Math.round(seconds * 1000);
    return `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

type StoryboardTimelineShot = {
    id?: unknown;
    pictureBindingId?: unknown;
    switchTime?: unknown;
};

function shotTimestampSeconds(value: unknown): number | null {
    const normalized = formatShotTimestamp(String(value ?? ""));
    if (!normalized) return null;
    const match = /^(\d{2}):(\d{2})\.(\d{3})$/u.exec(normalized);
    if (!match) return null;
    const [, minutes, seconds, milliseconds] = match;
    return Number(minutes) * 60 + Number(seconds) + Number(milliseconds) / 1000;
}

/** Derive persisted storyboard durations from the same timeline rendered into the prompt. */
export function deriveStoryboardDurations(shots: StoryboardTimelineShot[], totalDuration: unknown) {
    const duration = Number(totalDuration);
    if (!shots.length || !Number.isFinite(duration) || duration <= 0) return {};
    const starts = shots.map((shot, index) => index === 0 ? 0 : shotTimestampSeconds(shot.switchTime));
    if (starts.some((start) => start === null || !Number.isFinite(start))) return {};

    const result: Record<string, number> = {};
    shots.forEach((shot, index) => {
        const key = String(shot.pictureBindingId ?? shot.id ?? "").trim();
        const start = starts[index];
        const end = index + 1 < starts.length ? starts[index + 1] : duration;
        if (!key || start === null || end === null || end <= start || start >= duration) return;
        result[key] = Math.round((Math.min(end, duration) - start) * 1000) / 1000;
    });
    return result;
}

export function normalizeRef2vaSummary(summary: unknown, options: {
    hasStoryboardFrames?: boolean;
    hasReferenceImages?: boolean;
    hasAudioReference?: boolean;
} = {}) {
    const raw = String(summary ?? "").trim();
    const match = /^\s*\[([^\]]+)\]\s*([\s\S]*)$/u.exec(raw);
    const existing = match
        ? match[1].split(/\s*\+\s*/u).map((item) => item.trim().toLowerCase()).filter(Boolean)
        : [];
    const required = [
        ...(options.hasStoryboardFrames ? ["keyframe completion"] : []),
        ...(options.hasReferenceImages ? ["reference generation"] : []),
        ...(options.hasAudioReference ? ["audio reference"] : []),
    ];
    const taskTypes = [...new Set([...existing, ...required])];
    const body = (match ? match[2] : raw).trim();
    return taskTypes.length ? `[${taskTypes.join(" + ")}]${body ? ` ${body}` : ""}` : body;
}

export function validateStoryboardShotDescriptions(shots: Array<{ description?: unknown }>) {
    shots.forEach((shot, index) => {
        const description = String(shot.description ?? "").trim();
        if (
            /Use the approved[\s\S]{0,240}?for this shot\.\s*(?:to|into)\b/iu.test(description)
            || /^\s*(?:to|into)\s+the approved\b/iu.test(description)
        ) {
            throw new Error(`Shot ${index + 1} contains a malformed reference instruction; rewrite it as a complete sentence.`);
        }
    });
}

export function validateShotTimeline(shots: Array<{ switchTime?: string; preciseCut?: boolean }>, duration?: number) {
    let previous = 0;
    shots.forEach((shot, index) => {
        if (!index) return;
        const raw = String(shot.switchTime || "").trim();
        if (shot.preciseCut === true && !raw) throw new Error(`分镜 ${index + 1} 已开启精准切镜，请填写切换时间。`);
        if (!raw) return;
        const time = formatShotTimestamp(raw);
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
        if (match[1].toLowerCase() === "subject") continue;
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
