export { H3_VIDEO_MEGAPIXELS, H3_VIDEO_RATIOS, h3VideoDimensions, h3OriginalVideoDimensions } from "./video-settings.js";
/** H3 节点的单一基础默认值来源；前端节点定义与 MCP 创建节点共用。 */
export declare const BASE_H3_NODE_METADATA: Record<string, unknown>;
/** H3 工作台各模块区域的布局键：与画布手柄拖拽写入的 metadata minimax* 键一一对应。 */
export declare const H3_LAYOUT_PANE_KEYS: readonly ["minimaxPreviewH", "minimaxPreviewW", "minimaxPromptW", "minimaxTimelineH", "minimaxRefLaneH"];
/** H3 节点类型（含历史别名和插件名形式）。 */
export declare function isH3NodeType(type: unknown): boolean;
export type H3LayoutSnapshot = {
    width?: number;
    height?: number;
    panes: Record<string, number>;
};
/** 解析「设为默认参数」保存的布局快照；非有限正数一律丢弃，避免脏值污染新建节点。 */
export declare function readH3Layout(source: unknown): H3LayoutSnapshot;
/** 按“节点显式值 > 保存默认值 > 基础默认值”创建完整 H3 metadata。 */
export declare function createH3NodeMetadata(stored?: Record<string, unknown>, metadata?: Record<string, unknown>, panes?: Record<string, number>): {
    segments: {
        id: string;
        prompt: {};
        duration: unknown;
        taskMode: {};
        status: {};
    }[];
};
//# sourceMappingURL=node-factory.d.ts.map