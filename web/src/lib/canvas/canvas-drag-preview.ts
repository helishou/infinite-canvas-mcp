import { useCallback, useSyncExternalStore } from "react";

import type { Position } from "@/types/canvas";

export type CanvasResizePreviewBounds = { width: number; height: number; position: Position };

const previewsByProject = new Map<string, Map<string, Position>>();
const listenersByNode = new Map<string, Set<() => void>>();
const dragPreviewVersionsByNode = new Map<string, number>();
const resizePreviewsByProject = new Map<string, Map<string, CanvasResizePreviewBounds>>();
const nodePreviewListenersByNode = new Map<string, Set<() => void>>();
const nodePreviewVersionsByNode = new Map<string, number>();

function listenerKey(projectId: string, nodeId: string) {
    return `${projectId}\0${nodeId}`;
}

function notify(projectId: string, nodeId: string) {
    const key = listenerKey(projectId, nodeId);
    const listeners = listenersByNode.get(key);
    if (!listeners?.size) return;
    dragPreviewVersionsByNode.set(key, (dragPreviewVersionsByNode.get(key) || 0) + 1);
    listeners.forEach((listener) => listener());
}

function notifyNodePreview(projectId: string, nodeId: string) {
    const key = listenerKey(projectId, nodeId);
    const listeners = nodePreviewListenersByNode.get(key);
    if (!listeners?.size) return;
    nodePreviewVersionsByNode.set(key, (nodePreviewVersionsByNode.get(key) || 0) + 1);
    listeners.forEach((listener) => listener());
}

export function getCanvasDragPreviewPosition(projectId: string, nodeId: string) {
    return previewsByProject.get(projectId)?.get(nodeId);
}

/** 更新拖动中的节点坐标，只通知实际移动或刚刚结束移动的节点。 */
export function writeCanvasDragPreview(projectId: string, positions: ReadonlyMap<string, Position>) {
    const current = previewsByProject.get(projectId);
    if (!positions.size) {
        if (!current?.size) return;
        const previousIds = [...current.keys()];
        previewsByProject.delete(projectId);
        previousIds.forEach((nodeId) => {
            notify(projectId, nodeId);
            notifyNodePreview(projectId, nodeId);
        });
        return;
    }

    const next = current || new Map<string, Position>();
    const changedIds = new Set<string>();
    for (const nodeId of next.keys()) {
        if (!positions.has(nodeId)) {
            next.delete(nodeId);
            changedIds.add(nodeId);
        }
    }
    positions.forEach((position, nodeId) => {
        const previous = next.get(nodeId);
        if (!previous || previous.x !== position.x || previous.y !== position.y) {
            next.set(nodeId, position);
            changedIds.add(nodeId);
        }
    });
    if (!next.size) previewsByProject.delete(projectId);
    else previewsByProject.set(projectId, next);
    changedIds.forEach((nodeId) => {
        notify(projectId, nodeId);
        notifyNodePreview(projectId, nodeId);
    });
}

export function clearCanvasDragPreview(projectId: string) {
    writeCanvasDragPreview(projectId, new Map());
}

export function getCanvasResizePreviewBounds(projectId: string, nodeId: string) {
    return resizePreviewsByProject.get(projectId)?.get(nodeId);
}

/** 更新缩放中的节点尺寸，只通知实际变化的节点。 */
export function writeCanvasResizePreview(projectId: string, boundsByNode: ReadonlyMap<string, CanvasResizePreviewBounds>) {
    const current = resizePreviewsByProject.get(projectId);
    if (!boundsByNode.size) {
        if (!current?.size) return;
        const previousIds = [...current.keys()];
        resizePreviewsByProject.delete(projectId);
        previousIds.forEach((nodeId) => {
            notifyNodePreview(projectId, nodeId);
        });
        return;
    }

    const next = current || new Map<string, CanvasResizePreviewBounds>();
    const changedIds = new Set<string>();
    for (const nodeId of next.keys()) {
        if (!boundsByNode.has(nodeId)) {
            next.delete(nodeId);
            changedIds.add(nodeId);
        }
    }
    boundsByNode.forEach((bounds, nodeId) => {
        const previous = next.get(nodeId);
        if (!previous || previous.width !== bounds.width || previous.height !== bounds.height || previous.position.x !== bounds.position.x || previous.position.y !== bounds.position.y) {
            next.set(nodeId, bounds);
            changedIds.add(nodeId);
        }
    });
    if (!next.size) resizePreviewsByProject.delete(projectId);
    else resizePreviewsByProject.set(projectId, next);
    changedIds.forEach((nodeId) => {
        notifyNodePreview(projectId, nodeId);
    });
}

export function clearCanvasResizePreview(projectId: string) {
    writeCanvasResizePreview(projectId, new Map());
}

/** 节点本体同时需要拖动和缩放预览时，只建立一套订阅。 */
export function useCanvasNodePreview(projectId: string, nodeId: string) {
    const subscribe = useCallback((listener: () => void) => {
        const key = listenerKey(projectId, nodeId);
        const listeners = nodePreviewListenersByNode.get(key) || new Set<() => void>();
        listeners.add(listener);
        nodePreviewListenersByNode.set(key, listeners);
        return () => {
            listeners.delete(listener);
            if (!listeners.size) {
                nodePreviewListenersByNode.delete(key);
                nodePreviewVersionsByNode.delete(key);
            }
        };
    }, [nodeId, projectId]);
    const getSnapshot = useCallback(() => nodePreviewVersionsByNode.get(listenerKey(projectId, nodeId)) || 0, [nodeId, projectId]);
    useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return {
        dragPreviewPosition: getCanvasDragPreviewPosition(projectId, nodeId),
        resizePreviewBounds: getCanvasResizePreviewBounds(projectId, nodeId),
    };
}

/** 一条连线/参考线的两个端点共用一次订阅，端点任一移动时仍会触发重绘。 */
export function useCanvasDragPreviewPair(projectId: string, fromNodeId: string, toNodeId: string) {
    const fromKey = listenerKey(projectId, fromNodeId);
    const toKey = listenerKey(projectId, toNodeId);
    const subscribe = useCallback((listener: () => void) => {
        const keys = fromKey === toKey ? [fromKey] : [fromKey, toKey];
        const cleanups = keys.map((key) => {
            const listeners = listenersByNode.get(key) || new Set<() => void>();
            listeners.add(listener);
            listenersByNode.set(key, listeners);
            return () => {
                listeners.delete(listener);
                if (!listeners.size) {
                    listenersByNode.delete(key);
                    dragPreviewVersionsByNode.delete(key);
                }
            };
        });
        return () => cleanups.forEach((cleanup) => cleanup());
    }, [fromKey, toKey]);
    const getSnapshot = useCallback(() => `${dragPreviewVersionsByNode.get(fromKey) || 0}:${dragPreviewVersionsByNode.get(toKey) || 0}`, [fromKey, toKey]);
    useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return {
        fromPosition: getCanvasDragPreviewPosition(projectId, fromNodeId),
        toPosition: getCanvasDragPreviewPosition(projectId, toNodeId),
    };
}
