/** 制作台与画布是同一个工作台的两态（画布是全屏 overlay），不是两个并列页面。 */
export type WorkspaceViewMode = "production" | "canvas";
export const WORKSPACE_VIEW_MODES: readonly WorkspaceViewMode[] = ["production", "canvas"];

/** 点当前态不该重复触发打开/收起，避免焦点与媒体暂停被无谓重置。 */
export function shouldSwitchWorkspace(current: WorkspaceViewMode, target: WorkspaceViewMode): boolean {
    return current !== target;
}
