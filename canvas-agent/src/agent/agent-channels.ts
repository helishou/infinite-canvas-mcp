import type { JsonRecord } from "../utils/value.js";

/**
 * 导演（Agent 对话）可用的渠道。
 *
 * 只有两种运行方式，都是"原生引擎 + 自有事件流"：
 *   - `codex-cli`：本机 Codex app-server（原生 Codex 线程）
 *   - `hermes`   ：`hermes acp`（ACP over stdio，模型 id 形如 `provider/model`）
 *
 * 这里不再接受任意 OpenAI/Gemini 兼容端点作为导演模型：那套自建工具循环口径与原生引擎
 * 不一致（工具清单、审批、历史都各一套），已从导演链路移除。图像/视频生成、文案翻译等
 * 仍走 Backend 侧的渠道配置，与这里无关。
 */
export type AgentChannelKind = "codex-cli" | "hermes";

export type AgentChannelModel = {
    /** 渠道限定 id：`<channelId>::<modelName>`，与网页选择器一致。 */
    id: string;
    /** 引擎模型名：codex-cli 传原生模型名，hermes 传 ACP modelId。 */
    model: string;
    kind: AgentChannelKind;
    channelId: string;
    name: string;
    displayName: string;
};

const record = (value: unknown): JsonRecord => (value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {});
const rows = (value: unknown): JsonRecord[] => (Array.isArray(value) ? value.map(record) : []);

export function configuredAgentChannels(config: unknown): AgentChannelModel[] {
    const root = record(config);
    return rows(root.channels).flatMap((channel) => {
        const kind = String(channel.kind || "");
        if (kind !== "codex-cli" && kind !== "hermes") return [];
        const channelId = String(channel.id || "");
        if (!channelId) return [];
        return rows(channel.models)
            .filter((model) => String(model.capability || "text") === "text" && !String(model.script || "").trim())
            .map((model) => {
                const name = String(model.name || "").trim();
                return {
                    id: `${channelId}::${name}`,
                    model: name,
                    kind: kind as AgentChannelKind,
                    channelId,
                    name: `${String(channel.name || channelId)} / ${name}`,
                    displayName: `${String(channel.name || channelId)} / ${name}`,
                };
            })
            .filter((model) => Boolean(model.model));
    });
}

export function resolveAgentChannel(config: unknown, id?: string): AgentChannelModel | undefined {
    const channels = configuredAgentChannels(config);
    const selected = String(id || "").trim();
    if (selected) {
        const hit = channels.find((channel) => channel.id === selected || channel.model === selected);
        if (hit) return hit;
    }
    return channels.find((channel) => channel.id === String(record(config).textModel || "")) || channels[0];
}

export function hasHermesChannel(config: unknown) {
    return configuredAgentChannels(config).some((channel) => channel.kind === "hermes");
}
