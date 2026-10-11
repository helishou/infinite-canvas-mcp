import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export type CanvasNodePromptField = "prompt" | "composerContent";

export function resolveCanvasNodePromptField(nodeType: CanvasNodeData["type"], hasExistingContent: boolean): CanvasNodePromptField {
    return nodeType === CanvasNodeType.Config || (hasExistingContent && nodeType !== CanvasNodeType.Image) ? "composerContent" : "prompt";
}
