import type { CreativeLaunch } from "@/pages/home/workbench-data";

/**
 * 创作会话总线：所有「对话式生成」入口（首页创作台、Agent 站点工具）共用同一个会话。
 * 生成任务本身是无画布的，只有用户显式点「新建画布」才落地；
 * 这里只负责把一条新任务登记到首页对话工作台，避免为了让结果可见而偷偷建画布。
 */
export const CREATIVE_LAUNCH_EVENT = "infinite-canvas:creative-launch";

export function publishCreativeLaunch(launch: CreativeLaunch): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(CREATIVE_LAUNCH_EVENT, { detail: launch }));
}

export function subscribeCreativeLaunches(handler: (launch: CreativeLaunch) => void): () => void {
    if (typeof window === "undefined") return () => {};
    const listener = (event: Event) => {
        const launch = (event as CustomEvent<CreativeLaunch>).detail;
        if (launch && typeof launch.taskId === "string" && launch.taskId) handler(launch);
    };
    window.addEventListener(CREATIVE_LAUNCH_EVENT, listener);
    return () => window.removeEventListener(CREATIVE_LAUNCH_EVENT, listener);
}
