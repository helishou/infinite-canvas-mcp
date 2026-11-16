import type { BackendGenerationLog, BackendRuntimeTask } from "@/services/backend-api";
import type { CanvasFolder, CanvasProject } from "@/stores/canvas/use-canvas-store";

export type WorkbenchMedia = { kind: "image" | "video" | "audio"; storageKey?: string; url?: string };
export type WorkbenchOutput = WorkbenchMedia & { id: string; log: BackendGenerationLog };

export function retainProjectCovers(current: Record<string, WorkbenchMedia>, candidates: Array<{ key: string; media: WorkbenchMedia | null }>) {
    let next = current;
    for (const candidate of candidates) {
        if (!candidate.media || Object.hasOwn(current, candidate.key)) continue;
        if (next === current) next = { ...current };
        next[candidate.key] = candidate.media;
    }
    return next;
}

export function outputMedia(value: Record<string, unknown>): WorkbenchMedia | null {
    const storageKey = typeof value.storageKey === "string" ? value.storageKey : undefined;
    const url = [value.url, value.localUrl, value.content].find((v): v is string => typeof v === "string" && /^(https?:|blob:|data:(image|video|audio)\/|\/)/.test(v));
    if (!storageKey && !url) return null;
    const type = String(value.mimeType || value.type || "").toLowerCase();
    const hint = `${storageKey || ""} ${url?.split(/[?#]/)[0] || ""}`;
    const kind = /^(video)(\/|$)/.test(type)
        ? "video"
        : /^(audio)(\/|$)/.test(type)
          ? "audio"
          : /^(image)(\/|$)/.test(type)
            ? "image"
            : /\.(mp4|webm|mov|m4v)(\s|$)/i.test(hint) || storageKey?.startsWith("video:")
              ? "video"
              : /\.(mp3|wav|m4a|ogg|flac)(\s|$)/i.test(hint) || storageKey?.startsWith("audio:")
                ? "audio"
                : /\.(png|jpe?g|webp|gif|avif)(\s|$)/i.test(hint) || storageKey?.startsWith("image:") || url?.startsWith("data:image/")
                  ? "image"
                  : null;
    return kind ? { kind, storageKey, url } : null;
}

export function collectOutputs(logs: BackendGenerationLog[]): WorkbenchOutput[] {
    return [...logs]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .flatMap((log) =>
            log.status === "success"
                ? log.outputs.flatMap((output, index) => {
                      const media = outputMedia(output);
                      return media ? [{ ...media, id: `${log.id}:${index}`, log }] : [];
                  })
                : [],
        );
}

export function projectCover(project: CanvasProject, outputs: WorkbenchOutput[], folder?: CanvasFolder): WorkbenchMedia | null {
    const result = outputs.find((output) => output.log.projectId === project.id && output.kind === "image") || outputs.find((output) => output.log.projectId === project.id && output.kind === "video");
    if (result) return result;
    if (folder?.isDrama && folder.coverStorageKey) return { kind: "image", storageKey: folder.coverStorageKey };
    // Only inspect already-loaded nodes. The home page must not hydrate every canvas for a cover.
    for (const node of project.nodes) {
        const metadata = node.metadata;
        if (!metadata) continue;
        if (metadata.sceneImage) return { kind: "image", ...metadata.sceneImage };
        if (metadata.propImage) return { kind: "image", ...metadata.propImage };
        const characterImages = metadata.characterImages || [];
        const character = characterImages[Math.min(Math.max(metadata.characterPrimaryIndex || 0, 0), Math.max(characterImages.length - 1, 0))];
        if (character) return { kind: "image", ...character };
        const imageMode = node.type === "image" || (node.type === "config" && metadata.smart && (metadata.generationMode || "image") === "image");
        const primaryImage = imageMode ? metadata.images?.find((image) => image.id === metadata.primaryImageId) || metadata.images?.find((image) => image.status === "success") : undefined;
        if (primaryImage) return { kind: "image", storageKey: primaryImage.storageKey, url: primaryImage.content };
        const media = outputMedia({ ...metadata, type: node.type });
        if (media && media.kind !== "audio") return media;
    }
    return null;
}

/** 本轮提交用到的参考素材（影策 creation-user-message-references）。只落小体积 URL / storageKey，不存 data URL。 */
export type CreativeLaunchReference = {
    id: string;
    title: string;
    url: string;
    storageKey?: string;
    kind: "image" | "video" | "audio" | "file";
};

export type CreativeLaunch = {
    taskId: string;
    /** 旧版本每条提交都会自动建画布；新版本对话阶段不建画布，只有点「新建画布」后才回填。 */
    projectId?: string;
    nodeId?: string;
    mode: "image" | "video" | "text" | "audio";
    prompt: string;
    model: string;
    createdAt: string;
    params: { count?: number; size?: string; seconds?: string; resolution?: string };
    /** 用户消息下方的引用缩略图行，最多 5 项；历史记录没有该字段时静默降级为不显示。 */
    references?: CreativeLaunchReference[];
};

export type CreativeConversation = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    /** 用户显式点「新建画布」后落地的项目 id；对话阶段为空。 */
    canvasId?: string;
    launches: CreativeLaunch[];
};

export const CREATIVE_LAUNCH_LIMIT = 6;
export const CREATIVE_LAUNCH_STORAGE_KEY = "home-creative-launches";
export const CREATIVE_CONVERSATION_STORAGE_KEY = "home-creative-conversations";
const CREATIVE_LAUNCH_TTL_MS = 24 * 60 * 60 * 1000;

export function nextCreativeLaunches(current: readonly CreativeLaunch[], launch: CreativeLaunch): CreativeLaunch[] {
    return [launch, ...current.filter(item => item.taskId !== launch.taskId)].slice(0, CREATIVE_LAUNCH_LIMIT);
}

export function pruneCreativeLaunches(list: readonly CreativeLaunch[], now: number): CreativeLaunch[] {
    return list.filter(item => {
        const created = Date.parse(item.createdAt);
        return Number.isFinite(created) && now - created < CREATIVE_LAUNCH_TTL_MS;
    });
}

function isCreativeLaunch(value: unknown): value is CreativeLaunch {
    if (!value || typeof value !== "object") return false;
    const item = value as Record<string, unknown>;
    return typeof item.taskId === "string" && item.taskId.length > 0
        && (item.projectId === undefined || (typeof item.projectId === "string" && item.projectId.length > 0))
        && (item.nodeId === undefined || typeof item.nodeId === "string")
        && typeof item.prompt === "string"
        && typeof item.model === "string"
        && typeof item.createdAt === "string"
        && ["image", "video", "text", "audio"].includes(item.mode as string)
        && (item.params === undefined || (typeof item.params === "object" && item.params !== null))
        // 旧会话没有 references；带上时必须是最多 5 项且字段完整，避免脏数据把消息流渲染崩。
        && (item.references === undefined || (Array.isArray(item.references) && item.references.length <= 5 && item.references.every((value: unknown) => {
            const reference = value as Record<string, unknown> | null;
            return !!reference && typeof reference.id === "string" && typeof reference.title === "string" && typeof reference.url === "string";
        })));
}

export function readCreativeLaunches(storage: Pick<Storage, "getItem"> | undefined, now: number): CreativeLaunch[] {
    try {
        const raw = storage?.getItem(CREATIVE_LAUNCH_STORAGE_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return pruneCreativeLaunches(parsed.filter(isCreativeLaunch), now).slice(0, CREATIVE_LAUNCH_LIMIT);
    } catch {
        return [];
    }
}

export function writeCreativeLaunches(storage: Pick<Storage, "setItem"> | undefined, list: readonly CreativeLaunch[]): void {
    try {
        storage?.setItem(CREATIVE_LAUNCH_STORAGE_KEY, JSON.stringify(list));
    } catch {
        // 持久化失败不影响本次会话内的动态展示。
    }
}

/** 会话数量上限：与影策一致按最近保留，旧会话随 TTL 自然淘汰。 */
export const CREATIVE_CONVERSATION_LIMIT = 20;

function conversationTitle(launches: readonly CreativeLaunch[]): string {
    return launches[0]?.prompt.trim().slice(0, 24) || "对话";
}

/** 旧 launches 列表迁移成一个会话，避免升级后历史凭空消失。 */
export function migrateLaunchesToConversation(launches: readonly CreativeLaunch[]): CreativeConversation[] {
    if (!launches.length) return [];
    const sorted = [...launches].reverse();
    return [{
        id: "migrated",
        title: conversationTitle(sorted),
        createdAt: sorted[0].createdAt,
        updatedAt: sorted[sorted.length - 1].createdAt,
        launches: sorted,
    }];
}

export function readCreativeConversations(storage: Pick<Storage, "getItem"> | undefined, now: number): CreativeConversation[] {
    try {
        const raw = storage?.getItem(CREATIVE_CONVERSATION_STORAGE_KEY);
        if (!raw) return migrateLaunchesToConversation(readCreativeLaunches(storage, now));
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((item): item is CreativeConversation => {
                const conversation = item as Record<string, unknown>;
                return !!conversation && typeof conversation.id === "string" && Array.isArray(conversation.launches);
            })
            .map(conversation => ({
                ...conversation,
                title: typeof conversation.title === "string" && conversation.title.trim() ? conversation.title : conversationTitle(conversation.launches),
                createdAt: typeof conversation.createdAt === "string" ? conversation.createdAt : conversation.launches[0]?.createdAt || "",
                updatedAt: typeof conversation.updatedAt === "string" ? conversation.updatedAt : conversation.launches[0]?.createdAt || "",
                launches: pruneCreativeLaunches(conversation.launches.filter(isCreativeLaunch), now).slice(0, CREATIVE_LAUNCH_LIMIT),
            }))
            .filter(conversation => conversation.launches.length > 0)
            .slice(0, CREATIVE_CONVERSATION_LIMIT);
    } catch {
        return [];
    }
}

export function writeCreativeConversations(storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined, list: readonly CreativeConversation[]): void {
    try {
        storage?.setItem(CREATIVE_CONVERSATION_STORAGE_KEY, JSON.stringify(list));
        // 迁移完成后旧键即可退役，避免两份数据漂移。
        storage?.removeItem(CREATIVE_LAUNCH_STORAGE_KEY);
    } catch {
        // 持久化失败不影响本次会话内的动态展示。
    }
}

export function appendConversationLaunch(conversations: readonly CreativeConversation[], activeId: string, launch: CreativeLaunch): CreativeConversation[] {
    const next = conversations.map(conversation => conversation.id !== activeId ? conversation : {
        ...conversation,
        canvasId: conversation.canvasId || launch.projectId,
        updatedAt: launch.createdAt,
        title: conversation.launches.length ? conversation.title : conversationTitle([launch]),
        launches: [launch, ...conversation.launches].slice(0, CREATIVE_LAUNCH_LIMIT),
    });
    return next.slice(0, CREATIVE_CONVERSATION_LIMIT);
}

export function pruneConversations(conversations: readonly CreativeConversation[], now: number): CreativeConversation[] {
    return conversations
        .map(conversation => ({ ...conversation, launches: pruneCreativeLaunches(conversation.launches, now) }))
        .filter(conversation => conversation.launches.length > 0);
}

export function nextConversationId(): string {
    return `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 任务可能已滑出最近任务列表：此时用该画布的生成日志兜底判定状态。 */
export function launchStatus(task: BackendRuntimeTask | undefined, logs: BackendGenerationLog[]): BackendRuntimeTask["status"] {
    if (task) return task.status;
    if (logs.some(log => log.status === "success")) return "succeeded";
    if (logs.some(log => log.status === "failed")) return "failed";
    if (logs.some(log => log.status === "cancelled")) return "cancelled";
    return "queued";
}

/** 会话级任务没有生成日志：给预览卡片补一份最小可用的日志形状（model / 时间 / outputs）。 */
function conversationLog(launch: CreativeLaunch, outputs: Array<Record<string, unknown>>): BackendGenerationLog {
    return {
        id: `conversation:${launch.taskId}`,
        projectId: launch.projectId || "",
        ...(launch.nodeId ? { nodeId: launch.nodeId } : {}),
        status: "success",
        platform: launch.mode,
        model: launch.model,
        taskMode: launch.mode,
        prompt: launch.prompt,
        references: [],
        inputCounts: {},
        runtimeTaskId: launch.taskId,
        startedAt: launch.createdAt,
        finishedAt: launch.createdAt,
        durationMs: 0,
        outputs,
        params: {},
        createdAt: launch.createdAt,
        updatedAt: launch.createdAt,
    };
}

/**
 * 兼容两代数据：旧会话按画布生成日志取结果；新会话（无画布）直接读任务详情的 result.media。
 * 同一份媒体只保留一条，避免补日志后重复出现在「最近生成」里。
 */
export function resolveLaunchOutputs(task: BackendRuntimeTask | undefined, logs: BackendGenerationLog[], launch: CreativeLaunch): WorkbenchOutput[] {
    const fromLogs = collectOutputs(logs);
    const media = ((task?.result?.media || []) as unknown as Array<Record<string, unknown>>);
    const seen = new Set(fromLogs.map(output => output.storageKey || output.url || ""));
    const fromTask: WorkbenchOutput[] = [];
    for (const [index, item] of media.entries()) {
        const parsed = outputMedia(item);
        if (!parsed) continue;
        const key = parsed.storageKey || parsed.url || "";
        if (seen.has(key)) continue;
        seen.add(key);
        fromTask.push({ ...parsed, id: `${launch.taskId}:${index}`, log: conversationLog(launch, media) });
    }
    return [...fromLogs, ...fromTask];
}

export function launchTextResults(task: BackendRuntimeTask | undefined, logs: BackendGenerationLog[]): string[] {
    const fromTask = (task?.result?.texts || []).map(item => item.content).filter(content => typeof content === "string" && content.trim());
    if (fromTask.length) return fromTask;
    return logs.flatMap(log => log.status === "success"
        ? log.outputs.flatMap(output => {
            const type = String(output.mimeType || output.type || "").toLowerCase();
            const content = output.content;
            return type.startsWith("text/") && typeof content === "string" && content.trim() ? [content] : [];
        })
        : []);
}

export function taskDestination(task: BackendRuntimeTask, projectIds: Set<string>): string | null {
    const projectId = task.projectId || (typeof task.input?.projectId === "string" ? task.input.projectId : "");
    if (projectIds.has(projectId)) return `/canvas/${encodeURIComponent(projectId)}`;
    // A deleted canvas must never send users into another project or an unrelated studio.
    if (projectId && !projectId.startsWith("__")) return null;
    const scope = task.input?.scope;
    if (scope === "image" || scope === "video") return `/?mode=${scope}`;
    return null;
}
