// 在线资产目录解析：只读站点发布的数据，不执行页面脚本。

export type OnlineAsset = { id: string; category: string; keywords: string; thumbnail: string; original: string; poseType?: string; angle?: string };

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
