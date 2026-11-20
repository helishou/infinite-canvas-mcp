import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Modal, Tag } from "antd";
import { ArrowRight, GitCompareArrows, LoaderCircle, RefreshCw, VideoOff } from "lucide-react";
import {
    BackendApiError,
    backendMediaUrl,
    fetchClipVideosAtVersion,
    fetchClipVideosCurrent,
    fetchVersionCompare,
    fetchVersionCompareVersions,
    type ClipVideoChange,
    type ClipVideoTruth,
    type CompareCountDimension,
    type CompareStringDimension,
    type VersionCompareDiff,
    type VersionCompareVersion,
} from "@/services/backend-api";
import { buildClipVideoRows, formatClipDuration } from "./studio-version-clip-videos";

/**
 * 制作稿版本对比弹窗（真数据）：版本列表与结构化 diff 全部来自 Backend 的
 * version-compare API（后端从 episode_production_versions.snapshot_json 真派生），
 * 组件只负责选择与渲染，不编造任何计数、ID、哈希或 storageKey。
 */
export function StudioVersionCompare({
    open,
    onClose,
    episodeId,
    episodeTitle,
    dramaId,
}: {
    open: boolean;
    onClose: () => void;
    episodeId: string;
    episodeTitle?: string;
    dramaId?: string;
}) {
    const [versions, setVersions] = useState<VersionCompareVersion[]>([]);
    const [listLoading, setListLoading] = useState(false);
    const [listError, setListError] = useState("");
    const [fromVersion, setFromVersion] = useState<number | "">("");
    const [toVersion, setToVersion] = useState<number | "">("");
    const [comparison, setComparison] = useState<VersionCompareDiff | null>(null);
    const [comparing, setComparing] = useState(false);
    const [compareError, setCompareError] = useState("");
    const [reloadKey, setReloadKey] = useState(0);
    const [clipVideosFrom, setClipVideosFrom] = useState<ClipVideoTruth[]>([]);
    const [clipVideosTo, setClipVideosTo] = useState<ClipVideoTruth[]>([]);
    const [currentClipVideos, setCurrentClipVideos] = useState<ClipVideoTruth[]>([]);

    useEffect(() => {
        if (!open || !episodeId) return;
        let disposed = false;
        setListLoading(true);
        setListError("");
        setComparison(null);
        setCompareError("");
        void fetchVersionCompareVersions(episodeId)
            .then((res) => {
                if (disposed) return;
                const list = Array.isArray(res?.versions) ? res.versions : [];
                setVersions(list);
                // 列表倒序：默认「上一版 → 最新版」，只有一个版本时两端都指向它。
                setFromVersion(list.length > 1 ? list[1].version : (list[0]?.version ?? ""));
                setToVersion(list[0]?.version ?? "");
                if (list.length === 0) setListError("该集尚无已发布的制作稿版本，无法对比。");
            })
            .catch((error: unknown) => {
                if (disposed) return;
                setVersions([]);
                setListError(errorMessage(error));
            })
            .finally(() => { if (!disposed) setListLoading(false); });
        return () => { disposed = true; };
    }, [open, episodeId, reloadKey]);

    // 当前画布逐clip成片真值：版本快照不含逐clip成片地址，用它做「当前 vs 版本」的诚实对照。
    useEffect(() => {
        if (!open || !episodeId) return;
        let disposed = false;
        void fetchClipVideosCurrent(episodeId)
            .then((res) => { if (!disposed) setCurrentClipVideos(Array.isArray(res?.clipVideos) ? res.clipVideos : []); })
            .catch(() => { if (!disposed) setCurrentClipVideos([]); });
        return () => { disposed = true; };
    }, [open, episodeId, reloadKey]);

    const versionLabel = (item: VersionCompareVersion) => {
        const s = item.summary;
        const time = typeof item.createdAt === "string" ? item.createdAt.replace("T", " ").slice(0, 19) : item.createdAt;
        // h3ClipCount 是快照里计划的 clip 产物数；clipVideoCount 是 clip_video_versions 真记录的成片段数，两者不是一回事。
        const recordedClips = s.clipVideoCount ?? item.clipVideoCount ?? 0;
        return `v${item.version} · ${item.stage} · ${time} · ${s.shotCount}镜/${s.segmentCount}段/${s.h3ClipCount}clip · ${recordedClips}段成片${s.finalStorageKey ? " · 有成片" : ""}`;
    };
    const selected = (value: number | "") => versions.find((item) => item.version === value);
    const fromItem = useMemo(() => selected(fromVersion), [versions, fromVersion]);
    const toItem = useMemo(() => selected(toVersion), [versions, toVersion]);

    const runCompare = async () => {
        if (fromVersion === "" || toVersion === "") {
            setCompareError("请先选择两个版本。");
            return;
        }
        setComparing(true);
        setComparison(null);
        setCompareError("");
        try {
            const [res, fromRes, toRes] = await Promise.all([
                fetchVersionCompare(episodeId, Number(fromVersion), Number(toVersion)),
                fetchClipVideosAtVersion(episodeId, Number(fromVersion)),
                fetchClipVideosAtVersion(episodeId, Number(toVersion)),
            ]);
            setComparison(res.comparison);
            setClipVideosFrom(fromRes.clipVideos ?? []);
            setClipVideosTo(toRes.clipVideos ?? []);
        } catch (error) {
            setCompareError(errorMessage(error));
        } finally {
            setComparing(false);
        }
    };

    const countDims: CompareCountDimension[] = comparison
        ? [comparison.dimensions.scenes, comparison.dimensions.shots, comparison.dimensions.segments,
            comparison.dimensions.keyframes, comparison.dimensions.h3Clips, comparison.dimensions.prompts]
        : [];
    const stringDims: CompareStringDimension[] = comparison
        ? [comparison.dimensions.finalStorageKey, comparison.dimensions.sourceHash, comparison.dimensions.promptsHash]
        : [];

    return (
        <Modal
            title={<span className="flex items-center gap-2"><GitCompareArrows className="size-4" />版本记录与对比{episodeTitle ? ` · ${episodeTitle}` : ""}</span>}
            open={open}
            onCancel={onClose}
            width={960}
            footer={<Button onClick={onClose}>关闭</Button>}
            destroyOnHidden
        >
            <div data-testid="version-compare-modal" data-drama-id={dramaId || ""} data-episode-id={episodeId} className="space-y-3">
                <div className="flex flex-wrap items-end gap-2">
                    <label className="flex flex-col gap-1 text-xs">
                        <span className="text-muted-foreground">从版本（旧）</span>
                        <select
                            data-testid="version-compare-from"
                            aria-label="从版本"
                            value={fromVersion}
                            onChange={(e) => setFromVersion(e.target.value === "" ? "" : Number(e.target.value))}
                            className="h-9 min-w-[300px] rounded-md border border-border bg-background px-2 text-xs"
                        >
                            <option value="">选择版本…</option>
                            {versions.map((item) => <option key={item.version} value={item.version}>{versionLabel(item)}</option>)}
                        </select>
                    </label>
                    <ArrowRight className="mb-2 size-4 text-muted-foreground" />
                    <label className="flex flex-col gap-1 text-xs">
                        <span className="text-muted-foreground">到版本（新）</span>
                        <select
                            data-testid="version-compare-to"
                            aria-label="到版本"
                            value={toVersion}
                            onChange={(e) => setToVersion(e.target.value === "" ? "" : Number(e.target.value))}
                            className="h-9 min-w-[300px] rounded-md border border-border bg-background px-2 text-xs"
                        >
                            <option value="">选择版本…</option>
                            {versions.map((item) => <option key={item.version} value={item.version}>{versionLabel(item)}</option>)}
                        </select>
                    </label>
                    <Button
                        type="primary"
                        data-testid="version-compare-run"
                        icon={comparing ? <LoaderCircle className="size-3.5 animate-spin" /> : <GitCompareArrows className="size-3.5" />}
                        loading={comparing}
                        disabled={listLoading || versions.length === 0}
                        onClick={() => void runCompare()}
                    >
                        对比
                    </Button>
                    <Button
                        type="text"
                        size="small"
                        icon={<RefreshCw className="size-3.5" />}
                        onClick={() => setReloadKey((n) => n + 1)}
                        aria-label="刷新版本列表"
                    >
                        刷新
                    </Button>
                </div>

                {listLoading ? <div className="py-6 text-center text-xs text-muted-foreground">读取版本列表…</div> : null}
                {listError ? <Alert type="error" showIcon message="版本列表读取失败" description={listError} /> : null}
                {compareError ? <Alert type="error" showIcon message="对比失败" description={compareError} /> : null}

                {fromItem && toItem ? (
                    <div className="grid grid-cols-2 gap-2" data-testid="version-compare-split">
                        <VersionSide title="从（旧）" item={fromItem} />
                        <VersionSide title="到（新）" item={toItem} />
                    </div>
                ) : null}

                {fromItem && toItem ? (
                    <div className="space-y-1" data-testid="version-compare-film-split">
                        <div className="flex flex-wrap items-center justify-between gap-1">
                            <span className="text-sm font-semibold">成片分屏对比</span>
                            <span className="text-[11px] text-muted-foreground">
                                成片地址只取自版本快照真实记录的 finalResource.storageKey；未记录的版本如实标注，不放占位画面
                            </span>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            <FinalCutSide title="从（旧）" item={fromItem} side="from" />
                            <FinalCutSide title="到（新）" item={toItem} side="to" />
                        </div>
                    </div>
                ) : null}

                {comparison ? (
                    <div data-testid="version-compare-result" className="space-y-3">
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold">对比结果</span>
                            {comparison.changed
                                ? <Tag color="orange">有差异</Tag>
                                : <Tag color="green" data-testid="version-compare-no-diff">无差异</Tag>}
                            <span className="text-[11px] text-muted-foreground">
                                v{comparison.from.version} → v{comparison.to.version} · 数据全部来自制作稿快照
                            </span>
                        </div>

                        {!comparison.changed ? (
                            <Alert type="success" showIcon message="无差异" description="两个版本的制作稿快照在所有对比维度上完全一致。" />
                        ) : null}

                        <div className="grid grid-cols-2 gap-2 md:grid-cols-3" data-testid="version-compare-dimensions">
                            {countDims.map((d) => (
                                <div
                                    key={d.key}
                                    data-testid={`version-compare-dim-${d.key}`}
                                    className={`rounded-md border p-2 ${d.changed ? "border-orange-300 bg-orange-50/50 dark:bg-orange-950/20" : "border-border"}`}
                                >
                                    <div className="flex items-center justify-between">
                                        <span className="text-xs font-medium">{d.label}</span>
                                        <span className={`text-[10px] ${d.changed ? "text-orange-600" : "text-muted-foreground"}`}>
                                            {d.changed ? "变化" : "未变"}
                                        </span>
                                    </div>
                                    <div className="mt-1 flex items-center gap-1 text-xs tabular-nums">
                                        <span>{d.from}</span><ArrowRight className="size-3 text-muted-foreground" /><span className="font-semibold">{d.to}</span>
                                        <span className={`ml-auto ${d.delta > 0 ? "text-green-600" : d.delta < 0 ? "text-red-600" : "text-muted-foreground"}`}>
                                            {d.delta > 0 ? `+${d.delta}` : d.delta}
                                        </span>
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div className="space-y-1 rounded-md border border-border p-2" data-testid="version-compare-strings">
                            {stringDims.map((d) => (
                                <div key={d.key} data-testid={`version-compare-str-${d.key}`} className="text-[11px]">
                                    <span className="font-medium">{d.label}：</span>
                                    {d.changed ? (
                                        <span className="text-orange-600">
                                            已变化 · {shortHash(d.from)} → {shortHash(d.to)}
                                        </span>
                                    ) : <span className="text-muted-foreground">未变 · {shortHash(d.to)}</span>}
                                    {d.key === "finalStorageKey" && d.changed
                                        ? <div className="mt-0.5 break-all text-[10px] text-muted-foreground">旧：{d.from ?? "（无）"}<br />新：{d.to ?? "（无）"}</div>
                                        : null}
                                </div>
                            ))}
                        </div>

                        <EntitySection title="镜头" data={comparison.shots} testId="version-compare-shots" />
                        <EntitySection title="段" data={comparison.segments} testId="version-compare-segments" />
                        <ClipVideoSection
                            fromVersion={Number(fromVersion)}
                            toVersion={Number(toVersion)}
                            fromList={clipVideosFrom}
                            toList={clipVideosTo}
                            diff={comparison.clipVideos}
                            currentList={currentClipVideos}
                        />
                        <div className="rounded-md border border-border p-2 text-[11px]" data-testid="version-compare-prompts">
                            <div className="mb-1 font-semibold">提示词</div>
                            <div>新增 {comparison.prompts.added.length} · 移除 {comparison.prompts.removed.length} · 修改 {comparison.prompts.changed.length}</div>
                            {comparison.prompts.changed.length > 0 ? (
                                <ul className="mt-1 space-y-0.5 text-muted-foreground">
                                    {comparison.prompts.changed.slice(0, 12).map((c) => (
                                        <li key={c.id} className="break-all">{c.id}：{shortHash(c.fromHash)} → {shortHash(c.toHash)}</li>
                                    ))}
                                </ul>
                            ) : null}
                        </div>
                    </div>
                ) : null}
            </div>
        </Modal>
    );
}

/**
 * 某版本的成片地址只认快照里真实记录的 director.workflow.finalResource.storageKey。
 * 不猜、不按时间回填、不伪造占位地址——查证结果显示 128 份快照仅 1 份有该字段。
 */
export function finalCutStorageKey(item: VersionCompareVersion | undefined): string | null {
    const key = item?.summary?.finalStorageKey;
    return typeof key === "string" && key.trim() ? key : null;
}

/** 逐clip成片变化：缩略图/真实时长/是否更换，全部来自 clip_video_versions 真值表。 */
function ClipVideoThumb({ clip, side }: { clip: ClipVideoTruth; side: "from" | "to" | "current" }) {
    return (
        <div className="flex items-center gap-1" data-testid={`version-compare-clip-thumb-${side}`}>
            <video
                muted
                playsInline
                preload="metadata"
                className="size-12 shrink-0 rounded bg-black object-cover"
                src={`${backendMediaUrl(clip.storageKey)}#t=0.1`}
                aria-label={`${side} ${clip.title || clip.clipId} 成片缩略图`}
            />
            <div className="min-w-0 text-[10px]">
                <div className="tabular-nums text-foreground">{formatClipDuration(clip.durationMs)}</div>
                <div className="break-all text-muted-foreground" title={clip.storageKey}>{shortHash(clip.storageKey)}</div>
            </div>
        </div>
    );
}

function ClipVideoSection({ fromVersion, toVersion, fromList, toList, diff, currentList }: {
    fromVersion: number; toVersion: number;
    fromList: ClipVideoTruth[]; toList: ClipVideoTruth[];
    diff: NonNullable<VersionCompareDiff["clipVideos"]>;
    currentList: ClipVideoTruth[];
}) {
    const rows = buildClipVideoRows(fromList, toList, diff, currentList);
    return (
        <div className="rounded-md border border-border p-2" data-testid="version-compare-clip-videos">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-1">
                <span className="text-sm font-semibold">逐clip成片变化</span>
                <span className="text-[10px] text-muted-foreground">
                    成片地址只取自发布时记录的 clip_video_versions（画布段 resultStorageKey + media_files 真实时长）；快照本身没有逐clip成片地址
                </span>
            </div>
            {fromList.length === 0 && toList.length === 0 ? (
                <div data-testid="version-compare-clip-videos-empty" className="rounded border border-dashed border-border bg-muted/30 p-3 text-[11px] text-muted-foreground">
                    这两个版本都没有逐clip成片记录（旧快照只记录整集成片地址）。发布新版本时会自动把当时画布各段成片按版本打包入库；在此之前不编造成片地址。
                    {currentList.length > 0 ? ` 当前画布有 ${currentList.length} 段成片，可在制作台查看，或对比含成片记录的新版本。` : ""}
                </div>
            ) : (
                <>
                    <div className="mb-1 text-[10px] text-muted-foreground">
                        v{fromVersion} 记录 {diff.fromCount} 段 · v{toVersion} 记录 {diff.toCount} 段 · 更换 {diff.changed.filter((item) => item.storageKeyChanged).length} 段 · 当前画布 {currentList.length} 段
                    </div>
                    <div className="max-h-[300px] space-y-1 overflow-y-auto">
                        {rows.map((row) => {
                            const { clipId, from, to, current, status, title } = row;
                            return (
                                <div key={clipId} data-testid={`version-compare-clip-row-${clipId}`} className="grid grid-cols-[1fr_auto] items-center gap-2 rounded border border-border px-2 py-1">
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-1">
                                            <span className="truncate text-[11px] font-medium">{title}</span>
                                            <Tag color={row.color}>{status}</Tag>
                                        </div>
                                        <div className="truncate text-[10px] text-muted-foreground">{clipId}</div>
                                    </div>
                                    <div className="grid grid-cols-3 gap-3">
                                        <div>
                                            <div className="text-[9px] text-muted-foreground">v{fromVersion}</div>
                                            {from ? <ClipVideoThumb clip={from} side="from" /> : <span className="text-[10px] text-muted-foreground">该版本无成片记录</span>}
                                        </div>
                                        <div>
                                            <div className="text-[9px] text-muted-foreground">v{toVersion}</div>
                                            {to ? <ClipVideoThumb clip={to} side="to" /> : <span className="text-[10px] text-muted-foreground">该版本无成片记录</span>}
                                        </div>
                                        <div>
                                            <div className="text-[9px] text-muted-foreground">当前画布</div>
                                            {current ? <ClipVideoThumb clip={current} side="current" /> : <span className="text-[10px] text-muted-foreground">当前无成片</span>}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </>
            )}
        </div>
    );
}

function FinalCutSide({ title, item, side }: { title: string; item: VersionCompareVersion; side: "from" | "to" }) {
    const storageKey = finalCutStorageKey(item);
    return (
        <div className="rounded-md border border-border p-2" data-testid={`version-compare-film-${side}`}>
            <div className="mb-1 flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground">{title} · v{item.version}</span>
                <Tag color={storageKey ? "green" : "default"}>{storageKey ? "有成片" : "无成片"}</Tag>
            </div>
            {storageKey ? (
                <>
                    <video
                        controls
                        playsInline
                        preload="metadata"
                        className="mt-1 aspect-video w-full rounded bg-black"
                        src={backendMediaUrl(storageKey)}
                        aria-label={`v${item.version} 成片`}
                        data-testid={`version-compare-film-video-${side}`}
                    />
                    <div className="mt-1 break-all text-[10px] text-muted-foreground" data-testid={`version-compare-film-key-${side}`}>
                        成片地址：{storageKey}
                    </div>
                </>
            ) : (
                <div
                    className="mt-1 flex aspect-video w-full flex-col items-center justify-center gap-1 rounded border border-dashed border-border bg-muted/30 px-2 text-center"
                    data-testid={`version-compare-film-empty-${side}`}
                >
                    <VideoOff className="size-6 text-muted-foreground" />
                    <div className="text-xs text-muted-foreground">该版本未记录成片地址</div>
                    <div className="text-[10px] text-muted-foreground">制作稿快照里没有 finalResource.storageKey，不显示占位画面</div>
                </div>
            )}
        </div>
    );
}

function VersionSide({ title, item }: { title: string; item: VersionCompareVersion }) {
    const s = item.summary;
    const time = typeof item.createdAt === "string" ? item.createdAt.replace("T", " ").slice(0, 19) : item.createdAt;
    const recordedClips = s.clipVideoCount ?? item.clipVideoCount ?? 0;
    return (
        <div className="rounded-md border border-border p-2">
            <div className="mb-1 flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground">{title}</span>
                <Tag>{item.stage}</Tag>
            </div>
            <div className="text-sm font-semibold">v{item.version} <span className="text-[10px] font-normal text-muted-foreground">{time}</span></div>
            <div className="mt-1 text-[11px] text-muted-foreground">
                {s.sceneCount}场 · {s.shotCount}镜 · {s.segmentCount}段 · {s.h3ClipCount}clip · {s.promptCount}提示词
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground" data-testid={`version-compare-clip-count-${title === "从（旧）" ? "from" : "to"}`}>
                {recordedClips}段成片（clip_video_versions 真记录）
            </div>
            <div className="mt-0.5 break-all text-[10px] text-muted-foreground" data-testid={`version-compare-side-storage-${title === "从（旧）" ? "from" : "to"}`}>
                成片 storageKey：{s.finalStorageKey ?? "（无）"}
            </div>
        </div>
    );
}

function EntitySection({ title, data, testId }: {
    title: string;
    data: { added: string[]; removed: string[]; changed: Array<{ id: string; fields: Array<{ field: string; from: string; to: string }> }> };
    testId: string;
}) {
    return (
        <div className="rounded-md border border-border p-2 text-[11px]" data-testid={testId}>
            <div className="mb-1 font-semibold">{title}：新增 {data.added.length} · 移除 {data.removed.length} · 修改 {data.changed.length}</div>
            {data.added.length > 0 ? <div className="text-green-600">新增：{data.added.slice(0, 8).join("、")}</div> : null}
            {data.removed.length > 0 ? <div className="text-red-600">移除：{data.removed.slice(0, 8).join("、")}</div> : null}
            {data.changed.length > 0 ? (
                <div className="mt-1 space-y-1">
                    {data.changed.slice(0, 10).map((entity) => (
                        <div key={entity.id} className="break-all">
                            <span className="font-medium">{entity.id}</span>
                            {entity.fields.map((field) => (
                                <div key={field.field} className="ml-2 text-muted-foreground">
                                    · {field.field}：{clipText(field.from)} → {clipText(field.to)}
                                </div>
                            ))}
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

const clipText = (value: string) => value.length > 120 ? `${value.slice(0, 120)}…` : value;
const shortHash = (value: string | null) => !value ? "（无）" : value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
const errorMessage = (error: unknown) => {
    if (error instanceof BackendApiError) {
        if (error.status === 404) return `版本不存在（404）：${error.message}`;
        return `${error.message}`;
    }
    return error instanceof Error ? error.message : String(error);
};
