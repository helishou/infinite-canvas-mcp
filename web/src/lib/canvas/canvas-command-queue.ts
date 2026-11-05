import type { CanvasConflictBaseline } from "./canvas-conflict-baseline";

export type CanvasCommand<T> = {
    operationId: string; projectId: string; ownerId: string; backend: string; order: number;
    operations: Array<Record<string, unknown>>;
    /** 冲突判定基线：新代码写 CanvasConflictBaseline；存量草稿仍是完整 CanvasProject，两者都读。 */
    base: T | CanvasConflictBaseline;
    source?: { clientId: string; kind: "browser"; label: string };
    /** 首次发送前固定；丢回执后不允许改基线或请求内容。 */
    baseRevision?: number;
    rejected?: string;
    /** 确定性 400：本次编辑已明确失败，保留草稿但不再参与发送、冲突阻断与生成门禁。 */
    settled?: string;
    /** 用户明确重选冲突结果时，先落新记录再清旧记录，刷新按此集合屏蔽旧意图。 */
    supersedes?: string[];
};
type Storage<T> = { save: (command: CanvasCommand<T>) => Promise<unknown>; remove: (id: string) => Promise<unknown> };

/** 编辑动作在发生时入队；网络发送和远端投影绝不重新推导用户意图。 */
export class CanvasCommandQueue<T> {
    private commands = new Map<string, CanvasCommand<T>>();
    private writes = new Map<string, Promise<unknown>>();
    constructor(private storage: Storage<T>) {}
    /** 待发送命令。已 settle 的确定性拒绝仍是用户数据，但不参与发送、冲突判定与生成门禁。 */
    list(projectId?: string) {
        const superseded = new Set([...this.commands.values()].flatMap((item) => item.supersedes || []));
        return [...this.commands.values()].filter((item) => !item.settled && !superseded.has(item.operationId) && (!projectId || item.projectId === projectId)).sort((a, b) => a.order - b.order || a.operationId.localeCompare(b.operationId));
    }
    /** 含已 settle 失败草稿的完整列表，供恢复 UI 与显式丢弃使用。 */
    listAll(projectId?: string) {
        const superseded = new Set([...this.commands.values()].flatMap((item) => item.supersedes || []));
        return [...this.commands.values()].filter((item) => !superseded.has(item.operationId) && (!projectId || item.projectId === projectId)).sort((a, b) => a.order - b.order || a.operationId.localeCompare(b.operationId));
    }
    has(projectId: string) { return this.list(projectId).length > 0; }
    hasSettled(projectId: string) { return this.listAll(projectId).some((item) => Boolean(item.settled)); }
    restore(command: CanvasCommand<T>) {
        if (!this.commands.has(command.operationId)) this.commands.set(command.operationId, command);
    }
    enqueue(command: CanvasCommand<T>) {
        if (this.commands.has(command.operationId)) throw new Error("画布命令 ID 重复");
        // detach 调用方的可变数组/对象；入队后 UI 修改不能改变已保存请求。
        const captured = structuredClone(command);
        this.commands.set(captured.operationId, captured);
        this.write(captured);
    }
    private write(command: CanvasCommand<T>) {
        const previous = this.writes.get(command.operationId);
        const next = (previous || Promise.resolve()).catch(() => {}).then(() => this.storage.save(command));
        this.writes.set(command.operationId, next);
        // 立即保存的失败由 flush/发送屏障报告，不能变成未处理 Promise。
        void next.catch(() => {});
        return next;
    }
    async prepare(operationId: string, baseRevision: number) {
        const current = this.commands.get(operationId);
        if (!current) throw new Error("画布命令已不存在");
        if (current.rejected) throw new Error(current.rejected);
        const command = current.baseRevision === undefined ? { ...current, baseRevision } : current;
        this.commands.set(operationId, command);
        // 每次发送前确认落盘；存储曾失败也原样重试，不丢弃命令。
        await this.write(command);
        return command;
    }
    async reject(operationId: string, message: string) {
        const current = this.commands.get(operationId);
        if (!current) return;
        const command = { ...current, rejected: message };
        this.commands.set(operationId, command);
        await this.write(command);
    }
    /** Backend 已确认原 operationId 提交成功后，原样取回回执；不换 ID 或修改请求。 */
    async retryCommittedReceipt(operationId: string) {
        const current = this.commands.get(operationId);
        if (!current?.rejected) return;
        const command = { ...current };
        delete command.rejected;
        delete command.settled;
        this.commands.set(operationId, command);
        try { await this.write(command); }
        catch (error) { this.commands.set(operationId, current); throw error; }
    }
    /**
     * 确定性 400：这次编辑已明确失败。保留不可变草稿与拒因，但把它移出活动队列，
     * 让后续编辑立刻继续发送；刷新不复活自动重试，也不再把整张画布锁在冲突态。
     */
    async settle(operationId: string, reason: string) {
        const current = this.commands.get(operationId);
        if (!current || current.settled) return;
        const command = { ...current, rejected: current.rejected || reason, settled: reason };
        this.commands.set(operationId, command);
        try { await this.write(command); }
        catch (error) { this.commands.set(operationId, current); throw error; }
    }
    async acknowledge(operationId: string) {
        const current = this.commands.get(operationId);
        await this.writes.get(operationId)?.catch(async (error) => {
            if (!current) throw error;
            await this.write(current);
        });
        for (const id of this.commands.get(operationId)?.supersedes || []) {
            await this.writes.get(id)?.catch(() => {});
            await this.storage.remove(id);
            this.commands.delete(id);
            this.writes.delete(id);
        }
        await this.storage.remove(operationId);
        this.commands.delete(operationId);
        this.writes.delete(operationId);
    }
    async discard(projectId: string) {
        for (const command of this.listAll(projectId)) await this.acknowledge(command.operationId);
    }
    async replace(command: CanvasCommand<T>) {
        // 用户明确重提/采用远端时，连同已 settle 的失败草稿一起替代，避免旧意图残留。
        const old = this.listAll(command.projectId);
        const replacement = { ...command, order: old[0]?.order ?? command.order, supersedes: old.flatMap((item) => [item.operationId, ...(item.supersedes || [])]) };
        this.enqueue(replacement);
        await this.writes.get(replacement.operationId);
        // 清理旧记录前，新记录已经可恢复。新请求的 supersedes 不能在重试时改变。
        for (const previous of old) await this.acknowledge(previous.operationId);
    }
    async persisted() { await Promise.all(this.writes.values()); }
}
