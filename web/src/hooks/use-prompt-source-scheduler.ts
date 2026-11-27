import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { refreshDueSources } from "@/services/api/prompts";
import { usePromptSourceStore } from "@/stores/use-prompt-source-store";

const CHECK_INTERVAL_MS = 60_000;
/**
 * 首屏延后窗口：调度器一挂载就会给每个启用的提示词源读一次后端缓存（实测单次首页 10 条 /prompts/cache，
 * 合计 ~1.2MB），和首屏关键请求抢带宽。缓存 TTL 是 30 分钟，晚 6 秒做第一轮不影响正确性。
 */
const FIRST_TICK_DELAY_MS = 6_000;

/** Periodically update only the sources whose last successful refresh is due. */
export function usePromptSourceScheduler() {
    const queryClient = useQueryClient();
    const hydrated = usePromptSourceStore((state) => state.hydrated);
    const intervalMinutes = usePromptSourceStore((state) => state.schedule.intervalMinutes);

    useEffect(() => {
        if (!hydrated) return;
        if (!intervalMinutes) return;
        let running = false;
        const tick = async () => {
            if (running) return;
            const { updateSchedule } = usePromptSourceStore.getState();
            running = true;
            try {
                const result = await refreshDueSources(intervalMinutes * 60_000);
                if (!result.results.length) return;
                updateSchedule("lastFetchedAt", new Date().toISOString());
                await Promise.all([
                    queryClient.invalidateQueries({ queryKey: ["prompts"] }),
                    queryClient.invalidateQueries({ queryKey: ["side-panel-prompts"] }),
                    queryClient.invalidateQueries({ queryKey: ["prompt-source-statuses"] }),
                ]);
            } catch {
                // Per-source errors are stored in source state and retried during the next check cycle.
            } finally {
                running = false;
            }
        };
        // 首屏后再跑第一轮：提示词源缓存的刷新是后台维护（缓存 TTL 30 分钟），不必抢首屏带宽。
        const firstTimer = window.setTimeout(() => void tick(), FIRST_TICK_DELAY_MS);
        const timer = window.setInterval(() => void tick(), CHECK_INTERVAL_MS);
        return () => {
            window.clearTimeout(firstTimer);
            window.clearInterval(timer);
        };
    }, [hydrated, intervalMinutes, queryClient]);
}
