import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 标记当前执行上下文来自 agent（MCP 工具调用）。
 * 人工在编辑器里的写入不走 /mcp，因此不受 agent 侧结构约束。
 */
const storage = new AsyncLocalStorage<boolean>();

export function runAsAgentWrite<T>(fn: () => T): T {
    return storage.run(true, fn);
}

export function isAgentWrite(): boolean {
    return storage.getStore() === true;
}
