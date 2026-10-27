/** 画布节点的默认尺寸。 */
export type CanvasNodeSize = { width: number; height: number };

/**
 * 内置画布节点的默认尺寸：浏览器、Backend 与 MCP 共用这一份。
 *
 * 同一类型从任何入口创建（界面、Agent 规划、MCP 直接提交 op）都必须落成同一个尺寸；
 * 以前 Backend 一律兜底 320×240，导致 MCP 新建的配置节点比界面新建的小一整圈。
 * 插件节点类型由插件在浏览器注册，这里不登记，按 CANVAS_NODE_FALLBACK_SIZE 处理。
 */
export const BUILTIN_CANVAS_NODE_SIZES: Record<string, CanvasNodeSize> = {
    image: { width: 340, height: 240 },
    text: { width: 340, height: 240 },
    config: { width: 420, height: 540 },
    video: { width: 420, height: 236 },
    audio: { width: 340, height: 120 },
    loop: { width: 380, height: 320 },
    group: { width: 760, height: 480 },
    character: { width: 380, height: 320 },
    scene: { width: 380, height: 320 },
    prop: { width: 360, height: 300 },
};

/** 未知类型（插件节点、历史类型）的默认尺寸，与浏览器节点规格的兜底一致。 */
export const CANVAS_NODE_FALLBACK_SIZE: CanvasNodeSize = { width: 340, height: 240 };

/** 按节点类型取默认尺寸；未登记的类型返回兜底尺寸。 */
export function canvasNodeDefaultSize(type: unknown): CanvasNodeSize {
    return BUILTIN_CANVAS_NODE_SIZES[String(type ?? "")] ?? CANVAS_NODE_FALLBACK_SIZE;
}
