type SettingsAnchor = Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width">;
type SettingsPlacement = "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";

/** Keep the inspector inside the viewport, flipping only when its preferred side is too short. */
export function canvasSettingsPosition(anchor: SettingsAnchor, viewport: { width: number; height: number }, placement: SettingsPlacement = "topLeft") {
    const margin = 12;
    const gap = 8;
    const width = Math.min(356, Math.max(0, viewport.width - margin * 2));
    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
    const left = placement.endsWith("Right") ? anchor.right - width : placement === "top" || placement === "bottom" ? anchor.left + anchor.width / 2 - width / 2 : anchor.left;
    const upperEdge = clamp(anchor.top - gap, margin, viewport.height - margin);
    const lowerEdge = clamp(anchor.bottom + gap, margin, viewport.height - margin);
    const above = Math.max(0, upperEdge - margin);
    const below = Math.max(0, viewport.height - margin - lowerEdge);
    const preferTop = placement.startsWith("top");
    const top = preferTop ? above >= 260 || above >= below : !(below >= 260 || below >= above);
    return {
        width,
        left: clamp(left, margin, viewport.width - width - margin),
        ...(top ? { bottom: viewport.height - upperEdge, maxHeight: above } : { top: lowerEdge, maxHeight: below }),
    };
}
