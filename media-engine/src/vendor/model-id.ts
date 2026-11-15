/**
 * 渠道限定模型 ID 的解析（`<channelId>::<modelName>`）。
 *
 * 来源：canvas-agent `src/canvas/model-workflow.ts` 的 decodeChannelModel / modelOptionName。
 * 引擎与画布之间只靠 OpenAI 协议通信，因此这里保留一份自足实现——**不要**反过来 import 画布包。
 * 协议面上引擎只接受/返回裸模型名，`::` 形式属于宿主侧的寻址约定，解析规则必须与宿主一致。
 */
const CHANNEL_MODEL_SEPARATOR = "::";

export function decodeChannelModel(
    value: string,
): { channelId: string; model: string } | null {
    const index = String(value || "").indexOf(CHANNEL_MODEL_SEPARATOR);
    if (index < 0) return null;
    return {
        channelId: value.slice(0, index),
        model: value.slice(index + CHANNEL_MODEL_SEPARATOR.length),
    };
}

export function modelOptionName(value: string): string {
    return decodeChannelModel(String(value || ""))?.model || String(value || "");
}
