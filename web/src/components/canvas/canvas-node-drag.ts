const INTERACTIVE_NODE_TARGETS = "button, input, textarea, select, video, .ant-select-dropdown, [contenteditable='true'], [data-canvas-shortcuts-ignore]";

export function shouldStartCanvasNodeDrag(target: Element, isH3: boolean) {
    const interactive = target.closest(INTERACTIVE_NODE_TARGETS);
    const dragHandle = target.closest("[data-canvas-node-drag-handle]");
    const interactiveHandle = target.closest("[data-canvas-node-drag-interactive-handle]");
    const onResizeHandle = target.closest("[data-resize-handle]");
    const onConnectionHandle = target.closest("[data-connection-handle]");
    const onNodePanel = target.closest("[data-canvas-node-panel]");
    const explicitDragHandle = Boolean(dragHandle && (!interactive || interactiveHandle));

    if (onResizeHandle || onConnectionHandle || onNodePanel) return false;
    if (isH3) return explicitDragHandle;
    return !interactive || explicitDragHandle;
}
