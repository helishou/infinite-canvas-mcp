/**
 * 制作台「生成前体检」展示层的纯函数（只做状态映射与文案，不碰 React/后端）。
 * 真值来自后端 POST /drama/episodes/:id/prerun 的逐段 status / issues。
 */
export type PrerunTone = "ok" | "warning" | "error";

export const PRERUN_TONE_LABEL: Record<PrerunTone, string> = {
    ok: "通过",
    warning: "提醒",
    error: "失败",
};

/** 后端异常状态一律按失败显示，不把未知状态伪装成通过。 */
export function prerunTone(status: unknown): PrerunTone {
    return status === "ok" || status === "warning" || status === "error" ? status : "error";
}

/** 逐段卡片的颜色类名：绿/黄/红，供制作台分镜 tab 直接套用。 */
export const PRERUN_TONE_CLASS: Record<PrerunTone, string> = {
    ok: "border-emerald-500/40 bg-emerald-500/5 text-emerald-600 dark:text-emerald-300",
    warning: "border-amber-500/40 bg-amber-500/5 text-amber-600 dark:text-amber-300",
    error: "border-red-500/40 bg-red-500/5 text-red-600 dark:text-red-300",
};

/** 汇总横幅的口径：失败最优先，其次警告，全部通过才提示可生成。 */
export function prerunBanner(failed: number, warnings: number, total: number): { tone: PrerunTone; text: string } {
    if (failed > 0) return { tone: "error", text: `体检发现 ${failed} 个失败项（共 ${total} 段），请先修正再生成` };
    if (warnings > 0) return { tone: "warning", text: `体检通过，${warnings} 段有提醒（共 ${total} 段），可生成但建议先核对` };
    return { tone: "ok", text: `体检通过，${total} 段待生成内容就绪` };
}
