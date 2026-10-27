import { ArrowLeft, ArrowRight, BookOpen, CheckSquare, ClipboardPaste, Download, FolderPlus, History, ImagePlus, LoaderCircle, PenLine, Plus, SlidersHorizontal, Sparkles, Trash2, Upload } from "lucide-react";
import { captureVideoOwner } from "../video/task-receipts";
import { useEffect, useRef, useState } from "react";
import { App, Button, Checkbox, Drawer, Empty, Input, Modal, Select, Tag, Tooltip, Typography } from "antd";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";

import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { PageHeader } from "@/components/layout/page-header";
import { MediaImage } from "@/components/media/media-image";
import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { canvasThemes } from "@/lib/canvas-theme";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { modelOptionLabel, modelWorkflowMissingMessage, resolveModelChannel, resolveModelWorkflow, resolveModelWorkflowParams, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { nanoid } from "nanoid";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { requestEdit, requestGeneration } from "@/services/api/image";
import { backendMediaUrl } from "@/services/backend-api";
import { deleteStoredImages, uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { resolveComfyImageSize } from "@/services/api/comfyui";
import { fetchWorkflowDetail, isWorkflowImageField, runWorkflow, pollWorkflowTask, workflowRequiresPrompt } from "@/services/api/workflows";
import type { WorkflowDetail } from "@/services/api/workflows";
import { WorkflowCustomFields } from "@/components/workflow-custom-fields";
import type { ReferenceImage } from "@/types/image";
import i18n from "@/i18n";
import { deleteWorkbenchLogs, readWorkbenchLogs, saveWorkbenchLog } from "@/services/workbench-logs";
import { fetchStructuredSetting, saveStructuredSetting } from "@/services/settings-api";

type GeneratedImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType?: string;
};

class ImageSubmissionUnknown extends Error {}

type GenerationResult = {
    id: string;
    status: "pending" | "success" | "failed" | "unknown";
    image?: GeneratedImage;
    error?: string;
};

type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    imageCount: number;
    size: string;
    quality: string;
    status: "pending" | "success" | "failed";
    uncertainCount?: number;
    images: GeneratedImage[];
    thumbnails: string[];
};

type GenerationLogConfig = Pick<AiConfig, "model" | "imageModel" | "quality" | "size" | "count">;

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

const RESULT_ACTION_BUTTON_CLASS = "ui-result-action min-w-0 [&_.ant-btn-icon]:shrink-0";
const LEGACY_REFERENCES_KEY = "image_workbench_references";
let referencesHydration: Promise<ReferenceImage[]> | null = null;
let referencesSaveQueue = Promise.resolve();

function saveWorkbenchReferences(references: ReferenceImage[]) {
    referencesSaveQueue = referencesSaveQueue.then(() => saveStructuredSetting("image-workbench-references", references)).catch(() => undefined);
}

function hydrateWorkbenchReferences() {
    if (referencesHydration) return referencesHydration;
    referencesHydration = (async () => {
        let stored = await fetchStructuredSetting<ReferenceImage[]>("image-workbench-references");
        if (!stored) {
            const legacy = localStorage.getItem(LEGACY_REFERENCES_KEY);
            const parsed = legacy ? (JSON.parse(legacy) as ReferenceImage[]) : null;
            if (Array.isArray(parsed)) {
                stored = await Promise.all(
                    parsed.map(async (ref) => {
                        if (ref.storageKey || !ref.dataUrl.startsWith("data:")) return ref;
                        const uploaded = await uploadImage(ref.dataUrl, { category: "input" });
                        return { ...ref, dataUrl: uploaded.url, storageKey: uploaded.storageKey };
                    }),
                );
                await saveStructuredSetting("image-workbench-references", stored);
            }
        }
        localStorage.removeItem(LEGACY_REFERENCES_KEY);
        return (stored || []).map((ref) => ({
            ...ref,
            dataUrl: ref.storageKey ? backendMediaUrl(ref.storageKey) : ref.dataUrl,
        }));
    })().finally(() => {
        referencesHydration = null;
    });
    return referencesHydration;
}

export default function ImagePage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const selectionVersionRef = useRef(0);
    const mountedRef = useRef(true);
    useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; selectionVersionRef.current++; }; }, []);
    const submissionRef = useRef(false);
    const deliveryResultsRef = useRef(new Map<number, { url: string } | { dataUrl: string }>());
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dragDepthRef = useRef(0);
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const [prompt, setPrompt] = useState("");
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const [referencesHydrated, setReferencesHydrated] = useState(false);

    useEffect(() => {
        let active = true;
        void hydrateWorkbenchReferences().then((stored) => {
            if (!active) return;
            setReferences(stored);
            setReferencesHydrated(true);
        });
        return () => {
            active = false;
        };
    }, []);

    useEffect(() => {
        if (!referencesHydrated) return;
        saveWorkbenchReferences(references);
    }, [references, referencesHydrated]);

    // 支持在页面任意位置直接 Ctrl+V 粘贴截图为参考图；仅当剪切板带图片文件时接管事件，文本粘贴不受影响。
    useEffect(() => {
        const onPaste = (event: ClipboardEvent) => {
            const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith("image/"));
            if (!files.length) return;
            event.preventDefault();
            void addReferences(files);
        };
        window.addEventListener("paste", onPaste);
        return () => window.removeEventListener("paste", onPaste);
        // addReferences 只依赖 setReferences 等稳定引用，空依赖数组安全
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const [results, setResults] = useState<GenerationResult[]>([]);
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [running, setRunning] = useState(false);
    const [logsOpen, setLogsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [startedAt, setStartedAt] = useState(0);
    const [elapsedMs, setElapsedMs] = useState(0);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [previewLog, setPreviewLog] = useState<GenerationLog | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [isReferenceDragActive, setIsReferenceDragActive] = useState(false);
    const [autoRunToken, setAutoRunToken] = useState(0);
    const [workflowDetail, setWorkflowDetail] = useState<WorkflowDetail | null>(null);
    const [customFieldValues, setCustomFieldValues] = useState<Record<string, unknown>>({});
    const imageCommand = useWorkbenchAgentStore((state) => state.imageCommand);
    const clearImageCommand = useWorkbenchAgentStore((state) => state.clearImageCommand);
    const updateAgentTask = useWorkbenchAgentStore((state) => state.updateTask);
    const processedCommandRef = useRef(0);
    const agentTaskIdRef = useRef<string | undefined>(undefined);

    const model = effectiveConfig.imageModel || effectiveConfig.model;
    const activeWorkflowName = resolveModelChannel(config, model).kind === "comfyui" ? resolveModelWorkflow(config, model, references.length) : "";
    const promptRequired = workflowDetail?.name === activeWorkflowName && workflowRequiresPrompt(workflowDetail);
    const canGenerate = !promptRequired || Boolean(prompt.trim());
    const generationCount = Math.max(1, Math.min(10, Number(config.count) || 1));

    useEffect(() => {
        if (!running || !startedAt) return;
        const timer = window.setInterval(() => setElapsedMs(performance.now() - startedAt), 1000);
        return () => window.clearInterval(timer);
    }, [running, startedAt]);

    useEffect(() => {
        void refreshLogs();
    }, []);

    useEffect(() => {
        const refresh = (event: Event) => {
            const type = (event as CustomEvent<{ type?: string }>).detail?.type;
            if (type === "generation-log.updated" || type === "task.completed" || type === "task.failed") void refreshLogs();
        };
        window.addEventListener("backend-event", refresh);
        return () => window.removeEventListener("backend-event", refresh);
    }, []);

    // 选中 ComfyUI 渠道模型时，按「本次参考图数量」解析该场景实际会跑的工作流，拉它的详情渲染参数面板，
    // 并用模型设置里为该场景配的参数作为初值；参考图数量变化 → 场景变化 → 内部实现与参数字段一起切换。
    useEffect(() => {
        const workflowName = activeWorkflowName;
        if (!workflowName) {
            setWorkflowDetail(null);
            setCustomFieldValues({});
            return;
        }
        let cancelled = false;
        fetchWorkflowDetail(workflowName)
            .then((detail) => {
                if (cancelled) return;
                setWorkflowDetail(detail);
                const routedParams = resolveModelWorkflowParams(config, model, references.length);
                const initial: Record<string, unknown> = {};
                for (const field of detail.config?.fields || []) {
                    if (isWorkflowImageField(field, detail.workflow) || field.isPrompt) continue;
                    // 模型设置里为当前场景配的参数优先，其余按字段默认值
                    if (routedParams[field.id] !== undefined) {
                        initial[field.id] = routedParams[field.id];
                        continue;
                    }
                    if (field.id === "width" || field.id === "height") {
                        const size = resolveComfyImageSize(config.size);
                        initial[field.id] = field.id === "width" ? size.width : size.height;
                    } else if (field.type === "dropdown") {
                        // 下拉框初值必须命中 options，否则 (例如节点原始值为数字 16)
                        // ComfyUI 会报 value_not_in_list。缺失/非法时回退到第一项。
                        const opts = field.options || [];
                        initial[field.id] = opts.includes(String(field.default ?? "")) ? field.default : (opts[0] ?? "");
                    } else {
                        initial[field.id] = field.default ?? (field.type === "boolean" ? false : field.type === "number" || field.type === "slider" ? 0 : "");
                    }
                }
                setCustomFieldValues(initial);
            })
            .catch(() => {
                if (cancelled) return;
                setWorkflowDetail(null);
                setCustomFieldValues({});
            });
        return () => {
            cancelled = true;
        };
    }, [activeWorkflowName, config, model, references.length]);

    const addReferences = async (files?: FileList | readonly File[] | null) => {
        const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        const nextReferences = await Promise.all(
            imageFiles.map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
            }),
        );
        setReferences((value) => [...value, ...nextReferences]);
    };

    const addReferencesFromClipboard = async () => {
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            if (!blobs.length) {
                message.error(t("imageWorkbench.clipboardEmpty"));
                return;
            }
            const nextReferences = await Promise.all(
                blobs.map(async (blob, index) => {
                    const image = await uploadImage(blob, { category: "input" });
                    return { id: nanoid(), name: `clipboard-${index + 1}.png`, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            setReferences((value) => [...value, ...nextReferences]);
            message.success(t("imageWorkbench.clipboardAdded", { count: nextReferences.length }));
        } catch {
            message.error(t("imageWorkbench.clipboardEmpty"));
        }
    };

    const generate = async () => {
        if (submissionRef.current) return;
        const agentTaskId = agentTaskIdRef.current;
        agentTaskIdRef.current = undefined;
        const text = prompt.trim();
        if (promptRequired && !text) {
            message.error(t("imageWorkbench.promptRequired"));
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.promptRequired") });
            return;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning(t("workbench.configFirst"));
            openConfigDialog(true);
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.configIncomplete") });
            return;
        }

        const snapshot = buildRequestSnapshot();
        if (!snapshot) {
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.invalidParams") });
            return;
        }

        submissionRef.current = true;
        const selectionVersion = ++selectionVersionRef.current;
        let owner: Awaited<ReturnType<typeof captureVideoOwner>>;
        try { owner = await captureVideoOwner(); owner.assertCurrent(); } catch { submissionRef.current = false; setRunning(false); message.warning(t("videoRecovery.channelChanged")); return; }
        if (!mountedRef.current || selectionVersion !== selectionVersionRef.current) { submissionRef.current = false; return; }
        deliveryResultsRef.current.clear();
        setElapsedMs(0);
        setRunning(true);
        if (agentTaskId) updateAgentTask(agentTaskId, { status: "running", error: undefined });
        setPreviewLog(null);
        setResults(Array.from({ length: generationCount }, () => ({ id: nanoid(), status: "pending" })));
        const batchStartedAt = performance.now();
        setStartedAt(batchStartedAt);

        const tasks = Array.from({ length: generationCount }, (_, index) => runGenerationSlot(index, snapshot, selectionVersion, owner.assertCurrent));

        const result = await Promise.allSettled(tasks);
        const successImages = result.filter((item): item is PromiseFulfilledResult<GeneratedImage> => item.status === "fulfilled").map((item) => item.value);
        const successCount = successImages.length;
        const uncertainCount = result.filter(item => item.status === "rejected" && (item.reason instanceof ImageSubmissionUnknown || item.reason?.deliveryIncomplete)).length;
        const failCount = generationCount - successCount - uncertainCount;
        const failed = result.find((item): item is PromiseRejectedResult => item.status === "rejected");
        const error = failed?.reason instanceof Error ? failed.reason.message : failCount ? t("workbench.generationFailed") : undefined;

        try {
            await saveLog(
                buildLog({
                    prompt: text,
                    model,
                    config: { ...snapshot.config, count: String(generationCount) },
                    references: snapshot.references,
                    durationMs: performance.now() - batchStartedAt,
                    successCount,
                    failCount,
                    status: uncertainCount ? "pending" : successCount ? "success" : "failed",
                    uncertainCount,
                    images: successImages,
                }),
                owner.assertCurrent,
            );
            if (agentTaskId) updateAgentTask(agentTaskId, { status: uncertainCount ? "running" : successCount ? "succeeded" : "failed", successCount, failCount, error: uncertainCount ? t("videoRecovery.unknown") : successCount ? undefined : error });
            if (mountedRef.current && selectionVersion === selectionVersionRef.current) uncertainCount ? message.warning(t("videoRecovery.noReceipt")) : successCount ? message.success(t("imageWorkbench.generated")) : message.error(failed?.reason instanceof Error ? failed.reason.message : t("workbench.generationFailed"));
        } catch {
            message.warning(t("videoRecovery.historyUnavailable"));
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "running", error: t("videoRecovery.historyUnavailable") });
        } finally {
            submissionRef.current = false;
            setRunning(false);
        }
    };

    // Handle image-generation commands from the Agent panel by setting the prompt and optionally starting generation.
    useEffect(() => {
        if (!imageCommand || imageCommand.nonce === processedCommandRef.current) return;
        processedCommandRef.current = imageCommand.nonce;
        clearImageCommand();
        if (typeof imageCommand.prompt === "string") setPrompt(imageCommand.prompt);
        if (imageCommand.run && running) {
            if (imageCommand.taskId) updateAgentTask(imageCommand.taskId, { status: "failed", error: t("imageWorkbench.busy") });
            return;
        }
        if (imageCommand.run) {
            agentTaskIdRef.current = imageCommand.taskId;
            setAutoRunToken((value) => value + 1);
        }
    }, [imageCommand, clearImageCommand, running, updateAgentTask]);

    useEffect(() => {
        if (!autoRunToken) return;
        void generate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRunToken]);

    const downloadImage = (image: GeneratedImage, index: number) => {
        saveAs(image.storageKey ? backendMediaUrl(image.storageKey) : image.dataUrl, `image-${index + 1}.png`);
    };

    const addResultToReferences = async (image: GeneratedImage, index: number) => {
        const stored = await uploadImage(image.storageKey ? backendMediaUrl(image.storageKey) : image.dataUrl, { category: "input" });
        setReferences((value) => [...value, { id: nanoid(), name: `result-${index + 1}.png`, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
        message.success(t("imageWorkbench.addedReference"));
    };

    const saveResultToAssets = async (image: GeneratedImage, index: number) => {
        const stored = await uploadImage(image.storageKey ? backendMediaUrl(image.storageKey) : image.dataUrl, { category: "library" });
        addAsset({
            kind: "image",
            title: t("imageWorkbench.resultTitle", { count: index + 1 }),
            coverUrl: stored.url,
            tags: [],
            source: t("imageWorkbench.source"),
            data: { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType },
            metadata: { source: "image-page", prompt },
        });
        message.success(t("common.addedToAssets"));
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            setPrompt(payload.content);
        } else if (payload.kind === "image") {
            const stored = await uploadImage(payload.dataUrl);
            setReferences((value) => [...value, { id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
        } else {
            message.warning(t("imageWorkbench.unsupportedAsset"));
        }
        setAssetPickerOpen(false);
    };

    const createSession = () => {
        selectionVersionRef.current++;
        deliveryResultsRef.current.clear();
        setPrompt("");
        setReferences([]);
        setResults([]);
        setElapsedMs(0);
        setStartedAt(0);
        setSelectedLogIds([]);
        setPreviewLog(null);
    };

    const deleteSelectedLogs = () => {
        const imageKeys = logs.filter((log) => selectedLogIds.includes(log.id)).flatMap((log) => log.images.map((image) => image.storageKey).filter((key): key is string => Boolean(key)));
        void Promise.all([deleteStoredImages(imageKeys), deleteWorkbenchLogs("image", selectedLogIds)]).then(refreshLogs);
        if (previewLog && selectedLogIds.includes(previewLog.id)) {
            setPreviewLog(null);
            setResults([]);
        }
        setSelectedLogIds([]);
        setDeleteConfirmOpen(false);
    };

    const saveLog = async (log: GenerationLog, assertOwner?: () => void) => {
        await saveWorkbenchLog("image", log, { assertOwner });
        assertOwner?.();
        await refreshLogs();
    };

    const refreshLogs = async () => setLogs(await readStoredLogs());

    const previewGenerationLog = async (log: GenerationLog) => {
        selectionVersionRef.current++;
        deliveryResultsRef.current.clear();
        setPreviewLog(log);
        setLogsOpen(false);
        setPrompt(log.prompt);
        setReferences(log.references || []);
        if (log.config.imageModel || log.model) updateConfig("imageModel", log.config.imageModel || log.model);
        if (log.config.quality) updateConfig("quality", log.config.quality);
        if (log.config.size) updateConfig("size", log.config.size);
        if (log.config.count) updateConfig("count", log.config.count);
        setResults([...log.images.map((image): GenerationResult => ({ id: image.id, status: "success", image })), ...Array.from({length:log.uncertainCount || 0}, (_,index): GenerationResult => ({id:`${log.id}:unknown:${index}`,status:"unknown"}))]);
    };

    const buildRequestSnapshot = () => {
        const text = prompt.trim();
        if (promptRequired && !text) {
            message.error(t("imageWorkbench.promptRequired"));
            return null;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning(t("workbench.configFirst"));
            openConfigDialog(true);
            return null;
        }
        return { text, config: { ...effectiveConfig, model, count: "1" }, references: [...references] };
    };

    const runGenerationSlot = async (index: number, snapshot: { text: string; config: AiConfig; references: ReferenceImage[] }, selectionVersion = selectionVersionRef.current, assertOwner: () => void = () => {}) => {
        const itemStartedAt = performance.now();
        let submitted = false;
        try {
            assertOwner();
            const channel = resolveModelChannel(snapshot.config, snapshot.config.model);
            const local = channel.kind === "comfyui";
            // ComfyUI 渠道统一走工作流执行器（/api/workflows/:name/run）：工作流名由渠道模型配置的
            // 输入场景路由（文生 / 单图 / 多图）解析，未配置路由时回退到模型名对应的内置工作流；
            // 该场景被标记为「不支持」时解析结果为空，直接报错不回退。
            const workflowName = local ? resolveModelWorkflow(snapshot.config, snapshot.config.model, snapshot.references.length) : "";
            let result = deliveryResultsRef.current.get(index);
            if (!result && local) {
                if (!workflowName) throw new Error(modelWorkflowMissingMessage(snapshot.config, snapshot.config.model, snapshot.references.length));
                // 1) 拉 workflow 详情：拿 config.fields 里 type=image 的 input 节点
                // 2) 把生图工作台写的 prompt 注入到标记为「作为提示词」的文本字段
                // 3) 把生图工作台选的 references 按 image field 顺序塞到 fields
                // 4) runWorkflow 传真 config + fields，后端 processImageFields 会把 dataURL 上传到 ComfyUI 转文件名注入 workflow
                const detail = await fetchWorkflowDetail(workflowName);
                const imageFields = (detail.config?.fields || []).filter((field) => isWorkflowImageField(field, detail.workflow));
                const promptFields = (detail.config?.fields || []).filter((field) => field.type === "text" && field.isPrompt);
                const workflowFields: Record<string, unknown> = { prompt: snapshot.text };
                for (const field of promptFields) {
                    workflowFields[field.id] = snapshot.text;
                }
                // 注入 width/height（如果 workflow 有这些字段）
                const size = resolveComfyImageSize(snapshot.config.size);
                if (size.width > 0 && size.height > 0) {
                    for (const field of detail.config?.fields || []) {
                        if (field.id === "width") workflowFields[field.id] = size.width;
                        if (field.id === "height") workflowFields[field.id] = size.height;
                    }
                }
                for (let index = 0; index < imageFields.length; index += 1) {
                    const field = imageFields[index];
                    const ref = snapshot.references[index];
                    if (!ref) continue;
                    // dataUrl 优先，storageKey 也带上让后端可选走 media 引用
                    const dataUrl = ref.dataUrl || ref.url;
                    if (typeof dataUrl === "string" && dataUrl) workflowFields[field.id] = dataUrl;
                }
                // 合并用户在工作台自定义字段面板填写的值（非 image、非提示词）
                for (const [id, value] of Object.entries(customFieldValues)) {
                    workflowFields[id] = value;
                }
                submitted = true;
                const { taskId } = await runWorkflow(workflowName, workflowFields, detail.config);
                const run = await pollWorkflowTask(taskId);
                const first = run.media?.[0];
                if (!first) throw new Error("ComfyUI 工作流完成但没有返回媒体");
                result = { url: first.url };
            } else if (!result && snapshot.references.length) {
                submitted = true;
                result = await requestEdit(snapshot.config, snapshot.text, snapshot.references).then((items) => items[0]);
            } else if (!result) {
                submitted = true;
                result = await requestGeneration(snapshot.config, snapshot.text).then((items) => items[0]);
            }
            if (!result) throw new Error(t("imageWorkbench.missingResult"));
            if (selectionVersion === selectionVersionRef.current) deliveryResultsRef.current.set(index, result);
            const source = "url" in result ? await fetch((result as { url: string }).url).then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}: ${t("common.downloadFailed")}`); return response.blob(); }) : (result as { dataUrl: string }).dataUrl;
            assertOwner();
            const stored = await uploadImage(source, { category: "output" });
            assertOwner();
            const nextImage: GeneratedImage = {
                id: nanoid(),
                dataUrl: stored.url,
                ...(stored.storageKey ? { storageKey: stored.storageKey } : {}),
                durationMs: performance.now() - itemStartedAt,
                width: stored.width,
                height: stored.height,
                bytes: stored.bytes,
                mimeType: stored.mimeType,
            };
            if (selectionVersion === selectionVersionRef.current) setResults((value) => updateResultAt(value, index, { status: "success", image: nextImage }));
            return nextImage;
        } catch (error) {
            const unknown = submitted && !deliveryResultsRef.current.has(index);
            const failure = unknown ? new ImageSubmissionUnknown(error instanceof Error ? error.message : t("videoRecovery.unknown")) : error;
            if (failure instanceof Error && deliveryResultsRef.current.has(index)) Object.assign(failure, { deliveryIncomplete: true });
            if (selectionVersion === selectionVersionRef.current) setResults((value) => updateResultAt(value, index, { status: unknown ? "unknown" : "failed", error: failure instanceof Error ? failure.message : t("workbench.generationFailed") }));
            throw failure;
        }
    };

    const retryResult = async (index: number) => {
        if (submissionRef.current) return;
        const snapshot = buildRequestSnapshot();
        if (!snapshot) return;
        setPreviewLog(null);
        setResults((value) => updateResultAt(value, index, { status: "pending", error: undefined, image: undefined }));
        submissionRef.current = true;
        setRunning(true);
        const selectionVersion = selectionVersionRef.current;
        let owner: Awaited<ReturnType<typeof captureVideoOwner>>;
        try { owner = await captureVideoOwner(); owner.assertCurrent(); } catch { submissionRef.current = false; setRunning(false); message.warning(t("videoRecovery.channelChanged")); return; }
        if (!mountedRef.current || selectionVersion !== selectionVersionRef.current) { submissionRef.current = false; setRunning(false); return; }
        let generated = false;
        const retryStartedAt = performance.now();
        try {
            const image = await runGenerationSlot(index, snapshot, selectionVersion, owner.assertCurrent);
            generated = true;
            await saveLog(
                buildLog({
                    prompt: snapshot.text,
                    model,
                    config: { ...snapshot.config, count: "1" },
                    references: snapshot.references,
                    durationMs: performance.now() - retryStartedAt,
                    successCount: 1,
                    failCount: 0,
                    status: "success",
                    images: [image],
                }),
                owner.assertCurrent,
            );
            if (mountedRef.current && selectionVersion === selectionVersionRef.current) message.success(t("workbench.retrySuccess"));
        } catch {
            if (generated) message.warning(t("videoRecovery.historyUnavailable"));
        } finally { submissionRef.current = false; setRunning(false); }
    };

    const unknownResult = results.some(result => result.status === "unknown");
    const fitResultsToViewport = results.length > 0 && results.every(result => result.status === "success" && result.image);
    const deliveryIndex = results.findIndex((result,index) => result.status === "failed" && deliveryResultsRef.current.has(index));
    const confirmNewGeneration = () => Modal.confirm({ title:t("videoRecovery.newGeneration"), content:t("videoRecovery.confirmNew"), okText:t("videoRecovery.newGeneration"), onOk:()=>{ void generate(); } });

    return (
        <div className="ui-controls flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
            <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3 sm:p-5 lg:overflow-hidden lg:px-8 lg:py-6">
            <PageHeader
                className="shrink-0"
                width="gallery"
                title={t("imageWorkbench.title")}
                actions={
                    <div className="flex shrink-0 flex-wrap gap-1.5 xl:hidden">
                        <Button icon={<History className="size-4" />} onClick={() => setLogsOpen(true)}>
                            {t("workbench.logs")}
                        </Button>
                        <Button icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                            {t("workbench.settings")}
                        </Button>
                    </div>
                }
            />
            <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 lg:overflow-hidden lg:grid-rows-[minmax(0,1fr)] xl:grid-cols-[260px_minmax(0,1fr)]">
                <aside className="thin-scrollbar hidden min-h-0 min-w-0 overflow-y-auto border-r border-border pr-5 xl:block">
                    <LogPanel
                        logs={logs}
                        selectedLogIds={selectedLogIds}
                        activeLogId={previewLog?.id}
                        onSelectedLogIdsChange={setSelectedLogIds}
                        onCreateSession={createSession}
                        onDeleteSelected={() => setDeleteConfirmOpen(true)}
                        onPreviewLog={(log) => void previewGenerationLog(log)}
                    />
                </aside>

                <section className="grid min-w-0 gap-5 lg:h-full lg:min-h-0 lg:grid-cols-[minmax(320px,380px)_minmax(0,1fr)] lg:overflow-hidden">
                    <div className="thin-scrollbar flex min-w-0 flex-col ui-card border border-border bg-card p-4 sm:p-5 lg:min-h-0 lg:overflow-y-auto">
                        <div className="space-y-6">
                            <section aria-label={t("workbench.groups.input")}>
                                <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                                    <label htmlFor="image-workbench-prompt" className="ui-group-title">
                                        {t("workbench.groups.input")}
                                    </label>
                                    <div className="flex gap-2">
                                        <Button size="small" icon={<BookOpen className="size-4" />} onClick={() => setPromptDialogOpen(true)}>
                                            {t("workbench.viewPrompts")}
                                        </Button>
                                        <Button size="small" icon={<FolderPlus className="size-4" />} onClick={() => setAssetPickerOpen(true)}>
                                            {t("workbench.viewAssets")}
                                        </Button>
                                    </div>
                                </div>
                                <Input.TextArea
                                    id="image-workbench-prompt"
                                    className="!rounded-lg !px-3.5 !py-3 !text-sm !leading-relaxed"
                                    value={prompt}
                                    onChange={(event) => setPrompt(event.target.value)}
                                    rows={7}
                                    placeholder={t("imageWorkbench.promptPlaceholder")}
                                />
                            </section>

                            <section className="min-w-0" aria-label={t("workbench.groups.references")}>
                                <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <h2 className="ui-group-title">{t("workbench.groups.references")}</h2>
                                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">{references.length}</span>
                                    </div>
                                    <div className="flex gap-2">
                                        <Button size="small" icon={<ClipboardPaste className="size-4" />} onClick={() => void addReferencesFromClipboard()}>
                                            {t("workbench.clipboard")}
                                        </Button>
                                        <Button size="small" icon={<Upload className="size-4" />} onClick={() => fileInputRef.current?.click()}>
                                            {t("workbench.upload")}
                                        </Button>
                                    </div>
                                </div>
                                <div
                                    className={`hover-scrollbar hover-scrollbar-hint relative flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed bg-muted/25 p-2.5 pb-3 overscroll-x-contain transition-colors ${isReferenceDragActive ? "border-primary bg-primary/5" : "border-border"}`}
                                    onDragEnter={(event) => {
                                        event.preventDefault();
                                        dragDepthRef.current += 1;
                                        if (event.dataTransfer.types.includes("Files")) setIsReferenceDragActive(true);
                                    }}
                                    onDragOver={(event) => {
                                        event.preventDefault();
                                        event.dataTransfer.dropEffect = "copy";
                                    }}
                                    onDragLeave={(event) => {
                                        event.preventDefault();
                                        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
                                        if (!dragDepthRef.current) setIsReferenceDragActive(false);
                                    }}
                                    onDrop={(event) => {
                                        event.preventDefault();
                                        dragDepthRef.current = 0;
                                        setIsReferenceDragActive(false);
                                        void addReferences(event.dataTransfer.files);
                                    }}
                                    onWheel={(event) => {
                                        if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
                                        event.preventDefault();
                                        event.currentTarget.scrollLeft += event.deltaY;
                                    }}
                                >
                                    {references.map((item, index) => (
                                        <div key={item.id} className="group relative h-32 w-24 shrink-0 overflow-hidden rounded-md border border-border sm:h-28 sm:w-20">
                                            <img src={item.dataUrl} alt={item.name} className="h-20 w-full object-cover" />
                                            <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-medium text-white">{imageReferenceLabel(index)}</span>
                                            <ReferenceOrderButtons index={index} total={references.length} onMove={(offset) => setReferences((value) => moveListItem(value, index, offset))} />
                                            <button
                                                type="button"
                                                className="absolute right-1 top-1 flex size-11 sm:size-8 items-center justify-center rounded-md bg-background/90 text-foreground opacity-100 transition-opacity hover:bg-background focus-visible:outline-2 focus-visible:outline-ring sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                                                onClick={() => setReferences((value) => value.filter((ref) => ref.id !== item.id))}
                                                aria-label={t("imageWorkbench.removeReference")}
                                            >
                                                <Trash2 className="size-4" />
                                            </button>
                                        </div>
                                    ))}
                                    {!references.length ? (
                                        <div className="flex min-w-full items-center justify-center px-2 text-center text-xs leading-relaxed text-muted-foreground">
                                            {isReferenceDragActive ? t("imageWorkbench.dropReferences") : t("imageWorkbench.noReferences")}
                                        </div>
                                    ) : null}
                                </div>
                                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t(references.length ? "workbench.groups.withReferences" : "workbench.groups.withoutReferences")}</p>
                            </section>

                            <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg bg-muted/60 px-3 py-2.5 text-xs sm:hidden">
                                <span className="truncate text-muted-foreground">
                                    {modelOptionLabel(effectiveConfig, model)} · {effectiveConfig.size} · {effectiveConfig.quality}
                                </span>
                                <Button size="small" type="text" icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                    {t("workbench.adjust")}
                                </Button>
                            </div>

                            <section aria-label={t("workbench.groups.defaults")} className="hidden gap-4 border-t border-border pt-5 sm:grid sm:grid-cols-2">
                                <GenerationSettings
                                    config={effectiveConfig}
                                    model={model}
                                    updateConfig={updateConfig}
                                    openConfigDialog={openConfigDialog}
                                    workflowDetail={workflowDetail}
                                    customFieldValues={customFieldValues}
                                    setCustomFieldValues={setCustomFieldValues}
                                />
                            </section>
                        </div>

                        <section aria-label={t("workbench.groups.submit")} className="mt-auto border-t border-border pt-4">
                            <div className="mb-3 space-y-1">
                                <h2 className="ui-group-title">{t("workbench.groups.submit")}</h2>
                                <p className="break-words text-xs leading-relaxed text-muted-foreground">
                                    {modelOptionLabel(effectiveConfig, model)} · {t("workbench.groups.referenceCount", { count: references.length })} · {t("settingsPanels.image.images", { count: generationCount })}
                                </p>
                                <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
                                    {running ? t("workbench.generating") : !canGenerate ? t("imageWorkbench.promptRequired") : t("workbench.groups.ready")}
                                </p>
                            </div>
                            <Button type="primary" size="large" block className="!h-11 !rounded-lg !font-medium !shadow-none" icon={<Sparkles className="size-4" />} loading={running} disabled={running || (deliveryIndex < 0 && (unknownResult || !canGenerate))} onClick={() => deliveryIndex >= 0 ? void retryResult(deliveryIndex) : void generate()}>
                                {t(deliveryIndex >= 0 ? "videoRecovery.retrieveResult" : unknownResult ? "videoRecovery.unknown" : "workbench.generate")}
                            </Button>
                            {unknownResult || deliveryIndex >= 0 ? <Button type="text" block className="mt-2" disabled={running} onClick={confirmNewGeneration}>{t("videoRecovery.newGeneration")}</Button> : null}
                        </section>
                    </div>

                    <div className={`flex min-w-0 flex-col ui-card border border-border bg-card p-4 sm:p-5 lg:h-full lg:min-h-0 ${fitResultsToViewport ? "lg:overflow-hidden" : "lg:overflow-y-auto"}`}>
                        <div className="mb-5 flex shrink-0 flex-wrap items-center justify-between gap-3">
                            <div>
                                <h2 className="ui-panel-title">{t("workbench.results")}</h2>
                            </div>
                            {running ? (
                                <Tag role="status" className="m-0 px-2 py-1">
                                    {t("workbench.waiting", { time: formatDuration(elapsedMs) })}
                                </Tag>
                            ) : null}
                        </div>
                        {results.length ? (
                            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] items-stretch gap-4 lg:min-h-0 lg:flex-1 lg:auto-rows-fr">
                                {results.map((result, index) =>
                                    result.status === "success" && result.image ? (
                                        <ResultImageCard key={result.id} image={result.image} index={index} onEdit={addResultToReferences} onDownload={downloadImage} onSaveAsset={saveResultToAssets} />
                                    ) : result.status === "unknown" ? (
                                        <div key={result.id} role="status" className="rounded-lg border border-border p-4 space-y-3"><h3>{t("videoRecovery.unknown")}</h3><p className="text-sm">{t("videoRecovery.noReceipt")}</p><details className="text-xs break-words"><summary>{t("videoRecovery.errorDetails")}</summary>{result.error}</details><Button type="text" onClick={confirmNewGeneration}>{t("videoRecovery.newGeneration")}</Button></div>
                                    ) : result.status === "failed" ? (
                                        <FailedImageCard deliveryOnly={deliveryResultsRef.current.has(index)} key={result.id} error={result.error || t("workbench.generationFailed")} onRetry={() => retryResult(index)} />
                                    ) : (
                                        <PendingImageCard key={result.id} className="lg:h-full lg:aspect-auto" />
                                    ),
                                )}
                            </div>
                        ) : (
                            <div data-testid="workbench-empty" className="flex items-center gap-3 rounded-lg bg-muted/45 px-4 py-4">
                                <ImagePlus className="size-5 shrink-0 text-muted-foreground/65" aria-hidden="true" />
                                <p className="min-w-0 text-sm text-muted-foreground">
                                    {t("imageWorkbench.empty")}
                                    <span className="ml-1 text-xs opacity-80">{t("workbench.emptyHint")}</span>
                                </p>
                            </div>
                        )}
                    </div>
                </section>
            </div>
            </main>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    void addReferences(event.target.files);
                    event.target.value = "";
                }}
            />
            <Drawer title={t("workbench.logs")} placement="bottom" size="large" open={logsOpen} onClose={() => setLogsOpen(false)}>
                <LogPanel
                    logs={logs}
                    selectedLogIds={selectedLogIds}
                    activeLogId={previewLog?.id}
                    onSelectedLogIdsChange={setSelectedLogIds}
                    onCreateSession={createSession}
                    onDeleteSelected={() => setDeleteConfirmOpen(true)}
                    onPreviewLog={(log) => void previewGenerationLog(log)}
                />
            </Drawer>
            <Drawer title={t("workbench.groups.defaults")} placement="bottom" size="82vh" open={settingsOpen} onClose={() => setSettingsOpen(false)}>
                <div className="mx-auto grid max-w-2xl grid-cols-2 gap-4 pb-6">
                    <GenerationSettings
                        config={effectiveConfig}
                        model={model}
                        updateConfig={updateConfig}
                        openConfigDialog={openConfigDialog}
                        workflowDetail={workflowDetail}
                        customFieldValues={customFieldValues}
                        setCustomFieldValues={setCustomFieldValues}
                    />
                </div>
            </Drawer>
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={setPrompt} />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
            <Modal title={t("workbench.deleteLogs")} open={deleteConfirmOpen} onCancel={() => setDeleteConfirmOpen(false)} onOk={deleteSelectedLogs} okText={t("common.delete")} okButtonProps={{ danger: true }} cancelText={t("common.cancel")}>
                {t("workbench.deleteLogsConfirm", { count: selectedLogIds.length })}
            </Modal>
        </div>
    );
}

function GenerationSettings({
    config,
    model,
    updateConfig,
    openConfigDialog,
    workflowDetail,
    customFieldValues,
    setCustomFieldValues,
}: {
    config: AiConfig;
    model: string;
    updateConfig: UpdateAiConfig;
    openConfigDialog: (shouldPromptContinue?: boolean) => void;
    workflowDetail: WorkflowDetail | null;
    customFieldValues: Record<string, unknown>;
    setCustomFieldValues: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const displayFields = (workflowDetail?.config?.fields || []).filter((field) => !isWorkflowImageField(field, workflowDetail?.workflow) && !field.isPrompt);
    const channel = resolveModelChannel(config, model);
    const hideStandardImageOptions = channel.kind === "comfyui";

    return (
        <>
            <div className="col-span-2 space-y-1">
                <h2 className="ui-group-title">{t("workbench.groups.defaults")}</h2>
                <p className="text-xs leading-relaxed text-muted-foreground">{t("workbench.groups.defaultsHint")}</p>
            </div>
            <div className="col-span-2 block min-w-0" role="group" aria-label={t("workbench.model")}>
                <span className="mb-2 block text-xs font-medium text-muted-foreground">{t("workbench.model")}</span>
                <ModelPicker config={config} value={model} onChange={(value) => updateConfig("imageModel", value)} capability="image" fullWidth onMissingConfig={() => openConfigDialog(false)} />
            </div>
            {displayFields.length > 0 && (
                <section className="col-span-2 space-y-2" aria-label={t("settingsPanels.image.workflowFields")}>
                    <h3 className="ui-group-title">{t("settingsPanels.image.workflowFields")}</h3>
                    <p className="text-xs leading-relaxed text-muted-foreground">{t("workbench.groups.workflowHint")}</p>
                    <WorkflowCustomFields fields={displayFields} values={customFieldValues} onChange={(id, value) => setCustomFieldValues((prev) => ({ ...prev, [id]: value }))} />
                </section>
            )}
            <div className="col-span-2">
                <ImageSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-4" maxCount={10} hideStandardImageOptions={hideStandardImageOptions} />
            </div>
        </>
    );
}

function ResultImageCard({
    image,
    index,
    onEdit,
    onDownload,
    onSaveAsset,
}: {
    image: GeneratedImage;
    index: number;
    onEdit: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
}) {
    const { t } = useTranslation();
    return (
        <div className="overflow-hidden rounded-lg border border-border bg-card lg:flex lg:h-full lg:min-h-0 lg:flex-col">
            <MediaImage src={image.storageKey ? backendMediaUrl(image.storageKey) : image.dataUrl} alt={t("imageWorkbench.resultAlt", { count: index + 1 })} className="aspect-square w-full bg-muted/40 object-contain lg:aspect-auto lg:h-full lg:min-h-0 lg:flex-1" />
            <div className="space-y-2 border-t border-border px-3 py-3 lg:shrink-0">
                <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
                    <span>
                        {image.width}x{image.height}
                    </span>
                    <span>{formatBytes(image.bytes)}</span>
                    <span>{formatDuration(image.durationMs)}</span>
                </div>
                <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,108px),1fr))] gap-2" role="group" aria-label={t("workbench.groups.resultActions")}>
                    <Tooltip title={t("common.addToAssets")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<FolderPlus className="size-4" />} onClick={() => void onSaveAsset(image, index)}>
                            {t("common.addToAssets")}
                        </Button>
                    </Tooltip>
                    <Tooltip title={t("imageWorkbench.addReference")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<PenLine className="size-4" />} onClick={() => void onEdit(image, index)}>
                            {t("imageWorkbench.addReference")}
                        </Button>
                    </Tooltip>
                    <Tooltip title={t("common.download")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<Download className="size-4" />} onClick={() => onDownload(image, index)}>
                            {t("common.download")}
                        </Button>
                    </Tooltip>
                </div>
            </div>
        </div>
    );
}

function PendingImageCard({ className = "" }: { className?: string } = {}) {
    const { t } = useTranslation();
    return (
        <div className={`relative aspect-square overflow-hidden rounded-lg border border-dashed border-border bg-muted/40 ${className}`}>
            <div
                className="absolute inset-0 opacity-60"
                style={{
                    backgroundImage: "radial-gradient(circle, var(--border) 1px, transparent 1px)",
                    backgroundSize: "16px 16px",
                }}
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="size-6 animate-spin" />
                <span>{t("workbench.generating")}</span>
            </div>
        </div>
    );
}

function FailedImageCard({ error, onRetry, deliveryOnly }: { error: string; onRetry: () => void; deliveryOnly: boolean }) {
    const { t } = useTranslation();
    return (
        <div className="overflow-hidden rounded-lg border border-destructive/25 bg-destructive/5">
            <div className="flex aspect-square flex-col items-center justify-center gap-3 p-5 text-center">
                <div className="text-sm font-medium text-destructive">{t(deliveryOnly ? "videoRecovery.deliveryFailed" : "workbench.failed")}</div>
                <Typography.Paragraph ellipsis={{ rows: 4, expandable: true }} className="!mb-0 !text-sm !leading-[22px] !text-destructive">
                    {error}
                </Typography.Paragraph>
            </div>
            <div className="flex justify-end border-t border-destructive/20 p-3">
                <Button size="small" danger onClick={onRetry}>
                    {t(deliveryOnly ? "videoRecovery.retrieveResult" : "videoRecovery.newGeneration")}
                </Button>
            </div>
        </div>
    );
}

function updateResultAt(results: GenerationResult[], index: number, next: Partial<GenerationResult>) {
    return results.map((item, itemIndex) => (itemIndex === index ? { ...item, ...next } : item));
}

function LogPanel({
    logs,
    selectedLogIds,
    activeLogId,
    onSelectedLogIdsChange,
    onCreateSession,
    onDeleteSelected,
    onPreviewLog,
}: {
    logs: GenerationLog[];
    selectedLogIds: string[];
    activeLogId?: string;
    onSelectedLogIdsChange: (ids: string[]) => void;
    onCreateSession: () => void;
    onDeleteSelected: () => void;
    onPreviewLog: (log: GenerationLog) => void;
}) {
    const { t } = useTranslation();
    const allSelected = Boolean(logs.length) && selectedLogIds.length === logs.length;
    const toggleAll = () => onSelectedLogIdsChange(allSelected ? [] : logs.map((log) => log.id));

    return (
        <>
            <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                    <h2 className="ui-group-title">{t("workbench.logs")}</h2>
                </div>
                <Tag className="m-0">{logs.length}</Tag>
            </div>
            <p className="mb-3 text-xs leading-relaxed text-muted-foreground">{t("workbench.groups.historyHint")}</p>
            <div className="mb-3">
                <Button size="small" block icon={<Plus className="size-4" />} onClick={onCreateSession}>
                    {t("workbench.new")}
                </Button>
            </div>
            <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label={t("workbench.groups.historyManagement")}>
                <Button size="small" icon={<CheckSquare className="size-4" />} disabled={!logs.length} onClick={toggleAll}>
                    {allSelected ? t("common.cancel") : t("workbench.selectAll")}
                </Button>
                <Button size="small" danger icon={<Trash2 className="size-4" />} disabled={!selectedLogIds.length} onClick={onDeleteSelected}>
                    {t("common.delete")}
                    {selectedLogIds.length ? ` (${selectedLogIds.length})` : ""}
                </Button>
            </div>
            <div className="space-y-3">
                {logs.map((log) => (
                    <LogCard
                        key={log.id}
                        log={log}
                        selected={selectedLogIds.includes(log.id)}
                        active={activeLogId === log.id}
                        onSelectedChange={(checked) => onSelectedLogIdsChange(checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id))}
                        onClick={() => onPreviewLog(log)}
                    />
                ))}
                {!logs.length ? <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed border-border px-4 text-center text-xs leading-relaxed text-muted-foreground">{t("workbench.noLogs")}</div> : null}
            </div>
        </>
    );
}

function LogCard({ log, selected, active, onSelectedChange, onClick }: { log: GenerationLog; selected: boolean; active: boolean; onSelectedChange: (checked: boolean) => void; onClick: () => void }) {
    const { t } = useTranslation();
    const thumbnails = (log.thumbnails || []).filter(Boolean).slice(0, 4);

    return (
        <div className={`relative w-full rounded-lg border p-3 text-left transition-colors ${active ? "border-primary/35 bg-primary/5" : "border-border bg-card hover:border-primary/25 hover:bg-muted/50"}`}>
            <Checkbox aria-label={t("workbench.groups.selectHistory", { title: log.title })} className="absolute left-3 top-3.5 z-10" checked={selected} onChange={(event) => onSelectedChange(event.target.checked)} />
            <button
                type="button"
                aria-label={t("workbench.groups.restoreHistory", { title: log.title })}
                aria-current={active ? "true" : undefined}
                onClick={onClick}
                className="grid w-full min-w-0 gap-3 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
                <div className="min-w-0 pl-6">
                    <div className="min-w-0">
                        <div className="truncate ui-group-title leading-5">{log.title}</div>
                        {thumbnails.length ? (
                            <div className="mt-2 flex gap-1 overflow-hidden">
                                {thumbnails.map((image, index) => (
                                    <img key={`${log.id}-${index}`} src={image} alt="" className="size-8 shrink-0 rounded-md object-cover" />
                                ))}
                            </div>
                        ) : null}
                    </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <div className="flex gap-1">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="blue">
                            {t("workbench.successCount", { count: log.successCount ?? log.imageCount })}
                        </Tag>
                        {log.failCount ? (
                            <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="red">
                                {t("workbench.failCount", { count: log.failCount })}
                            </Tag>
                        ) : null}
                    </div>
                    <div className="flex flex-wrap justify-end gap-1">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{t("workbench.itemCount", { count: log.imageCount })}</Tag>
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="green">
                            {formatDuration(log.durationMs)}
                        </Tag>
                    </div>
                    <div className="flex justify-end">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.time}</Tag>
                    </div>
                </div>
            </button>
        </div>
    );
}

async function readStoredLogs() {
    if (typeof window === "undefined") return [];
    return readWorkbenchLogs("image") as Promise<GenerationLog[]>;
}

function moveListItem<T>(items: T[], index: number, offset: number) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= items.length) return items;
    const next = [...items];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    return next;
}

function ReferenceOrderButtons({ index, total, onMove }: { index: number; total: number; onMove: (offset: number) => void }) {
    const { t } = useTranslation();
    if (total <= 1) return null;
    return (
        <div className="absolute inset-x-0.5 bottom-1 flex justify-between">
            <Button
                size="small"
                className="!h-11 !w-11 !min-w-11 sm:!h-8 sm:!w-8 sm:!min-w-8 !rounded-md !border-border !bg-background/90 !p-0 !text-foreground"
                aria-label={t("workbench.groups.moveReferenceEarlier", { count: index + 1 })}
                icon={<ArrowLeft className="size-4" />}
                disabled={index <= 0}
                onClick={() => onMove(-1)}
            />
            <Button
                size="small"
                className="!h-11 !w-11 !min-w-11 sm:!h-8 sm:!w-8 sm:!min-w-8 !rounded-md !border-border !bg-background/90 !p-0 !text-foreground"
                aria-label={t("workbench.groups.moveReferenceLater", { count: index + 1 })}
                icon={<ArrowRight className="size-4" />}
                disabled={index >= total - 1}
                onClick={() => onMove(1)}
            />
        </div>
    );
}

function buildLog({
    prompt,
    model,
    config,
    references,
    durationMs,
    successCount,
    failCount,
    uncertainCount,
    status,
    images,
}: {
    prompt: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    uncertainCount?: number;
    status: GenerationLog["status"];
    images: GeneratedImage[];
}): GenerationLog {
    const logConfig = {
        model: config.model,
        imageModel: config.imageModel,
        quality: config.quality,
        size: config.size,
        count: config.count,
    };
    return {
        id: nanoid(),
        createdAt: Date.now(),
        title: prompt.slice(0, 12) || i18n.t("workbench.untitled"),
        prompt,
        time: new Date().toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model,
        config: logConfig,
        references,
        durationMs,
        successCount,
        failCount,
        uncertainCount,
        imageCount: Number(logConfig.count) || successCount,
        size: logConfig.size,
        quality: logConfig.quality,
        status,
        images,
        thumbnails: images.map((image) => (image.storageKey ? backendMediaUrl(image.storageKey) : image.dataUrl)).filter(Boolean),
    };
}
