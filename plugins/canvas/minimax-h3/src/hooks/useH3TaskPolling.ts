import { useEffect } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { appendVideoMaterials } from "../services/h3-data";
import { finishH3Log } from "../services/h3-logs";
import { restorableParams, mergeBackendResultSegments } from "../services/h3-segment-utils";
import { segmentsFor, compactSegmentStarts } from "../hooks/useH3Segments";

export function useH3TaskPolling(ctx: CanvasNodeContext, metadata: Record<string, unknown>, update: (patch: Record<string, unknown>) => void) {
    useEffect(() => {
        const taskId = String(metadata.runtimeTaskId || "");
        if (!["loading", "queued"].includes(String(metadata.status))) return;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        // 把生成成功的视频写回「当前 Clip」：同时更新 segment.result，
        // 否则视频只堆积在 Output（materials / content），时间轴 Clip 卡片与
        // 工作台预览都不会显示它（表现为“仅出现在 Output，没有替换当前 Clip”）。
        // 回写目标必须锁定到「本次提交时正在生成的 Clip」：
        // 否则用户在等待期间切换到其他 Clip 后，轮询成功的结果会被误写到
        // 当前选中的 Clip（表现为“生成成功的视频乱写到其他 clip”）。
        const resolveTargetId = (baseMeta: Record<string, unknown>) => String(baseMeta.runtimeTargetSegmentId || baseMeta.selectedSegmentId || segmentsFor(baseMeta)[0]?.id || "");
        const withSelectedResult = (baseMeta: Record<string, unknown>, url: string, storageKey?: string, explicitId?: string) => {
            const segs = segmentsFor(baseMeta);
            const selId = explicitId || resolveTargetId(baseMeta);
            return compactSegmentStarts(segs.map((seg, index) => seg.id === selId ? {
                ...seg,
                result: url,
                resultStorageKey: storageKey,
                results: [...(seg.results || []).filter((item) => item.url !== url), { url, storageKey, type: "video", name: `Clip ${index + 1}` }],
                status: "success",
                progress: 1,
            } : seg));
        };
        const recoverTask = async () => {
            if (taskId) return taskId;
            const logs = await ctx.generationLogs.list({ projectId: ctx.projectId, nodeId: ctx.node.id, limit: 50 });
            const runStartedAt = Number(metadata.runStartedAt || 0);
            const log = logs
                .filter((item) => ["queued", "running", "success", "failed", "cancelled"].includes(item.status))
                .filter((item) => {
                    // 只考虑当前运行开始之后创建的日志，避免把上一次成功运行的日志
                    // 误认为当前运行的结果（导致节点直接显示"已完成"而不再提交新任务）。
                    if (runStartedAt <= 0) return true;
                    const logTime = new Date(item.createdAt || 0).getTime();
                    return logTime >= runStartedAt - 2000;
                })
                .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))[0];
            if (!log || cancelled) return "";
            if (log.status === "success" && log.outputs?.[0]?.url) {
                const output = log.outputs[0];
                const url = String(output.url);
                const storageKey = typeof output.storageKey === "string" ? output.storageKey : undefined;
                // 刷新后恢复：优先用提交时记录在 generationLog 里的目标 Clip（最准确），
                // 否则回退到 metadata 中锁定的 runtimeTargetSegmentId / 当前选中。
                const logParams = log.params && typeof log.params === "object" ? (log.params as Record<string, unknown>) : {};
                const logSelId = String(logParams.selectedSegmentId || "");
                const selId = logSelId || resolveTargetId(metadata);
                update({ content: url, storageKey, mimeType: typeof output.mimeType === "string" ? output.mimeType : "video/mp4", segments: withSelectedResult(metadata, url, storageKey, selId), status: "success", errorDetails: "", runtimeTaskId: undefined, runtimeTargetSegmentId: undefined });
                return "";
            }
            if (["failed", "cancelled"].includes(log.status)) {
                update({ status: log.status === "cancelled" ? "cancelled" : "error", errorDetails: log.error || "H3 任务失败", runtimeTaskId: undefined });
                return "";
            }
            if (log.runtimeTaskId) {
                update({ runtimeTaskId: log.runtimeTaskId });
                return log.runtimeTaskId;
            }
            // 孤儿日志自救：log 卡在 queued/running 但没有 runtimeTaskId（onTaskId 回调从未触发、
            // 或触发了但 metadata 没被持久化），且 startedAt 超过 90 秒前——视为已废弃，自动清空
            // 节点状态让用户能重新点生成，否则前端会卡在 "生成中" 永远不出来。
            const staleMs = Date.now() - new Date(String(log.startedAt || log.createdAt || 0)).getTime();
            if (staleMs > 90_000) {
                console.warn("[minimax-h3] orphan log detected, clearing stale state", { logId: log.id, status: log.status, staleSeconds: Math.round(staleMs / 1000) });
                update({ status: "idle", errorDetails: "上次的生成任务已失联（无后端 task id），已自动重置状态", runtimeTaskId: "", runtimeTargetSegmentId: undefined, runProgress: 0, cancelRequested: false });
                return "";
            }
            return "";
        };
        const poll = async () => {
            try {
                const recoveredTaskId = await recoverTask();
                if (!recoveredTaskId) {
                    if (!cancelled) timer = setTimeout(() => void poll(), 1500);
                    return;
                }
                const task = String(metadata.minimaxEngine || "").toLowerCase() === "runninghub"
                    ? await ctx.ai.getRunningHubH3Task(recoveredTaskId)
                    : await ctx.ai.getLocalH3Task(recoveredTaskId);
                if (cancelled) return;
                if (task.status === "succeeded" && task.result?.url) {
                    // 任务结果必须使用本次 ComfyUI 返回的 storageKey；
                    // metadata.storageKey 可能属于用户后来替换的 Clip 挂载视频。
                    const storageKey = task.result.storageKey;
                    const url = task.result.url;
                    // 回写目标用提交时锁定的 runtimeTargetSegmentId，而非实时选中的 Clip，
                    // 否则等待期间切换 Clip 会把结果误写到错误 clip。
                    const selId = resolveTargetId(metadata);
                    const targetSource = segmentsFor(metadata).find((seg) => seg.id === selId);
                    // 后端自动分段成功会返回 task.result.segments（缺 loraSlots 等前端字段）。
                    // 直接整段替换会清空所有 Clip 的 LoRA/参数，改为按 index 合并，保留前端参数。
                    const mergedSegments = mergeBackendResultSegments(segmentsFor(metadata), task.result.segments, url, storageKey);
                    update({
                        content: url,
                        storageKey,
                        mimeType: task.result.mimeType,
                        segments: mergedSegments ?? withSelectedResult(metadata, url, storageKey, selId),
                        materials: appendVideoMaterials(metadata.materials, [{ url, storageKey, type: "video", name: "H3 输出", segmentId: selId, params: restorableParams(targetSource as unknown as Record<string, unknown> | undefined) }]),
                        status: "success",
                        errorDetails: "",
                        runtimeTaskId: undefined,
                        runtimeTargetSegmentId: undefined,
                    });
                    void finishH3Log(ctx, recoveredTaskId, "success", {
                        finishedAt: new Date().toISOString(),
                        durationMs: Date.now() - Number(metadata.runStartedAt || Date.now()),
                        outputs: [{ url, storageKey, type: "video", mimeType: task.result.mimeType }],
                    });
                } else if (["failed", "cancelled"].includes(task.status)) {
                    const status = task.status === "cancelled" ? "cancelled" : "error";
                    update({ status, errorDetails: task.error || "H3 任务失败" });
                    void finishH3Log(ctx, recoveredTaskId, task.status === "cancelled" ? "cancelled" : "failed", {
                        finishedAt: new Date().toISOString(),
                        durationMs: Date.now() - Number(metadata.runStartedAt || Date.now()),
                        error: task.error || "H3 任务失败",
                    });
                } else {
                    timer = setTimeout(() => void poll(), 1500);
                }
            } catch {
                if (!cancelled) timer = setTimeout(() => void poll(), 2500);
            }
        };
        void poll();
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, [ctx.node.id, metadata.runtimeTaskId, metadata.status, update]);
}
