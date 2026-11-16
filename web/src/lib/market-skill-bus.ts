/**
 * 技能广场 → Agent 对话的桥接总线。
 * 广场里点"用此技能对话"时发事件；全局 AgentPanel 内的 LocalAgentPanel 监听，
 * 强制刷新技能列表后按 name 选中该技能并把提示词填进输入框。
 * 只做"选中 + 打开面板"，不自动发送、不改生成链路。
 */
export const USE_MARKET_SKILL_EVENT = "infinite-canvas:use-market-skill";

export type UseMarketSkillDetail = {
    /** frontmatter.name（导演大师技能为中文名，如「选题立项」） */
    name: string;
    /** 安装目录 slug（如 drama-topic）；Codex 引擎可能以此作为技能名 */
    slug?: string;
    /** 可选的绝对路径；给出时按 name+path 精确匹配 */
    path?: string;
    /** 预填到输入框的提示词 */
    prompt?: string;
};

export function publishUseMarketSkill(detail: UseMarketSkillDetail): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(USE_MARKET_SKILL_EVENT, { detail }));
}

export function subscribeUseMarketSkill(handler: (detail: UseMarketSkillDetail) => void): () => void {
    if (typeof window === "undefined") return () => {};
    const listener = (event: Event) => {
        const detail = (event as CustomEvent<UseMarketSkillDetail>).detail;
        if (detail && typeof detail.name === "string" && detail.name) handler(detail);
    };
    window.addEventListener(USE_MARKET_SKILL_EVENT, listener);
    return () => window.removeEventListener(USE_MARKET_SKILL_EVENT, listener);
}
