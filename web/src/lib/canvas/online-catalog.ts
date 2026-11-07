// 在线资产目录解析：只读站点发布的数据，不执行页面脚本。

export type OnlineCatalogKind = "costume" | "costume-anime" | "portrait" | "pose" | "depth" | "anime";
export type OnlineAsset = { id: string; name?: string; category: string; summary?: string; displayKeywords?: string; keywords: string; thumbnail: string; original: string; subcategory?: string; poseType?: string; angle?: string };

export const COSTUME_SOURCE = "https://ai-costume-gallery.pages.dev/";
export const POSE_SOURCE = "https://ai-pose-gallery.pages.dev/";
// 脸型图由原站发布；中文索引站另有带中文标签的静态 JSON，优先用它，原站数据作为不可达时的兜底。
export const PORTRAIT_SOURCE = "https://ai-portrait-gallery.pages.dev/";

const imageUrl = (base: string, path: string, label: string) => {
    const result = new URL(path, base);
    if (result.origin !== new URL(base).origin || result.protocol !== "https:") throw new Error(`Invalid ${label} image URL`);
    return result.href;
};

export function parseCostumeCatalog(html: string): OnlineAsset[] {
    const match = html.match(/\bconst\s+D\s*=\s*(\[[\s\S]*?\]);\s*const\s+PAGE\b/);
    if (!match) throw new Error("Costume catalog unavailable");
    const records: unknown = JSON.parse(match[1]);
    if (!Array.isArray(records)) throw new Error("Invalid costume catalog");
    return records.map((record: any) => {
        if (!record || typeof record.id !== "string" || typeof record["カテゴリ"] !== "string" || typeof record["キーワード"] !== "string" || typeof record["サムネ"] !== "string" || typeof record["原寸"] !== "string") throw new Error("Invalid costume entry");
        return { id: record.id, category: record["カテゴリ"], keywords: record["キーワード"], thumbnail: imageUrl(COSTUME_SOURCE, record["サムネ"], "costume"), original: imageUrl(COSTUME_SOURCE, record["原寸"], "costume") };
    });
}

export function parsePoseCatalog(html: string): OnlineAsset[] {
    const match = html.match(/\bconst\s+D\s*=\s*(\[[\s\S]*?\]);\s*const\s+ANG\b/);
    if (!match) throw new Error("Pose catalog unavailable");
    const records: unknown = JSON.parse(match[1]);
    if (!Array.isArray(records)) throw new Error("Invalid pose catalog");
    return records.map((record: unknown) => {
        if (!record || typeof record !== "object") throw new Error("Invalid pose entry");
        const item = record as Record<string, unknown>;
        const fields = ["id", "系統", "分類", "ポーズ名", "ポーズ番号", "アングル", "サムネ", "原寸"];
        if (fields.some(field => typeof item[field] !== "string")) throw new Error("Invalid pose entry");
        return { id: item.id as string, category: item["系統"] as string,
            poseType: item["分類"] as string, angle: item["アングル"] as string,
            keywords: `${item["ポーズ番号"]} · ${item["ポーズ名"]} · ${item["分類"]} · ${item["アングル"]}`,
            thumbnail: imageUrl(POSE_SOURCE, item["サムネ"] as string, "pose"), original: imageUrl(POSE_SOURCE, item["原寸"] as string, "pose") };
    });
}

export function parsePortraitZhCatalog(text: string): OnlineAsset[] {
    const records: unknown = JSON.parse(text);
    if (!Array.isArray(records)) throw new Error("Invalid portrait catalog");
    return records.map((record: unknown) => {
        if (!record || typeof record !== "object") throw new Error("Invalid portrait entry");
        const item = record as Record<string, unknown>;
        if (["id", "类型", "发长", "缩略图", "原图"].some(field => typeof item[field] !== "string")) throw new Error("Invalid portrait entry");
        // 发长作主分类，类型（正面脸图/造型参考）作二级筛选，发型只进关键词供中/日文搜索。
        return { id: item.id as string, category: item["发长"] as string, poseType: item["类型"] as string,
            keywords: [item["类型"], item["发型"], item["原始发型"]].filter((value): value is string => typeof value === "string" && Boolean(value)).join(" · "),
            thumbnail: imageUrl(PORTRAIT_SOURCE, item["缩略图"] as string, "portrait"), original: imageUrl(PORTRAIT_SOURCE, item["原图"] as string, "portrait") };
    });
}

export function parsePortraitOriginCatalog(text: string): OnlineAsset[] {
    const match = text.match(/\bwindow\.GALLERY_IMAGES\s*=\s*(\[[\s\S]*\]);/);
    if (!match) throw new Error("Portrait catalog unavailable");
    const records: unknown = JSON.parse(match[1]);
    if (!Array.isArray(records)) throw new Error("Invalid portrait catalog");
    return records.map((record: unknown) => {
        if (!record || typeof record !== "object") throw new Error("Invalid portrait entry");
        const item = record as Record<string, unknown>;
        if (["id", "section", "hair", "full", "thumb"].some(field => typeof item[field] !== "string")) throw new Error("Invalid portrait entry");
        const section = item.section === "face" ? "正面脸图" : "造型参考";
        return { id: item.id as string, category: item.hair as string, poseType: section,
            keywords: [section, item.style].filter((value): value is string => typeof value === "string" && Boolean(value)).join(" · "),
            thumbnail: imageUrl(PORTRAIT_SOURCE, item.thumb as string, "portrait"), original: imageUrl(PORTRAIT_SOURCE, item.full as string, "portrait") };
    });
}

const PORTRAIT_CATALOGS = [
    { url: "https://deeyu.github.io/ai-costume-gallery-zh/portrait/data/portrait-zh.json", parse: parsePortraitZhCatalog },
    { url: `${PORTRAIT_SOURCE}data/images.js`, parse: parsePortraitOriginCatalog },
];

// 中文站走 GitHub Pages，直连较慢；单个源 10 秒内拿不到就换原站，避免面板长时间空转。
export async function loadPortraitCatalog(): Promise<OnlineAsset[]> {
    let failure: unknown = new Error("Portrait catalog unavailable");
    for (const { url, parse } of PORTRAIT_CATALOGS) {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
            if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
            return parse(await response.text());
        } catch (error) { failure = error; }
    }
    throw failure;
}

// 读取中文索引站公开的静态 JSON；不在前端固化图库条目，因此站点发布新数据后可直接读取。
const GALLERY_ROOT = "https://deeyu.github.io/ai-costume-gallery-zh/";

export const ONLINE_CATALOG_KINDS: readonly OnlineCatalogKind[] = ["costume", "costume-anime", "portrait", "pose", "depth", "anime"];

type OnlineCatalogDefinition = {
    pageUrl: string;
    dataUrl: string;
    imageBase: string;
    allowedImagePrefixes: readonly string[];
};

export const ONLINE_CATALOGS: Record<OnlineCatalogKind, OnlineCatalogDefinition> = {
    costume: {
        pageUrl: GALLERY_ROOT,
        dataUrl: `${GALLERY_ROOT}data/costume-zh.json`,
        imageBase: GALLERY_ROOT,
        allowedImagePrefixes: [GALLERY_ROOT, "https://raw.githubusercontent.com/Deeyu/ai-costume-gallery-zh/"],
    },
    "costume-anime": {
        pageUrl: `${GALLERY_ROOT}costume-anime/`,
        dataUrl: `${GALLERY_ROOT}costume-anime/data/costume-zh.json`,
        imageBase: GALLERY_ROOT,
        allowedImagePrefixes: ["https://ai-costume-anime-gallery.pages.dev/"],
    },
    portrait: {
        pageUrl: `${GALLERY_ROOT}portrait/`,
        dataUrl: `${GALLERY_ROOT}portrait/data/portrait-zh.json`,
        imageBase: GALLERY_ROOT,
        allowedImagePrefixes: ["https://ai-portrait-gallery.pages.dev/"],
    },
    pose: {
        pageUrl: `${GALLERY_ROOT}pose/`,
        dataUrl: `${GALLERY_ROOT}pose/data/pose-zh.json`,
        imageBase: GALLERY_ROOT,
        allowedImagePrefixes: ["https://ai-pose-gallery.pages.dev/"],
    },
    depth: {
        pageUrl: `${GALLERY_ROOT}depth/`,
        dataUrl: `${GALLERY_ROOT}depth/data/depth-zh.json`,
        imageBase: GALLERY_ROOT,
        allowedImagePrefixes: ["https://ai-pose-depth-gallery.pages.dev/"],
    },
    anime: {
        pageUrl: `${GALLERY_ROOT}anime/`,
        dataUrl: `${GALLERY_ROOT}anime/data/anime-zh.json`,
        imageBase: GALLERY_ROOT,
        allowedImagePrefixes: ["https://charadb-2fi.pages.dev/"],
    },
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label} entry`);
    return value as Record<string, unknown>;
}

function requiredString(item: Record<string, unknown>, field: string, label: string): string {
    const value = item[field];
    if (typeof value !== "string") throw new Error(`Invalid ${label} entry`);
    return value;
}

function optionalString(item: Record<string, unknown>, field: string): string {
    const value = item[field];
    return typeof value === "string" ? value : "";
}

function textValues(...values: unknown[]): string[] {
    return values.flatMap(value => {
        if (typeof value === "string") return value ? [value] : [];
        if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && Boolean(item));
        return [];
    });
}

function catalogImageUrl(value: string, definition: OnlineCatalogDefinition, label: string): string {
    const result = new URL(value, definition.imageBase);
    if (result.protocol !== "https:" || !definition.allowedImagePrefixes.some(prefix => result.href.startsWith(prefix))) {
        throw new Error(`Invalid ${label} image URL`);
    }
    return result.href;
}

export function parseChineseOnlineCatalog(kind: OnlineCatalogKind, payload: unknown): OnlineAsset[] {
    if (!Array.isArray(payload)) throw new Error(`Invalid ${kind} catalog`);
    const definition = ONLINE_CATALOGS[kind];
    return payload.map((record: unknown) => {
        const item = asRecord(record, kind);
        const id = requiredString(item, "id", kind);
        const thumbnail = catalogImageUrl(requiredString(item, "缩略图", kind), definition, kind);
        const original = catalogImageUrl(requiredString(item, "原图", kind), definition, kind);
        const indexedSearch = optionalString(item, "检索");

        if (kind === "costume" || kind === "costume-anime") {
            const category = requiredString(item, "分类", kind);
            const tags = textValues(item["关键词"]);
            const name = tags.slice(0, 2).join(" · ") || id;
            const displayKeywords = tags.slice(2, 6).join(" · ");
            const keywords = textValues(item["关键词"], item["英文关键词"], indexedSearch).join(" · ");
            return { id, name, category, summary: category, displayKeywords, keywords, thumbnail, original };
        }
        if (kind === "portrait") {
            const category = requiredString(item, "发长", kind);
            const subcategory = requiredString(item, "类型", kind);
            const hairstyle = optionalString(item, "发型");
            const name = hairstyle || category;
            const summary = hairstyle ? `${category} · ${subcategory}` : subcategory;
            const keywords = textValues(indexedSearch, item["发型"], item["原始发长"], item["原始发型"], subcategory).join(" · ");
            return { id, name, category, subcategory, summary, keywords, thumbnail, original };
        }
        if (kind === "pose" || kind === "depth") {
            const category = requiredString(item, "体系", kind);
            const subcategory = requiredString(item, "分类", kind);
            const angle = requiredString(item, "角度", kind);
            const name = requiredString(item, "姿势名称", kind);
            const summary = [category, subcategory, angle].join(" · ");
            const keywords = textValues(indexedSearch, item["原始姿势名称"], item["原始分类"], item["原始角度"], item["姿势编号"]).join(" · ");
            return { id, name, category, subcategory, angle, summary, keywords, thumbnail, original };
        }

        const category = requiredString(item, "类型", kind);
        const subcategory = requiredString(item, "分类", kind);
        const name = requiredString(item, "名称", kind);
        const summary = `${category} · ${subcategory}`;
        const displayKeywords = textValues(item["标签"], item["发色"]).join(" · ");
        const keywords = textValues(indexedSearch, item["原始名称"], item["原始分类"], item["标签"], item["子类型"], item["父级"], item["发色"]).join(" · ");
        return { id, name, category, subcategory, summary, displayKeywords, keywords, thumbnail, original };
    });
}

export async function loadOnlineCatalog(kind: OnlineCatalogKind): Promise<OnlineAsset[]> {
    const response = await fetch(ONLINE_CATALOGS[kind].dataUrl, { cache: "no-cache" });
    if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
    return parseChineseOnlineCatalog(kind, await response.json());
}
