import localforage from "localforage";
import { dramaProductionPlanSchema, type DramaProductionPlan } from "@basketikun/canvas-agent/drama/production-contract";

/**
 * 新建剧目面板的草稿：关掉弹窗不丢「原文 + 选题 + 分集 + 模型选择」。
 *
 * 原文可能有几十万字，放 localforage 的大对象存储，不用只装小配置的 localStorage。
 * 上传的风格参考图是浏览器 File，跨会话留不住，这里不存，回来重选即可。
 */
const store = localforage.createInstance({ name: "infinite-canvas", storeName: "drama_new_draft" });
const KEY = "new-drama";

export type NewDramaStyleMode = "upload" | "prompt" | "none";

export type NewDramaDraft = {
    name: string;
    plan: DramaProductionPlan;
    styleMode: NewDramaStyleMode;
    stylePrompt: string;
    autoEpisodes: boolean;
    handoff: boolean;
    step: number;
    savedAt: string;
};

export async function readNewDramaDraft(): Promise<NewDramaDraft | null> {
    try {
        const raw = await store.getItem<NewDramaDraft>(KEY);
        if (!raw) return null;
        // 老草稿里的 plan 可能缺新字段，按当前 schema 收敛一次再回填。
        return { ...raw, plan: dramaProductionPlanSchema.parse(raw.plan || {}) };
    } catch {
        await store.removeItem(KEY).catch(() => undefined);
        return null;
    }
}

export async function writeNewDramaDraft(draft: Omit<NewDramaDraft, "savedAt">) {
    try {
        await store.setItem(KEY, { ...draft, savedAt: new Date().toISOString() });
    } catch {
        // 配额不够就不存草稿，不打断创建。
    }
}

export async function clearNewDramaDraft() {
    await store.removeItem(KEY).catch(() => undefined);
}

/** 只开了面板什么都没填就关掉时不留空草稿。 */
export function newDramaDraftHasContent(draft: { name: string; plan: DramaProductionPlan }) {
    const topic = draft.plan.topic;
    return Boolean(draft.name.trim() || String(draft.plan.sourceScript || "").trim() || topic?.themes?.length || topic?.logline?.trim());
}
