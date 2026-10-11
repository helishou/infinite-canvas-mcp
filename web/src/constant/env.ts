export const APP_VERSION = __APP_VERSION__ || "dev";

export const DOCS_URL = import.meta.env.VITE_DOC_URL || "https://docs.canvas.best";

// Build and serve the official registry with this deployment by default; forks can point at another registry at build time.
export const PLUGIN_REGISTRY_URL = import.meta.env.VITE_PLUGIN_REGISTRY_URL || "/plugins/official-plugins.json";
