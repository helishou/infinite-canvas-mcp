const INTERACTIVE_NODE_TARGETS = "button, input, textarea, select, video, .ant-select-dropdown, [contenteditable='true'], [data-canvas-shortcuts-ignore]";
const H3_INTERACTIVE_SURFACES = ".minimax-tl-clip, .minimax-timeline-controls, .minimax-ruler-row, .minimax-tracks-scroll, .minimax-ref-row";

export function shouldStartCanvasNodeDrag(target: Element, isH3: boolean, event?: Pick<MouseEvent, "clientY">) {
    const interactive = target.closest(INTERACTIVE_NODE_TARGETS);
    const dragHandle = target.closest("[data-canvas-node-drag-handle]");
    const interactiveHandle = target.closest("[data-canvas-node-drag-interactive-handle]");
    const onResizeHandle = target.closest("[data-resize-handle]");
    const onConnectionHandle = target.closest("[data-connection-handle]");
    const onNodePanel = target.closest("[data-canvas-node-panel]");
    const explicitDragHandle = Boolean(dragHandle && (!interactive || interactiveHandle));
    const video = target.closest("video");
    const videoBounds = video?.getBoundingClientRect();
    const onVideoDragSurface = Boolean(videoBounds && event && event.clientY < videoBounds.bottom - Math.min(56, videoBounds.height * 0.25));

    if (onResizeHandle || onConnectionHandle || onNodePanel) return false;
    if (isH3) {
        if (explicitDragHandle) return true;
        if (interactive || !event || target.closest(H3_INTERACTIVE_SURFACES)) return false;

        // When selected, an H3 node stays in full mode even after zooming far out.
        // Its toolbar remains usable but becomes too small to be a reliable drag target;
        // let otherwise empty parts of the compact node body start a drag.
        const bounds = target.closest(".node-element")?.getBoundingClientRect();
        return Boolean(bounds && Math.min(bounds.width, bounds.height) <= 100);
    }
    return !interactive || explicitDragHandle || onVideoDragSurface;
}
