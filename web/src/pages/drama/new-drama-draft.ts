import localforage from "localforage";
import { dramaProductionPlanSchema, type DramaProductionPlan } from "@basketikun/canvas-agent/drama/production-contract";

import type { StudioProductionSettings } from "@/pages/drama-studio/studio-settings-store";

/**
 * 新建短剧整页的草稿：离开页面或停笔 700ms 就存「原文 + 选题 + 分集 + 模型选择 + 制作设置」，
 * 下次打开 /drama-studio/new 自动回填（保存草稿按钮也写同一份）。
 *
 * 原文可能有几十万字，放 localforage 的大对象存储，不用只装小配置的 localStorage。
 * 上传的风格参考图是浏览器 File，跨会话留不住，这里不存，回来重选即可。
 * studio 与创建后写进剧目的制作设置是同一份字段（studio-settings-store），刷新恢复后再创建
 * 得到的就是刷新前看到的配置。
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
    /** 文字步骤 / 参考图 / 分镜规则 / 审阅与生成节奏的选择；老草稿没有该字段时按默认补。 */
    studio: StudioProductionSettings;
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
