/**
 * 从执行引擎 `comfyui2api/src/vendor/model-id.ts` 落地到画布。
 * 这类能力属于画布自身（视频拼接、直连渠道上游 API、模型 id 解析），
 * 放在画布内可以不再依赖引擎包；引擎侧改动时需手工同步。
 */
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
