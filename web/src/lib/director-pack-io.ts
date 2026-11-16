import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import { DIRECTOR_PACK_FORMAT, DIRECTOR_PACK_TASK_TYPE, DIRECTOR_PACK_VERSION, parseDirectorPack, type DirectorPack } from "./director-pack";

/**
 * `.mmxpack.zip` 的读写（fflate，同步版够用：一集包 200MB 以内）。
 * 目录结构与导演大师完全一致：pack.json / timeline.json / shared_params/shared_params.json / asset_groups/NN/{group.json,PictureN.png}
 */

export function packToZip(pack: DirectorPack): Uint8Array {
    const files: Record<string, Uint8Array> = {};
    files["pack.json"] = strToU8(JSON.stringify(pack.pack, null, 2));
    files["timeline.json"] = strToU8(JSON.stringify(pack.timeline, null, 2));
    files["shared_params/shared_params.json"] = strToU8(JSON.stringify(pack.sharedParams, null, 2));
    for (const group of pack.groups) {
        const dir = `asset_groups/${String(group.index).padStart(2, "0")}`;
        files[`${dir}/group.json`] = strToU8(JSON.stringify(group.segment, null, 2));
        for (const image of group.images) files[`${dir}/${image.name}`] = image.bytes;
    }
    return zipSync(files, { level: 6 });
}

function readJson(source: Uint8Array | undefined): Record<string, unknown> {
    if (!source) return {};
    try {
        const parsed = JSON.parse(strFromU8(source));
        return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

export function zipToPack(bytes: Uint8Array): DirectorPack {
    const entries = unzipSync(bytes);
    const pack = readJson(entries["pack.json"]);
    if (!pack.format) throw new Error("这个 zip 里没有 pack.json（不是导演包）");
    const timeline = readJson(entries["timeline.json"]);
    const sharedParams = entries["shared_params/shared_params.json"] ? readJson(entries["shared_params/shared_params.json"]) : undefined;
    const groups = new Map<number, { segment: Record<string, unknown>; images: Array<{ name: string; bytes: Uint8Array }> }>();
    for (const name of Object.keys(entries)) {
        const match = /^asset_groups\/(\d+)\//.exec(name);
        if (!match) continue;
        const index = Number(match[1]);
        const bucket = groups.get(index) || { segment: {}, images: [] };
        if (name.endsWith("/group.json")) bucket.segment = readJson(entries[name]);
        else if (!name.includes("/group.json")) bucket.images.push({ name: name.split("/").pop() || "", bytes: entries[name] });
        groups.set(index, bucket);
    }
    return parseDirectorPack({ pack, timeline, sharedParams, groups });
}

/** 预览用：不解全包也能报出关键规格。 */
export function readPackHeader(bytes: Uint8Array) {
    const entries = unzipSync(bytes);
    const pack = readJson(entries["pack.json"]);
    const timeline = readJson(entries["timeline.json"]);
    const segments = Array.isArray(timeline.segments) ? timeline.segments as Array<Record<string, unknown>> : [];
    const output = (timeline.output || pack.output || {}) as Record<string, unknown>;
    return {
        format: String(pack.format || ""),
        formatVersion: Number(pack.formatVersion || 0),
        taskType: String(pack.taskType || DIRECTOR_PACK_TASK_TYPE),
        segments: segments.length,
        firstPrompt: String(segments[0]?.prompt || "").slice(0, 80),
        output: { width: Number(output.width || 1280), height: Number(output.height || 720), fps: Number(output.fps || 24) },
        bytes: bytes.byteLength,
    };
}

export const DIRECTOR_PACK_META = { format: DIRECTOR_PACK_FORMAT, formatVersion: DIRECTOR_PACK_VERSION, taskType: DIRECTOR_PACK_TASK_TYPE };
