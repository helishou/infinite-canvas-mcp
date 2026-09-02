import type { PluginStorage } from "@/types/canvas-plugin";
import { deleteBackendPluginStorage, getBackendPluginStorage, setBackendPluginStorage } from "@/services/backend-api";

// Lightweight canvas event bus for communication between nodes and plugins.
type Handler = (payload: unknown) => void;
const handlers = new Map<string, Set<Handler>>();

export function emitCanvasEvent(event: string, payload?: unknown) {
    handlers.get(event)?.forEach((handler) => {
        try {
            handler(payload);
        } catch (error) {
            console.error(`[canvas-event] handler for "${event}" failed`, error);
        }
    });
}

export function onCanvasEvent(event: string, handler: Handler) {
    let set = handlers.get(event);
    if (!set) {
        set = new Set();
        handlers.set(event, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
}

// Private plugin storage isolated by pluginId namespace.
export function createPluginStorage(pluginId: string): PluginStorage {
    return {
        get: async <T>(key: string) => (await getBackendPluginStorage<T>(pluginId, key)).value,
        set: async (key, value) => { await setBackendPluginStorage(pluginId, key, value); },
        remove: async (key) => { await deleteBackendPluginStorage(pluginId, key); },
    };
}
