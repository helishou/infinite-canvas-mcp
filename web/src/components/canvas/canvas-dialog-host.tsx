import { Children, isValidElement, lazy, Suspense, type ReactNode } from "react";

export const CanvasNodeAngleDialog = lazy(() => import("@/components/canvas/canvas-node-angle-dialog").then((module) => ({ default: module.CanvasNodeAngleDialog })));
export const CanvasNodeCropDialog = lazy(() => import("@/components/canvas/canvas-node-crop-dialog").then((module) => ({ default: module.CanvasNodeCropDialog })));
export const CanvasNodeMaskEditDialog = lazy(() => import("@/components/canvas/canvas-node-mask-edit-dialog").then((module) => ({ default: module.CanvasNodeMaskEditDialog })));
export const CanvasNodeSplitDialog = lazy(() => import("@/components/canvas/canvas-node-split-dialog").then((module) => ({ default: module.CanvasNodeSplitDialog })));
export const CanvasNodeUpscaleDialog = lazy(() => import("@/components/canvas/canvas-node-upscale-dialog").then((module) => ({ default: module.CanvasNodeUpscaleDialog })));
export const CanvasPluginManagerModal = lazy(() => import("@/components/canvas/canvas-plugin-manager-modal").then((module) => ({ default: module.CanvasPluginManagerModal })));
export const CanvasGenerationLogDialog = lazy(() => import("@/components/canvas/canvas-generation-log-dialog").then((module) => ({ default: module.CanvasGenerationLogDialog })));
export const CharacterNodeEditModal = lazy(() => import("@/components/canvas/character-node-edit-modal").then((module) => ({ default: module.CharacterNodeEditModal })));
export const SceneNodeEditModal = lazy(() => import("@/components/canvas/scene-node-edit-modal").then((module) => ({ default: module.SceneNodeEditModal })));
export const PropNodeEditModal = lazy(() => import("@/components/canvas/prop-node-edit-modal").then((module) => ({ default: module.PropNodeEditModal })));
export const CanvasVideoCompareModal = lazy(() => import("@/components/canvas/canvas-video-compare-modal").then((module) => ({ default: module.CanvasVideoCompareModal })));
export const AssetPickerModal = lazy(() => import("@/components/canvas/asset-picker-modal").then((module) => ({ default: module.AssetPickerModal })));
export const CanvasNodePromptPanel = lazy(() => import("@/components/canvas/canvas-node-prompt-panel").then((module) => ({ default: module.CanvasNodePromptPanel })));

/** Keeps each lazy dialog in its own null-fallback boundary so one loading chunk cannot hide sibling dialogs. */
export function CanvasDialogHost({ children }: { children: ReactNode }) {
    return (
        <>
            {Children.toArray(children).map((dialog, index) =>
                isValidElement(dialog) ? (
                    <Suspense key={dialog.key ?? `canvas-dialog-${index}`} fallback={null}>
                        {dialog}
                    </Suspense>
                ) : (
                    dialog
                ),
            )}
        </>
    );
}
