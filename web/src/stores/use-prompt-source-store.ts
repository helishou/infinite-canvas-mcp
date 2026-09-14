import { create } from "zustand";

import { DEFAULT_PROMPT_SOURCES, createPromptSource, type PromptSource } from "@/services/api/prompt-source-presets";
import { fetchStructuredSetting, saveStructuredSetting } from "@/services/settings-api";

export type PromptSourceSchedule = {
    intervalMinutes: number;
    lastFetchedAt: string;
};

const PROMPT_SOURCE_STORE_KEY = "infinite-canvas:prompt_source_store_v2";
let promptSourceSyncQueue = Promise.resolve();

const defaultSchedule: PromptSourceSchedule = {
    intervalMinutes: 30,
    lastFetchedAt: "",
};

export const PROMPT_SOURCE_INTERVALS = [0, 30, 60, 360, 1440];

type PromptSourceStore = {
    sources: PromptSource[];
    schedule: PromptSourceSchedule;
    hydrated: boolean;
    addSource: () => PromptSource;
    saveSource: (source: PromptSource) => void;
    removeSource: (id: string) => void;
    toggleSource: (id: string, enabled: boolean) => void;
    updateSchedule: <K extends keyof PromptSourceSchedule>(key: K, value: PromptSourceSchedule[K]) => void;
    replacePromptSources: (value: StoredPromptSources) => void;
};

export type StoredPromptSources = {
    sources: PromptSource[];
    schedule: PromptSourceSchedule;
};

function normalizeStoredPromptSources(value?: Partial<StoredPromptSources> | null): StoredPromptSources {
    const savedSources = Array.isArray(value?.sources) ? value.sources : [];
    const enabledById = new Map(savedSources.map((source) => [source.id, source.enabled]));
    const builtIn = DEFAULT_PROMPT_SOURCES.map((source) => ({ ...source, enabled: enabledById.get(source.id) ?? source.enabled }));
    const custom = savedSources.filter((source) => !source.builtIn).map((source) => createPromptSource(source));
    return { sources: [...builtIn, ...custom], schedule: { ...defaultSchedule, ...(value?.schedule || {}) } };
}

function readLegacyPromptSources(): StoredPromptSources | null {
    try {
        const stored = JSON.parse(localStorage.getItem(PROMPT_SOURCE_STORE_KEY) || "null") as { state?: Partial<StoredPromptSources> } | null;
        return stored?.state ? normalizeStoredPromptSources(stored.state) : null;
    } catch {
        return null;
    }
}

function persistPromptSources(state: Pick<PromptSourceStore, "sources" | "schedule">) {
    promptSourceSyncQueue = promptSourceSyncQueue
        .then(() => saveStructuredSetting("prompt-sources", { sources: state.sources, schedule: state.schedule }))
        .catch(() => undefined);
}

export async function hydratePromptSourcesFromBackend(): Promise<boolean> {
    if (typeof window === "undefined") return false;
    try {
        let stored = await fetchStructuredSetting<StoredPromptSources>("prompt-sources");
        if (!stored) {
            stored = readLegacyPromptSources();
            if (stored) await saveStructuredSetting("prompt-sources", stored);
        }
        usePromptSourceStore.setState({ ...normalizeStoredPromptSources(stored), hydrated: true });
        localStorage.removeItem(PROMPT_SOURCE_STORE_KEY);
        return true;
    } catch {
        return false;
    }
}

export const usePromptSourceStore = create<PromptSourceStore>((set, get) => ({
    sources: DEFAULT_PROMPT_SOURCES,
    schedule: defaultSchedule,
    hydrated: false,
    addSource: () => createPromptSource(),
    saveSource: (source) => {
        set((state) => ({
            sources: state.sources.some((item) => item.id === source.id)
                ? state.sources.map((item) => (item.id === source.id && !item.builtIn ? createPromptSource(source) : item))
                : [...state.sources, createPromptSource(source)],
        }));
        persistPromptSources(get());
    },
    removeSource: (id) => {
        set((state) => ({ sources: state.sources.filter((item) => item.id !== id || item.builtIn) }));
        persistPromptSources(get());
    },
    toggleSource: (id, enabled) => {
        set((state) => ({ sources: state.sources.map((item) => (item.id === id ? { ...item, enabled } : item)) }));
        persistPromptSources(get());
    },
    updateSchedule: (key, value) => {
        set((state) => ({ schedule: { ...state.schedule, [key]: value } }));
        persistPromptSources(get());
    },
    replacePromptSources: (value) => {
        const next = normalizeStoredPromptSources(value);
        set({ ...next, hydrated: true });
        persistPromptSources(next);
    },
}));

if (typeof window !== "undefined") {
    window.addEventListener("backend-event", (event) => {
        const detail = (event as CustomEvent).detail as { type?: string; entityId?: string } | undefined;
        if (detail?.type === "settings.updated" && detail.entityId === "prompt.sources") void hydratePromptSourcesFromBackend();
    });
}
