import type { CSSProperties } from "react";

// H3 工作台的 CSS 变量只挂在 .minimax-canvas-workbench 上，而 antd Modal 默认 portal 到 body，
// 弹框内部拿不到这些变量 → 依赖 var(--h3-*) 的边框/底色全部失效（表现为各区域黏在一起、看不出分区）。
// 这里统一出口，弹框内容容器上再挂一次同样的变量。
export type H3ThemeSource = {
    node: { panel: string; fill: string; stroke: string; text: string; muted: string; faint: string; activeStroke: string };
    toolbar: { panel: string; itemHover: string; activeBg: string; activeText: string };
};

export function h3ThemeVars(theme: H3ThemeSource): CSSProperties {
    return {
        "--h3-panel": theme.node.panel,
        "--h3-fill": theme.node.fill,
        "--h3-border": theme.node.stroke,
        "--h3-text": theme.node.text,
        "--h3-muted": theme.node.muted,
        "--h3-faint": theme.node.faint,
        "--h3-active": theme.node.activeStroke,
        "--h3-toolbar": theme.toolbar.panel,
        "--h3-hover": theme.toolbar.itemHover,
        "--h3-active-bg": theme.toolbar.activeBg,
        "--h3-active-text": theme.toolbar.activeText,
    } as CSSProperties;
}
