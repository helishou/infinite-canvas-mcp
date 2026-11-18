import { App, Button, Tag, Tooltip } from "antd";
import { Download, Loader2, PackageOpen, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { productionSceneEntries } from "@basketikun/canvas-agent/drama/production-contract";

import { buildPlan, toWriteOps, type DraftShot } from "@/lib/drama/adapt-storyboard";
import { buildDirectorPack, composeSegmentPrompt, packSegmentsToShotRows, packSummary, pickSegmentPrompt, regroupPlanByPackSegments, segmentFromShotGroup, textOf } from "@/lib/director-pack";
import { buildPackGroupMedia, collectPackClips } from "@/lib/director-pack-canvas";
import { collectPackRefs, importPackRefs } from "@/lib/director-pack-assets";
import { promoteImportedPack } from "@/lib/director-pack-promote";
import { packToZip, zipToPack } from "@/lib/director-pack-io";
import { editEpisodeProduction, fetchEpisodeProduction, type DramaEpisode } from "@/services/backend-api";

type Production = {
    revision: number;
    draft?: { director?: { source?: Record<string, unknown>; artifacts?: Array<Record<string, unknown>> } };
    source?: Record<string, unknown>;
};

const asArray = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value as Array<Record<string, unknown>> : []);
const str = (value: unknown) => String(value ?? "");

/** 制作稿里的 Clip 分组（编译层是 snake_case，接口层是 camelCase，两边都认）。 */
function readGroups(source: Record<string, unknown>) {
    return asArray(source.segments).map((segment) => ({
        id: str(segment.id || segment.segmentId || segment.segment_id),
        shotIds: (Array.isArray(segment.shotIds) ? segment.shotIds : Array.isArray(segment.shot_ids) ? segment.shot_ids : []).map(String),
        prompt: str(segment.prompt),
    }));
}

function readShots(source: Record<string, unknown>) {
    const fps = Math.max(1, Number(source.fps_num || 24) / Math.max(1, Number(source.fps_den || 1)));
    return { fps, shots: asArray(source.shots) };
}

/** 画布制作稿 → 导演包（段=Clip，提示词=画布 H3 段的视频提示词，缺就按累计时间拼镜头）。 */
export function buildPackFromProduction(input: { title: string; production: Production; aspect?: string; clipPrompts?: Map<string, string> }) {
    const director = input.production.draft?.director;
    const source = (director?.source || input.production.source || {}) as Record<string, unknown>;
    // 编译产物是画布提示词的备份：画布被清空或没打开时，包里仍然有真实的视频提示词。
    const artifactPrompts = new Map<string, string>();
    for (const artifact of asArray(director?.artifacts)) {
        if (artifact.kind !== "h3" || artifact.status !== "ready") continue;
        const targetId = str(artifact.targetId), prompt = str(artifact.prompt).trim();
        if (targetId && prompt && !artifactPrompts.has(targetId)) artifactPrompts.set(targetId, prompt);
    }
    const groups = readGroups(source);
    const { fps, shots } = readShots(source);
    const byId = new Map(shots.map((shot) => [str(shot.id), shot]));
    const shotSeconds = (shot: Record<string, unknown>) => {
        const frames = Number(shot.duration_frames ?? shot.durationFrames ?? 0);
        if (frames > 0) return frames / fps;
        return Math.max(0.5, Number(shot.duration ?? 2));
    };
    const [width, height] = /^(\d+):(\d+)$/.test(String(input.aspect || ""))
        ? String(input.aspect).split(":").map(Number)
        : [16, 9];
    const longest = Math.max(width, height);
    let cursor = 0;
    const segments = groups.map((group, index) => {
        const members = group.shotIds.map((id) => byId.get(id)).filter(Boolean) as Array<Record<string, unknown>>;
        const seconds = members.reduce((sum, shot) => sum + shotSeconds(shot), 0) || Math.max(0.5, Number(source.clip_seconds || 6));
        const prompt = pickSegmentPrompt([
            // 画布 H3 段上的提示词就是实际提交给模型的视频提示词，优先用它。
            input.clipPrompts?.get(group.id),
            artifactPrompts.get(group.id),
            group.prompt,
        ], composeSegmentPrompt(members.map((shot) => ({
            // 只取画面正文：草稿里的 camera 是编译器自动补的「固定机位，按画面描述构图」，
            // 拼进去会让导出的提示词和原包对不上（实测 25/25 段全被污染）。
            visual: textOf(shot.visual),
            camera: "",
            durationSec: shotSeconds(shot),
        })), fps));
        const segment = segmentFromShotGroup({ index, id: group.id || `sh_${index + 1}`, prompt, durationSec: seconds, fps, start: cursor, continuityFromPrev: index > 0 });
        cursor += seconds;
        return segment;
    });
    return buildDirectorPack({
        title: input.title,
        output: {
            width: Math.round(1280 * width / longest) || 1280,
            height: Math.round(1280 * height / longest) || 720,
            fps,
            continuityEnabled: Boolean(source.continuity_enabled ?? true),
            continuityOverlapFrames: Math.round(Number(source.continuity_overlap_frames || 22)),
        },
        segments,
    });
}

/**
 * 导演包 → 制作稿 → 上画布。
 * 顺序见 `promoteImportedPack`：先建 H3 场景节点，再写分镜，否则 bind_director_segment 找不到节点。
 * 编译只走本地编译器，**不调模型**，不会产生生成费用；生成由用户在 H3 节点上点。
 */
export async function importDirectorPackIntoEpisode(episode: DramaEpisode, pack: ReturnType<typeof zipToPack>, onStage?: (stage: string) => void) {
    const rows = packSegmentsToShotRows(pack.timeline.segments, pack.timeline.output.fps);
    if (!rows.length) throw new Error("这个导演包里没有可用段落（prompt 全空）");
    const promoted = await promoteImportedPack({ episode, pack, onStage: (stage) => onStage?.(stage) });
    return { pack, written: promoted.shots, clips: promoted.clips, summary: packSummary(pack) };
}

export function DirectorPackBar({ episode, production, onImported }: {
    episode?: DramaEpisode;
    production?: Production;
    onImported?: () => void;
}) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [exporting, setExporting] = useState(false);
    const [importing, setImporting] = useState(false);
    const [lastPack, setLastPack] = useState<{ name: string; segments: number; seconds: number } | null>(null);
    const [stage, setStage] = useState("");
    const fileRef = useRef<HTMLInputElement | null>(null);

    const groups = production ? readGroups((production.draft?.director?.source || production.source || {}) as Record<string, unknown>) : [];

    const doExport = async () => {
        if (!production) return;
        setExporting(true);
        try {
            // 画布 H3 节点是视频提示词与参考图的权威来源；读不到就退回分镜拼稿，并明确告知。
            const canvasClips = episode?.canvasId ? await collectPackClips(episode.canvasId).catch(() => null) : null;
            const clipPrompts = new Map<string, string>();
            for (const [targetId, clip] of canvasClips || []) if (clip.prompt) clipPrompts.set(targetId, clip.prompt);
            const pack = buildPackFromProduction({ title: episode ? `第 ${episode.episodeNumber} 集` : "导演包", production, clipPrompts });
            let missingRefs = 0;
            let refCount = 0;
            for (const group of pack.groups) {
                const clip = canvasClips?.get(group.segment.id);
                if (!clip?.images.length) continue;
                const media = await buildPackGroupMedia({ groupIndex: group.index, images: clip.images });
                group.images = media.images;
                group.segment.refs = media.refs;
                missingRefs += media.missing;
                refCount += media.images.length;
            }
            // 老包导入时落在资产库的参考图（那批数据没有画布 referenceBindings）；画布已给齐就不必再拉资产库。
            const legacy = episode && pack.groups.some((group) => !group.images.length)
                ? await collectPackRefs({ episodeId: episode.id, dramaId: episode.dramaId }).catch(() => null)
                : null;
            if (legacy) {
                for (const group of pack.groups) {
                    if (group.images.length) continue;
                    const hit = legacy.get(group.index);
                    if (!hit) continue;
                    group.images = hit.images;
                    group.segment.refs = hit.refs;
                    refCount += hit.images.length;
                }
            }
            // groups 与 timeline.segments 共用同一批对象，段级 refs 已同步；这里只把段级改动收口。
            for (const group of pack.groups) {
                const self = pack.timeline.segments.find((segment) => segment.id === group.segment.id);
                if (self) self.refs = group.segment.refs;
            }
            const bytes = packToZip(pack);
            const blob = new Blob([bytes as unknown as BlobPart], { type: "application/zip" });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `${String(episode ? `E${String(episode.episodeNumber).padStart(2, "0")}` : "pack")}.mmxpack.zip`;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 1500);
            message.success(t("directorPack.exported", { segments: pack.timeline.segments.length, refs: refCount }));
            if (!clipPrompts.size) message.warning(t("directorPack.exportNoCanvas"));
            if (missingRefs) message.warning(t("directorPack.exportMissingRefs", { count: missingRefs }));
        } catch (error) {
            message.error(String((error as Error)?.message || error));
        } finally {
            setExporting(false);
        }
    };

    const doImport = async (file: File) => {
        if (!episode) return;
        setImporting(true);
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const pack = zipToPack(bytes);
            // 参考图先传：上传只依赖媒体库，不依赖画布；放到编译之后传会在后端忙时成片失败（实测 26 张全丢）。
            setStage(t("directorPack.stage.refs"));
            const refs = await importPackRefs({ episodeId: episode.id, dramaId: episode.dramaId, packName: file.name.replace(/\.mmxpack\.zip$/i, "").replace(/\.zip$/i, ""), groups: pack.groups });
            setStage(t("directorPack.stage.init"));
            const result = await importDirectorPackIntoEpisode(episode, pack, next => setStage(t(`directorPack.stage.${next}`)));
            setStage("");
            setLastPack({ name: file.name, segments: result.written, seconds: result.summary.totalSeconds });
            message.success(t("directorPack.imported", { segments: result.written, clips: result.clips, refs: refs.uploaded }));
            if (refs.failed) message.warning(t("directorPack.refsFailed", { failed: refs.failed }));
            onImported?.();
        } catch (error) {
            message.error(String((error as Error)?.message || error));
        } finally {
            setStage("");
            setImporting(false);
            if (fileRef.current) fileRef.current.value = "";
        }
    };

    return (
        <div data-director-pack-bar className="mb-5 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border bg-card/60 px-3 py-2">
            <span className="text-xs font-medium text-foreground">{t("directorPack.title")}</span>
            <Tag className="!mr-0 !text-[11px]">{t("directorPack.format")}</Tag>
            <span className="text-xs text-muted-foreground">{t("directorPack.segments", { count: groups.length })}</span>
            <div className="ms-auto flex flex-wrap items-center gap-2">
                {stage && <span data-director-pack-stage className="text-xs text-primary">{stage}</span>}
                {lastPack && !stage && <span data-director-pack-last className="text-xs text-muted-foreground">{t("directorPack.lastImport", { name: lastPack.name, segments: lastPack.segments })}</span>}
                <Tooltip title={t("directorPack.importHint")}>
                    <Button size="small" icon={importing ? <Loader2 className="size-3 animate-spin" /> : <Upload className="size-3" />} loading={importing} disabled={!episode || importing} onClick={() => fileRef.current?.click()}>
                        {t("directorPack.import")}
                    </Button>
                </Tooltip>
                <Button size="small" type="primary" icon={exporting ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />} loading={exporting} disabled={!production || !groups.length || exporting} onClick={() => void doExport()}>
                    {t("directorPack.export")}
                </Button>
                <input ref={fileRef} type="file" accept=".zip,.mmxpack" className="hidden" data-director-pack-file onChange={(event) => { const file = event.target.files?.[0]; if (file) void doImport(file); }} />
            </div>
        </div>
    );
}

export const DirectorPackIcon = PackageOpen;
