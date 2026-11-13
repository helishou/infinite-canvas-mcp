/** 制作阶段游标的纯投影：只做数据转换，方便单测，不引入 React。 */

/** 阶段固定顺序；与 settings.productionStage 的枚举一致，不另立一套。 */
export const PRODUCTION_STAGE_KEYS = ["script", "assets", "spatial", "shots", "keyframes", "clips"] as const;
export type ProductionStageKey = (typeof PRODUCTION_STAGE_KEYS)[number];
export type ProductionStageState = { key: ProductionStageKey; state: "done" | "current" | "pending" };
export type ProductionStageValue = { current?: string; done?: readonly string[]; note?: string } | null | undefined;

/**
 * 把源稿里的阶段游标转成可渲染的六格状态。
 * 游标缺失（老项目/未初始化）返回空数组：界面据此显示"尚未初始化"，而不是假装从第一步开始。
 */
export function stageStates(stage: ProductionStageValue): ProductionStageState[] {
    if (!stage || typeof stage.current !== "string" || !stage.current) return [];
    const done = new Set(Array.isArray(stage.done) ? stage.done : []);
    const current = stage.current;
    return PRODUCTION_STAGE_KEYS.map(key => ({
        key,
        state: done.has(key) && key !== current ? "done" : key === current ? "current" : "pending",
    }));
}

export type ReadinessCounts = { ready: number; blocked: number; review: number; total: number };

/** 目标就绪计数：ready/complete 算可用，needs_review 与 blocked 分开报，避免把待审当阻塞。 */
export function readinessCounts(targets: ReadonlyArray<{ status: string }> | null | undefined): ReadinessCounts {
    const list = targets || [];
    let ready = 0, blocked = 0, review = 0;
    for (const item of list) {
        if (item.status === "ready" || item.status === "complete") ready++;
        else if (item.status === "needs_review") review++;
        else blocked++;
    }
    return { ready, blocked, review, total: list.length };
}
