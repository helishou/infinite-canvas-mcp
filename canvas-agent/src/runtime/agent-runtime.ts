import { createAgentApp, type AgentHttpOptions } from "../server/http.js";

/** Agent 嵌入运行时的稳定形态；业务存储和 ComfyUI 由 Backend 提供。 */
export type AgentRuntime = ReturnType<typeof createAgentApp>;

/** 创建不监听端口的 AgentRuntime，供 Backend 挂载 /agent。 */
export function createAgentRuntime(options: Omit<AgentHttpOptions, "listen"> = {}): AgentRuntime {
    return createAgentApp({ ...options, listen: false });
}
