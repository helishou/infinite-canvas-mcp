/**
 * 风格预设（Style Profile）CRUD 路由 —— 影策内置能力迁移。
 *
 * 真源参考：
 *   E:/影策本地版/app/backend/internal/prompts/style_profile.go
 *   E:/影策本地版/app/backend/internal/handler/style_profile.go
 *   E:/影策本地版/app/backend/internal/repository/style_profile.go
 *
 * 本实现为独立文件、不依赖数据库：使用 DATA_DIR/style-profiles.json 做文件持久化
 * （可用环境变量 STYLE_PROFILES_FILE 覆盖），语义、校验规则与 200 个上限对齐影策真源。
 * 只新增本文件；server.ts 中仅追加两行注册（import + register）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Express, Request, Response } from "express";
import { DATA_DIR } from "../config.js";

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

export const MAX_USER_STYLE_PROFILES = 200;
const MAX_PROFILE_JSON_BYTES = 256 * 1024;
const MAX_REQUEST_BODY_BYTES = 320 * 1024;
const STORE_FILE = process.env.STYLE_PROFILES_FILE
    ? path.resolve(process.env.STYLE_PROFILES_FILE)
    : path.join(DATA_DIR, "style-profiles.json");

const byteLength = (value: string) => Buffer.byteLength(value, "utf8");
const runeLength = (value: string) => Array.from(value).length;
const trimmed = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

export type StyleProfileAssetParameters = {
    sampler?: string;
    steps?: number | null;
    cfg?: number | null;
    size?: string;
};
export type StyleProfileAssetLicense = {
    commercial?: boolean | null;
    note?: string;
    source?: string;
    capturedAt?: string;
};
export type StyleProfileAsset = {
    id?: string;
    kind?: string;
    provider?: string;
    title?: string;
    enabled?: boolean | null;
    sourceId?: string;
    sourceUrl?: string;
    model?: string;
    version?: string;
    baseModels?: string[];
    triggerWords?: string[];
    promptFragment?: string;
    weight?: number | null;
    parameters?: StyleProfileAssetParameters | null;
    referenceUrls?: string[];
    referenceResourceIds?: string[];
    status?: string;
    license?: StyleProfileAssetLicense | null;
};
export type StyleProfileDocument = {
    schemaVersion?: number;
    presetId?: string;
    title?: string;
    description?: string;
    tags?: string[];
    prompt?: string;
    negativePrompt?: string;
    coverUrl?: string;
    sourceProfileId?: string;
    selection?: Record<string, string>;
    assets?: StyleProfileAsset[];
    executionPolicy?: string;
    source?: string;
    revision?: number;
};

export type StoredStyleProfile = {
    id: string;
    userId: string;
    name: string;
    description: string;
    coverUrl: string;
    tags: string[];
    favorite: boolean;
    revision: number;
    profileJson: string;
    createdAt: string;
    updatedAt: string;
    lastUsedAt: string | null;
};

class HttpError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}
function bad(message: string): never {
    throw new HttpError(400, message);
}
function notFound(): never {
    throw new HttpError(404, "风格预设不存在");
}

// ---------------------------------------------------------------------------
// 校验（对齐影策 ValidateStyleProfileJSON / normalizeUserStyleProfileJSON）
// ---------------------------------------------------------------------------

const allowedValue = (value: unknown, ...allowed: string[]) =>
    typeof value === "string" && allowed.includes(value);
const nonEmptyStrings = (values: unknown): string[] =>
    Array.isArray(values) ? values.map(trimmed).filter(Boolean) : [];

/** 校验 profileJson 字符串；返回规范化后的字符串，失败抛 HttpError。 */
export function validateStyleProfileJson(value: string): string {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) bad("项目画风资产配置不能为空");
    if (byteLength(text) > MAX_PROFILE_JSON_BYTES) bad("项目画风资产配置过大");

    let profile: StyleProfileDocument;
    try {
        profile = JSON.parse(text) as StyleProfileDocument;
    } catch {
        return bad("项目画风资产配置不是合法 JSON");
    }
    if (!isRecord(profile)) bad("项目画风资产配置不是合法 JSON");

    if (
        profile.schemaVersion !== 1 ||
        !trimmed(profile.presetId) ||
        !trimmed(profile.title) ||
        !trimmed(profile.prompt) ||
        typeof profile.revision !== "number" ||
        profile.revision < 1
    ) {
        bad("项目画风资产配置缺少必要字段");
    }
    if (!Array.isArray(profile.assets)) bad("项目画风资产配置缺少 assets 数组");
    if (profile.assets.length > 20) bad("项目画风执行资产最多绑定 20 个");
    if (
        profile.executionPolicy &&
        !allowedValue(profile.executionPolicy, "compatible-fallback", "strict-assets")
    ) {
        bad("项目画风执行策略不支持");
    }
    if (!allowedValue(profile.source, "builtin", "user", "external")) bad("项目画风来源不支持");

    const selection = profile.selection || {};
    const selectionKeys = Object.keys(selection);
    if (selectionKeys.length > 20) bad("项目画风辅助标注最多 20 项");
    for (const key of selectionKeys) {
        const val = selection[key];
        if (!key.trim() || runeLength(key) > 64 || runeLength(String(val ?? "")) > 200) {
            bad("项目画风辅助标注格式无效");
        }
    }

    const assetIds = new Set<string>();
    for (const asset of profile.assets) {
        if (
            !asset ||
            !trimmed(asset.id) ||
            !trimmed(asset.title) ||
            !trimmed(asset.provider) ||
            !allowedValue(asset.kind, "lora", "template", "reference", "prompt") ||
            !allowedValue(asset.status, "draft", "validated", "unavailable")
        ) {
            bad("项目画风执行资产字段不完整");
        }
        if (assetIds.has(asset.id!)) bad("项目画风执行资产 ID 不能重复");
        assetIds.add(asset.id!);
        if (asset.weight != null && (asset.weight < 0 || asset.weight > 2)) {
            bad("LoRA 权重必须在 0 到 2 之间");
        }
        if (Array.isArray(asset.baseModels) && asset.baseModels.length > 20) {
            bad("单个画风资产最多声明 20 个兼容模型");
        }
        if (
            (Array.isArray(asset.triggerWords) && asset.triggerWords.length > 50) ||
            (Array.isArray(asset.referenceUrls) && asset.referenceUrls.length > 20) ||
            (Array.isArray(asset.referenceResourceIds) && asset.referenceResourceIds.length > 20)
        ) {
            bad("项目画风执行资产的触发词或参考图数量过多");
        }
        if (asset.parameters) {
            if (
                asset.parameters.steps != null &&
                (asset.parameters.steps < 1 || asset.parameters.steps > 200)
            ) {
                bad("画风资产 Steps 必须在 1 到 200 之间");
            }
            if (asset.parameters.cfg != null && (asset.parameters.cfg < 0 || asset.parameters.cfg > 50)) {
                bad("画风资产 CFG 必须在 0 到 50 之间");
            }
        }
        if (asset.status === "validated") {
            switch (asset.kind) {
                case "lora":
                    if (!trimmed(asset.sourceId) && !trimmed(asset.sourceUrl)) {
                        bad("已验证的 LoRA 必须填写来源资产 ID 或 URL");
                    }
                    break;
                case "template":
                case "prompt":
                    if (!trimmed(asset.promptFragment) && nonEmptyStrings(asset.triggerWords).length === 0) {
                        bad("已验证的模板或提示词模块必须填写提示词内容");
                    }
                    break;
                case "reference":
                    if (
                        nonEmptyStrings(asset.referenceUrls).length === 0 &&
                        nonEmptyStrings(asset.referenceResourceIds).length === 0
                    ) {
                        bad("已验证的参考图组必须绑定参考图");
                    }
                    break;
            }
        }
    }
    return text;
}

/** 规范化用户风格文档：锁定归属与 revision，返回可直接存储的 JSON。 */
export function normalizeUserStyleProfileJson(
    value: string,
    presetId: string,
    revision: number
): { json: string; doc: StyleProfileDocument } {
    const validated = validateStyleProfileJson(value);
    let doc: StyleProfileDocument;
    try {
        doc = JSON.parse(validated) as StyleProfileDocument;
    } catch {
        return bad("用户风格配置解析失败");
    }

    if (runeLength(trimmed(doc.title)) > 80) bad("风格名称最多 80 个字");
    if (runeLength(trimmed(doc.description)) > 500) bad("风格简介最多 500 个字");
    if (Array.isArray(doc.tags) && doc.tags.length > 20) bad("风格标签最多 20 个");
    if (byteLength(trimmed(doc.coverUrl)) > 4096 || byteLength(trimmed(doc.negativePrompt)) > 64 * 1024) {
        bad("风格封面或负面 Prompt 过大");
    }
    const cover = trimmed(doc.coverUrl).toLowerCase();
    if (
        cover &&
        !cover.startsWith("http://") &&
        !cover.startsWith("https://") &&
        !cover.startsWith("/") &&
        !cover.startsWith("data:image/")
    ) {
        bad("风格封面只支持 http(s)、站内路径或图片 Data URL");
    }

    if (trimmed(presetId)) doc.presetId = presetId.trim();
    doc.sourceProfileId = doc.presetId;
    doc.source = "user";
    doc.revision = revision;
    doc.title = trimmed(doc.title);
    doc.description = trimmed(doc.description);
    doc.coverUrl = trimmed(doc.coverUrl);
    doc.negativePrompt = trimmed(doc.negativePrompt);
    doc.tags = nonEmptyStrings(doc.tags);

    let encoded: string;
    try {
        encoded = JSON.stringify(doc);
    } catch {
        return bad("用户风格配置序列化失败");
    }
    if (byteLength(encoded) > MAX_PROFILE_JSON_BYTES) bad("用户风格配置过大");
    return { json: encoded, doc };
}

/** 校验预设与结构化快照的 presetId 一致性（供外部复用）。 */
export function validateStyleProfilePreset(presetId: string, profileJson: string): void {
    if (!trimmed(profileJson)) return;
    let profile: StyleProfileDocument;
    try {
        profile = JSON.parse(profileJson) as StyleProfileDocument;
    } catch {
        bad("项目画风资产配置解析失败");
    }
    if (!trimmed(presetId) || trimmed(profile.presetId) !== presetId.trim()) {
        bad("项目画风预设与结构化快照不一致");
    }
}

// ---------------------------------------------------------------------------
// 文件存储（独立、无数据库依赖；原子写入）
// ---------------------------------------------------------------------------

type Store = { profiles: StoredStyleProfile[] };
let cache: Store | null = null;

function loadStore(): Store {
    if (cache) return cache;
    try {
        const parsed = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) as Partial<Store>;
        cache = { profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [] };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            // 损坏文件不静默丢弃：备份后重建，避免整库丢失。
            try {
                fs.renameSync(STORE_FILE, `${STORE_FILE}.corrupt-${Date.now()}`);
            } catch {
                /* ignore */
            }
        }
        cache = { profiles: [] };
    }
    return cache;
}

function persist(): void {
    const store = loadStore();
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true, mode: 0o700 });
    const temp = `${STORE_FILE}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
    try {
        fs.writeFileSync(temp, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
        fs.renameSync(temp, STORE_FILE);
    } finally {
        try {
            fs.unlinkSync(temp);
        } catch {
            /* ignore */
        }
    }
}

const owned = (userId: string, id: string): StoredStyleProfile => {
    const found = loadStore().profiles.find((p) => p.id === id && p.userId === userId);
    if (!found) notFound();
    return found;
};

function publicProfile(profile: StoredStyleProfile) {
    return { ...profile };
}

// ---------------------------------------------------------------------------
// 业务逻辑（对齐影策 Service 层）
// ---------------------------------------------------------------------------

function listProfiles(userId: string): StoredStyleProfile[] {
    return loadStore()
        .profiles.filter((p) => p.userId === userId)
        .sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.updatedAt.localeCompare(a.updatedAt))
        .map(publicProfile);
}

function createProfile(userId: string, profileJsonInput: string): StoredStyleProfile {
    const store = loadStore();
    if (store.profiles.filter((p) => p.userId === userId).length >= MAX_USER_STYLE_PROFILES) {
        bad(`我的风格最多保存 ${MAX_USER_STYLE_PROFILES} 个`);
    }
    // 第一次规范化：取得标题等元信息并生成 ID。
    const first = normalizeUserStyleProfileJson(profileJsonInput, "", 1);
    const now = new Date().toISOString();
    const profile: StoredStyleProfile = {
        id: crypto.randomUUID(),
        userId,
        name: first.doc.title?.trim() || "",
        description: first.doc.description?.trim() || "",
        coverUrl: first.doc.coverUrl?.trim() || "",
        tags: first.doc.tags || [],
        favorite: false,
        revision: 1,
        profileJson: "",
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null,
    };
    // 第二次规范化：把生成的 ID 锁定进文档，防止前端伪造 presetId。
    const second = normalizeUserStyleProfileJson(profileJsonInput, profile.id, profile.revision);
    profile.name = second.doc.title || profile.name;
    profile.description = second.doc.description || "";
    profile.coverUrl = second.doc.coverUrl || "";
    profile.tags = second.doc.tags || [];
    profile.profileJson = second.json;
    store.profiles.push(profile);
    persist();
    return publicProfile(profile);
}

function updateProfile(userId: string, id: string, profileJsonInput: string): StoredStyleProfile {
    const store = loadStore();
    const profile = owned(userId, id);
    const nextRevision = profile.revision + 1;
    const result = normalizeUserStyleProfileJson(profileJsonInput, profile.id, nextRevision);
    profile.name = result.doc.title || "";
    profile.description = result.doc.description || "";
    profile.coverUrl = result.doc.coverUrl || "";
    profile.tags = result.doc.tags || [];
    profile.profileJson = result.json;
    profile.revision = nextRevision;
    profile.updatedAt = new Date().toISOString();
    persist();
    return publicProfile(profile);
}

function setFavorite(userId: string, id: string, favorite: boolean): void {
    const profile = owned(userId, id);
    profile.favorite = favorite;
    profile.updatedAt = new Date().toISOString();
    persist();
}

function touchProfile(userId: string, id: string): void {
    const profile = owned(userId, id);
    profile.lastUsedAt = new Date().toISOString();
    // 影策只更新 last_used_at，不改 updated_at（不影响默认排序）。
    persist();
}

function deleteProfile(userId: string, id: string): void {
    const store = loadStore();
    owned(userId, id);
    store.profiles = store.profiles.filter((p) => !(p.id === id && p.userId === userId));
    persist();
}

// ---------------------------------------------------------------------------
// Express 路由
// ---------------------------------------------------------------------------

function resolveUserId(req: Request): string {
    const header = req.header("x-user-id");
    return header && header.trim() ? header.trim() : "local";
}

function handleError(res: Response, error: unknown): void {
    if (error instanceof HttpError) {
        res.status(error.status).json({ ok: false, error: error.message });
        return;
    }
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
}

function readProfileJson(req: Request): string {
    if (typeof req.body?.profileJson !== "string") bad("profileJson 必填且必须是字符串");
    if (byteLength(req.body.profileJson) > MAX_REQUEST_BODY_BYTES) bad("profileJson 过大");
    return req.body.profileJson;
}

/** 注册风格预设路由。幂等：重复注册不会重复挂载。 */
export function registerStyleProfileRoutes(app: Express): void {
    if ((app as Express & { __styleProfileRoutesRegistered?: boolean }).__styleProfileRoutesRegistered) return;
    (app as Express & { __styleProfileRoutesRegistered?: boolean }).__styleProfileRoutesRegistered = true;

    // 上限信息，便于前端展示“最多 200 个”。
    app.get("/api/style-profiles/meta", (_req, res) => {
        res.json({ ok: true, max: MAX_USER_STYLE_PROFILES, data: { max: MAX_USER_STYLE_PROFILES } });
    });

    app.get("/api/style-profiles", (req, res) => {
        try {
            const profiles = listProfiles(resolveUserId(req));
            res.json({ ok: true, profiles, data: { profiles } });
        } catch (error) {
            handleError(res, error);
        }
    });

    app.post("/api/style-profiles", (req, res) => {
        try {
            const profile = createProfile(resolveUserId(req), readProfileJson(req));
            res.json({ ok: true, profile, data: profile });
        } catch (error) {
            handleError(res, error);
        }
    });

    app.patch("/api/style-profiles/:id", (req, res) => {
        try {
            const profile = updateProfile(resolveUserId(req), String(req.params.id), readProfileJson(req));
            res.json({ ok: true, profile, data: profile });
        } catch (error) {
            handleError(res, error);
        }
    });

    app.patch("/api/style-profiles/:id/favorite", (req, res) => {
        try {
            if (typeof req.body?.favorite !== "boolean") bad("favorite 必填且必须是布尔值");
            setFavorite(resolveUserId(req), String(req.params.id), req.body.favorite);
            res.json({
                ok: true,
                id: String(req.params.id),
                favorite: req.body.favorite,
                data: { id: String(req.params.id), favorite: req.body.favorite },
            });
        } catch (error) {
            handleError(res, error);
        }
    });

    app.post("/api/style-profiles/:id/use", (req, res) => {
        try {
            touchProfile(resolveUserId(req), String(req.params.id));
            res.json({ ok: true, id: String(req.params.id), data: { id: String(req.params.id) } });
        } catch (error) {
            handleError(res, error);
        }
    });

    app.delete("/api/style-profiles/:id", (req, res) => {
        try {
            deleteProfile(resolveUserId(req), String(req.params.id));
            res.json({ ok: true, id: String(req.params.id), data: { id: String(req.params.id) } });
        } catch (error) {
            handleError(res, error);
        }
    });
}

export default registerStyleProfileRoutes;
