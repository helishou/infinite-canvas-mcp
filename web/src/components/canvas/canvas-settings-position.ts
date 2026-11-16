type SettingsAnchor = Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width">;
type SettingsPlacement = "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";

/** Keep the inspector inside the viewport, flipping only when its preferred side is too short. */
export function canvasSettingsPosition(anchor: SettingsAnchor, viewport: { width: number; height: number }, placement: SettingsPlacement = "topLeft") {
    const margin = 12;
    const gap = 8;
    const width = Math.min(320, Math.max(0, viewport.width - margin * 2));
    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
    const left = placement.endsWith("Right") ? anchor.right - width : placement === "top" || placement === "bottom" ? anchor.left + anchor.width / 2 - width / 2 : anchor.left;
    const upperEdge = clamp(anchor.top - gap, margin, viewport.height - margin);
    const lowerEdge = clamp(anchor.bottom + gap, margin, viewport.height - margin);
    const above = Math.max(0, upperEdge - margin);
    const below = Math.max(0, viewport.height - margin - lowerEdge);
    const preferTop = placement.startsWith("top");
    // bottom* 表示调用方希望向下弹：只要下方还有可用高度就照做。
    // 首页创作台的参数按钮位于视口上半部，若沿用「下方不足就翻上去」的旧规则，
    // 面板会被顶到视口最上沿、盖住页头标题（实测面板高 536px 而上方仅 526px）。
    // 只有下方几乎放不下、且上方明显更宽裕时才回退向上，保留画布底部按钮的行为。
    const top = preferTop
        ? above >= 260 || above >= below
        : below < 120 && above > below;
    return {
        width,
        left: clamp(left, margin, viewport.width - width - margin),
        ...(top ? { bottom: viewport.height - upperEdge, maxHeight: above } : { top: lowerEdge, maxHeight: below }),
    };
}
