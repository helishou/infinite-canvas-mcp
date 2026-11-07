import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Express, Request, Response } from "express";

/**
 * 镜头库：直接把 acheng-director skill 随包的 132 段运镜白模（camera-moves-whitebox-132）
 * 以只读方式提供给制作工作台，不复制 117MB 视频、不另建第二份索引。
 *
 * 数据权威顺序：data/camera-moves.json（id / 中英文名 / 分类 / 编号）→
 * camera-moves-whitebox-132/manifest.json（文件名 / 时长 / 分辨率 / 体积）→ 实际 mp4 文件。
 */
export const CAMERA_LIBRARY_MEDIA_PATH = "/camera-library/media";

const SKILL_RELATIVE_PATH = path.join(".agents", "skills", "acheng-director");
const CATALOG_RELATIVE_PATH = path.join("data", "camera-moves.json");
const MEDIA_RELATIVE_PATH = "camera-moves-whitebox-132";
const MANIFEST_RELATIVE_PATH = path.join(MEDIA_RELATIVE_PATH, "manifest.json");

/** 分组边界来自 skill 的 scripts/build_source_data.py，顺序与 data/camera-moves.json 一致。 */
const CATEGORY_ORDER = [
    "basic",
    "classic",
    "advanced_static_subject",
    "moving_subject",
    "film_grammar",
    "film_grammar_continued",
    "fast",
    "practical",
] as const;

type CatalogRow = {
    id?: unknown;
    key?: unknown;
    name_zh?: unknown;
    name_en?: unknown;
    source_file?: unknown;
    category?: unknown;
    source_duration?: unknown;
    source_fps?: unknown;
};

type ManifestRow = {
    key?: unknown;
    file?: unknown;
    ok?: unknown;
    duration?: unknown;
    fps?: unknown;
    width?: unknown;
    height?: unknown;
    size?: unknown;
};

export type CameraLibraryMove = {
    id: string;
    key: string;
    nameZh: string;
    nameEn: string;
    category: string;
    file: string;
    url: string;
    duration: number;
    fps: number;
    width: number;
    height: number;
    size: number;
    available: boolean;
};

export type CameraLibraryCategory = { key: string; from: string; to: string; count: number };

export type CameraLibraryIndex = {
    ok: true;
    available: boolean;
    source: string;
    mediaBase: string;
    count: number;
    categories: CameraLibraryCategory[];
    moves: CameraLibraryMove[];
    reason?: string;
};

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const number = (value: unknown, fallback = 0) => typeof value === "number" && Number.isFinite(value) ? value : fallback;

function ancestorRoots(): string[] {
    const roots = new Set<string>();
    const explicit = process.env.ACHENG_CAMERA_LIBRARY_DIR || process.env.ACHENG_SKILL_DIR;
    if (explicit) roots.add(path.resolve(explicit));
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    for (const start of [process.cwd(), moduleDir]) {
        let current = path.resolve(start);
        for (let depth = 0; depth < 8; depth++) {
            roots.add(current);
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }
    }
    return [...roots];
}

/** 定位 skill 根：优先工作区 submodule，其次 Acheng 运行时 junction 与可写源 checkout。 */
export function resolveCameraLibraryRoot(): string | undefined {
    for (const root of ancestorRoots()) {
        const candidates = [
            root,
            path.join(root, SKILL_RELATIVE_PATH),
            path.join(root, ".canvas-runtime", "skills", "acheng-director"),
            path.join(root, "work", "acheng-runtime-source"),
        ];
        for (const candidate of candidates) {
            if (!fs.existsSync(path.join(candidate, CATALOG_RELATIVE_PATH))) continue;
            if (!fs.existsSync(path.join(candidate, MANIFEST_RELATIVE_PATH))) continue;
            return candidate;
        }
    }
    return undefined;
}

function readJsonArray<T>(file: string): T[] {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    const rows = Array.isArray(parsed) ? parsed : (parsed as { moves?: unknown })?.moves;
    return Array.isArray(rows) ? rows as T[] : [];
}

let cached: { index: CameraLibraryIndex; stamp: number; root: string } | undefined;

/** 以 catalog + manifest 的 mtime 作为缓存失效条件，skill 更新后无需重启 Backend。 */
export function readCameraLibrary(): CameraLibraryIndex {
    const root = resolveCameraLibraryRoot();
    if (!root) return {
        ok: true, available: false, source: SKILL_RELATIVE_PATH, mediaBase: CAMERA_LIBRARY_MEDIA_PATH,
        count: 0, categories: [], moves: [],
        reason: `未找到 acheng-director 镜头库（需要 ${SKILL_RELATIVE_PATH}/data/camera-moves.json 与 ${MANIFEST_RELATIVE_PATH}）`,
    };
    const catalogFile = path.join(root, CATALOG_RELATIVE_PATH);
    const manifestFile = path.join(root, MANIFEST_RELATIVE_PATH);
    const stamp = fs.statSync(catalogFile).mtimeMs + fs.statSync(manifestFile).mtimeMs;
    if (cached && cached.root === root && cached.stamp === stamp) return cached.index;

    const catalog = readJsonArray<CatalogRow>(catalogFile);
    const manifest = readJsonArray<ManifestRow>(manifestFile);
    const byKey = new Map(manifest.map(row => [text(row.key), row]));
    const mediaDir = path.join(root, MEDIA_RELATIVE_PATH);
    const moves: CameraLibraryMove[] = catalog.map((row, position) => {
        const key = text(row.key);
        const media = byKey.get(key);
        const file = text(media?.file) || text(row.source_file) || `${key}.mp4`;
        const id = text(row.id) || String(position + 1).padStart(3, "0");
        const filePath = path.join(mediaDir, file);
        return {
            id,
            key,
            nameZh: text(row.name_zh) || text(media?.key) || key,
            nameEn: text(row.name_en) || key,
            category: text(row.category) || "basic",
            file,
            url: `${CAMERA_LIBRARY_MEDIA_PATH}/${encodeURIComponent(file)}`,
            duration: number(media?.duration, number(row.source_duration, 4)),
            fps: number(media?.fps, number(row.source_fps, 24)),
            width: number(media?.width, 1920),
            height: number(media?.height, 1080),
            size: number(media?.size),
            available: media?.ok !== false && fs.existsSync(filePath),
        };
    });
    const categories: CameraLibraryCategory[] = CATEGORY_ORDER.flatMap(key => {
        const members = moves.filter(move => move.category === key);
        return members.length ? [{
            key, from: members[0].id, to: members[members.length - 1].id, count: members.length,
        }] : [];
    });
    for (const move of moves) {
        if (!categories.some(category => category.key === move.category)) {
            categories.push({ key: move.category, from: move.id, to: move.id, count: 1 });
        }
    }
    const index: CameraLibraryIndex = {
        ok: true, available: moves.length > 0, source: SKILL_RELATIVE_PATH,
        mediaBase: CAMERA_LIBRARY_MEDIA_PATH, count: moves.length, categories, moves,
    };
    cached = { index, stamp, root };
    return index;
}

/** 文件名白名单：只放行 skill 索引里登记过的 mp4，杜绝路径穿越与任意文件读取。 */
function allowedMediaFiles(): Set<string> {
    return new Set(readCameraLibrary().moves.map(move => move.file));
}

function streamMedia(req: Request, res: Response, filePath: string) {
    const bytes = fs.statSync(filePath).size;
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const range = req.headers.range;
    if (!range) {
        res.setHeader("Content-Length", String(bytes));
        fs.createReadStream(filePath).pipe(res);
        return;
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match) {
        res.setHeader("Content-Range", `bytes */${bytes}`);
        return void res.status(416).end();
    }
    const suffixLength = match[1] ? 0 : Number(match[2]);
    const start = match[1] ? Number(match[1]) : Math.max(0, bytes - suffixLength);
    const end = match[1]
        ? match[2] ? Math.min(Number(match[2]), bytes - 1) : bytes - 1
        : bytes - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= bytes || end < start) {
        res.setHeader("Content-Range", `bytes */${bytes}`);
        return void res.status(416).end();
    }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${bytes}`);
    res.setHeader("Content-Length", String(end - start + 1));
    fs.createReadStream(filePath, { start, end }).pipe(res);
}

export function registerCameraLibraryRoutes(app: Express) {
    app.get("/camera-library/moves", (_req, res) => {
        try {
            res.json(readCameraLibrary());
        } catch (error) {
            res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    app.get(`${CAMERA_LIBRARY_MEDIA_PATH}/:file`, (req, res) => {
        let file: string;
        try { file = decodeURIComponent(String(req.params.file || "")); } catch {
            return void res.status(400).json({ ok: false, error: "invalid media file" });
        }
        if (!/^\d{1,3}_[a-z0-9_]+\.mp4$/i.test(file) || !allowedMediaFiles().has(file)) {
            return void res.status(404).json({ ok: false, error: "camera library media not found" });
        }
        const root = resolveCameraLibraryRoot();
        if (!root) return void res.status(404).json({ ok: false, error: "camera library unavailable" });
        const filePath = path.join(root, MEDIA_RELATIVE_PATH, file);
        if (!fs.existsSync(filePath)) return void res.status(404).json({ ok: false, error: "camera library media not found" });
        try {
            streamMedia(req, res, filePath);
        } catch {
            res.status(404).json({ ok: false, error: "camera library media lost" });
        }
    });
}
