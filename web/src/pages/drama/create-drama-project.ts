import type { TFunction } from "i18next";
import { nanoid } from "nanoid";

import type { DramaProductionPlan } from "@basketikun/canvas-agent/drama/production-contract";
import { resolveStudioSettings, saveStudioSettings, type StudioProductionSettings } from "@/pages/drama-studio/studio-settings-store";
import { splitSourceIntoEpisodes } from "@/lib/drama/adapt";
import {
    applyBackendCanvasOperations,
    createBackendDramaEpisode,
    ensureSharedAssetCanvas,
    startCanvasGeneration,
    upsertBackendCanvasFolder,
} from "@/services/backend-api";
import { uploadImage, type UploadedImage } from "@/services/image-storage";
import { useCanvasStore, type CanvasFolder } from "@/stores/canvas/use-canvas-store";

import type { NewDramaStyleMode } from "./new-drama-draft";
import { planningPrompt, stashPlanningHandoff } from "./planning-director-launch";

/**
 * 新建剧目的提交链：建本地剧目 → 同步 Backend → 建共享资产画布 → 放画风锚点 → 按集数建空分集 → 交给导演。
 *
 * 这段逻辑原来整个写在 `pages/drama/index.tsx` 的创建弹窗里。现在新建改成整页
 * `new-drama-page.tsx`，把调用链原样搬到这里复用：入口换了承载形态，真实接口
 * （Backend 同步、共享资产画布、上传与出图、建集）与顺序都不变。
 * 页面只负责收集表单，不在页面里另写一套创建。
 */

export type DramaCreationSession = {
    folderId: string;
    image?: UploadedImage;
    imageNodeId: string;
    operationId: string;
    taskKey: string;
    mode: NewDramaStyleMode;
    prompt: string;
    plan: DramaProductionPlan;
};

export type CreateDramaProjectInput = {
    name: string;
    plan: DramaProductionPlan;
    styleMode: NewDramaStyleMode;
    styleImageFile?: File;
    stylePrompt: string;
    autoEpisodes: boolean;
    handoff: boolean;
    /**
     * 新建页选的制作设置（文字步骤 / 参考图 / 分镜规则 / 审阅与生成节奏）。
     * 创建成功后按剧目 ID 写进制作台「制作设置」同一落点（localStorage drama-studio:settings:<id>），
     * 打开设置页看到的就是创建时选的配置，不是只存在新页面 state 里。
     */
    studioSettings?: Partial<StudioProductionSettings>;
    /** 当前页面 query，创建后跳转时保留（例如新制作台的 worktab 参数）。 */
    search?: string;
    t: TFunction;
    message: { warning: (content: string) => void };
    /**
     * 失败重试时复用上一次已经建好的剧目，避免连点「创建」建出第二个空剧目。
     * 页面用 ref 持有它，成功后由页面清空；函数本身不存跨调用状态。
     */
    session?: { current?: DramaCreationSession };
};

export type CreateDramaProjectResult = { folderId: string; destination: string };

/** 建剧并返回要落的地址；有原文落到「原剧本」页签，勾了交导演落到规划页。 */
export async function createDramaProject(input: CreateDramaProjectInput): Promise<CreateDramaProjectResult> {
    const { name, plan, styleMode, styleImageFile, stylePrompt, autoEpisodes, handoff, search = "", t, message } = input;
    const sessionRef = input.session ?? {};
    let session = sessionRef.current;
    if (!session) {
        const uploaded = styleMode === "upload" && styleImageFile ? await uploadImage(styleImageFile, { category: "library" }) : undefined;
        const imageNodeId = styleMode !== "none" ? nanoid() : "";
        const creationPlan = {
            ...plan,
            ...(imageNodeId ? { styleAnchorNodeId: imageNodeId } : {}),
        } as DramaProductionPlan;
        const folderId = useCanvasStore.getState().createFolder(name, true, creationPlan);
        session = { folderId, image: uploaded, imageNodeId, operationId: nanoid(), taskKey: nanoid(), mode: styleMode, prompt: stylePrompt.trim(), plan: creationPlan };
        sessionRef.current = session;
    }

    const folder = useCanvasStore.getState().folders.find(item => item.id === session!.folderId);
    if (!folder) throw new Error("新剧目已创建，但读取不到本地剧目信息");
    const saved = await upsertBackendCanvasFolder(folder as unknown as Record<string, unknown>);
    if (saved.folder) {
        useCanvasStore.setState(state => ({
            folders: state.folders.map(item => item.id === session!.folderId ? saved.folder as unknown as CanvasFolder : item),
        }));
    }

    // 共享资产画布是新制作台资产库的真值容器：无论有没有风格图都必须建（styleMode=none 也要），
    // ensure 幂等（已绑定直接返回），保证从原文新建的剧目天然具备共享资产画布。
    const { project } = await ensureSharedAssetCanvas(session.folderId);
    if (session.imageNodeId) {
        const image = session.image;
        const node = session.mode === "prompt"
            ? { type: "add_node", id: session.imageNodeId, nodeType: "config", title: t("drama.createProjectStyleNode"), position: { x: 0, y: 0 }, width: 360, height: 260, metadata: { smart: true, generationMode: "image", prompt: session.prompt, composerContent: session.prompt, model: session.plan.imageModelsByKind.style || session.plan.imageModel || undefined, status: "idle", generationType: "generation", count: 1, styleMother: true } }
            : { type: "add_node", id: session.imageNodeId, nodeType: "image", title: t("drama.createProjectStyleNode"), position: { x: 0, y: 0 }, width: 360, height: Math.max(220, Math.min(420, 360 * ((image?.height || 1) / Math.max(1, image?.width || 1)))), metadata: { content: image?.url, storageKey: image?.storageKey, status: "success", naturalWidth: image?.width, naturalHeight: image?.height, bytes: image?.bytes, mimeType: image?.mimeType, styleMother: true } };
        await applyBackendCanvasOperations(String(project.id), [node], Number(project.revision || 0), session.operationId);
        if (session.mode === "prompt") {
            await startCanvasGeneration({ mode: "image", projectId: String(project.id), nodeId: session.imageNodeId, model: session.plan.imageModelsByKind.style || session.plan.imageModel || undefined, prompt: session.prompt, count: 1, clientTaskId: session.taskKey, idempotencyKey: session.taskKey });
        }
    }

    const episodeCount = autoEpisodes ? Number(session.plan.topic?.episodes || 0) : 0;
    // 原文拆集不在建剧时做：原文与分集口径只进规划契约，建集统一在
    // 「剧目规划 · 原剧本」点「批量建集」，用的是同一份拆章结果，不做第二套。
    const split = splitSourceIntoEpisodes(session.plan.sourceScript || "", session.plan.sourceSplit);
    if (!split.groups.length) {
        for (let number = 1; number <= episodeCount; number += 1) {
            try {
                await createBackendDramaEpisode(session.folderId, { episodeNumber: number });
            } catch (error) {
                message.warning(`${t("newDrama.episodeFailed", { number })}：${error instanceof Error ? error.message : String(error)}`);
                break;
            }
        }
    }
    if (handoff) {
        stashPlanningHandoff(session.folderId, planningPrompt("outline", {
            dramaId: session.folderId,
            name: session.plan.topic?.logline ? `${name}` : name,
            pendingEpisodes: Array.from({ length: episodeCount }, (_, index) => index + 1),
        }));
    }
    // 制作设置落到该剧目的真值位置（与设置页「保存设置」同一 key、同一份字段），
    // 创建后打开设置页看到的就是这里选的文字步骤 / 参考图模型 / 分镜规则 / 审阅与生成节奏。
    if (input.studioSettings) {
        try {
            saveStudioSettings(session.folderId, resolveStudioSettings(input.studioSettings));
        } catch {
            // localStorage 写不进去（隐私模式/配额）时不阻断建剧，设置页仍可按默认值再改。
        }
    }

    // 新建页就在新制作台下，创建完直接进新制作台；有原文时落到「原剧本」页签，
    // 勾了交导演落到规划页——与旧弹窗在制作台内创建后的落点一致。
    const query = new URLSearchParams(search);
    query.set("dramaId", session.folderId);
    query.delete("episodeId");
    query.delete("new");
    if (split.groups.length) {
        query.set("workspace", "series");
        query.set("seriesView", "planning");
        query.set("seriesTab", "source");
    } else if (handoff) {
        query.set("workspace", "series");
        query.set("seriesView", "planning");
    }
    return { folderId: session.folderId, destination: `/drama-studio?${query.toString()}` };
}
