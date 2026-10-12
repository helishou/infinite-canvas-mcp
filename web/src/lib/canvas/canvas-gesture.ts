export type CanvasTool = "select" | "pan";

/** Decide whether this pointer-down belongs to viewport panning or a canvas control. */
export function shouldStartCanvasPan(button: number, activeTool: CanvasTool, hitInteractiveControl: boolean): boolean {
    if (button === 1) return true;
    return button === 0 && activeTool === "pan" && !hitInteractiveControl;
}
