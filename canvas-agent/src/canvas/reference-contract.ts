export const REFERENCE_ROLES = [
    "character_identity", "character_turnaround", "scene", "blocking", "storyboard",
    "keyframe", "motion_reference", "audio_reference", "character_voice", "style",
    "palette", "prop", "other",
] as const;

export type ReferenceRole = (typeof REFERENCE_ROLES)[number];
export type ReferenceMediaType = "image" | "video" | "audio";
export type ReferenceUsage = "reference" | "first_frame" | "last_frame";

export type ProjectReferenceAsset = {
    id: string;
    label: string;
    mediaType: ReferenceMediaType;
    role: ReferenceRole;
    tags: string[];
    url?: string;
    storageKey?: string;
    mimeType?: string;
    sourceNodeId?: string;
    subjectId?: string;
    analysis?: { summary?: string; suggestedRole?: ReferenceRole; suggestedTags?: string[]; model?: string; updatedAt?: string };
    createdAt?: string;
    updatedAt?: string;
};

/**
 * Clip 只保存对项目参考资产的稳定绑定。媒体字段是离线展示快照；提交时优先使用
 * project.referenceCatalog 中同 assetId 的资产，避免 UI 和 MCP 各自拼一套输入。
 */
export type ReferenceBinding = {
    id: string;
    assetId: string;
    label: string;
    role: ReferenceRole;
    tags: string[];
    enabled: boolean;
    usage: ReferenceUsage;
    subjectId?: string;
    mediaType?: ReferenceMediaType;
    url?: string;
    storageKey?: string;
    mimeType?: string;
    sourceNodeId?: string;
};

export type ReferenceIssue = { severity: "error" | "warning"; code: string; message: string; bindingId?: string };
export type CompiledReference = ReferenceBinding & { mediaType: ReferenceMediaType; ordinal: number; token: string };
export type ReferenceCompilation = {
    semanticPrompt: string;
    compiledPrompt: string;
    bindings: ReferenceBinding[];
    references: CompiledReference[];
    issues: ReferenceIssue[];
    migratedLegacyRefs: boolean;
};

const SEMANTIC_REF = /\{\{ref:([a-zA-Z0-9._:-]+)\}\}/g;
const SEMANTIC_SUBJECT = /\{\{subject:([a-zA-Z0-9._:-]+)\}\}/g;

export function normalizeReferenceRole(value: unknown, fallback: ReferenceRole = "other"): ReferenceRole {
    return REFERENCE_ROLES.includes(value as ReferenceRole) ? value as ReferenceRole : fallback;
}

export function inferReferenceRole(value: { name?: unknown; label?: unknown; role?: unknown; type?: unknown; mimeType?: unknown }): ReferenceRole {
    const explicit = normalizeReferenceRole(value.role, "other");
    if (explicit !== "other") return explicit;
    const text = `${String(value.name || value.label || "")} ${String(value.type || "")} ${String(value.mimeType || "")}`.toLowerCase();
    if (/色卡|调色|palette|color card/.test(text)) return "palette";
    if (/站位|轴线|blocking|position/.test(text)) return "blocking";
    if (/四视图|三视图|turnaround|character sheet/.test(text)) return "character_turnaround";
    if (/人物|角色|定妆|形象|identity|portrait/.test(text)) return "character_identity";
    if (/分镜|关键帧|storyboard|shot|frame/.test(text)) return "storyboard";
    if (/场景|环境|scene|room|interior|exterior/.test(text)) return "scene";
    if (/动作|运动|motion/.test(text)) return "motion_reference";
    if (/声线|配音|voice/.test(text)) return "character_voice";
    if (/音频|音乐|audio|music|sound/.test(text)) return "audio_reference";
    if (/风格|style|look/.test(text)) return "style";
    if (/道具|prop|ticket|phone/.test(text)) return "prop";
    return "other";
}

export function inferReferenceMediaType(value: { mediaType?: unknown; type?: unknown; kind?: unknown; mimeType?: unknown; url?: unknown; name?: unknown }): ReferenceMediaType {
    const explicit = String(value.mediaType || value.type || value.kind || "").toLowerCase();
    if (explicit.includes("video")) return "video";
    if (explicit.includes("audio")) return "audio";
    const text = `${String(value.mimeType || "")} ${String(value.url || "")} ${String(value.name || "")}`.toLowerCase();
    if (/video|\.(mp4|webm|mov)(?:$|\?)/.test(text)) return "video";
    if (/audio|\.(mp3|wav|m4a|flac)(?:$|\?)/.test(text)) return "audio";
    return "image";
}

export function stableReferenceId(prefix: "asset" | "binding", value: string, index = 0) {
    let hash = 2166136261;
    for (const char of `${value}:${index}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return `${prefix}-${(hash >>> 0).toString(36)}`;
}

export function referenceCatalogOf(project: Record<string, unknown>): ProjectReferenceAsset[] {
    return Array.isArray(project.referenceCatalog) ? project.referenceCatalog.map(normalizeAsset).filter(Boolean) as ProjectReferenceAsset[] : [];
}

export function referenceBindingsOf(segment: Record<string, unknown>): { bindings: ReferenceBinding[]; migratedLegacyRefs: boolean } {
    if (Array.isArray(segment.referenceBindings)) {
        return { bindings: segment.referenceBindings.map(normalizeBinding).filter(Boolean) as ReferenceBinding[], migratedLegacyRefs: false };
    }
    const refsRecord = recordOf(segment.refs);
    const buckets = ["image", "video", "audio"].flatMap((type) => {
        const value = refsRecord[type];
        return (Array.isArray(value) ? value : value ? [value] : []).map((item) => ({ ...recordOf(item), type }));
    });
    const refs = Array.isArray(segment.refItems) && segment.refItems.length ? segment.refItems : buckets;
    const bindings = refs.map((raw, index) => {
        const ref = recordOf(raw);
        const mediaType = inferReferenceMediaType(ref);
        const identity = String(ref.storageKey || ref.url || ref.nodeId || ref.name || index);
        const role = inferReferenceRole(ref);
        return normalizeBinding({
            id: String(ref.bindingId || stableReferenceId("binding", identity, index)),
            assetId: String(ref.assetId || stableReferenceId("asset", identity)),
            label: String(ref.name || `参考 ${index + 1}`), role, tags: Array.isArray(ref.tags) ? ref.tags : [], enabled: ref.enabled !== false,
            usage: ref.usage || "reference", subjectId: ref.subjectId, mediaType, url: ref.url, storageKey: ref.storageKey,
            mimeType: ref.mimeType, sourceNodeId: ref.nodeId,
        });
    }).filter(Boolean) as ReferenceBinding[];
    return { bindings, migratedLegacyRefs: bindings.length > 0 };
}

export function compileReferenceSubmission(project: Record<string, unknown>, segment: Record<string, unknown>): ReferenceCompilation {
    const catalog = new Map(referenceCatalogOf(project).map((asset) => [asset.id, asset]));
    const { bindings, migratedLegacyRefs } = referenceBindingsOf(segment);
    const issues: ReferenceIssue[] = [];
    const counters: Record<ReferenceMediaType, number> = { image: 0, video: 0, audio: 0 };
    const references = bindings.filter((binding) => binding.enabled).flatMap((binding): CompiledReference[] => {
        const asset = catalog.get(binding.assetId);
        const merged = {
            ...binding,
            ...(asset || {}),
            id: binding.id,
            assetId: binding.assetId,
            enabled: binding.enabled,
            usage: binding.usage,
            role: binding.role,
            tags: binding.tags.length ? binding.tags : asset?.tags || [],
            subjectId: binding.subjectId || asset?.subjectId,
        } as ReferenceBinding & ProjectReferenceAsset;
        const mediaType = inferReferenceMediaType(merged);
        if (!merged.storageKey && !merged.url) {
            issues.push({ severity: "error", code: "reference_media_missing", bindingId: binding.id, message: `参考“${binding.label}”没有可用媒体` });
            return [];
        }
        if (!asset && binding.assetId) issues.push({ severity: "warning", code: "catalog_asset_missing", bindingId: binding.id, message: `参考“${binding.label}”尚未登记到项目参考库，将使用绑定快照` });
        if (binding.role === "palette") issues.push({ severity: "warning", code: "palette_as_runtime_reference", bindingId: binding.id, message: `“${binding.label}”是色卡；仅在模型确实需要图像色彩锚点时保留` });
        const ordinal = ++counters[mediaType];
        const token = mediaType === "image" ? `<Picture ${ordinal}>` : mediaType === "video" ? `<Video ${ordinal}>` : `<Audio ${ordinal}>`;
        return [{ ...merged, mediaType, ordinal, token }];
    });
    const semanticPrompt = String(segment.prompt || "");
    const byId = new Map(references.map((reference) => [reference.id, reference]));
    const replaceMarker = (kind: "ref" | "subject", id: string) => {
        const reference = byId.get(id);
        if (!reference) {
            issues.push({ severity: "error", code: "prompt_binding_missing", bindingId: id, message: `提示词引用了不存在或已禁用的参考：${id}` });
            return `{{${kind}:${id}}}`;
        }
        if (kind === "subject" && reference.mediaType !== "image") {
            issues.push({ severity: "error", code: "subject_requires_image", bindingId: id, message: `Subject 只能绑定图片参考：“${reference.label}”不是图片` });
            return `{{subject:${id}}}`;
        }
        return kind === "subject" ? `<Subject ${reference.ordinal}>` : reference.token;
    };
    const compiledPrompt = semanticPrompt
        .replace(SEMANTIC_SUBJECT, (_match, id: string) => replaceMarker("subject", id))
        .replace(SEMANTIC_REF, (_match, id: string) => replaceMarker("ref", id));
    validateLimits(segment, semanticPrompt, references, issues);
    return { semanticPrompt, compiledPrompt, bindings, references, issues, migratedLegacyRefs };
}

export function assertReferenceCompilation(compilation: ReferenceCompilation) {
    const errors = compilation.issues.filter((issue) => issue.severity === "error");
    if (errors.length) throw new Error(errors.map((issue) => issue.message).join("；"));
}

function validateLimits(segment: Record<string, unknown>, semanticPrompt: string, references: CompiledReference[], issues: ReferenceIssue[]) {
    const mode = String(segment.taskMode || segment.mode || "ref2va").toLowerCase();
    const images = references.filter((reference) => reference.mediaType === "image");
    const videos = references.filter((reference) => reference.mediaType === "video");
    const audios = references.filter((reference) => reference.mediaType === "audio");
    if (mode === "t2v" && references.length) issues.push({ severity: "warning", code: "t2v_ignores_references", message: "T2V 模式不会提交参考素材" });
    if (mode === "t2v" && /\{\{(?:ref|subject):[^}]+\}\}|<(?:Picture|Video|Audio)\s+\d+>/i.test(semanticPrompt)) {
        issues.push({ severity: "error", code: "t2v_prompt_uses_reference", message: "T2V 提示词不能引用 Picture、Video、Audio 或 Subject；请改用 I2V、FL2V 或 Ref2VA" });
    }
    if (mode === "i2v" && images.length !== 1) issues.push({ severity: "error", code: "i2v_image_count", message: "I2V 必须且只能使用 1 张图片" });
    if (mode === "fl2v" && images.length !== 2) issues.push({ severity: "error", code: "fl2v_image_count", message: "FL2V 必须使用 2 张图片作为首尾帧" });
    if (images.length > 9) issues.push({ severity: "error", code: "image_limit", message: "MiniMax H3 最多支持 9 张参考图片" });
    if (videos.length > 3) issues.push({ severity: "error", code: "video_limit", message: "MiniMax H3 最多支持 3 段参考视频" });
    if (audios.length > 3) issues.push({ severity: "error", code: "audio_limit", message: "MiniMax H3 最多支持 3 段参考音频" });
}

function normalizeAsset(value: unknown): ProjectReferenceAsset | null {
    const item = recordOf(value);
    const id = String(item.id || "");
    if (!id) return null;
    return { ...item, id, label: String(item.label || item.name || id), mediaType: inferReferenceMediaType(item), role: inferReferenceRole(item), tags: Array.isArray(item.tags) ? item.tags.map(String) : [] } as ProjectReferenceAsset;
}

function normalizeBinding(value: unknown): ReferenceBinding | null {
    const item = recordOf(value);
    const id = String(item.id || item.bindingId || "");
    const assetId = String(item.assetId || "");
    if (!id || !assetId) return null;
    return {
        ...item, id, assetId, label: String(item.label || item.name || assetId), role: inferReferenceRole(item),
        tags: Array.isArray(item.tags) ? item.tags.map(String) : [], enabled: item.enabled !== false,
        usage: ["first_frame", "last_frame"].includes(String(item.usage)) ? item.usage as ReferenceUsage : "reference",
        ...(item.mediaType || item.type || item.kind ? { mediaType: inferReferenceMediaType(item) } : {}),
    } as ReferenceBinding;
}

function recordOf(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
