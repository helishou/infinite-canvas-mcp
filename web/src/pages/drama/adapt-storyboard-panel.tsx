import { Alert, App, Button, Input, InputNumber, Select, Tag, Tooltip } from "antd";
import { ArrowDown, ArrowUp, Loader2, Merge, Plus, Scissors, Trash2, Wand2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { buildChapterDemandPrompt, fallbackChapterDemand, parseChapterDemand } from "@basketikun/canvas-agent/drama/chapter-demand";
import { parseDemandText } from "@basketikun/canvas-agent/drama/demand-beats";
import { productionSceneEntries } from "@basketikun/canvas-agent/drama/production-contract";

import {
    buildPlan,
    draftFromParsed,
    draftToDemand,
    emptyShot,
    mergeWithNext,
    moveShot,
    patchShot,
    removeShot,
    shotIssues,
    splitShot,
    toWriteOps,
    type DraftShot,
} from "@/lib/drama/adapt-storyboard";
import {
    applyProductionCompilation,
    compileProduction,
    editEpisodeProduction,
    fetchBackendTask,
    fetchEpisodeProduction,
    fetchProductionCompilation,
    fetchProductionReadiness,
    prepareProductionTargets,
    publishEpisodeProduction,
    startCanvasGeneration,
    syncEpisodeProductionClips,
    updateBackendDramaEpisode,
    type DramaEpisode,
} from "@/services/backend-api";
import { fetchSettings } from "@/services/settings-api";
import { promoteStoryboardToCanvas } from "@/lib/drama/adapt-storyboard";
import { modelOptionName, resolveModelForCapability, useConfigStore } from "@/stores/use-config-store";

type SceneEntry = { id: string; environmentId: string; title: string; shotIds: string[] };

/**
 * 后端从 demand 取场景名的正则是 `场景[：:]\s*([^\r\n]+)`，会把收尾的「】」一起吞进去，
 * 场次环境 ID 就长成「破庙】」。功能上不影响（写分镜用的就是同一个串），只在展示时抹掉。
 */
function cleanSceneName(value: string) {
    return value.replace(/[】\]]+$/, "").trim();
}

/** 长任务轮询：任务系统没有推送，只能按间隔问。 */
async function waitTask(taskId: string, onTick?: (status: string) => void) {
    const deadline = Date.now() + 180_000;
    for (;;) {
        const { task } = await fetchBackendTask(taskId);
        if (!task) throw new Error("任务不存在或已被清理");
        onTick?.(task.status);
        if (task.status === "succeeded") return task;
        if (task.status === "failed" || task.status === "cancelled") throw new Error(task.error || `任务${task.status === "failed" ? "失败" : "已取消"}`);
        if (Date.now() > deadline) throw new Error("等模型超时（3 分钟），可稍后重试");
        await new Promise(resolve => setTimeout(resolve, 1500));
    }
}

/**
 * 分镜草案（方案 A 第三跳）：需求正文 → 镜头草案 → 写进制作稿。
 *
 * 草案只在浏览器里编辑，点「写稿」才动后端，且写稿是一串确定的动作：
 * 先落 synopsis（后端按它切剧本块），没有场次就先初始化，再按场次写分镜与台词。
 * 重复写同一场次时复用原 Clip ID —— 否则后端会以「Clip ID 集合不一致」拒绝。
 */
export function AdaptStoryboardPanel({ dramaId, episodes, onWritten, defaultEpisodeId }: {
    dramaId: string;
    episodes: readonly DramaEpisode[];
    onWritten?: () => void;
    /** 外部（如制作台抽屉）指定初始选中的分集；用户仍可在下拉里改选。 */
    defaultEpisodeId?: string;
}) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const config = useConfigStore(state => state.config);

    const [episodeId, setEpisodeId] = useState(defaultEpisodeId || "");
    const [rows, setRows] = useState<DraftShot[]>([]);
    const [meta, setMeta] = useState<{ sceneName: string; timeOfDay: string }>({ sceneName: "", timeOfDay: "" });
    const [diagnostics, setDiagnostics] = useState<string[]>([]);
    const [busy, setBusy] = useState<"idle" | "generating" | "writing">("idle");
    const [status, setStatus] = useState("");
    const [envOptions, setEnvOptions] = useState<Array<{ id: string; name: string }>>([]);

    const episode = useMemo(() => episodes.find(item => item.id === episodeId), [episodes, episodeId]);

    useEffect(() => {
        if (!episodeId && episodes.length) setEpisodeId(episodes[0].id);
    }, [episodes, episodeId]);

    // 外部切换当前集时同步选中（抽屉复用同一组件实例）。
    useEffect(() => {
        if (defaultEpisodeId) setEpisodeId(defaultEpisodeId);
    }, [defaultEpisodeId]);

    // 换集必须清空草案：草案是按集写的，留着上一集的镜头会把它写进别的集。
    useEffect(() => {
        setRows([]);
        setDiagnostics([]);
        setMeta({ sceneName: "", timeOfDay: "" });
    }, [episodeId]);

    // 场次环境清单：制作稿已经有场次时让模型从里面挑，避免它瞎编 environmentId。
    useEffect(() => {
        let disposed = false;
        if (!episodeId) { setEnvOptions([]); return; }
        void fetchEpisodeProduction(episodeId)
            .then(result => {
                if (disposed) return;
                const source = (result.production?.draft as { director?: { source?: Record<string, unknown> } } | undefined)?.director?.source;
                const scenes = source ? productionSceneEntries(source as never) as SceneEntry[] : [];
                setEnvOptions(scenes.map(scene => ({ id: scene.environmentId, name: cleanSceneName(scene.title) })));
            })
            .catch(() => { if (!disposed) setEnvOptions([]); });
        return () => { disposed = true; };
    }, [episodeId]);

    const generateDraft = async () => {
        if (!episode) return void message.warning("先选一集");
        const body = (episode.synopsis || "").trim();
        if (!body) return void message.warning("这一集还没有原文，请先在「编排成集」里建集并带上章节正文");
        // 优先用导演 agent 的模型（设置里的「导演引擎」，Codex/Hermes 渠道）；
        // 它没有登记 text 能力或读取失败时退回普通文本模型。
        let model = resolveModelForCapability(config, config.textModel, "text");
        try {
            const settings = await fetchSettings();
            const agentModel = settings.agentModel?.trim();
            if (agentModel && resolveModelForCapability(config, agentModel, "text") === agentModel) model = agentModel;
        } catch {
            // 读不到设置就沿用文本模型，不阻塞生成。
        }
        if (!model) return void message.error("没有可用的文本模型，请先在设置里选一个");
        const modelLabel = modelOptionName(model);

        setBusy("generating");
        setStatus(`${t("drama.adapt.storyboard.generating")} · ${modelLabel}`);
        try {
            const prompt = buildChapterDemandPrompt({ chapterTitle: episode.title, chapterBody: body, environments: envOptions });
            const started = await startCanvasGeneration({
                mode: "text",
                model,
                prompt: [prompt.system, "", prompt.user].join("\n"),
                count: 1,
            });
            const task = await waitTask(started.taskId, value => setStatus(`${t("drama.adapt.storyboard.generating")} · ${value}`));
            const text = (task.result?.texts || []).map(item => item.content).join("\n").trim();
            if (!text) throw new Error("模型没有返回内容");

            let demandText = "";
            let parsed;
            try {
                const draft = parseChapterDemand(text, { environments: envOptions });
                demandText = draft.demand;
            } catch (error) {
                // 模型没按 JSON 回：直接把回包当正文解析，比整段失败更有用。
                demandText = text;
                message.warning(`模型回包不是标准 JSON，已按正文解析：${error instanceof Error ? error.message : error}`);
            }
            parsed = parseDemandText(demandText);
            setRows(draftFromParsed(parsed));
            setMeta({ sceneName: parsed.sceneName, timeOfDay: parsed.timeOfDay });
            setDiagnostics(parsed.diagnostics);
            message.success(t("drama.adapt.storyboard.generated", { count: parsed.beats.length }));
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            // 兜底：模型挂了也先把结构立起来，用户在草案里改比对着空白强。
            try {
                const fallback = fallbackChapterDemand({
                    chapterTitle: episode.title,
                    chapterBody: body,
                    environmentId: envOptions[0]?.id || "",
                    sceneName: envOptions[0]?.name,
                });
                const parsed = parseDemandText(fallback.demand);
                setRows(draftFromParsed(parsed));
                setMeta({ sceneName: parsed.sceneName, timeOfDay: parsed.timeOfDay });
                setDiagnostics([`模型调用失败，已按原文兜底分镜：${text}`, ...parsed.diagnostics]);
                message.warning(t("drama.adapt.storyboard.fallback"));
            } catch (fallbackError) {
                message.error(`${text}${fallbackError instanceof Error ? ` / 兜底也失败：${fallbackError.message}` : ""}`);
            }
        } finally {
            setBusy("idle");
            setStatus("");
        }
    };

    const writeDraft = async () => {
        if (!episode) return;
        if (!rows.length) return void message.warning("草案是空的，先生成或手动加一镜");
        const issues = shotIssues(rows);
        if (issues.length) return void message.error(issues[0]);

        setBusy("writing");
        setStatus(t("drama.adapt.storyboard.writing"));
        try {
            const demand = draftToDemand(rows, meta);
            // 1) 需求正文先落到分集：后端建场次、切剧本块都以 synopsis 为准。
            await updateBackendDramaEpisode(episode.id, { synopsis: demand });

            // 2) 制作稿还没有任何场次时才初始化（只吃空壳稿，放在写分镜之前）。
            //    已初始化过（有 scenes、哪怕还没有 shots）再调会撞 DIRECTOR_ALREADY_INITIALIZED，必须跳过。
            let production = (await fetchEpisodeProduction(episode.id)).production;
            const directorSource = () => (production.draft as { director?: { source?: Record<string, unknown> } } | undefined)?.director?.source;
            const sceneList = (directorSource() as { scene_registry?: unknown[] } | undefined)?.scene_registry;
            const hasScenes = Array.isArray(sceneList) && sceneList.length > 0;
            if (!hasScenes) {
                production = (await editEpisodeProduction(episode.id, production.revision, [{ type: "initialize_director_from_demand" } as never])).production;
            }

            const source = directorSource() as Record<string, unknown> | undefined;
            const scenes = source ? productionSceneEntries(source as never) as SceneEntry[] : [];
            if (!scenes.length) throw new Error("制作稿里还没有场次：初始化没有产出场景，请检查这一集的需求正文里是否有【场景：】标记");
            const scene = scenes.find(item => item.environmentId === meta.sceneName)
                || scenes.find(item => cleanSceneName(item.environmentId) === meta.sceneName)
                || scenes[0];

            const ownedShots = new Set(scene.shotIds);
            const segments = Array.isArray(source?.segments) ? source!.segments as Array<Record<string, unknown>> : [];
            const reuseClipIds = segments
                .filter(segment => (Array.isArray(segment.shot_ids) ? segment.shot_ids : []).some(id => ownedShots.has(String(id))))
                .map(segment => String(segment.id));

            const fpsNum = Number(source?.fps_num || 24);
            const fpsDen = Number(source?.fps_den || 1);
            const fps = Math.max(1, fpsNum / Math.max(1, fpsDen));
            const plan = buildPlan({ chapterId: episode.id, environmentId: scene.environmentId, rows, fps });
            const ops = toWriteOps({ plan, sceneId: scene.id, environmentId: scene.environmentId, fps, reuseClipIds });

            await editEpisodeProduction(episode.id, production.revision, ops as never);
            message.success(t("drama.adapt.storyboard.written", { shots: plan.shots.length, clips: plan.segments.length }));

            // 写稿不等于上画布：发布 → 编译 → 应用 → 再发布 → 准备节点 → 同步 Clip，
            // 缺任何一步画布上都不会出现 H3 节点（探针实测，见 promoteStoryboardToCanvas 注释）。
            setStatus(t("drama.adapt.storyboard.promoting"));
            const promote = await promoteStoryboardToCanvas({
                segmentTargets: async () => {
                    const { readiness } = await fetchProductionReadiness(episode.id);
                    return (readiness.targets || [])
                        .filter(target => target.kind === "segment")
                        .map(target => ({ id: target.id, status: target.status, blockers: target.blockers }));
                },
                publish: async () => {
                    const fresh = (await fetchEpisodeProduction(episode.id)).production;
                    const result = await publishEpisodeProduction(episode.id, fresh.revision, "director");
                    return { publishedVersion: result.production.publishedVersion };
                },
                compile: async () => {
                    const fresh = (await fetchEpisodeProduction(episode.id)).production;
                    const { compilation } = await compileProduction(episode.id, fresh.revision, `adapt-compile-${Date.now()}`);
                    return { operationId: compilation.operationId };
                },
                pollCompilation: async operationId => {
                    const { compilation } = await fetchProductionCompilation(episode.id, operationId);
                    return {
                        status: compilation.status,
                        preparedId: (compilation.nextAction?.input?.preparedId as string | undefined) || compilation.preparedId,
                        blockedMessage: compilation.blockingDiagnostic?.message,
                    };
                },
                applyCompilation: preparedId => applyProductionCompilation(episode.id, preparedId).then(() => undefined),
                prepareTargets: async targets => {
                    const fresh = (await fetchEpisodeProduction(episode.id)).production;
                    await prepareProductionTargets(episode.id, fresh.revision, targets, `adapt-prepare-${Date.now()}`);
                },
                syncClips: () => syncEpisodeProductionClips(episode.id).then(() => undefined),
            }, step => setStatus(step));
            message.success(t("drama.adapt.storyboard.promoted", { clips: promote.segments }));
            onWritten?.();
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy("idle");
            setStatus("");
        }
    };

    const issues = useMemo(() => shotIssues(rows), [rows]);
    const totalSeconds = useMemo(() => rows.reduce((sum, row) => sum + (Number(row.seconds) || 0), 0), [rows]);

    return (
        <div className="rounded-xl border border-border bg-background p-4" data-testid="adapt-storyboard-panel">
            <div className="mb-3 flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-medium">{t("drama.adapt.storyboard.title")}</h3>
                <Select
                    size="small"
                    className="min-w-[220px]"
                    value={episodeId || undefined}
                    placeholder={t("drama.adapt.storyboard.pickEpisode")}
                    onChange={setEpisodeId}
                    options={episodes.map(item => ({ value: item.id, label: `第 ${item.episodeNumber} 集 · ${item.title}` }))}
                />
                <Button size="small" icon={<Wand2 className="size-3.5" />} loading={busy === "generating"} disabled={busy !== "idle" || !episodeId} onClick={() => void generateDraft()}>
                    {t("drama.adapt.storyboard.generate")}
                </Button>
                <Button size="small" type="primary" loading={busy === "writing"} disabled={busy !== "idle" || !rows.length} onClick={() => void writeDraft()}>
                    {t("drama.adapt.storyboard.write")}
                </Button>
                <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                    {rows.length ? <Tag>{t("drama.adapt.storyboard.summary", { shots: rows.length, seconds: Math.round(totalSeconds) })}</Tag> : null}
                    {status ? <span className="inline-flex items-center gap-1"><Loader2 className="size-3 animate-spin" />{status}</span> : null}
                </span>
            </div>

            {rows.length ? (
                <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>{t("drama.adapt.storyboard.scene")}</span>
                        <Input size="small" className="w-40" data-testid="adapt-storyboard-scene" value={meta.sceneName} onChange={event => setMeta(current => ({ ...current, sceneName: event.target.value }))} />
                        <span>{t("drama.adapt.storyboard.time")}</span>
                        <Input size="small" className="w-28" data-testid="adapt-storyboard-time" value={meta.timeOfDay} onChange={event => setMeta(current => ({ ...current, timeOfDay: event.target.value }))} />
                    </div>

                    <div className="max-h-[420px] overflow-auto rounded-lg border border-border">
                        {rows.map((row, index) => (
                            <div key={row.key} className="space-y-1.5 border-b border-border/60 px-2 py-2 last:border-b-0" data-testid="adapt-storyboard-shot">
                                <div className="flex items-center gap-2">
                                    <span className="w-6 shrink-0 text-xs text-muted-foreground">{index + 1}</span>
                                    <Input size="small" variant="borderless" className="flex-1 font-medium" data-testid="adapt-shot-title" value={row.title} onChange={event => setRows(current => patchShot(current, row.key, { title: event.target.value }))} />
                                    <InputNumber size="small" min={0.5} max={10} step={0.5} value={row.seconds} onChange={value => setRows(current => patchShot(current, row.key, { seconds: Number(value) || 1 }))} className="w-20" aria-label={t("drama.adapt.storyboard.seconds")} />
                                    <Tooltip title={t("drama.adapt.storyboard.up")}><Button size="small" type="text" icon={<ArrowUp className="size-3.5" />} disabled={index === 0} onClick={() => setRows(current => moveShot(current, row.key, -1))} /></Tooltip>
                                    <Tooltip title={t("drama.adapt.storyboard.down")}><Button size="small" type="text" icon={<ArrowDown className="size-3.5" />} disabled={index === rows.length - 1} onClick={() => setRows(current => moveShot(current, row.key, 1))} /></Tooltip>
                                    <Tooltip title={t("drama.adapt.storyboard.split")}><Button size="small" type="text" icon={<Scissors className="size-3.5" />} onClick={() => setRows(current => splitShot(current, row.key))} /></Tooltip>
                                    <Tooltip title={t("drama.adapt.storyboard.merge")}><Button size="small" type="text" icon={<Merge className="size-3.5" />} disabled={index === rows.length - 1} onClick={() => setRows(current => mergeWithNext(current, row.key))} /></Tooltip>
                                    <Tooltip title={t("drama.adapt.storyboard.remove")}><Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} onClick={() => setRows(current => removeShot(current, row.key))} /></Tooltip>
                                </div>
                                <Input.TextArea
                                    size="small"
                                    autoSize={{ minRows: 1, maxRows: 4 }}
                                    value={row.visual}
                                    placeholder={t("drama.adapt.storyboard.visual")}
                                    onChange={event => setRows(current => patchShot(current, row.key, { visual: event.target.value }))}
                                />
                                <div className="flex items-center gap-2">
                                    <Input size="small" className="w-28" data-testid="adapt-shot-speaker" placeholder={t("drama.adapt.storyboard.speaker")} value={row.speaker} onChange={event => setRows(current => patchShot(current, row.key, { speaker: event.target.value }))} />
                                    <Input size="small" className="flex-1" data-testid="adapt-shot-dialogue" placeholder={t("drama.adapt.storyboard.dialogue")} value={row.dialogue} onChange={event => setRows(current => patchShot(current, row.key, { dialogue: event.target.value }))} />
                                    <Input size="small" className="w-24" placeholder={t("drama.adapt.storyboard.camera")} value={row.camera} onChange={event => setRows(current => patchShot(current, row.key, { camera: event.target.value }))} />
                                </div>
                            </div>
                        ))}
                    </div>

                    {diagnostics.length ? (
                        <Alert
                            type="info"
                            showIcon
                            className="text-xs"
                            message={<div className="max-h-24 space-y-0.5 overflow-auto">{diagnostics.map(text => <div key={text}>{text}</div>)}</div>}
                        />
                    ) : null}
                </div>
            ) : (
                <p className="text-xs text-muted-foreground">{t("drama.adapt.storyboard.empty")}</p>
            )}

            {/* 空草案也要能加镜：否则「手动加一镜」这条路走不通。 */}
            <div className="mt-2 flex items-center gap-2">
                <Button size="small" type="dashed" icon={<Plus className="size-3.5" />} onClick={() => setRows(current => [...current, emptyShot(current.length)])}>{t("drama.adapt.storyboard.addShot")}</Button>
                {issues.length ? <span className="text-xs text-amber-600">{t("drama.adapt.storyboard.issueCount", { count: issues.length })}：{issues[0]}</span> : null}
            </div>
        </div>
    );
}
