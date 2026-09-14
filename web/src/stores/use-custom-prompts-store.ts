import { create } from "zustand";
import localforage from "localforage";
import { nanoid } from "nanoid";

import type { RawPrompt } from "@/services/api/prompt-source-runtime";
import { fetchStructuredSetting, saveStructuredSetting } from "@/services/settings-api";

const CUSTOM_PROMPTS_KEY = "custom-prompts-v1";
let loadPromise: Promise<void> | null = null;
let mutationQueue = Promise.resolve();

export const CUSTOM_PROMPTS_CATEGORY = "我的提示词";
export const CUSTOM_PROMPTS_SOURCE_ID = "custom";

export type NewCustomPrompt = {
    title: string;
    prompt: string;
    description?: string;
    tags?: string[];
    coverUrl?: string;
    referenceImageUrls?: string[];
};

type CustomPromptsStore = {
    prompts: RawPrompt[];
    loaded: boolean;
    load: () => Promise<void>;
    addPrompt: (input: NewCustomPrompt) => Promise<RawPrompt>;
    updatePrompt: (id: string, patch: Partial<RawPrompt>) => Promise<RawPrompt | null>;
    removePrompt: (id: string) => Promise<boolean>;
};

async function persist(prompts: RawPrompt[]) {
    await saveStructuredSetting("custom-prompts", prompts);
}

async function hydrateCustomPrompts() {
    let stored = await fetchStructuredSetting<RawPrompt[]>("custom-prompts");
    if (!stored) {
        const legacy = await localforage.getItem<RawPrompt[]>(CUSTOM_PROMPTS_KEY);
        if (Array.isArray(legacy)) {
            stored = legacy;
            await persist(legacy);
        }
    }
    await localforage.removeItem(CUSTOM_PROMPTS_KEY);
    useCustomPromptsStore.setState({ prompts: Array.isArray(stored) ? stored : [], loaded: true });
}

function enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = mutationQueue.then(mutation, mutation);
    mutationQueue = result.then(() => undefined, () => undefined);
    return result;
}

function makePrompt(input: NewCustomPrompt): RawPrompt {
    const now = new Date().toISOString();
    return {
        id: nanoid(),
        title: input.title.trim(),
        prompt: input.prompt.trim(),
        description: input.description?.trim() || "",
        coverUrl: input.coverUrl || "",
        referenceImageUrls: Array.isArray(input.referenceImageUrls) ? input.referenceImageUrls.filter(Boolean) : [],
        tags: (input.tags || []).map((tag) => tag.trim()).filter(Boolean),
        preview: "",
        createdAt: now,
        updatedAt: now,
    };
}

export const useCustomPromptsStore = create<CustomPromptsStore>((set, get) => ({
    prompts: [],
    loaded: false,
    load: async () => {
        if (get().loaded) return;
        if (!loadPromise) loadPromise = (async () => {
            await hydrateCustomPrompts();
        })().finally(() => { loadPromise = null; });
        await loadPromise;
    },
    addPrompt: (input) => enqueueMutation(async () => {
        await get().load();
        if (!input.title.trim() || !input.prompt.trim()) throw new Error("标题和正文不能为空");
        const prompt = makePrompt(input);
        const next = [prompt, ...get().prompts];
        await persist(next);
        set({ prompts: next });
        return prompt;
    }),
    updatePrompt: (id, patch) => enqueueMutation(async () => {
        await get().load();
        const list = get().prompts;
        const index = list.findIndex((item) => item.id === id);
        if (index < 0) return null;
        const merged: RawPrompt = { ...list[index], ...patch, id: list[index].id, updatedAt: new Date().toISOString() };
        if (typeof merged.title === "string") merged.title = merged.title.trim();
        if (typeof merged.prompt === "string") merged.prompt = merged.prompt.trim();
        if (typeof merged.description === "string") merged.description = merged.description.trim();
        if (Array.isArray(merged.tags)) merged.tags = merged.tags.map((tag) => String(tag).trim()).filter(Boolean);
        if (!merged.title || !merged.prompt) throw new Error("标题和正文不能为空");
        const next = [...list];
        next[index] = merged;
        await persist(next);
        set({ prompts: next });
        return merged;
    }),
    removePrompt: (id) => enqueueMutation(async () => {
        await get().load();
        const list = get().prompts;
        const next = list.filter((item) => item.id !== id);
        if (next.length === list.length) return false;
        await persist(next);
        set({ prompts: next });
        return true;
    }),
}));

if (typeof window !== "undefined") {
    window.addEventListener("backend-event", (event) => {
        const detail = (event as CustomEvent).detail as { type?: string; entityId?: string } | undefined;
        if (detail?.type === "settings.updated" && detail.entityId === "prompts.custom") void hydrateCustomPrompts();
    });
}
