function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function channelCount(config: unknown): number {
    const obj = record(config);
    if (!obj || !Array.isArray(obj.channels)) return 0;
    return obj.channels.filter((c) => record(c) !== null).length;
}

/**
 * 判断一次 ai.config 写入是否会把已有渠道清空。
 *
 * 常驻 bug：前端 hydrate 到空 config（{}）或一次残缺保存，经 normalizeConfig 把
 * channels 归一成 []，再整体 PUT 回后端，就把用户全部渠道抹掉；下次加载又是空，
 * 自我维持。这里在写入闸门口拦下「当前有渠道、incoming 无渠道」的写入。
 */
export function wouldWipeAiChannels(current: unknown, incoming: unknown): boolean {
    return channelCount(current) > 0 && channelCount(incoming) === 0;
}
