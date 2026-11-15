/** 阶段内的子步判定：只在文案层面看「这一步是不是提到了、写完没有」，不产出任何制作真值。 */
export type FlowTone = "done" | "running" | "pending";

/** 带这些词才算写完；只提到关键词（「正在补…」）算进行中。 */
const COMPLETION = /已|完成|写完|写好|写入|保存|生成|归档|验收|通过/;

export function substepTone(texts: readonly string[], keywords: readonly string[]): FlowTone {
    const hits = texts.filter((text) => keywords.some((keyword) => text.includes(keyword)));
    if (!hits.length) return "pending";
    return hits.some((text) => COMPLETION.test(text)) ? "done" : "running";
}

export function toneStatusKey(tone: FlowTone) {
    return tone === "done" ? "agent.message.completed" : tone === "running" ? "agent.message.running" : "agent.message.notStarted";
}
