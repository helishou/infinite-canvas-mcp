import { CodexAppClient } from "./codex-client.js";
import type { CodexReasoningEffort } from "./codex-protocol.js";
import type { AgentEmit } from "./types.js";

/** Fixed capacity; waiting media/user work is outside this pool. No retry policy. */
export class WorkPool {
    private running = 0;
    private queue: Array<{ priority: number; run: () => Promise<void> }> = [];
    constructor(readonly capacity: number) { if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Invalid work pool capacity"); }
    submit<T>(work: () => Promise<T>, priority = 0): Promise<T> {
        return new Promise((resolve, reject) => {
            this.queue.push({ priority, run: async () => { try { resolve(await work()); } catch (error) { reject(error); } } });
            this.queue.sort((a, b) => b.priority - a.priority); this.drain();
        });
    }
    private drain() {
        while (this.running < this.capacity && this.queue.length) {
            this.running++;
            const job = this.queue.shift()!;
            void job.run().finally(() => { this.running--; this.drain(); });
        }
    }
}

export type ProductionAgentRequest = { workId: string; prompt: string; cwd: string; schema: Record<string, unknown>; threadId?: string; model?: string; effort?: CodexReasoningEffort; review?: boolean; recoverOutput?: boolean; turnId?: string; onTurn?: (turnId: string) => void; images?: string[]; readRoots?: string[]; onThread: (threadId: string) => void; emit?: AgentEmit };
type ApiWorker = { canRun(request: ProductionAgentRequest): boolean; run(request: ProductionAgentRequest): Promise<{ threadId: string; output: unknown }> };
type ProductionClient = Pick<CodexAppClient, "resumeProductionThread" | "startProductionThread" | "generateProductionOutput" | "stopProductionClient"> & Partial<Pick<CodexAppClient, "recoverProductionOutput">>;
type Slot = { busy: boolean; client?: ProductionClient; emit?: AgentEmit };
export class ProductionAgentPool {
    constructor(private createClient: (emit: AgentEmit, onExit: () => void) => Promise<ProductionClient> = CodexAppClient.start, private apiWorker?: ApiWorker, private resolveWorkerModel?: (model?: string, threadId?: string) => string | undefined) {}
    private pool = new WorkPool(3);
    private slots: Slot[] = Array.from({ length: 3 }, () => ({ busy: false }));
    private active = new Map<string, Promise<{ threadId: string; output: unknown }>>();
    get busy() { return this.active.size > 0; }
    run(request: ProductionAgentRequest) {
        const prior = this.active.get(request.workId); if (prior) return prior;
        try { if (this.resolveWorkerModel) request = { ...request, model: this.resolveWorkerModel(request.model, request.threadId) }; }
        catch (error) { return Promise.reject(error); }
        const job = this.pool.submit(async () => {
            if (this.apiWorker?.canRun(request)) return await this.apiWorker.run(request);
            const slot = this.slots.find(item => !item.busy)!; slot.busy = true; slot.emit = request.emit;
            try {
                if (request.recoverOutput && !request.threadId) throw new Error("AGENT_RECOVERY_REQUIRED: 缺少原线程身份，未创建新线程");
                slot.client ||= await this.createClient((type, data) => slot.emit?.(type, data), () => { slot.client = undefined; });
                let threadId = request.threadId;
                if (threadId) await slot.client.resumeProductionThread(threadId, request.cwd);
                else { const thread = await slot.client.startProductionThread(request.cwd); threadId = String(thread.id); request.onThread(threadId); }
                if (request.recoverOutput && (!request.threadId || !slot.client.recoverProductionOutput)) throw new Error("AGENT_RECOVERY_REQUIRED: 无法读取原线程回包，未重跑代理");
                const output = request.recoverOutput ? await slot.client.recoverProductionOutput!(threadId!, request.turnId) : await slot.client.generateProductionOutput(threadId!, request.prompt, request.schema, request.images || [], request.model, request.effort, request.onTurn);
                return { threadId: threadId!, output: JSON.parse(output) as unknown };
            } finally { slot.busy = false; slot.emit = undefined; }
        }, request.review ? 1 : 0);
        this.active.set(request.workId, job);
        void job.finally(() => this.active.delete(request.workId)).catch(() => undefined);
        return job;
    }
    stop() { for (const slot of this.slots) slot.client?.stopProductionClient(); }
}
