import { Zip, ZipPassThrough } from "fflate";

import { backendMediaUrl, fetchBackendGenerationLogs, type EpisodeProduction, type ProductionReadiness } from "@/services/backend-api";
import { productionSegmentRuntimeMatches, productionSegments, segmentShotIds } from "@/lib/production-source";
import { productionSourceFps, productionSubtitleTracks } from "@/lib/production-subtitles";
import { buildJianyingDraft, type JianyingCaption, type JianyingClip } from "@/lib/jianying-draft";
import type { SubtitleCalibration } from "@/lib/subtitle-calibration";
import type { CanvasNodeData } from "@/types/canvas";

type RecordValue = Record<string, unknown>;
type CanvasNode = CanvasNodeData;
type BinaryEntry = Omit<MediaEntry, "included" | "requested" | "missingReason">;
type ExportOptions = {
    owner: { kind: "canvas" | "episode" | "scene"; id: string };
    title: string;
    projectId: string;
    production: EpisodeProduction;
    readiness: ProductionReadiness;
    canvasNodes: CanvasNode[];
    includeGeneratedMedia?: boolean;
    /** 按实际视频音频校准后的字幕时间线；仅当 sourceHash 一致时生效，创作稿 SRT 始终保留作对照。 */
    calibration?: SubtitleCalibration | null;
    /** 剪映草稿画布尺寸与本机草稿目录；留空时产出占位路径，由包内脚本替换。 */
    jianying?: { width?: number; height?: number; root?: string };
};
type MediaEntry = { key: string; path: string; kind: "reference" | "asset" | "keyframe" | "video"; targetId: string; sha256?: string; requested: boolean; included: boolean; missingReason?: string };

const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const safeName = (value: string) => String(value || "target").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 100) || "target";
const extensionOf = (storageKey: string) => /\.([a-z0-9]{1,8})$/i.exec(storageKey.split(/[?#]/, 1)[0])?.[1]?.toLowerCase() || "bin";

export async function exportAchengDeliveryBundle(options: ExportOptions) {
    const sourceRevision = options.production.revision;
    const publishedVersion = options.production.publishedVersion;
    const snapshot = options.production.draft;
    const director = snapshot.director;
    if (!director) throw new Error("尚未建立 Acheng 正式制作稿");
    const artifacts = director.artifacts;
    const binaries = new Map<string, BinaryEntry>();
    const generatedPrompts = await Promise.all(productionSegments({ draft: snapshot as EpisodeProduction["draft"], published: null }).flatMap(group => {
        const locked = (Array.isArray(director.source?.segments) ? director.source.segments : []).map(record).find(segment => String(segment.id || "") === String(group.id));
        if (locked?.locked !== true) return [];
        const runtime = productionSegmentRuntimeMatches(options.canvasNodes, String(group.id), options.owner)[0]?.segment
            || options.canvasNodes.find(item => item.id === group.nodeId)?.metadata?.segments?.map(record).find(item => String(item.id || "") === String(group.segmentId || ""));
        const nodeId = String(group.nodeId || ""), segmentId = String(group.segmentId || ""), outputKey = String(runtime?.resultStorageKey || "");
        if (!nodeId || !segmentId || !outputKey) return [{ targetId: String(group.id), status: "missing" as const }];
        return [fetchBackendGenerationLogs({ projectId: options.projectId, nodeId, segmentId, limit: 100 }).then(({ logs = [] }) => {
            const log = logs.find(item => item.status === "success" && item.outputs.some(output => String(output.storageKey || "") === outputKey) && typeof item.prompt === "string" && item.prompt.length > 0);
            return log ? { targetId: String(group.id), status: "recorded" as const, prompt: log.prompt, logId: log.id, startedAt: log.startedAt, outputStorageKey: outputKey }
                : { targetId: String(group.id), status: "missing" as const };
        }).catch(() => ({ targetId: String(group.id), status: "unavailable" as const }))];
    }));
    const generatedPromptFiles = generatedPrompts.flatMap(item => {
        if (item.status !== "recorded") return [];
        const path = `prompts/generated/h3/${safeName(item.targetId)}.txt`;
        return [{ ...item, path }];
    });
    const artifactFiles = artifacts.map(artifact => {
        const kind = artifact.kind === "image" ? "image" : "h3";
        const base = `${kind}/${safeName(artifact.targetId)}`;
        const promptPath = `prompts/${base}.txt`;
        const uploadPath = `uploads/${base}.json`;
        const refs = artifact.references.map((ref, index) => {
            const key = `${ref.storageKey}\0${ref.sha256}`;
            let binary = binaries.get(key);
            if (!binary) {
                const path = `references/${String(binaries.size + 1).padStart(3, "0")}-${safeName(ref.label)}.${extensionOf(ref.storageKey)}`;
                binary = { key: ref.storageKey, path, kind: "reference", targetId: artifact.targetId, sha256: ref.sha256 };
                binaries.set(key, binary);
            }
            if (!binary) throw new Error(`无法分配参考媒体路径：${ref.label}`);
            return { slot: index + 1, label: ref.label, role: ref.role, nodeId: ref.nodeId, storageKey: ref.storageKey, sha256: ref.sha256, file: binary.path };
        });
        return {
            artifact,
            promptPath,
            uploadPath,
            refs,
            manifest: { id: artifact.id, kind: artifact.kind, targetId: artifact.targetId, status: artifact.status, promptSha256: artifact.sha256, sourceHash: artifact.sourceHash, receipt: artifact.receipt, promptFile: promptPath, uploadCard: uploadPath, references: refs },
        };
    });

    const d = director as EpisodeProduction["draft"]["director"];
    const actualMedia: BinaryEntry[] = [];
    for (const [assetId, asset] of Object.entries(d?.assets || {})) if (asset.storageKey) actualMedia.push({ key: asset.storageKey, path: `outputs/assets/${safeName(assetId)}.${extensionOf(asset.storageKey)}`, kind: "asset", targetId: assetId, sha256: asset.sha256 });
    for (const [shotId, frame] of Object.entries(snapshot.keyframes)) if (frame.storageKey) actualMedia.push({ key: frame.storageKey, path: `outputs/keyframes/${safeName(shotId)}.${extensionOf(frame.storageKey)}`, kind: "keyframe", targetId: shotId });
    const lockedClipIds = new Set((Array.isArray(d?.source?.segments) ? d.source.segments : [])
        .map(record).filter(segment => segment.locked === true).map(segment => String(segment.id || "")).filter(Boolean));
    // 剪映草稿的帧精确时间轴：v2 用 shot.duration_frames，旧稿用 shot.end_frame - start_frame。
    const sourceRecord = record(director.source);
    const sourceShots: RecordValue[] = Array.isArray(sourceRecord.shots) ? (sourceRecord.shots as unknown[]).map(record) : [];
    const shotFrames = new Map<string, number>(sourceShots.map(shot => {
        const frames = Number(shot.duration_frames);
        const span = Number(shot.end_frame ?? 0) - Number(shot.start_frame ?? 0);
        const value = Number.isFinite(frames) && frames > 0 ? frames : Number.isFinite(span) && span > 0 ? span : 0;
        return [String(shot.id || ""), value] as const;
    }));
    const jianyingFps = productionSourceFps(director.source);
    const jianyingClips: JianyingClip[] = [];
    const jianyingWarnings: string[] = [];
    const jianyingNames = new Set<string>();
    const FALLBACK_CLIP_US = 5_000_000;
    for (const [index, group] of productionSegments({ draft: snapshot as EpisodeProduction["draft"], published: null }).entries()) {
        const runtime = productionSegmentRuntimeMatches(options.canvasNodes, String(group.id), options.owner)[0]?.segment
            || options.canvasNodes.find(item => item.id === group.nodeId)?.metadata?.segments?.map(record).find(item => String(item.id || "") === String(group.segmentId || ""));
        const storageKey = String(runtime?.resultStorageKey || "");
        const baseName = safeName(String(group.id || `segment-${index + 1}`));
        let fileName = `${baseName}.${storageKey ? extensionOf(storageKey) : "mp4"}`;
        if (jianyingNames.has(fileName.toLowerCase())) {
            fileName = `${baseName}-${index + 1}.${storageKey ? extensionOf(storageKey) : "mp4"}`;
            jianyingWarnings.push(`段落 ${group.id} 的素材文件名重复，剪映草稿改用 ${fileName}`);
        }
        jianyingNames.add(fileName.toLowerCase());
        // 时间轴覆盖全部段落：未生成 / 未锁定的段也占位，避免字幕帧窗被压缩后错位。
        const frames = segmentShotIds(group).reduce((total, shotId) => total + (shotFrames.get(shotId) || 0), 0);
        if (!(frames > 0)) jianyingWarnings.push(`段落 ${group.id} 无法从制作稿读取帧时长，剪映草稿按 5s 占位，导入后请核对`);
        jianyingClips.push({
            fileName,
            name: String(group.id || baseName),
            durationUs: frames > 0 ? Math.round(frames / jianyingFps * 1_000_000) : FALLBACK_CLIP_US,
        });
        if (!lockedClipIds.has(String(group.id)) && group.locked !== true) continue;
        if (storageKey) actualMedia.push({ key: storageKey, path: `outputs/video/${fileName}`, kind: "video", targetId: group.id });
    }
    const chosenOutputs = options.includeGeneratedMedia ? actualMedia : [];
    const outputByKey = new Map<string, BinaryEntry>();
    for (const item of chosenOutputs) if (!outputByKey.has(item.key)) outputByKey.set(item.key, item);
    const allBinaries = [...binaries.values(), ...outputByKey.values()];
    const mediaEntries: MediaEntry[] = actualMedia.filter(item => !options.includeGeneratedMedia).map(item => ({ ...item, requested: false, included: false }));
    const chunks: Uint8Array[] = [];
    let rejectArchive: (error: Error) => void = () => undefined;
    let resolveArchive: (blob: Blob) => void = () => undefined;
    const archiveDone = new Promise<Blob>((resolve, reject) => { resolveArchive = resolve; rejectArchive = reject; });
    const archive = new Zip((error, chunk, final) => {
        if (error) { rejectArchive(error); return; }
        if (chunk.length) chunks.push(chunk);
        if (final) resolveArchive(new Blob(chunks.map(chunk => Uint8Array.from(chunk).buffer), { type: "application/zip" }));
    });
    const addBytes = (path: string, data: Uint8Array) => {
        const file = new ZipPassThrough(path);
        archive.add(file);
        file.push(data, true);
    };
    const addJson = (path: string, value: unknown) => addBytes(path, new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`));

    try {
        const encoder = new TextEncoder();
        // 字幕是制作稿里既有台词的投影：按 Shot 时间窗与 ref 片段生成，不改写任何台词文本。
        const subtitleTracks = productionSubtitleTracks(director.source);
        const subtitleIndex = subtitleTracks.map(track => ({ timelineId: track.timelineId, path: `subtitles/${safeName(track.timelineId)}.srt`, cueCount: track.cues.length, cues: track.cues }));
        // Calibration is a delivery-layer overlay: a stale sourceHash must never silently retime cues.
        const calibration = options.calibration?.version === 1 && options.calibration.sourceHash === director.sourceHash ? options.calibration : null;
        const calibrationWarnings: string[] = [];
        if (options.calibration && !calibration) calibrationWarnings.push("字幕校准基于旧 sourceHash，已忽略；请重新校准当前制作稿");
        const calibratedIndex = (calibration?.tracks || []).map(track => ({ timelineId: track.timelineId, path: `subtitles/calibrated/${safeName(track.timelineId)}.srt`, cueCount: track.cues.length, cues: track.cues }));
        // 剪映草稿只有一条时间线：多条 timeline 时只投影第一条，其余在 warning 里列明，不做静默合并。
        // 已校准时用实际音频时间线，未校准时回退到创作稿帧窗。
        const primarySubtitleTrack = calibration?.tracks[0] || subtitleTracks[0];
        const jianyingCaptions: JianyingCaption[] = (primarySubtitleTrack?.cues || []).map(cue => ({
            text: cue.text,
            startUs: Math.round(cue.startSeconds * 1_000_000),
            durationUs: Math.round((cue.endSeconds - cue.startSeconds) * 1_000_000),
        }));
        if (subtitleTracks.length > 1) jianyingWarnings.push(`制作稿有 ${subtitleTracks.length} 条时间线，剪映草稿只投影 ${primarySubtitleTrack?.timelineId || "第一条"}，其余 ${subtitleTracks.length - 1} 条字幕轨未导入`);
        let jianyingDraft: ReturnType<typeof buildJianyingDraft> | null = null;
        try {
            if (jianyingClips.length) jianyingDraft = buildJianyingDraft({
                name: safeName(`${options.title || options.owner.id}-剪映草稿`),
                width: options.jianying?.width ?? 1920,
                height: options.jianying?.height ?? 1080,
                fps: jianyingFps,
                clips: jianyingClips,
                captions: jianyingCaptions,
                ...(options.jianying?.root ? { root: options.jianying.root } : {}),
            });
        } catch (error) {
            jianyingWarnings.push(`剪映草稿未生成：${error instanceof Error ? error.message : String(error)}`);
        }
        if (!jianyingClips.length) jianyingWarnings.push("剪映草稿未生成：制作稿没有可导出的段落");
        const completePrompts = artifacts.length > 0 && artifacts.every(item => item.status === "ready" && item.sourceHash === director.sourceHash && item.receipt.sourceHash === director.sourceHash && item.receipt.promptHash === item.sha256);
        const readyTargets = options.readiness.targets.filter(item => item.status === "ready" || item.status === "complete").length;
        const dependenciesCleared = !options.readiness.unresolved.length && options.readiness.targets.every(item => item.status === "ready" || item.status === "complete");
        const samePublishedSource = options.production.published?.director?.sourceHash === director.sourceHash;
        const manifest: RecordValue = {
            contract: "acheng-delivery-v1",
            owner: options.owner,
            title: options.title,
            sourceRevision,
            publishedVersion,
            stage: completePrompts && dependenciesCleared && samePublishedSource ? "prompt-ready" : "partial",
            fixedEngine: director.engine,
            sourceHash: director.sourceHash,
            unresolved: options.readiness.unresolved,
            targets: options.readiness.targets,
            artifacts: artifactFiles.map(item => item.manifest),
            generatedPrompts: generatedPrompts.map(item => item.status === "recorded"
                ? { targetId: item.targetId, status: item.status, logId: item.logId, startedAt: item.startedAt, outputStorageKey: item.outputStorageKey, promptFile: `prompts/generated/h3/${safeName(item.targetId)}.txt` }
                : { targetId: item.targetId, status: item.status }),
            media: mediaEntries,
            outputsIncluded: options.includeGeneratedMedia === true,
            subtitles: {
                contract: "srt-1", fps: productionSourceFps(director.source), tracks: subtitleIndex,
                ...(calibration ? { calibrated: { contract: "srt-calibrated-1", sourceHash: calibration.sourceHash, createdAt: calibration.createdAt, model: calibration.model, language: calibration.language, tracks: calibratedIndex, report: calibration.report } } : {}),
                ...(calibrationWarnings.length ? { warnings: calibrationWarnings } : {}),
            },
            jianying: jianyingDraft ? {
                contract: "jianying-draft-1",
                folder: `jianying/${jianyingDraft.name}`,
                clips: jianyingDraft.stats.clips,
                captions: jianyingDraft.stats.captions,
                durationUs: jianyingDraft.durationUs,
                warnings: [...jianyingWarnings, ...jianyingDraft.warnings],
            } : { status: "skipped", warnings: jianyingWarnings },
            readinessSummary: { ready: readyTargets, total: options.readiness.targets.length, nextAction: options.readiness.nextAction },
        };
        addJson("production.json", { owner: options.owner, revision: sourceRevision, publishedVersion, stage: options.production.published ? "draft-with-published-baseline" : "draft", data: snapshot, publishedSnapshot: options.production.published });
        for (const item of artifactFiles) {
            addBytes(item.promptPath, encoder.encode(item.artifact.prompt));
            addJson(item.uploadPath, { targetId: item.artifact.targetId, kind: item.artifact.kind, references: item.refs, receipt: item.artifact.receipt });
        }
        for (const item of generatedPromptFiles) addBytes(item.path, encoder.encode(item.prompt));
        for (const track of subtitleTracks) addBytes(`subtitles/${safeName(track.timelineId)}.srt`, encoder.encode(track.srt));
        if (subtitleTracks.length) addJson("subtitles/index.json", { fps: productionSourceFps(director.source), tracks: subtitleIndex });
        for (const track of calibration?.tracks || []) addBytes(`subtitles/calibrated/${safeName(track.timelineId)}.srt`, encoder.encode(track.srt));
        if (calibratedIndex.length && calibration) addJson("subtitles/calibrated/index.json", { contract: "srt-calibrated-1", sourceHash: calibration.sourceHash, model: calibration.model, language: calibration.language, createdAt: calibration.createdAt, fps: productionSourceFps(director.source), tracks: calibratedIndex, report: calibration.report, warnings: calibrationWarnings });
        if (jianyingDraft) for (const [fileName, content] of Object.entries(jianyingDraft.files)) {
            addBytes(`jianying/${jianyingDraft.name}/${fileName}`, encoder.encode(content));
        }
        for (const binary of allBinaries) {
            const response = await fetch(backendMediaUrl(binary.key));
            if (!response.ok) {
                mediaEntries.push({ ...binary, requested: true, included: false, missingReason: `HTTP ${response.status}` });
                continue;
            }
            const file = new ZipPassThrough(binary.path);
            archive.add(file);
            if (response.body) {
                const reader = response.body.getReader();
                for (;;) {
                    const next = await reader.read();
                    if (next.done) break;
                    if (next.value?.length) file.push(next.value, false);
                }
                file.push(new Uint8Array(), true);
            } else file.push(new Uint8Array(await response.arrayBuffer()), true);
            mediaEntries.push({ ...binary, requested: true, included: true });
        }
        manifest.media = mediaEntries;
        const missingRequestedMedia = mediaEntries.some(item => item.requested && !item.included);
        if (missingRequestedMedia) manifest.stage = "partial";
        addBytes("README.txt", encoder.encode(`${options.title}\nAcheng revision ${sourceRevision} · published v${publishedVersion || "draft"}\nPackage status: ${String(manifest.stage)}\n${options.readiness.nextAction}\n${subtitleTracks.length ? `Subtitles: ${subtitleTracks.reduce((total, track) => total + track.cues.length, 0)} cues · ${subtitleTracks.map(track => `subtitles/${safeName(track.timelineId)}.srt`).join(", ")}` : "Subtitles: no recorded dialogue."}\n${calibration ? `Calibrated subtitles (real audio): ${calibration.report.calibrated}/${calibration.report.totalCues} cues · ${calibratedIndex.map(track => track.path).join(", ")} · Jianying captions use this timeline` : "Calibrated subtitles: not applied (authored Shot windows in use)."}\n${calibrationWarnings.length ? `Calibration warnings: ${calibrationWarnings.join("; ")}\n` : ""}${jianyingDraft ? `Jianying draft: jianying/${jianyingDraft.name} · ${jianyingDraft.stats.clips} clips / ${jianyingDraft.stats.captions} captions · run apply-draft-root.mjs before import` : "Jianying draft: skipped (see manifest.json)"}\n${missingRequestedMedia ? "Some requested media files were unavailable; see manifest.json." : ""}\n`));
        addJson("manifest.json", manifest);
        archive.end();
        return await archiveDone;
    } catch (error) {
        archive.terminate();
        const failure = error instanceof Error ? error : new Error(String(error));
        throw failure;
    }
}
