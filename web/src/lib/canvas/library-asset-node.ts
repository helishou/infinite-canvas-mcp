import { libraryAssetNode as nodeFromAsset } from "@basketikun/canvas-agent/shared-asset-reference";
import type { Asset } from "@/stores/use-asset-store";
import type { CanvasNodeData } from "@/types/canvas";

/** The same field mapping is used by Backend and the canvas insertion preview. */
export function libraryAssetNode(asset: Asset): Omit<CanvasNodeData, "position" | "width" | "height"> {
    return nodeFromAsset(asset) as Omit<CanvasNodeData, "position" | "width" | "height">;
}
