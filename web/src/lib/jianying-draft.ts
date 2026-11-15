/**
 * 剪映专业版草稿工程生成（纯函数，无网络 / 无文件系统 / 无后端依赖）。
 *
 * 字段形态参考影策 open-ai-canvas 的 backend/internal/jianying/draft.go（MIT），
 * 但两处按本项目重写：
 *  - 字幕时间轴由 productionSubtitleTracks 的帧精确 cue 换算成微秒传入，
 *    不是按分镜时长比例估算（影策 dramaSegmentCaptions 的做法）；
 *  - 素材绝对路径不写死：root 留空时产出占位符，由 applyDraftRoot / 包内脚本
 *    在用户本机替换，避免把导出机器的路径塞进草稿。
 *
 * 剪映草稿是私有格式：platform 5.9.0 / version 360000 / new_version 110.0.0
 * 为实测可用的常量，不保证所有客户端版本兼容。
 */

export const DRAFT_ROOT_PLACEHOLDER = "__CANVAS_DRAFT_ROOT__";
export const JIANYING_MATERIALS_DIR = "materials";
export const JIANYING_APP_VERSION = "5.9.0";

export type JianyingClip = {
    /** materials 目录内的文件名，不含路径分隔符。 */
    fileName: string;
    name?: string;
    /** 微秒。由 Shot duration_frames / fps 精确换算，不要用估算值。 */
    durationUs: number;
    width?: number;
    height?: number;
};

export type JianyingCaption = {
    text: string;
    /** 微秒，相对整条成片时间轴起点。 */
    startUs: number;
    durationUs: number;
};

export type JianyingDraftOptions = {
    name: string;
    /** 剪映草稿目录（本机绝对路径）。留空则用占位符，交付后由脚本替换。 */
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
    /** 草稿文件夹内的相对文件名 → 文本内容。 */
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
    const cryptoObject = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, char => {
        const value = Math.floor(Math.random() * 16);
        return (char === "x" ? value : (value & 0x3) | 0x8).toString(16);
    });
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

/** 剪映导入字幕的默认样式：白字黑描边、居中、自动换行、位于画面下方。range 用 Unicode 码点数。 */
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
        // 占位路径统一用 "/" 拼装；替换后把该路径里残留的 "/" 一并转成本机分隔符，避免 C:\.../name/materials 混合斜杠。
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

/** 把占位路径替换成用户本机绝对路径；JSON 文件按结构替换，避免反斜杠破坏 JSON 转义。 */
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

/** 包内自包含脚本：替换占位路径 + 从交付包拷贝同名视频素材到 materials。 */
export function draftRootApplyScript(name: string) {
    // 占位符在脚本里拼装，避免 applyDraftRoot 的纯文本替换把脚本自身的常量改掉。
    return `// 用法：node jianying/${name}/apply-draft-root.mjs "<剪映草稿目录的绝对路径>"
// 只依赖 Node 内置模块；不联网、不改原视频文件。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLACEHOLDER = ["__CANVAS", "DRAFT", "ROOT"].join("_");
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
