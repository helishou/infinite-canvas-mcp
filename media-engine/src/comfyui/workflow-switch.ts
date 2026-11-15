/** Shared by built-in presets and imported workflows, scoped to a ComfyUI endpoint. */
export class ComfyWorkflowSwitch {
    private endpoints = new Map<string, { previous?: string; tail: Promise<unknown> }>();

    async submit<T>(url: string, workflow: string, submit: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        const endpoint = url.replace(/\/+$/, "");
        const state = this.state(endpoint);
        const result = state.tail.catch(() => {}).then(async () => {
            signal?.throwIfAborted();
            const changed = state.previous !== workflow;
            if (state.previous !== undefined && changed) {
                const response = await fetch(`${endpoint}/free`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    // 切流时必须连执行缓存一起放掉（free_memory:true → e.reset()）：
                    // 只卸权重会留下 RAM pressure cache，把系统文件缓存挤走，下一段每步从磁盘读权重。
                    body: JSON.stringify({ unload_models: true, free_memory: true }),
                    signal,
                });
                if (!response.ok) throw new Error(`ComfyUI /free failed: HTTP ${response.status}`);
            }
            signal?.throwIfAborted();
            const value = await submit();
            state.previous = workflow;
            return value;
        });
        state.tail = result;
        return result;
    }

    /**
     * 任务结束后释放模型与执行缓存，用于同一自定义工作流连续分段：
     * 每段跑完即回到干净状态，下一段的加载速度与第一段一致，不会因为上一段残留的
     * 文本编码器 + DiT 挤占显存而在采样里反复换入换出。
     *
     * 只在目标 ComfyUI 当前没有运行中/排队中的 prompt 时释放，避免清掉其他客户端正在用的模型；
     * 并且排进本端点的串行队列，不会插到本进程刚提交、ComfyUI 还没取走的 prompt 前面。
     * 返回是否真的执行了释放。
     */
    async releaseIfIdle(url: string, signal?: AbortSignal): Promise<boolean> {
        const endpoint = url.replace(/\/+$/, "");
        const state = this.state(endpoint);
        const result = state.tail.catch(() => {}).then(async () => {
            signal?.throwIfAborted();
            const queue = await fetch(`${endpoint}/queue`, { signal });
            if (!queue.ok) throw new Error(`ComfyUI /queue failed: HTTP ${queue.status}`);
            const body = await queue.json() as { queue_running?: unknown[]; queue_pending?: unknown[] };
            if ((body.queue_running?.length ?? 0) > 0 || (body.queue_pending?.length ?? 0) > 0) return false;
            signal?.throwIfAborted();
            const response = await fetch(`${endpoint}/free`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ unload_models: true, free_memory: true }),
                signal,
            });
            if (!response.ok) throw new Error(`ComfyUI /free failed: HTTP ${response.status}`);
            // 已释放：下一次提交不再按「切换工作流」重复释放。
            state.previous = undefined;
            return true;
        });
        state.tail = result;
        return result;
    }

    private state(endpoint: string) {
        let state = this.endpoints.get(endpoint);
        if (!state) {
            state = { tail: Promise.resolve() };
            this.endpoints.set(endpoint, state);
        }
        return state;
    }
}

export const comfyWorkflowSwitch = new ComfyWorkflowSwitch();
