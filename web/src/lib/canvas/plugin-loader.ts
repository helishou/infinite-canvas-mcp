import { registerNodeDefinitions, unregisterPluginNodes } from "@/lib/canvas/node-registry";
import { getPluginRuntime } from "@/lib/canvas/plugin-runtime";
import { usePluginStore, type InstalledPlugin } from "@/stores/canvas/use-plugin-store";
import { fetchBackendInstalledPlugins, saveBackendInstalledPlugins, saveBackendPluginMcpDeclarations } from "@/services/backend-api";
import type { AgentPluginMcpDeclaration } from "@/services/api/canvas-agent";
import type { CanvasPlugin } from "@/types/canvas-plugin";
import i18n from "@/i18n";
import { h3SystemPlugin } from "../../../../plugins/canvas/minimax-h3/src/system";

const cleanups = new Map<string, () => void>();
// 缓存已评估插件的 MCP 声明(用于启用/禁用时通知 Agent 动态注册/注销工具)
const evaluatedPlugins = new Map<string, CanvasPlugin>();
// Host system nodes use their live source manifest for MCP metadata. Their public bundles may
// contain bare imports and must not be evaluated again or replace the Vite-registered node.
const HOST_SYSTEM_PLUGINS = new Map<string, CanvasPlugin>([["minimax-h3", h3SystemPlugin as unknown as CanvasPlugin]]);
const HOST_SYSTEM_PLUGIN_IDS = new Set(HOST_SYSTEM_PLUGINS.keys());

// A remote plugin may export CanvasPlugin directly or a factory that receives runtime and returns CanvasPlugin.
// The factory uses runtime.React so the bundle does not need its own React copy.
async function evaluatePluginSource(source: string): Promise<CanvasPlugin> {
    const blob = new Blob([source], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    try {
        const mod = (await import(/* @vite-ignore */ url)) as { default?: unknown; plugin?: unknown };
        const exported = mod.default ?? mod.plugin;
        const plugin = typeof exported === "function" ? (exported as (runtime: unknown) => unknown)(getPluginRuntime()) : exported;
        assertPlugin(plugin);
        return plugin;
    } finally {
        URL.revokeObjectURL(url);
    }
}

function assertPlugin(plugin: unknown): asserts plugin is CanvasPlugin {
    const value = plugin as Partial<CanvasPlugin> | null;
    if (!value || typeof value !== "object") throw new Error(i18n.t("canvas.pluginErrors.invalidExport"));
    if (!value.id || !Array.isArray(value.nodes) || !value.nodes.length) throw new Error(i18n.t("canvas.pluginErrors.missingFields"));
}

export function activatePlugin(plugin: CanvasPlugin) {
    evaluatedPlugins.set(plugin.id, plugin);
    if (HOST_SYSTEM_PLUGIN_IDS.has(plugin.id)) return;
    registerNodeDefinitions(plugin.nodes, plugin.id);
    const runtime = getPluginRuntime();
    const disposers: Array<() => void> = [];
    // Inject declared styles when enabled and remove them when disabled or uninstalled.
    if (plugin.css) disposers.push(runtime.injectCSS(plugin.css, plugin.id));
    const cleanup = plugin.setup?.(runtime);
    if (typeof cleanup === "function") disposers.push(cleanup);
    if (disposers.length) cleanups.set(plugin.id, () => disposers.forEach((dispose) => dispose()));
}

export function deactivatePlugin(pluginId: string) {
    if (HOST_SYSTEM_PLUGIN_IDS.has(pluginId)) return;
    cleanups.get(pluginId)?.();
    cleanups.delete(pluginId);
    unregisterPluginNodes(pluginId);
}

async function fetchPluginSource(url: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(i18n.t("canvas.pluginErrors.downloadFailed", { status: response.status }));
    return response.text();
}

// Add a cache-busting parameter so watch builds load the latest output.
function withCacheBust(url: string) {
    return `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
}

// Install or replace a plugin from a URL and enable it immediately.
// bustCache bypasses HTTP/CDN caches during upgrades while persisting a clean URL without the timestamp query.
export async function installPluginFromUrl(url: string, opts?: { official?: boolean; bustCache?: boolean }) {
    const source = await fetchPluginSource(opts?.bustCache ? withCacheBust(url) : url);
    const plugin = await evaluatePluginSource(source);
    deactivatePlugin(plugin.id); // Replace the previous version.
    usePluginStore.getState().upsert({ id: plugin.id, name: plugin.name || plugin.id, version: plugin.version || "0.0.0", description: plugin.description, url, source, enabled: true, official: opts?.official });
    await persistInstalledPlugins();
    activatePlugin(plugin);
    void syncPluginMcpToBackend();
    return plugin;
}

export async function updatePlugin(record: InstalledPlugin) {
    // Upgrades must fetch the latest output and therefore always bypass caches.
    return installPluginFromUrl(record.url, { official: record.official, bustCache: true });
}

export async function setPluginEnabled(record: InstalledPlugin, enabled: boolean) {
    usePluginStore.getState().setEnabled(record.id, enabled);
    await persistInstalledPlugins();
    if (!enabled) {
        deactivatePlugin(record.id);
        void syncPluginMcpToBackend();
        return;
    }
    // Reload local plugins from their URL when enabled because the cached source may be stale.
    const source = record.local ? await fetchPluginSource(withCacheBust(record.url)) : record.source;
    const plugin = await evaluatePluginSource(source);
    activatePlugin(plugin);
    void syncPluginMcpToBackend();
}

export async function uninstallPlugin(id: string) {
    deactivatePlugin(id);
    usePluginStore.getState().remove(id);
    await persistInstalledPlugins();
    void syncPluginMcpToBackend();
}

/**
 * 将当前已启用插件的 MCP 声明直接写入 Backend SQLite。
 * Agent 与独立 MCP 进程都从 Backend 读取，不依赖浏览器中的 Agent 面板连接状态。
 */
async function syncPluginMcpToBackend() {
    try {
        const records = usePluginStore.getState().plugins;
        const plugins: AgentPluginMcpDeclaration[] = [...HOST_SYSTEM_PLUGINS.values()].flatMap((plugin) => (
            plugin.mcp ? [{ id: plugin.id, name: plugin.name, version: plugin.version, mcp: { tools: [...plugin.mcp.tools], enabled: true } }] : []
        ));
        for (const record of records) {
            if (HOST_SYSTEM_PLUGIN_IDS.has(record.id)) continue;
            const plugin = evaluatedPlugins.get(record.id);
            if (!plugin?.mcp || !record.enabled) continue;
            plugins.push({ id: record.id, name: record.name, version: record.version, mcp: { tools: [...plugin.mcp.tools], enabled: true } });
        }
        const updatedAt = new Date().toISOString();
        await saveBackendPluginMcpDeclarations(plugins.map((plugin) => ({
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            enabled: plugin.mcp.enabled,
            tools: plugin.mcp.tools,
            updatedAt,
        })));
    } catch (error) {
        console.warn("[plugin] Failed to sync MCP declarations", error);
    }
}

let loaded = false;
let loading: Promise<void> | null = null;

// Load installed and enabled plugins at application startup.
export async function ensurePluginsLoaded() {
    if (loaded) return;
    if (loading) return loading;
    loading = (async () => {
        let backendLoadSucceeded = false;
        try {
            try {
                usePluginStore.getState().setPlugins(((await fetchBackendInstalledPlugins()).plugins || []).filter((record) => !HOST_SYSTEM_PLUGIN_IDS.has(record.id)));
                backendLoadSucceeded = true;
            } catch (error) { console.warn("[plugin] Failed to load installed plugins", error); }
            await loadLocalPlugins(); // Discover disabled local plugins first, then activate all enabled records.
            const records = usePluginStore.getState().plugins.filter((record) => record.enabled);
            await Promise.all(
                records.map(async (record) => {
                    if (HOST_SYSTEM_PLUGIN_IDS.has(record.id)) return;
                    try {
                        // Local plugins use the latest output; other plugins use their cached source.
                        const source = record.local ? await fetchPluginSource(withCacheBust(record.url)) : record.source;
                        activatePlugin(await evaluatePluginSource(source));
                    } catch (error) {
                        console.warn(`[plugin] Failed to load: ${record.id}`, error);
                    }
                }),
            );
            await persistInstalledPlugins();
            await loadDevPlugins();
            await syncPluginMcpToBackend();
            loaded = backendLoadSucceeded;
        } finally {
            loading = null;
        }
    })();
    return loading;
}

async function persistInstalledPlugins() {
    try { await saveBackendInstalledPlugins(usePluginStore.getState().plugins); } catch (error) { console.warn("[plugin] Failed to persist installed plugins", error); }
}

// Discover local plugins from web/public/plugins, add them disabled, and expose them in the manager without a URL.
// Refresh metadata and source for existing records while preserving the enabled flag so persisted versions stay current.
async function loadLocalPlugins() {
    let urls: unknown;
    try {
        const response = await fetch("/plugins/index.json");
        if (!response.ok) return;
        urls = await response.json();
    } catch {
        return; // Skip when no local manifest exists, such as production builds without plugins.
    }
    if (!Array.isArray(urls) || !urls.length) return;
    const store = usePluginStore.getState();
    await Promise.all(
        urls.map(async (url: string) => {
            try {
                const localId = url.split("/").pop()?.replace(/\.js(?:\?.*)?$/, "") || "";
                if (HOST_SYSTEM_PLUGIN_IDS.has(localId)) return;
                const source = await fetchPluginSource(withCacheBust(url));
                const plugin = await evaluatePluginSource(source);
                const existing = store.plugins.find((item) => item.id === plugin.id);
                store.upsert({
                    id: plugin.id,
                    name: plugin.name || plugin.id,
                    version: plugin.version || "0.0.0",
                    description: plugin.description,
                    url,
                    source,
                    enabled: existing?.enabled ?? false,
                    local: true,
                });
            } catch (error) {
                console.warn(`[plugin] Failed to discover local plugin: ${url}`, error);
            }
        }),
    );
}

// During local development, refetch VITE_DEV_PLUGINS URLs without caching or persistence on every startup.
// Together with watch builds, refreshing the page loads code changes without reinstalling the plugin.
async function loadDevPlugins() {
    const raw = import.meta.env.VITE_DEV_PLUGINS;
    if (!raw) return;
    const urls = raw.split(",").map((item) => item.trim()).filter(Boolean);
    await Promise.all(
        urls.map(async (url) => {
            try {
                const source = await fetchPluginSource(withCacheBust(url));
                const plugin = await evaluatePluginSource(source);
                deactivatePlugin(plugin.id);
                activatePlugin(plugin);
                console.info(`[plugin] Dev plugin loaded: ${plugin.id} (${url})`);
            } catch (error) {
                console.warn(`[plugin] Failed to load dev plugin: ${url}`, error);
            }
        }),
    );
}
