/**
 * 画布 → 制作台的续接写回。
 *
 * 正式制作 Clip 的「尾帧参考 / Motion Context / 视频续写」由画布与制作台两侧共同拥有：
 * - 制作台侧：`set_director_boundary` 写源稿 boundaries，编译时投影回画布（既有链路）；
 * - 画布侧：H3 面板保存时同步调用同一接口（web/src/lib/canvas/production-editing.ts）。
 *
 * MCP（h3_update_clips / 脚本 / Agent）改的是画布段，若不写回源稿，两侧显示会长期不一致，
 * 下一次编译还可能把源稿里的旧值当权威再投影回来。这里补上画布侧写回的第三条通道：
 * 用画布顺序推算相邻正式 Clip，按 `set_director_boundary` 落源稿。
 */

export const CONTINUATION_FIELDS = ["tailFrameContinuation", "motionContextEnabled", "videoContinuation"] as const;

export type ContinuationPort = {
    get?: (path: string, signal?: AbortSignal) => Promise<unknown>;
    post?: (path: string, body?: unknown, signal?: AbortSignal) => Promise<unknown>;
};

export type ContinuationSyncReceipt = {
    /** 已写回源稿的边界。 */
    boundaries: Array<{ from: string; to: string; tailFrame: boolean; motionContext: boolean; videoContinuation: boolean }>;
    /** 未写回的段与原因（非正式 Clip、末尾无相邻段等）。 */
    skipped: Array<{ segmentId: string; reason: string }>;
    revision?: number;
    error?: string;
};

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? value as Record<string, unknown> : {});
const projectionOf = (segment: Record<string, unknown>) => record(segment.productionClipProjection);
const targetOf = (segment: Record<string, unknown>) => {
    const targetId = projectionOf(segment).targetId;
    return typeof targetId === "string" && targetId ? targetId : "";
};

/** 画布顺序里，该段之后最近的正式 Clip（未投影的本地 Clip 不构成边界）。 */
function nextFormalTarget(segments: Array<Record<string, unknown>>, index: number) {
    for (let cursor = index + 1; cursor < segments.length; cursor++) {
        const targetId = targetOf(segments[cursor]);
        if (targetId) return targetId;
    }
    return "";
}

function ownerBasePath(owner: Record<string, unknown>) {
    const kind = String(owner.kind || ""), id = String(owner.id || "");
    if (!id) return "";
    if (kind === "episode") return `/drama/episodes/${encodeURIComponent(id)}/production`;
    if (kind === "scene") return `/drama/scenes/${encodeURIComponent(id)}/production`;
    if (kind === "canvas") return `/canvas/projects/${encodeURIComponent(id)}/production`;
    return "";
}

/**
 * 把本次改动的画布段续接配置写回制作台源稿。
 * 失败不回滚已提交的画布写入（画布是本次操作的正本），只把原因放回执。
 */
export async function syncContinuationBoundaries(port: ContinuationPort, input: {
    projectId: string;
    segments: Array<Record<string, unknown>>;
    segmentIds: string[];
    operationId: string;
    signal?: AbortSignal;
}): Promise<ContinuationSyncReceipt> {
    const receipt: ContinuationSyncReceipt = { boundaries: [], skipped: [] };
    if (!port.get || !port.post) return receipt; // 老 Backend 未提供通用读写能力，静默跳过。
    const touched = [...new Set(input.segmentIds.map(String))];
    if (!touched.length) return receipt;

    const planned: ContinuationSyncReceipt["boundaries"] = [];
    for (const segmentId of touched) {
        const index = input.segments.findIndex((segment) => String(segment.id || "") === segmentId);
        const segment = index >= 0 ? input.segments[index] : undefined;
        const from = segment ? targetOf(segment) : "";
        if (!segment || !from) {
            receipt.skipped.push({ segmentId, reason: "NOT_FORMAL_CLIP" });
            continue;
        }
        const to = nextFormalTarget(input.segments, index);
        if (!to) {
            receipt.skipped.push({ segmentId, reason: "NO_NEXT_FORMAL_CLIP" });
            continue;
        }
        planned.push({
            from, to,
            tailFrame: segment.tailFrameContinuation === true,
            motionContext: segment.motionContextEnabled === true,
            videoContinuation: segment.videoContinuation === true,
        });
    }
    if (!planned.length) return receipt;

    try {
        const context = record(await port.get(`/canvas/projects/${encodeURIComponent(input.projectId)}/production-context`, input.signal));
        const base = ownerBasePath(record(context.context).owner as Record<string, unknown> || record(context.owner));
        if (!base) {
            receipt.error = "PRODUCTION_OWNER_UNAVAILABLE";
            return receipt;
        }
        const summary = record(await port.get(`${base}?view=summary&snapshot=draft`, input.signal));
        const revision = Number(record(summary.production).revision ?? summary.revision);
        if (!Number.isInteger(revision) || revision < 0) {
            receipt.error = "PRODUCTION_REVISION_UNAVAILABLE";
            return receipt;
        }
        const ops = planned.map((boundary) => ({
            type: "set_director_boundary",
            boundary: { ...boundary, reason: "由 H3 Clip 设置保存续段衔接" },
        }));
        const result = record(await port.post(`${base}/ops`, {
            operationId: `${input.operationId}:continuation`,
            expectedRevision: revision,
            ops,
        }, input.signal));
        receipt.boundaries = planned;
        receipt.revision = Number(record(result.production).revision ?? result.revision ?? revision);
    } catch (error) {
        receipt.error = error instanceof Error ? error.message : String(error);
    }
    return receipt;
}
