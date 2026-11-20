/**
 * 剪映草稿构建的后端等价实现（影策 streamDramaArchive 的移植）。
 *
 * 由 web/src/lib/jianying-draft.ts（草稿文件生成）、web/src/lib/acheng-delivery-export.ts
 * （段→clip / 字幕轨 / calibration / ZIP 打包）与 web/src/lib/production-subtitles.ts
 * （台词时间窗口径）逐条移植到 Node：草稿内容完全在服务端生成，媒体从 db.media_files
 * 的 filePath 以流式写入 ZIP，不依赖浏览器 fflate 打包。
 *
 * 本文件是纯构建层：不访问数据库，revision 复核与段三分类由 jianying-preflight +
 * EpisodeProductionService.prepareJianyingExport 负责。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { createReadStream } from "node:fs";
import { Zip, ZipPassThrough } from "fflate";

import { isSubjectPromptAssembly } from "@basketikun/canvas-agent/drama/production-contract";
import { subjectShotWindows } from "@basketikun/canvas-agent/drama/subject-assembly";
import type { DramaJianyingDraftPreview } from "./jianying-preflight.js";

// ---------------------------------------------------------------------------
// 错误类型（路由层据此返回 409 / 400）
// ---------------------------------------------------------------------------

/** 下载时 revision 与重新计算的交付指纹不一致：内容已变化，拒绝导出（影策 409 防篡改）。 */
export class JianyingRevisionConflictError extends Error {
    readonly code = "JIANYING_REVISION_CONFLICT";
    constructor(readonly expected: string, readonly current: string) {
        super(`剪映草稿内容已变化（预检 revision ${expected.slice(0, 12)}… 与当前 ${current.slice(0, 12)}… 不一致），请重新预检后再导出`);
        this.name = "JianyingRevisionConflictError";
    }
}

/** 未勾选放行项但预检存在不可导出 / 旧版本段。 */
export class JianyingExportBlockedError extends Error {
    readonly code: string;
    constructor(message: string, code: string, readonly details: Record<string, unknown> = {}) {
        super(message);
        this.name = "JianyingExportBlockedError";
        this.code = code;
    }
}

// ---------------------------------------------------------------------------
// 草稿文件生成（移植自 web/src/lib/jianying-draft.ts）
// ---------------------------------------------------------------------------

export const DRAFT_ROOT_PLACEHOLDER = "__CANVAS_DRAFT_ROOT__";
export const JIANYING_MATERIALS_DIR = "materials";
export const JIANYING_APP_VERSION = "5.9.0";

export type JianyingClip = {
    fileName: string;
    name?: string;
    durationUs: number;
    width?: number;
    height?: number;
};

export type JianyingCaption = { text: string; startUs: number; durationUs: number };

export type JianyingDraftOptions = {
    name: string;
    root?: string;
    width: number;
    height: number;
    fps: number;
    clips: readonly JianyingClip[];
    captions?: readonly JianyingCaption[];
    now?: Date;
    uuid?: () => string;
    hasCover?: boolean;
};

export type JianyingDraft = {
    name: string;
    root: string;
    durationUs: number;
    srt: string;
    files: Record<string, string>;
    warnings: string[];
    stats: { clips: number; captions: number; skippedCaptions: number };
};

const unsafeName = /[\\/:*?"<>|\x00-\x1f]+/g;
const windowsRoot = /^[A-Za-z]:[\\/]/;
const EMPTY_MATERIAL_KEYS = [
    "ai_translates", "audio_balances", "audio_effects", "audio_fades", "audio_track_indexes", "audios", "beats", "canvases", "chromas",
    "color_curves", "digital_humans", "drafts", "effects", "flowers", "green_screens", "handwrites", "hsl", "images", "log_color_wheels",
    "loudnesses", "manual_deformations", "masks", "material_animations", "material_colors", "multi_language_refs", "placeholders",
    "plugin_effects", "primary_color_wheels", "realtime_denoises", "shapes", "smart_crops", "smart_relights", "sound_channel_mappings",
    "speeds", "stickers", "tail_leaders", "text_templates", "texts", "time_marks", "transitions", "video_effects", "video_trackings",
    "videos", "vocal_beautifys", "vocal_separations",
];

const record = (value: Record<string, unknown>) => value;

function reservedWindowsName(name: string) {
    const base = name.split(".")[0].toUpperCase();
    if (["CON", "PRN", "AUX", "NUL"].includes(base)) return true;
    return base.length === 4 && (base.startsWith("COM") || base.startsWith("LPT")) && base[3] >= "1" && base[3] <= "9";
}

export function safeDraftName(raw: string, fallback = "Acheng-Draft", limit = 120): string {
    let name = String(raw ?? "").replace(unsafeName, "-").trim().replace(/^[.\s]+|[.\s]+$/g, "");
    const runes = Array.from(name);
    if (runes.length > limit) name = runes.slice(0, limit).join("").trim();
    name = name.replace(/^[.\s]+|[.\s]+$/g, "");
    if (!name) name = fallback;
    if (reservedWindowsName(name)) name = `_${name}`;
    return name;
}

/** 只校验路径形态，不访问文件系统；Windows/UNC 统一成反斜杠，POSIX 保持斜杠。 */
export function normalizeDraftRoot(raw: string): string {
    let root = String(raw ?? "").trim();
    if (!root) throw new Error("请填写剪映草稿目录（本机绝对路径）");
    if (root.includes("你的用户名")) throw new Error("请把路径里的「你的用户名」换成电脑上的实际用户名");
    if (Array.from(root).length > 400 || root.includes('"') || /[\x00-\x1f\x7f]/.test(root)) throw new Error("剪映草稿目录包含无效字符");
    const windows = windowsRoot.test(root);
    const unc = root.startsWith("\\\\") || root.startsWith("//");
    if (!windows && !unc && !root.startsWith("/")) throw new Error("剪映草稿目录必须是 Windows / UNC / macOS 的绝对路径");
    let canonical = windows || unc ? root.replace(/\\/g, "/") : root;
    if (windows || unc) {
        const body = windows ? canonical.slice(3) : canonical.replace(/^\/\//, "");
        if (/[:*?<>|]/.test(body)) throw new Error("Windows 草稿目录包含无效字符");
        const parts = body.replace(/\/+$/, "").split("/");
        if (unc && parts.length < 3) throw new Error("请填写共享目录下的草稿文件夹，不能使用共享根目录");
        for (const part of parts) {
            if (!part || part.endsWith(".") || part.endsWith(" ") || reservedWindowsName(part)) throw new Error("Windows 草稿目录包含无效的文件夹名称");
        }
    }
    for (const part of canonical.split("/")) if (part === "." || part === "..") throw new Error("剪映草稿目录不能包含 . 或 .. 路径段");
    canonical = canonical.replace(/\/+$/, "");
    if (!canonical || (windows && canonical.length <= 2)) throw new Error("剪映草稿目录不能是磁盘根目录");
    return windows || unc ? canonical.replace(/\//g, "\\") : canonical;
}

function draftSeparator(root: string) {
    return windowsRoot.test(root) || root.startsWith("\\\\") ? "\\" : "/";
}

function draftFolderPath(root: string, name: string) {
    return `${root}${draftSeparator(root)}${name}`;
}

function draftMaterialPath(root: string, name: string, fileName: string) {
    return `${draftFolderPath(root, name)}${draftSeparator(root)}${JIANYING_MATERIALS_DIR}${draftSeparator(root)}${fileName}`;
}

function newUUID(random: () => string) {
    return random().toUpperCase();
}

function defaultUUID() {
    return crypto.randomUUID();
}

function timerange(start: number, duration: number) {
    return { start, duration };
}

function speedMaterial(uuid: () => string) {
    return { curve_speed: null, id: uuid(), mode: 0, speed: 1.0, type: "speed" };
}

function clipSettings(transformY: number) {
    return { alpha: 1.0, flip: { horizontal: false, vertical: false }, rotation: 0.0, scale: { x: 1.0, y: 1.0 }, transform: { x: 0.0, y: transformY } };
}

function baseSegment(uuid: () => string, materialId: string, start: number, duration: number, renderIndex: number, refs: string[], clip: ReturnType<typeof clipSettings>): Record<string, unknown> {
    return {
        enable_adjust: true, enable_color_correct_adjust: false, enable_color_curves: true, enable_color_match_adjust: false,
        enable_color_wheels: true, enable_lut: true, enable_smart_color_adjust: false, last_nonzero_volume: 1.0, reverse: false,
        track_attribute: 0, track_render_index: 0, visible: true, id: uuid(), material_id: materialId,
        target_timerange: timerange(start, duration), common_keyframes: [], keyframe_refs: [],
        speed: 1.0, volume: 1.0, extra_material_refs: refs, is_tone_modify: false,
        clip, uniform_scale: { on: true, value: 1.0 }, render_index: renderIndex,
    };
}

function track(uuid: () => string, kind: string, name: string, segments: unknown[]) {
    return { attribute: 0, flag: 0, id: uuid(), is_default_name: name === "", name, segments, type: kind };
}

function subtitleMaterial(id: string, text: string) {
    const content = JSON.stringify({
        styles: [{
            fill: { alpha: 1.0, content: { render_type: "solid", solid: { alpha: 1.0, color: [1, 1, 1] } } },
            range: [0, Array.from(text).length], size: 6.0, bold: false, italic: false, underline: false,
            strokes: [{ content: { solid: { alpha: 1.0, color: [0, 0, 0] } }, width: 0.08 }],
        }],
        text,
    });
    return {
        id, content, typesetting: 0, alignment: 1, letter_spacing: 0.0, line_spacing: 0.02,
        line_feed: 1, line_max_width: 0.82, force_apply_line_max_width: false, check_flag: 15, type: "subtitle", global_alpha: 1.0,
    };
}

function emptyMaterials(): Record<string, unknown[]> {
    const materials: Record<string, unknown[]> = {};
    for (const key of EMPTY_MATERIAL_KEYS) materials[key] = [];
    return materials;
}

export function jianyingSrtTime(us: number) {
    const ms = Math.max(0, Math.floor(us / 1000));
    return `${String(Math.floor(ms / 3_600_000)).padStart(2, "0")}:${String(Math.floor(ms / 60_000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

export function jianyingSrt(captions: readonly JianyingCaption[]) {
    let index = 0;
    let output = "";
    for (const caption of captions) {
        const text = String(caption.text ?? "").trim();
        if (!text || !(caption.durationUs > 0) || caption.startUs < 0) continue;
        index += 1;
        output += `${index}\n${jianyingSrtTime(caption.startUs)} --> ${jianyingSrtTime(caption.startUs + caption.durationUs)}\n${text}\n\n`;
    }
    return output;
}

export function buildJianyingDraft(options: JianyingDraftOptions): JianyingDraft {
    const warnings: string[] = [];
    const name = safeDraftName(options.name);
    if (name !== options.name) warnings.push(`草稿名称含非法字符，已规范化为「${name}」`);
    if (!(options.width > 0) || !(options.height > 0)) throw new Error("草稿缺少有效画面尺寸");
    if (!options.clips.length) throw new Error("草稿至少需要一个视频片段");
    let fps = Number(options.fps);
    if (!Number.isFinite(fps) || fps <= 0) { fps = 30; warnings.push("未取得有效 fps，草稿按 30fps 写入"); }
    else if (!Number.isInteger(fps)) warnings.push(`制作稿 fps 为 ${fps}（非整数），剪映可能按最接近的整数帧率导入，请核对音画同步`);

    const root = options.root?.trim() ? normalizeDraftRoot(options.root) : DRAFT_ROOT_PLACEHOLDER;
    if (root === DRAFT_ROOT_PLACEHOLDER) warnings.push("草稿目录未填写：素材路径使用占位符，解压后运行包内 jianying/apply-draft-root.mjs 替换为本机绝对路径");
    const now = options.now ?? new Date();
    const uuid = () => newUUID(options.uuid ?? defaultUUID);
    const draftId = uuid();
    const materials = emptyMaterials();
    const videos: Record<string, unknown>[] = [];
    const speeds: ReturnType<typeof speedMaterial>[] = [];
    const videoSegments: Record<string, unknown>[] = [];
    const usedFileNames = new Set<string>();
    let cursor = 0;

    for (const clip of options.clips) {
        const fileName = String(clip.fileName ?? "").trim();
        const durationUs = Math.round(Number(clip.durationUs));
        if (!(durationUs > 0)) throw new Error(`视频片段「${clip.name || fileName}」的时长无效`);
        if (!fileName || /[\\/:*?"<>|\x00-\x1f]/.test(fileName) || fileName === "." || fileName === "..") throw new Error(`视频素材文件名无效：${fileName}`);
        if (usedFileNames.has(fileName.toLowerCase())) throw new Error(`草稿素材文件名重复：${fileName}`);
        usedFileNames.add(fileName.toLowerCase());
        const materialId = uuid();
        videos.push(record({
            audio_fade: null, category_id: "", category_name: "local", check_flag: 63487,
            crop: { upper_left_x: 0.0, upper_left_y: 0.0, upper_right_x: 1.0, upper_right_y: 0.0, lower_left_x: 0.0, lower_left_y: 1.0, lower_right_x: 1.0, lower_right_y: 1.0 },
            crop_ratio: "free", crop_scale: 1.0, duration: durationUs,
            height: typeof clip.height === "number" && clip.height > 0 ? clip.height : options.height,
            width: typeof clip.width === "number" && clip.width > 0 ? clip.width : options.width,
            id: materialId, local_material_id: "", material_id: materialId, material_name: String(clip.name || fileName).trim() || fileName,
            media_path: "", path: draftMaterialPath(root, name, fileName), type: "video",
        }));
        const speed = speedMaterial(uuid);
        speeds.push(speed);
        const segment = baseSegment(uuid, materialId, cursor, durationUs, 0, [speed.id], clipSettings(0));
        segment.source_timerange = timerange(0, durationUs);
        segment.hdr_settings = { intensity: 1.0, mode: 1, nits: 1000 };
        videoSegments.push(segment);
        cursor += durationUs;
    }

    const tracks: Record<string, unknown>[] = [track(uuid, "video", "", videoSegments)];
    const texts: ReturnType<typeof subtitleMaterial>[] = [];
    const usedCaptions: JianyingCaption[] = [];
    let skippedCaptions = 0;
    if (options.captions?.length) {
        const textSegments: Record<string, unknown>[] = [];
        for (const caption of options.captions) {
            const text = String(caption.text ?? "").trim();
            const startUs = Math.round(Number(caption.startUs));
            const durationUs = Math.round(Number(caption.durationUs));
            if (!text || !(durationUs > 0) || !(startUs >= 0) || startUs >= cursor) { skippedCaptions += 1; continue; }
            const clipped = Math.min(durationUs, cursor - startUs);
            const materialId = uuid();
            texts.push(subtitleMaterial(materialId, text));
            const speed = speedMaterial(uuid);
            const segment = baseSegment(uuid, materialId, startUs, clipped, 1, [speed.id], clipSettings(-0.8));
            segment.source_timerange = null;
            textSegments.push(segment);
            speeds.push(speed);
            usedCaptions.push({ text, startUs, durationUs: clipped });
        }
        if (textSegments.length) tracks.push(track(uuid, "text", "台词字幕", textSegments));
        if (skippedCaptions) warnings.push(`${skippedCaptions} 条字幕超出成片时长或为空，已跳过`);
    }

    materials.videos = videos;
    materials.speeds = speeds;
    materials.texts = texts;
    const platform = { app_id: 3704, app_source: "lv", app_version: JIANYING_APP_VERSION, os: "windows" };
    const unixSeconds = Math.floor(now.getTime() / 1000);
    const unixMicros = unixSeconds * 1_000_000;
    const content = record({
        canvas_config: { height: options.height, ratio: "original", width: options.width },
        color_space: 0,
        config: {
            adjust_max_index: 1, attachment_info: [], combination_max_index: 1, export_range: null, extract_audio_last_index: 1,
            lyrics_recognition_id: "", lyrics_sync: true, lyrics_taskinfo: [], maintrack_adsorb: true, material_save_mode: 0,
            multi_language_current: "none", multi_language_list: [], multi_language_main: "none", multi_language_mode: "none",
            original_sound_last_index: 1, record_audio_last_index: 1, sticker_max_index: 1, subtitle_keywords_config: null,
            subtitle_recognition_id: "", subtitle_sync: true, subtitle_taskinfo: [], system_font_list: [], video_mute: false, zoom_info_params: null,
        },
        cover: null, create_time: unixSeconds, duration: cursor, extra_info: null, fps,
        free_render_index_mode_on: false, group_container: null, id: draftId, keyframe_graph_list: [],
        keyframes: { adjusts: [], audios: [], effects: [], filters: [], handwrites: [], stickers: [], texts: [], videos: [] },
        last_modified_platform: platform, platform, materials, mutable_config: null, name,
        new_version: "110.0.0", relationships: [], render_index_track_mode_on: false, retouch_cover: null, source: "default",
        static_cover_image_path: "", time_marks: null, tracks, update_time: unixSeconds, version: 360000,
    });
    const folderPath = draftFolderPath(root, name);
    const meta = record({
        cloud_package_completed_time: "", draft_cloud_capcut_purchase_info: "", draft_cloud_last_action_download: false,
        draft_cloud_materials: [], draft_cloud_purchase_info: "", draft_cloud_template_id: "", draft_cloud_tutorial_info: "",
        draft_cloud_videocut_purchase_info: "", draft_cover: options.hasCover ? `${folderPath}${draftSeparator(root)}draft_cover.jpg` : "",
        draft_deeplink_url: "", draft_enterprise_info: { draft_enterprise_extra: "", draft_enterprise_id: "", draft_enterprise_name: "", enterprise_material: [] },
        draft_fold_path: folderPath, draft_id: draftId, draft_is_ai_packaging_used: false, draft_is_ai_shorts: false,
        draft_is_ai_translate: false, draft_is_article_video_draft: false, draft_is_from_deeplink: "false", draft_is_invisible: false,
        draft_materials: [0, 1, 2, 3, 6, 7, 8].map(type => ({ type, value: [] })),
        draft_materials_copied_info: [], draft_name: name, draft_new_version: "", draft_removable_storage_device: "",
        draft_root_path: root, draft_segment_extra_info: [], draft_type: "", tm_draft_cloud_completed: "",
        tm_draft_cloud_modified: 0, tm_draft_create: unixMicros, tm_draft_modified: unixMicros, tm_draft_removed: 0,
        tm_duration: cursor,
    });
    const contentJson = `${JSON.stringify(content, null, 2)}\n`;
    const metaJson = `${JSON.stringify(meta, null, 2)}\n`;
    const srt = jianyingSrt(usedCaptions);
    const files: Record<string, string> = {
        "draft_content.json": contentJson,
        // macOS 版剪映读 draft_info.json，内容与 draft_content.json 相同。
        "draft_info.json": contentJson,
        "draft_meta_info.json": metaJson,
        "台词字幕.srt": srt,
        "导入说明.txt": [
            `${name}`,
            `视频片段 ${options.clips.length} 段 · 字幕 ${usedCaptions.length} 条 · 总时长 ${(cursor / 1_000_000).toFixed(3)}s · ${fps}fps`,
            "",
            `1. 在本包根目录运行：node jianying/${name}/apply-draft-root.mjs "<剪映草稿目录的绝对路径>"`,
            "   脚本会把占位路径改成真实路径，并把 outputs/video 里同名素材拷进 materials。",
            "2. 把整个草稿文件夹复制到剪映的草稿目录，重启剪映后在草稿列表打开。",
            "3. 字幕来自制作稿台词的帧精确时间窗，不是语音识别；若配音时长与帧窗不符，",
            "   可在剪映里删掉字幕轨再用「识别字幕」重新生成，或用 subtitles/*.srt 导入。",
            "4. 草稿为硬切、speed=1、无转场/关键帧；剪映私有格式仅实测 5.9.0，其他版本需自行验收。",
            "5. 素材文件名与 outputs/video 一致。若导出时未勾选包含生成媒体，请手动把视频放进 materials。",
            "",
            ...warnings.map(item => `注意：${item}`),
            "",
        ].join("\n"),
        "apply-draft-root.mjs": draftRootApplyScript(name),
    };
    warnings.push("剪映草稿为私有格式（platform 5.9.0 / version 360000），不同客户端版本可能不兼容，需实际导入验收");
    return {
        name, root, durationUs: cursor, srt, files, warnings,
        stats: { clips: options.clips.length, captions: usedCaptions.length, skippedCaptions },
    };
}

function deepReplace(value: unknown, root: string): unknown {
    if (typeof value === "string") {
        if (!value.includes(DRAFT_ROOT_PLACEHOLDER)) return value;
        const replaced = value.split(`${DRAFT_ROOT_PLACEHOLDER}/`).join(`${root}${draftSeparator(root)}`).split(DRAFT_ROOT_PLACEHOLDER).join(root);
        return draftSeparator(root) === "\\" ? replaced.replace(/\//g, "\\") : replaced;
    }
    if (Array.isArray(value)) return value.map(item => deepReplace(item, root));
    if (value && typeof value === "object") {
        const output: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) output[key] = deepReplace(item, root);
        return output;
    }
    return value;
}

export function applyDraftRoot(files: Record<string, string>, rawRoot: string): Record<string, string> {
    const root = normalizeDraftRoot(rawRoot);
    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(files)) {
        output[key] = key.endsWith(".json")
            ? `${JSON.stringify(deepReplace(JSON.parse(value), root), null, 2)}\n`
            : value;
    }
    return output;
}

export function draftRootApplyScript(name: string) {
    return `// 用法：node jianying/${name}/apply-draft-root.mjs "<剪映草稿目录的绝对路径>"
// 只依赖 Node 内置模块；不联网、不改原视频文件。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLACEHOLDER = "__CANVAS_DRAFT_ROOT__";
const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const rawRoot = process.argv[2];
if (!rawRoot) { console.error("缺少剪映草稿目录参数"); process.exit(1); }
const isWindows = /^[A-Za-z]:[\\\\/]/.test(rawRoot) || rawRoot.startsWith("\\\\\\\\");
let root = rawRoot.trim().replace(/[\\\\/]+$/, "");
if (isWindows) root = root.replace(/\\//g, "\\\\");
if (!/^[A-Za-z]:[\\\\/]/.test(root) && !root.startsWith("\\\\\\\\") && !root.startsWith("/")) {
  console.error("请填写 Windows / UNC / macOS 的绝对路径"); process.exit(1);
}
const joinedRoot = root + (isWindows ? "\\\\" : "/");
const replace = (value) => {
  if (typeof value === "string") {
    if (!value.includes(PLACEHOLDER)) return value;
    const replaced = value.split(PLACEHOLDER + "/").join(joinedRoot).split(PLACEHOLDER).join(root);
    return isWindows ? replaced.replace(/\\//g, "\\\\") : replaced;
  }
  if (Array.isArray(value)) return value.map(replace);
  if (value && typeof value === "object") {
    const out = {}; for (const [key, item] of Object.entries(value)) out[key] = replace(item); return out;
  }
  return value;
};
for (const file of ["draft_content.json", "draft_info.json", "draft_meta_info.json"]) {
  const target = path.join(here, file);
  const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  fs.writeFileSync(target, JSON.stringify(replace(parsed), null, 2) + "\\n", "utf8");
}
const content = JSON.parse(fs.readFileSync(path.join(here, "draft_content.json"), "utf8"));
const materialsDir = path.join(here, "materials");
fs.mkdirSync(materialsDir, { recursive: true });
let copied = 0, missing = 0;
for (const video of content.materials?.videos || []) {
  const fileName = path.basename(String(video.path || ""));
  if (!fileName) continue;
  const source = path.join(packageRoot, "outputs", "video", fileName);
  if (fs.existsSync(source)) { fs.copyFileSync(source, path.join(materialsDir, fileName)); copied += 1; }
  else { missing += 1; console.warn("缺少素材（请手动放入 materials）：" + fileName); }
}
console.log("草稿目录：" + root);
console.log("素材已复制 " + copied + " 个，缺失 " + missing + " 个");
if (missing) console.warn("缺失素材时剪映会提示「素材丢失」；导出交付包时请勾选包含生成媒体。");
console.log("下一步：把 " + here + " 整个文件夹复制到剪映草稿目录，重启剪映后打开。");
`;
}

// ---------------------------------------------------------------------------
// 字幕时间窗（移植自 web/src/lib/production-subtitles.ts）
// ---------------------------------------------------------------------------

type Row = Record<string, any>;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as Row[] : [];

export type SubtitleCue = {
    index: number;
    timelineId: string;
    shotId: string;
    utteranceId: string;
    speaker: string;
    startFrame: number;
    endFrame: number;
    startSeconds: number;
    endSeconds: number;
    text: string;
};
export type SubtitleTrack = { timelineId: string; fps: number; cues: SubtitleCue[]; srt: string };
export type SubtitleCalibration = {
    version: number;
    sourceHash: string;
    tracks: Array<{ timelineId: string; cues: Array<{ text: string; startSeconds: number; endSeconds: number }> }>;
    [key: string]: unknown;
};

/** 无帧率记录时的兜底；真实制作稿都写 fps_num/fps_den。 */
export const DEFAULT_SUBTITLE_FPS = 24;

export function productionSourceFps(source: unknown) {
    const src = source && typeof source === "object" ? source as Row : {};
    const numerator = Number(src.fps_num), denominator = Number(src.fps_den ?? 1);
    return Number.isFinite(numerator) && numerator > 0 && Number.isFinite(denominator) && denominator > 0 ? numerator / denominator : DEFAULT_SUBTITLE_FPS;
}

export function srtTimestamp(seconds: number) {
    const total = Math.max(0, Math.round(seconds * 1000));
    const milliseconds = total % 1000, whole = Math.floor(total / 1000);
    return `${String(Math.floor(whole / 3600)).padStart(2, "0")}:${String(Math.floor(whole / 60) % 60).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
}

export function cuesToSrt(cues: readonly Pick<SubtitleCue, "text" | "startSeconds" | "endSeconds">[]) {
    if (!cues.length) return "";
    return `${cues.map((cue, index) => `${index + 1}\n${srtTimestamp(cue.startSeconds)} --> ${srtTimestamp(cue.endSeconds)}\n${cue.text}\n`).join("\n")}\n`;
}

function subjectDisplayName(source: Row, subjectId: string): string {
    const subjects = rows(source.subject_registry).concat(rows(source.subjects));
    const found = subjects.find(item => String(item.id) === subjectId);
    return String(found?.name || found?.label || subjectId || "");
}

/**
 * 台词字幕是制作稿既有台词的投影：每个 Shot 的 utterance_refs 窗口按 subjectShotWindows
 * 放到权威 Shot 时间线上，cue 文本是 ref 自身的切片。只支持 Subject Prompt Assembly v2。
 */
export function productionSubtitleTracks(source: unknown): SubtitleTrack[] {
    const src = source && typeof source === "object" ? source as Row : {};
    if (!isSubjectPromptAssembly(src)) return [];
    const fps = productionSourceFps(src);
    const utterances = new Map(rows(src.utterances).map(utterance => [String(utterance.id), utterance]));
    const windows = subjectShotWindows(src);
    const timelineOrder = new Map(rows(src.ledger?.timelines).map((timeline, index) => [String(timeline.id), index]));
    const cues: SubtitleCue[] = [];
    for (const shot of rows(src.shots)) {
        const window = windows.get(String(shot.id));
        if (!window) continue;
        for (const ref of rows(shot.utterance_refs)) {
            const utterance = utterances.get(String(ref.utteranceId));
            if (!utterance) continue;
            const characters = Array.from(String(utterance.text ?? ""));
            const textStart = Math.max(0, Math.min(characters.length, Number(ref.textStart ?? 0)));
            const textEnd = Math.max(textStart, Math.min(characters.length, Number(ref.textEnd ?? characters.length)));
            const text = characters.slice(textStart, textEnd).join("").trim();
            if (!text) continue;
            const startFrame = window.startFrame + Math.max(0, Number(ref.localStartFrame ?? 0));
            const endFrame = Math.min(window.endFrame, window.startFrame + Number(ref.localEndFrame ?? 0));
            if (!(endFrame > startFrame)) continue;
            cues.push({
                index: 0, timelineId: window.timelineId, shotId: String(shot.id), utteranceId: String(utterance.id),
                speaker: String(utterance.speakerName || "").trim() || (utterance.speakerSubjectId ? subjectDisplayName(src, String(utterance.speakerSubjectId)) : ""),
                startFrame, endFrame, startSeconds: startFrame / fps, endSeconds: endFrame / fps, text,
            });
        }
    }
    cues.sort((left, right) => (timelineOrder.get(left.timelineId) ?? Number.MAX_SAFE_INTEGER) - (timelineOrder.get(right.timelineId) ?? Number.MAX_SAFE_INTEGER)
        || left.startFrame - right.startFrame || left.endFrame - right.endFrame || left.speaker.localeCompare(right.speaker));
    const byTimeline = new Map<string, SubtitleCue[]>();
    for (const cue of cues) byTimeline.set(cue.timelineId, [...(byTimeline.get(cue.timelineId) || []), cue]);
    return [...byTimeline].map(([timelineId, timelineCues]) => {
        const reindexed = timelineCues.map((cue, index) => ({ ...cue, index: index + 1 }));
        return { timelineId, fps, cues: reindexed, srt: cuesToSrt(reindexed) };
    });
}

/** calibration 是交付层叠加：sourceHash 不一致时绝不静默改时间线。 */
export function effectiveCalibration(calibration: SubtitleCalibration | null | undefined, sourceHash: string): SubtitleCalibration | null {
    if (!calibration || calibration.version !== 1 || calibration.sourceHash !== sourceHash) return null;
    return calibration;
}

export type ShotClipSpan = { startUs: number; durationUs: number };

/**
 * 把台词 cue 投影到剪映草稿的「拼接后」时间线。
 * 未校准：用 subjectShotWindows 把绝对帧窗减成段内局部帧，再叠加该段 clip 在草稿里的起点。
 * 已校准：cue 的秒数即为成片时间线（影策实际音频口径），直接映射并裁到成片总长。
 * 只投影被纳入（included）的段，跳过段的镜头不产生字幕。
 */
export function buildJianyingCaptions(
    source: unknown,
    spans: Map<string, ShotClipSpan>,
    calibration: SubtitleCalibration | null,
    totalUs: number,
): JianyingCaption[] {
    const fps = productionSourceFps(source);
    const captions: JianyingCaption[] = [];
    if (calibration?.tracks?.length) {
        for (const track of calibration.tracks) {
            for (const cue of track.cues || []) {
                const text = String(cue.text ?? "").trim();
                const startUs = Math.round(Number(cue.startSeconds) * 1_000_000);
                const endUs = Math.round(Number(cue.endSeconds) * 1_000_000);
                const clipped = Math.min(endUs, totalUs) - startUs;
                if (text && startUs >= 0 && clipped > 0) captions.push({ text, startUs, durationUs: clipped });
            }
        }
        return captions.sort((a, b) => a.startUs - b.startUs);
    }
    const windows = subjectShotWindows(source && typeof source === "object" ? source as Row : {});
    for (const track of productionSubtitleTracks(source)) {
        for (const cue of track.cues) {
            const span = spans.get(cue.shotId);
            const window = windows.get(cue.shotId);
            if (!span || !window) continue;
            const origin = window.startFrame;
            const localStart = Math.max(0, cue.startFrame - origin);
            const localEnd = Math.max(0, cue.endFrame - origin);
            const startUs = span.startUs + Math.round(localStart / fps * 1_000_000);
            const endUs = Math.min(span.startUs + span.durationUs, span.startUs + Math.round(localEnd / fps * 1_000_000));
            const durationUs = endUs - startUs;
            if (durationUs > 0 && startUs >= 0 && startUs < totalUs) captions.push({ text: cue.text, startUs, durationUs });
        }
    }
    return captions.sort((a, b) => a.startUs - b.startUs);
}

// ---------------------------------------------------------------------------
// 导出计划与流式 ZIP
// ---------------------------------------------------------------------------

export type JianyingExportMedia = { path: string; filePath: string; bytes: number; fileName: string; sha256: string; storageKey: string };

export type JianyingExportPlan = {
    preview: DramaJianyingDraftPreview;
    name: string;
    draft: JianyingDraft;
    /** 草稿文件夹外的字幕条目（subtitles/...），captions=false 时为空。 */
    subtitleFiles: Record<string, string>;
    media: JianyingExportMedia[];
    captionCount: number;
    calibrationApplied: boolean;
    warnings: string[];
    fileName: string;
};

/** 把一集的可导出媒体读成占位符已替换的草稿 + 字幕计划；不写 ZIP、不访问用户本机草稿目录。 */
export function makeJianyingExportPlan(input: {
    preview: DramaJianyingDraftPreview;
    segments: Array<{ shotIds: string[]; resultStorageKey: string; title: string; media: { filePath: string; bytes: number; sha256?: string | null; storageKey: string; width?: number; height?: number } | null }>;
    source: unknown;
    sourceHash: string;
    title: string;
    draftRoot?: string;
    captions?: boolean;
    width?: number;
    height?: number;
    calibration?: SubtitleCalibration | null;
}): JianyingExportPlan {
    const { preview, segments, source } = input;
    const name = safeDraftName(`${input.title || "剪映草稿"}-剪映草稿`);
    const warnings: string[] = [];
    const fps = productionSourceFps(source);
    const clips: JianyingClip[] = [];
    const spans = new Map<string, ShotClipSpan>();
    const media: JianyingExportMedia[] = [];
    const usedNames = new Set<string>();
    let cursorUs = 0;

    preview.segments.forEach((seg, index) => {
        if (!seg.included) return;
        const segInput = segments[index];
        const durationUs = Math.max(1, Math.round(Number(seg.durationMs) * 1000));
        const storageKey = String(segInput?.resultStorageKey || "");
        const extension = /\.([a-z0-9]{1,8})$/i.exec(storageKey.split(/[?#]/, 1)[0])?.[1]?.toLowerCase() || "mp4";
        const base = safeDraftName(String(seg.title || `segment-${index + 1}`).slice(0, 60), "clip", 60);
        let fileName = `${base}.${extension}`;
        if (usedNames.has(fileName.toLowerCase())) fileName = `${base}-${index + 1}.${extension}`;
        usedNames.add(fileName.toLowerCase());
        const m = segInput?.media || null;
        clips.push({
            fileName,
            name: String(seg.title || base),
            durationUs,
            ...(m?.width ? { width: m.width } : {}),
            ...(m?.height ? { height: m.height } : {}),
        });
        for (const shotId of segInput?.shotIds || []) spans.set(String(shotId), { startUs: cursorUs, durationUs });
        if (m?.filePath && m.bytes > 0 && fs.existsSync(m.filePath)) {
            media.push({ path: `outputs/video/${fileName}`, filePath: m.filePath, bytes: m.bytes,
                fileName, sha256: String(m.sha256 || ""), storageKey });
        } else if (m) {
            warnings.push(`段「${seg.title}」的媒体文件当前不可读取（${m.filePath}），草稿已保留占位片段但包内不含该视频`);
        }
        cursorUs += durationUs;
    });

    if (!clips.length) throw new JianyingExportBlockedError("没有可导出的视频段，请先生成或修复素材", "JIANYING_NO_SEGMENTS");

    const calibration = input.captions === false ? null : effectiveCalibration(input.calibration, input.sourceHash);
    const captions = input.captions === false ? [] : buildJianyingCaptions(source, spans, calibration, cursorUs);
    const draft = buildJianyingDraft({
        name,
        width: input.width && input.width > 0 ? input.width : 1920,
        height: input.height && input.height > 0 ? input.height : 1080,
        fps,
        clips,
        captions,
        ...(input.draftRoot?.trim() ? { root: input.draftRoot } : {}),
    });
    warnings.push(...draft.warnings);

    const subtitleFiles: Record<string, string> = {};
    const subtitleIndex: Array<Record<string, unknown>> = [];
    for (const track of (input.captions === false ? [] : productionSubtitleTracks(source))) {
        const path = `subtitles/${safeDraftName(track.timelineId, "timeline", 80)}.srt`;
        subtitleFiles[path] = track.srt;
        subtitleIndex.push({ timelineId: track.timelineId, path, cueCount: track.cues.length, fps: track.fps });
    }
    if (subtitleIndex.length) subtitleFiles["subtitles/index.json"] = `${JSON.stringify({ fps, tracks: subtitleIndex }, null, 2)}\n`;

    let calibrationApplied = false;
    if (calibration) {
        const calibratedIndex: Array<Record<string, unknown>> = [];
        for (const track of calibration.tracks || []) {
            const path = `subtitles/calibrated/${safeDraftName(track.timelineId, "timeline", 80)}.srt`;
            const cues = (track.cues || []).map((cue, index) => ({
                index: index + 1, timelineId: track.timelineId, shotId: "", utteranceId: "", speaker: "",
                text: String(cue.text || ""), startFrame: 0, endFrame: 0,
                startSeconds: Number(cue.startSeconds) || 0, endSeconds: Number(cue.endSeconds) || 0,
            }));
            subtitleFiles[path] = cuesToSrt(cues);
            calibratedIndex.push({ timelineId: track.timelineId, path, cueCount: cues.length });
        }
        if (calibratedIndex.length) {
            subtitleFiles["subtitles/calibrated/index.json"] = `${JSON.stringify({ contract: "srt-calibrated-1", sourceHash: calibration.sourceHash,
                ...Object.fromEntries(Object.entries(calibration).filter(([key]) => !["version", "tracks"].includes(key))),
                tracks: calibratedIndex }, null, 2)}\n`;
            calibrationApplied = true;
        }
    }

    const fileName = `${safeDraftName(input.title || "剪映草稿", "draft", 80)}-剪映草稿-r${preview.availableSegments}-${preview.revision.slice(0, 8)}.zip`;
    return { preview, name: draft.name, draft, subtitleFiles, media, captionCount: captions.length, calibrationApplied, warnings, fileName };
}

/** fflate 流式 ZIP 写入器：每个 chunk 直接交给 res.write，媒体按文件流逐段 push。 */
export class JianyingZipWriter {
    private readonly archive: Zip;
    private readonly done: Promise<void>;
    private resolveDone: () => void = () => undefined;
    private rejectDone: (error: Error) => void = () => undefined;
    private paused = false;
    private drainWaiters: Array<() => void> = [];

    constructor(private readonly write: (chunk: Uint8Array) => boolean | void) {
        this.done = new Promise<void>((resolve, reject) => { this.resolveDone = resolve; this.rejectDone = reject; });
        this.archive = new Zip((error, chunk, final) => {
            if (error) { this.rejectDone(error); return; }
            if (chunk?.length) {
                let ok: boolean | void = true;
                try { ok = this.write(chunk); }
                catch (failure) { this.rejectDone(failure instanceof Error ? failure : new Error(String(failure))); return; }
                if (ok === false) this.paused = true;
            }
            if (final) this.resolveDone();
        });
    }

    addBytes(path: string, data: Uint8Array) {
        const file = new ZipPassThrough(path);
        this.archive.add(file);
        file.push(data, true);
    }

    addText(path: string, text: string) {
        this.addBytes(path, new TextEncoder().encode(text));
    }

    /** res.write 返回 false 时路由监听 drain 调 resume，避免大媒体把内存吃满。 */
    resume() {
        this.paused = false;
        const waiters = this.drainWaiters.splice(0);
        for (const waiter of waiters) waiter();
    }

    async addFile(path: string, filePath: string) {
        const file = new ZipPassThrough(path);
        this.archive.add(file);
        for await (const chunk of createReadStream(filePath)) {
            if (this.paused) await new Promise<void>(resolve => this.drainWaiters.push(resolve));
            file.push(Uint8Array.from(chunk as Buffer), false);
        }
        file.push(new Uint8Array(0), true);
    }

    async end() {
        this.archive.end();
        await this.done;
    }

    terminate() {
        this.archive.terminate();
        this.rejectDone(new Error("ZIP 写入已终止"));
    }
}

/** 把完整导出计划写进 ZIP：草稿文件 → 字幕 → 媒体流 → manifest。 */
export async function writeJianyingExport(plan: JianyingExportPlan, writer: JianyingZipWriter) {
    for (const [fileName, content] of Object.entries(plan.draft.files)) {
        writer.addText(`jianying/${plan.draft.name}/${fileName}`, content);
    }
    for (const [path, content] of Object.entries(plan.subtitleFiles)) writer.addText(path, content);
    for (const item of plan.media) await writer.addFile(item.path, item.filePath);
    const manifest = {
        contract: "jianying-export-v1",
        revision: plan.preview.revision,
        draftRoot: plan.preview.draftRoot,
        name: plan.draft.name,
        folder: `jianying/${plan.draft.name}`,
        draft: plan.draft.stats,
        durationUs: plan.draft.durationUs,
        preview: {
            totalSegments: plan.preview.totalSegments, availableSegments: plan.preview.availableSegments,
            missingSegments: plan.preview.missingSegments, staleSegments: plan.preview.staleSegments,
            captionCount: plan.preview.captionCount, mediaBytes: plan.preview.mediaBytes,
        },
        media: plan.media.map(item => ({ path: item.path, storageKey: item.storageKey, sha256: item.sha256, bytes: item.bytes })),
        subtitles: { captionCount: plan.captionCount, calibrated: plan.calibrationApplied },
        warnings: [...plan.warnings, ...plan.preview.warnings],
    };
    writer.addText("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
    writer.addText("README.txt", [
        plan.draft.name,
        `revision ${plan.preview.revision}`,
        `视频 ${plan.draft.stats.clips} 段 · 字幕 ${plan.draft.stats.captions} 条 · ${(plan.draft.durationUs / 1_000_000).toFixed(3)}s`,
        "",
        "1. 运行 jianying/<草稿名>/apply-draft-root.mjs <本机剪映草稿目录> 替换占位路径并拷贝素材。",
        "2. 把 jianying/<草稿名> 整个文件夹复制到剪映草稿目录，重启剪映打开。",
        ...plan.warnings.map(item => `注意：${item}`),
        "",
    ].join("\n"));
    await writer.end();
}
