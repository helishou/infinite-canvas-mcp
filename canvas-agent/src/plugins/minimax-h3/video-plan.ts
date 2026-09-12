export type H3ReferenceRole = "character_turnaround" | "storyboard" | "scene" | "motion_reference" | "audio_reference";

/** H3 领域参数的统一载体；执行器提交 ComfyUI 时将 videoSteps 映射为 steps。 */
export type H3GenerationSettings = Record<string, unknown> & { videoSteps?: number; steps?: number };

export type PlannedReference = {
    nodeId: string;
    role: H3ReferenceRole;
    subjectId?: string;
    order: number;
    storageKey: string;
    name: string;
    type: "image" | "video" | "audio";
    url?: string;
    mimeType?: string;
};

export type H3PlannedSegment = {
    id: string;
    sourceShotId: string;
    title: string;
    duration: number;
    taskMode: "r2v" | "i2v" | "fl2v" | "t2v";
    subjects: Array<{ subjectId: string; name?: string; role?: string }>;
    openingState: string;
    timeline: Array<{ start: number; end: number; action: string; camera: string; composition?: string; effects?: string }>;
    endingState: string;
    continuityIn?: string;
    continuityOut?: string;
    soundscape?: string;
    music?: string;
    constraints?: string[];
    references: PlannedReference[];
    settings?: Partial<H3GenerationSettings>;
};

export function normalizeH3GenerationSettings(value: Record<string, unknown> = {}): H3GenerationSettings {
    const settings = { ...value } as H3GenerationSettings;
    if (settings.videoSteps === undefined && settings.steps !== undefined) settings.videoSteps = settings.steps;
    delete settings.steps;
    return settings;
}

export function validateVideoPlan(segments: H3PlannedSegment[]) {
    if (!segments.length) throw new Error("视频计划至少需要一段");
    const ids = new Set<string>();
    for (const segment of segments) {
        if (!segment.id || ids.has(segment.id)) throw new Error(`视频计划片段 id 重复或为空:${segment.id}`);
        ids.add(segment.id);
        if (!Number.isFinite(segment.duration) || segment.duration <= 0) throw new Error(`片段 ${segment.id} 的 duration 必须大于 0`);
        if (!Array.isArray(segment.timeline) || !segment.timeline.length) throw new Error(`片段 ${segment.id} 缺少时间轴`);
        const last = segment.timeline[segment.timeline.length - 1];
        if (!last || last.end !== segment.duration) throw new Error(`片段 ${segment.id} 的时间轴末端必须等于 duration`);
        let cursor = 0;
        for (const item of segment.timeline) {
            if (item.start !== cursor || item.end <= item.start || item.end > segment.duration) throw new Error(`片段 ${segment.id} 时间轴不连续`);
            cursor = item.end;
        }
        const refs = segment.references || [];
        const orders = new Set<number>();
        const subjects = new Set((segment.subjects || []).map((subject) => subject.subjectId));
        for (const ref of refs) {
            if (!ref.storageKey || !ref.nodeId) throw new Error(`片段 ${segment.id} 存在无 storageKey 的参考图`);
            if (!["character_turnaround", "storyboard", "scene", "motion_reference", "audio_reference"].includes(ref.role)) throw new Error(`片段 ${segment.id} 存在未知参考角色:${String(ref.role)}`);
            if (!Number.isInteger(ref.order) || ref.order < 0 || orders.has(ref.order)) throw new Error(`片段 ${segment.id} 的参考顺序必须唯一且为非负整数`);
            orders.add(ref.order);
            if (ref.role === "character_turnaround" && (!ref.subjectId || !subjects.has(ref.subjectId))) throw new Error(`片段 ${segment.id} 的角色四视图缺少对应 subjectId`);
        }
    }
}

export function compileChineseH3Prompt(segment: H3PlannedSegment, refs = segment.references): string {
    const ordered = [...refs].sort((a, b) => a.order - b.order);
    const counters = { image: 0, video: 0, audio: 0 };
    const references = ordered.map((ref) => {
        const label = ref.type === "image" ? "图片" : ref.type === "video" ? "视频" : "音频";
        const ordinal = ++counters[ref.type];
        return `@${label}${ordinal}：${ref.name}`;
    }).join("；") || "无";
    const timeline = segment.timeline.map((item) => `${item.start.toFixed(1)}-${item.end.toFixed(1)}秒：动作：${item.action}；运镜：${item.camera}${item.composition ? `；构图：${item.composition}` : ""}${item.effects ? `；效果：${item.effects}` : ""}`).join("\n");
    return [
        `主体定义：${segment.subjects.map((item) => item.name || item.subjectId).join("、") || "按参考图保持主体一致"}`,
        `镜头目标：${segment.title || segment.sourceShotId}`,
        `起始画面：${segment.openingState}`,
        `时间轴动作与运镜：\n${timeline}`,
        `结束画面：${segment.endingState}`,
        segment.continuityIn ? `连续性要求（接入）：${segment.continuityIn}` : "",
        segment.continuityOut ? `连续性要求（接出）：${segment.continuityOut}` : "",
        `参考素材：${references}`,
        `光影与物理效果：${segment.timeline.map((item) => item.effects).filter(Boolean).join("；") || "遵循起始画面与参考素材的光照、材质和空间关系自然变化"}`,
        segment.soundscape ? `声音环境：${segment.soundscape}` : "",
        segment.music ? `配乐：${segment.music}` : "",
        segment.constraints?.length ? `限制条件：${segment.constraints.join("；")}` : "",
        "保持人物外观、服饰、比例、空间方向和光线连续，不添加未指定的主体或文字。",
    ].filter(Boolean).join("\n");
}

export function normalizePlannedSegment(segment: H3PlannedSegment) {
    const refs = [...segment.references].sort((a, b) => a.order - b.order);
    const images = refs.filter((ref) => ref.type === "image");
    const videos = refs.filter((ref) => ref.type === "video");
    const audios = refs.filter((ref) => ref.type === "audio");
    return {
        ...normalizeH3GenerationSettings(segment.settings || {}),
        id: segment.id,
        sourceShotId: segment.sourceShotId,
        title: segment.title,
        duration: segment.duration,
        taskMode: segment.taskMode,
        prompt: compileChineseH3Prompt(segment, refs),
        openingState: segment.openingState,
        endingState: segment.endingState,
        continuityIn: segment.continuityIn,
        continuityOut: segment.continuityOut,
        timeline: segment.timeline,
        subjects: segment.subjects,
        refs: { image: images, video: videos, audio: audios },
        refItems: refs,
        status: "idle",
    };
}
