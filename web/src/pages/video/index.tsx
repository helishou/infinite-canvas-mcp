import { ArrowLeft, ArrowRight, BookOpen, CheckSquare, ClipboardPaste, Download, FolderPlus, History, LoaderCircle, Plus, SlidersHorizontal, Sparkles, Trash2, Upload, VideoIcon } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { App, Button, Checkbox, Drawer, Empty, Input, Modal, Tag, Typography } from "antd";
import { nanoid } from "nanoid";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";

import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { PageHeader } from "@/components/layout/page-header";
import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { VideoSettingsPanel, normalizeVideoResolutionValue, normalizeVideoSizeValue, videoSizeLabel } from "@/components/video-settings-panel";
import { isLocalH3VideoModel } from "@/lib/h3-video-settings";
import { initialVideoParamValues, resolveVideoImplementation, videoParamKey, videoScenarioBlocked, type VideoImplementation } from "@/lib/video-implementation";
import { resolveModelChannel, resolveModelRequestConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { deleteStoredMedia } from "@/services/file-storage";
import { uploadImage } from "@/services/image-storage";
import { createVideoGenerationTask, videoProviderFingerprint, pollVideoGenerationTask, storeGeneratedVideo, type VideoGenerationTask } from "@/services/api/video";
import { useAssetStore } from "@/stores/use-asset-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { boolConfig, modelOptionLabel, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ReferenceImage } from "@/types/image";
import i18n from "@/i18n";
import { captureVideoOwner, retainVideoReceipt, clearVideoReceipt, readVideoReceipts } from "./task-receipts";
import { observeVideoTask, videoEndpoint, videoNeedsVerification, VideoTerminalFailure } from "./task-recovery";
import { deleteWorkbenchLogs, readWorkbenchLogs, saveWorkbenchLog } from "@/services/workbench-logs";

/** 把未知值收敛成可展开的字典；字段参数在配置里是可选的，缺失时按空字典处理。 */
function recordOf(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

type GeneratedVideo = {
    id: string;
    url: string;
    storageKey: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

type GenerationResult = {
    id: string;
    status: "pending" | "success" | "failed" | "unknown";
    video?: GeneratedVideo;
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
    size: string;
    resolution: string;
    seconds: string;
    status: "pending" | "success" | "failed";
    providerFingerprint?: string;
    ownerKey?: string;
    agentTaskId?: string;
    queryEndpoint?: string;
    terminalConfirmed?: boolean;
    queryError?: string;
    submissionUnknown?: boolean;
    task?: VideoGenerationTask;
    video?: GeneratedVideo;
    error?: string;
};

type GenerationLogConfig = Pick<AiConfig, "model" | "videoModel" | "size" | "vquality" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark">;

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

export default function VideoPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dragDepthRef = useRef(0);
    const activeLogIdsRef = useRef<Set<string>>(new Set());
    const selectionVersionRef = useRef(0);
    const submissionRef = useRef(false);
    const currentLogIdRef = useRef<string | null>(null);
    const controllersRef = useRef(new Map<string, AbortController>());
    const mountedRef = useRef(true);
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const [prompt, setPrompt] = useState("");
    const [references, setReferences] = useState<ReferenceImage[]>([]);
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
    const [referenceDragTarget, setReferenceDragTarget] = useState(false);
    const [autoRunToken, setAutoRunToken] = useState(0);
    const videoCommand = useWorkbenchAgentStore((state) => state.videoCommand);
    const clearVideoCommand = useWorkbenchAgentStore((state) => state.clearVideoCommand);
    const updateAgentTask = useWorkbenchAgentStore((state) => state.updateTask);
    const processedCommandRef = useRef(0);
    const agentTaskIdRef = useRef<string | undefined>(undefined);

    const model = effectiveConfig.videoModel || effectiveConfig.model;
    // 内部实现字段值：面板编辑后要随生成请求一起提交，因此放在页面级而非面板内部。
    const [videoParamValues, setVideoParamValues] = useState<Record<string, unknown>>({});
    const [implementation, setImplementation] = useState<VideoImplementation | null>(null);
    const canGenerate = Boolean(prompt.trim());

    useEffect(() => {
        if (!running || !startedAt) return;
        const timer = window.setInterval(() => setElapsedMs(performance.now() - startedAt), 1000);
        return () => window.clearInterval(timer);
    }, [running, startedAt]);

    useEffect(() => {
        mountedRef.current = true;
        void refreshLogs();
        return () => { mountedRef.current = false; for (const controller of controllersRef.current.values()) controller.abort(); controllersRef.current.clear(); activeLogIdsRef.current.clear(); };
    }, []);

    useEffect(() => {
        const refresh = (event: Event) => {
            const type = (event as CustomEvent<{ type?: string }>).detail?.type;
            if (type === "generation-log.updated" || type === "task.completed" || type === "task.failed") void refreshLogs();
        };
        window.addEventListener("backend-event", refresh);
        return () => window.removeEventListener("backend-event", refresh);
    }, []);

    const addReferences = async (files?: FileList | null) => {
        const selectedFiles = Array.from(files || []);
        const unsupported = selectedFiles.filter((file) => !file.type.startsWith("image/"));
        if (unsupported.length) message.warning(t("videoWorkbench.unsupportedFiles"));
        const imageFiles = selectedFiles.filter((file) => file.type.startsWith("image/")).slice(0, 7 - references.length);
        const nextReferences = await Promise.all(
            imageFiles.map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
            }),
        );
        setReferences((value) => [...value, ...nextReferences].slice(0, 7));
    };

    const handleReferenceDragEnter = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current += 1;
        if (event.dataTransfer.types.includes("Files")) setReferenceDragTarget(true);
    };

    const handleReferenceDragLeave = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (!dragDepthRef.current) setReferenceDragTarget(false);
    };

    const handleReferenceDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current = 0;
        setReferenceDragTarget(false);
        void addReferences(event.dataTransfer.files);
    };

    const addReferencesFromClipboard = async () => {
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            if (!blobs.length) {
                message.error(t("videoWorkbench.clipboardEmpty"));
                return;
            }
            const nextReferences = await Promise.all(
                blobs.slice(0, 7 - references.length).map(async (blob, index) => {
                    const image = await uploadImage(blob);
                    return { id: nanoid(), name: `clipboard-${index + 1}.png`, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            setReferences((value) => [...value, ...nextReferences].slice(0, 7));
            message.success(t("videoWorkbench.clipboardAdded", { count: nextReferences.length }));
        } catch {
            message.error(t("videoWorkbench.clipboardEmpty"));
        }
    };
    const generate = async () => {
        if (submissionRef.current || activeLogIdsRef.current.size) return;
        const agentTaskId = agentTaskIdRef.current;
        agentTaskIdRef.current = undefined;
        const snapshot = buildRequestSnapshot();
        if (!snapshot) {
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("videoWorkbench.invalidParams") });
            return;
        }
        submissionRef.current = true;
        const selectionVersion = ++selectionVersionRef.current;
        currentLogIdRef.current = null;
        setElapsedMs(0);
        setRunning(true);
        if (agentTaskId) updateAgentTask(agentTaskId, { status: "running", error: undefined });
        setPreviewLog(null);
        setResults([{ id: nanoid(), status: "pending" }]);
        const batchStartedAt = performance.now();
        setStartedAt(batchStartedAt);
        let receipt: GenerationLog | undefined;
        let owner: Awaited<ReturnType<typeof captureVideoOwner>> | undefined;
        try {
            owner = await captureVideoOwner();
            owner.assertCurrent();
            // 面板填的内部实现字段值随请求下发；后端按 `model::workflow` 取值合并进图，
            // 所以键要和 video-dispatcher 读的形状一致。
            const implementationId = implementation?.id || "";
            const fieldValuesKey = implementationId ? videoParamKey(model, implementationId) : "";
            const requestConfig = fieldValuesKey
                ? ({
                      ...snapshot.config,
                      selectedVideoModelFieldValues: {
                          ...recordOf(snapshot.config.selectedVideoModelFieldValues),
                          [fieldValuesKey]: videoParamValues,
                      },
                  } as AiConfig)
                : snapshot.config;
            receipt = { ...buildLog({ prompt: snapshot.text, model, config: snapshot.config, references: snapshot.references, durationMs: 0, status: "pending" }), submissionUnknown: true, ownerKey: owner.key, providerFingerprint: await videoProviderFingerprint(requestConfig, model) };
            await retainVideoReceipt(receipt, owner.key);
            owner.assertCurrent();
            const task = await createVideoGenerationTask(requestConfig, snapshot.text, snapshot.references);
            const log = { ...buildLog({ prompt: snapshot.text, model, config: snapshot.config, references: snapshot.references, durationMs: 0, status: "pending", task }), id: receipt.id, providerFingerprint: receipt.providerFingerprint, ownerKey: owner.key, agentTaskId, queryEndpoint: videoEndpoint(resolveModelRequestConfig(snapshot.config, model).baseUrl) };
            receipt = log;
            if (selectionVersionRef.current === selectionVersion) currentLogIdRef.current = log.id;
            setLogs(value => [log, ...value.filter(item => item.id !== log.id)]);
            await retainVideoReceipt(log, owner.key);
            owner.assertCurrent();
            await saveLog(log, false, owner.assertCurrent);
            if (mountedRef.current) void pollGenerationLog(log, snapshot.config, agentTaskId);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : t("workbench.generationFailed");
            const log: GenerationLog = receipt ? { ...receipt, queryError: errorMessage } : { ...buildLog({ prompt: snapshot.text, model, config: snapshot.config, references: snapshot.references, durationMs: performance.now() - batchStartedAt, status: "pending", error: errorMessage }), submissionUnknown: true };
            if (selectionVersionRef.current === selectionVersion) currentLogIdRef.current = log.id;
            setLogs(value => [log, ...value.filter(item => item.id !== log.id)]);
            if (mountedRef.current && selectionVersionRef.current === selectionVersion) setResults([{ id: log.id, status: "unknown", error: errorMessage }]);
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "running", error: t("videoRecovery.unknown") });
            try { if (owner) { await retainVideoReceipt(log, owner.key); await saveLog(log, false, owner.assertCurrent); } } catch { message.warning(t("videoRecovery.historyUnavailable")); }
            setRunning(false);
        } finally { submissionRef.current = false; }

    };

    // Handle video-generation commands from the Agent panel by setting the prompt and optionally starting generation.
    useEffect(() => {
        if (!videoCommand || videoCommand.nonce === processedCommandRef.current) return;
        processedCommandRef.current = videoCommand.nonce;
        clearVideoCommand();
        if (typeof videoCommand.prompt === "string") setPrompt(videoCommand.prompt);
        if (videoCommand.run && (running || results.some(result => result.status === "unknown"))) {
            if (videoCommand.taskId) updateAgentTask(videoCommand.taskId, { status: "failed", error: t("videoWorkbench.busy") });
            return;
        }
        if (videoCommand.run) {
            agentTaskIdRef.current = videoCommand.taskId;
            setAutoRunToken((value) => value + 1);
        }
    }, [videoCommand, clearVideoCommand, running, updateAgentTask]);

    useEffect(() => {
        if (!autoRunToken) return;
        void generate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRunToken]);

    const buildRequestSnapshot = () => {
        const text = prompt.trim();
        if (!text) {
            message.error(t("videoWorkbench.promptRequired"));
            return null;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning(t("workbench.configFirst"));
            openConfigDialog(true);
            return null;
        }
        return { text, config: buildVideoConfig(effectiveConfig, model), references: [...references] };
    };

    const confirmNewGeneration = () => {
        Modal.confirm({ title: t("videoRecovery.newGeneration"), content: t("videoRecovery.confirmNew"), okText: t("videoRecovery.newGeneration"), onOk: () => { void generate(); } });
    };
    const retryResult = () => void generate();
    const unknownResult = results.find(result => result.status === "unknown");
    const recoverCurrent = () => { const log = logs.find(item => item.id === unknownResult?.id); if (log?.task) void pollGenerationLog(log); };


    const downloadVideo = (video: GeneratedVideo) => {
        saveAs(video.url, "video.mp4");
    };

    const saveResultToAssets = (video: GeneratedVideo) => {
        addAsset({
            kind: "video",
            title: t("videoWorkbench.resultTitle"),
            coverUrl: "",
            tags: [],
            source: t("videoWorkbench.source"),
            data: { url: video.url, storageKey: video.storageKey, width: video.width, height: video.height, bytes: video.bytes, mimeType: video.mimeType },
            metadata: { source: "video-page", prompt },
        });
        message.success(t("common.addedToAssets"));
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            setPrompt(payload.content);
        } else if (payload.kind === "image") {
            const stored = await uploadImage(payload.dataUrl);
            setReferences((value) => [...value, { id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }].slice(0, 7));
        }
        setAssetPickerOpen(false);
    };

    const createSession = () => {
        selectionVersionRef.current++;
        currentLogIdRef.current = null;
        setPrompt("");
        setReferences([]);
        setResults([]);
        setElapsedMs(0);
        setStartedAt(0);
        setSelectedLogIds([]);
        setPreviewLog(null);
    };

    const deleteSelectedLogs = () => {
        const mediaKeys = logs
            .filter((log) => selectedLogIds.includes(log.id))
            .map((log) => log.video?.storageKey)
            .filter((key): key is string => Boolean(key));
        void Promise.all([deleteStoredMedia(mediaKeys), deleteWorkbenchLogs("video", selectedLogIds)]).then(() => refreshLogs());
        if (previewLog && selectedLogIds.includes(previewLog.id)) {
            setPreviewLog(null);
            setResults([]);
        }
        setSelectedLogIds([]);
        setDeleteConfirmOpen(false);
    };

    const saveLog = async (log: GenerationLog, resumePending = true, assertOwner?: () => void) => {
        await saveWorkbenchLog("video", log, { assertOwner });
        assertOwner?.();
        await refreshLogs(resumePending);
    };

    const refreshLogs = async (resumePending = true) => {
        const owner = await captureVideoOwner();
        let nextLogs: GenerationLog[];
        try { nextLogs = await readStoredLogs(); } catch { nextLogs = []; }
        const receipts = await readVideoReceipts(owner.key).catch(() => []);
        try { owner.assertCurrent(); } catch { return []; }
        for (const receipt of receipts) {
            if (!nextLogs.some(log => log.id === receipt.id)) nextLogs.push({ ...buildLog({ prompt: "", model: receipt.task?.model || model, config: effectiveConfig, references: [], durationMs: 0, status: "pending", task: receipt.task }), ...receipt, queryError: t("videoRecovery.unknown") });
        }
        if (!mountedRef.current) return nextLogs;
        setLogs(value => [...nextLogs, ...value.filter(log => !nextLogs.some(next => next.id === log.id))]);
        if (resumePending) resumePendingLogs(nextLogs);
        return nextLogs;
    };

    const resumePendingLogs = (items: GenerationLog[]) => {
        for (const log of items) {
            if (log.status === "pending" && !log.queryError && !log.submissionUnknown && log.task) void pollGenerationLog(log);
        }
    };

    const pollGenerationLog = async (log: GenerationLog, configOverride?: AiConfig, agentTaskId?: string) => {
        if (!log.task || activeLogIdsRef.current.has(log.id)) return;
        agentTaskId ||= log.agentTaskId;
        activeLogIdsRef.current.add(log.id);
        const controller = new AbortController();
        controllersRef.current.set(log.id, controller);
        setRunning(true);
        const show = () => mountedRef.current && currentLogIdRef.current === log.id;
        if (show()) setResults([{ id: log.id, status: "pending" }]);
        const taskConfig = buildVideoConfig({ ...effectiveConfig, ...log.config }, log.task.model || log.model);
        let finished: GenerationLog | undefined;
        let owner: Awaited<ReturnType<typeof captureVideoOwner>> | undefined;
        try {
            owner = await captureVideoOwner();
            owner.assertCurrent();
            if (log.ownerKey && log.ownerKey !== owner.key) throw new Error(t("videoRecovery.channelChanged"));
            if (log.providerFingerprint && log.providerFingerprint !== await videoProviderFingerprint(configOverride || taskConfig, log.task.model)) throw new Error(t("videoRecovery.channelChanged"));
            if (log.queryEndpoint && log.queryEndpoint !== videoEndpoint(resolveModelRequestConfig(configOverride || taskConfig, log.task.model).baseUrl)) throw new Error(t("videoRecovery.channelChanged"));
            const result = await observeVideoTask({
                poll: async () => { owner!.assertCurrent(); const state = await pollVideoGenerationTask(configOverride || taskConfig, log.task!, { signal: controller.signal }); owner!.assertCurrent(); return state; },
                signal: controller.signal, attempts: log.task.provider === "comfyui" ? 1200 : 120, wait: () => delay(log.task!.provider === "comfyui" ? 1500 : 2500), timeoutMessage: t("videoWorkbench.timeout"),
            });
            owner.assertCurrent();
            const stored = await storeGeneratedVideo(result);
            owner.assertCurrent();
            controller.signal.throwIfAborted();
            const video: GeneratedVideo = { id: nanoid(), url: stored.url, storageKey: stored.storageKey, durationMs: Date.now() - log.createdAt, width: stored.width || 1280, height: stored.height || 720, bytes: stored.bytes, mimeType: stored.mimeType };
            finished = { ...log, status: "success", durationMs: video.durationMs, video, error: undefined, queryError: undefined };
            setLogs(value => value.map(item => item.id === log.id ? finished! : item));
            if (show()) setResults([{ id: video.id, status: "success", video }]);
            await saveLog(finished, false, owner.assertCurrent);
            await clearVideoReceipt(log.id, owner.key);
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "succeeded", successCount: 1, failCount: 0, error: undefined });
            if (show()) message.success(t("videoWorkbench.generated"));
        } catch (error) {
            if (controller.signal.aborted) return;
            if (!owner) { message.warning(t("videoRecovery.historyUnavailable")); return; }
            const errorMessage = error instanceof Error ? error.message : t("workbench.generationFailed");
            if (finished) { message.warning(t("videoRecovery.historyUnavailable")); return; }
            const terminal = error instanceof VideoTerminalFailure;
            const next: GenerationLog = { ...log, status: terminal ? "failed" : "pending", terminalConfirmed: terminal, queryError: terminal ? undefined : errorMessage, error: errorMessage, durationMs: Date.now() - log.createdAt };
            setLogs(value => value.map(item => item.id === log.id ? next : item));
            if (show()) setResults([{ id: log.id, status: terminal ? "failed" : "unknown", error: errorMessage }]);
            if (agentTaskId) updateAgentTask(agentTaskId, { status: terminal ? "failed" : "running", error: errorMessage });
            try { await retainVideoReceipt(next, log.ownerKey || owner.key); await saveLog(next, false, owner.assertCurrent); if (terminal) await clearVideoReceipt(log.id, owner.key); } catch { message.warning(t("videoRecovery.historyUnavailable")); }
        } finally {
            if (controllersRef.current.get(log.id) !== controller) return;
            activeLogIdsRef.current.delete(log.id);
            controllersRef.current.delete(log.id);
            if (mountedRef.current && !activeLogIdsRef.current.size) { setRunning(false); setStartedAt(0); }
        }
    };

    const previewGenerationLog = (log: GenerationLog) => {
        selectionVersionRef.current++;
        currentLogIdRef.current = log.id;
        setPreviewLog(log);
        setLogsOpen(false);
        setPrompt(log.prompt);
        setReferences(log.references || []);
        if (log.config.videoModel || log.model) updateConfig("videoModel", log.config.videoModel || log.model);
        if (log.config.size) updateConfig("size", log.config.size);
        if (log.config.vquality) updateConfig("vquality", log.config.vquality);
        if (log.config.videoSeconds) updateConfig("videoSeconds", log.config.videoSeconds);
        if (log.config.videoGenerateAudio) updateConfig("videoGenerateAudio", log.config.videoGenerateAudio);
        if (log.config.videoWatermark) updateConfig("videoWatermark", log.config.videoWatermark);
        setResults(videoNeedsVerification(log) ? [{ id: log.id, status: "unknown", error: log.queryError || log.error }] : log.status === "pending" ? [{ id: log.id, status: "pending" }] : log.video ? [{ id: log.video.id, status: "success", video: log.video }] : [{ id: log.id, status: "failed", error: log.error || t("workbench.generationFailed") }]);
    };

    return (
        <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
            <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3 sm:p-5 lg:overflow-hidden lg:px-8 lg:py-6">
            <PageHeader
                className="shrink-0"
                width="gallery"
                title={t("videoWorkbench.title")}
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
            <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 lg:overflow-hidden xl:grid-cols-[260px_minmax(0,1fr)]">
                <aside className="thin-scrollbar hidden min-h-0 min-w-0 overflow-y-auto border-r border-border pr-5 xl:block">
                    <LogPanel
                        logs={logs}
                        selectedLogIds={selectedLogIds}
                        activeLogId={previewLog?.id}
                        onSelectedLogIdsChange={setSelectedLogIds}
                        onCreateSession={createSession}
                        onDeleteSelected={() => setDeleteConfirmOpen(true)}
                        onPreviewLog={previewGenerationLog}
                    />
                </aside>

                <section className="grid min-w-0 gap-5 lg:min-h-0 lg:grid-cols-[minmax(320px,380px)_minmax(0,1fr)] lg:overflow-hidden">
                    <div className="thin-scrollbar flex min-w-0 flex-col rounded-xl border border-border bg-card p-4 sm:p-5 lg:min-h-0 lg:overflow-y-auto">
                        <div className="space-y-6">
                            <section aria-label={t("workbench.groups.input")}>
                                <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                                    <label htmlFor="video-workbench-prompt" className="text-sm font-semibold">
                                        {t("workbench.groups.input")}
                                    </label>
                                    <div className="flex gap-2">
                                        <Button size="small" icon={<BookOpen className="size-3.5" />} onClick={() => setPromptDialogOpen(true)}>
                                            {t("workbench.viewPrompts")}
                                        </Button>
                                        <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => setAssetPickerOpen(true)}>
                                            {t("workbench.viewAssets")}
                                        </Button>
                                    </div>
                                </div>
                                <Input.TextArea
                                    id="video-workbench-prompt"
                                    className="!rounded-lg !px-3.5 !py-3 !text-sm !leading-relaxed"
                                    value={prompt}
                                    onChange={(event) => setPrompt(event.target.value)}
                                    rows={7}
                                    placeholder={t("videoWorkbench.promptPlaceholder")}
                                />
                            </section>

                            <section className="min-w-0" aria-label={t("workbench.groups.references")}>
                                <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <h2 className="text-sm font-semibold">{t("workbench.groups.references")}</h2>
                                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">{references.length}</span>
                                    </div>
                                    <div className="flex gap-2">
                                        <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={() => void addReferencesFromClipboard()}>
                                            {t("workbench.clipboard")}
                                        </Button>
                                        <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>
                                            {t("workbench.upload")}
                                        </Button>
                                    </div>
                                </div>
                                <div
                                    className={`hover-scrollbar hover-scrollbar-hint flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed bg-muted/25 p-2.5 pb-3 overscroll-x-contain transition-colors ${referenceDragTarget ? "border-primary bg-primary/5" : "border-border"}`}
                                    onDragEnter={handleReferenceDragEnter}
                                    onDragOver={(event) => {
                                        event.preventDefault();
                                        event.dataTransfer.dropEffect = "copy";
                                    }}
                                    onDragLeave={handleReferenceDragLeave}
                                    onDrop={handleReferenceDrop}
                                >
                                    {references.map((item, index) => (
                                        <div key={item.id} className="group relative size-20 shrink-0 overflow-hidden rounded-lg border border-border">
                                            <img src={item.dataUrl} alt={item.name} className="size-full object-cover" />
                                            <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{index + 1}</span>
                                            <ReferenceOrderButtons index={index} total={references.length} onMove={(offset) => setReferences((value) => moveListItem(value, index, offset))} />
                                            <button
                                                type="button"
                                                className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-md bg-background/90 text-foreground opacity-100 transition-opacity hover:bg-background focus-visible:outline-2 focus-visible:outline-ring sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                                                onClick={() => setReferences((value) => value.filter((ref) => ref.id !== item.id))}
                                                aria-label={t("videoWorkbench.removeImage")}
                                            >
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                    {!references.length ? (
                                        <div className="flex min-w-full items-center justify-center px-2 text-center text-xs leading-relaxed text-muted-foreground">
                                            {referenceDragTarget ? t("videoWorkbench.dropReferences") : t("videoWorkbench.noImages")}
                                        </div>
                                    ) : null}
                                </div>
                                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t(references.length ? "workbench.groups.withReferences" : "workbench.groups.withoutReferences")}</p>
                            </section>

                            <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg bg-muted/60 px-3 py-2.5 text-xs sm:hidden">
                                <span className="truncate text-muted-foreground">
                                    {modelOptionLabel(effectiveConfig, model)} · {normalizeResolution(effectiveConfig.vquality)}p · {videoSizeLabel(effectiveConfig.size)} · {normalizeVideoSeconds(effectiveConfig.videoSeconds)}s
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
                                    referenceCount={references.length}
                                    paramValues={videoParamValues}
                                    onParamValuesChange={setVideoParamValues}
                                    onImplementationChange={setImplementation}
                                />
                            </section>
                        </div>

                        <section aria-label={t("workbench.groups.submit")} className="mt-auto border-t border-border pt-4">
                            <div className="mb-3 space-y-1">
                                <h2 className="text-sm font-semibold">{t("workbench.groups.submit")}</h2>
                                <p className="break-words text-xs leading-relaxed text-muted-foreground">
                                    {modelOptionLabel(effectiveConfig, model)} · {t("workbench.groups.referenceCount", { count: references.length })}
                                </p>
                                <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
                                    {running ? t("workbench.generating") : !canGenerate ? t("videoWorkbench.promptRequired") : t("workbench.groups.ready")}
                                </p>
                            </div>
                            <Button type="primary" size="large" block className="!h-11 !rounded-lg !font-medium !shadow-none" icon={<Sparkles className="size-4" />} loading={running} onClick={() => unknownResult ? recoverCurrent() : void generate()} disabled={(unknownResult ? !logs.find(log => log.id === unknownResult.id)?.task : !canGenerate) || running}>
                                {unknownResult ? t("videoRecovery.resume") : t("workbench.generate")}
                            </Button>
                            {unknownResult ? <Button type="text" block className="mt-2" disabled={running} onClick={confirmNewGeneration}>{t("videoRecovery.newGeneration")}</Button> : null}
                        </section>
                    </div>

                    <div className="thin-scrollbar flex min-w-0 flex-col rounded-xl border border-border bg-card p-4 sm:p-5 lg:min-h-0 lg:overflow-y-auto">
                        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                            <h2 className="text-base font-semibold tracking-tight">{t("workbench.results")}</h2>
                            {running ? (
                                <Tag role="status" className="m-0 px-2 py-1">
                                    {t("workbench.waiting", { time: formatDuration(elapsedMs) })}
                                </Tag>
                            ) : null}
                        </div>
                        {results.length ? (
                            <div className="grid gap-4">
                                {results.map((result) =>
                                    result.status === "success" && result.video ? (
                                        <ResultVideoCard key={result.id} video={result.video} onDownload={downloadVideo} onSaveAsset={saveResultToAssets} />
                                    ) : result.status === "unknown" ? (
                                        <div key={result.id} className="rounded-lg border border-border p-4 space-y-3" role="status">
                                            <h3>{t("videoRecovery.unknown")}</h3><p className="text-sm">{t("videoRecovery.hint")}</p>
                                            <details className="text-xs text-muted-foreground break-words"><summary>{t("videoRecovery.errorDetails")}</summary>{result.error}</details>
                                            {logs.find(log => log.id === result.id)?.task ? <Button type="primary" loading={activeLogIdsRef.current.has(result.id)} onClick={() => { const log = logs.find(item => item.id === result.id); if (log) void pollGenerationLog(log); }}>{t("videoRecovery.resume")}</Button> : <p>{t("videoRecovery.noReceipt")}</p>}
                                        </div>
                                    ) : result.status === "failed" ? (
                                        <FailedVideoCard key={result.id} error={result.error || t("workbench.generationFailed")} onRetry={retryResult} />
                                    ) : (
                                        <PendingVideoCard key={result.id} />
                                    ),
                                )}
                            </div>
                        ) : (
                            <div data-testid="workbench-empty" className="flex items-center gap-3 rounded-lg bg-muted/45 px-4 py-4">
                                <VideoIcon className="size-5 shrink-0 text-muted-foreground/65" aria-hidden="true" />
                                <p className="min-w-0 text-sm text-muted-foreground">
                                    {t("videoWorkbench.empty")}
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
                    onPreviewLog={previewGenerationLog}
                />
            </Drawer>
            <Drawer title={t("workbench.groups.defaults")} placement="bottom" size="82vh" open={settingsOpen} onClose={() => setSettingsOpen(false)}>
                <div className="mx-auto grid max-w-2xl grid-cols-2 gap-4 pb-6">
                    <GenerationSettings
                        config={effectiveConfig}
                        model={model}
                        updateConfig={updateConfig}
                        openConfigDialog={openConfigDialog}
                        referenceCount={references.length}
                        paramValues={videoParamValues}
                        onParamValuesChange={setVideoParamValues}
                        onImplementationChange={setImplementation}
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
    referenceCount = 0,
    paramValues,
    onParamValuesChange,
    onImplementationChange,
}: {
    config: AiConfig;
    model: string;
    updateConfig: UpdateAiConfig;
    openConfigDialog: (shouldPromptContinue?: boolean) => void;
    referenceCount?: number;
    paramValues: Record<string, unknown>;
    onParamValuesChange: (values: Record<string, unknown>) => void;
    onImplementationChange: (implementation: VideoImplementation | null) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const [implementation, setImplementation] = useState<VideoImplementation | null>(null);
    // 参数值由父组件持有：提交时要和提示词、参考图一起发出去，不能只留在面板里。
    const [loadedKey, setLoadedKey] = useState("");
    const publish = onImplementationChange;
    const blocked = videoScenarioBlocked(config, model, referenceCount);
    const isImplementationChannel = resolveModelChannel(config, model).kind === "comfyui";

    // 命中的内部实现（本地工作流或 RunningHub 档案）决定面板渲染哪些字段。
    // 换模型、换场景或换参考图数量都要重新解析，否则会沿用上一个实现的字段。
    useEffect(() => {
        if (!isImplementationChannel || !model) {
            setImplementation(null);
            publish?.(null);
            return;
        }
        let cancelled = false;
        void resolveVideoImplementation(config, model, referenceCount).then((next) => {
            if (cancelled) return;
            setImplementation(next);
            publish?.(next);
            const key = next ? videoParamKey(model, next.id) : "";
            if (key === loadedKey) return;
            setLoadedKey(key);
            // 渠道里按场景配的值作为初值；换实现时不沿用上一个实现的字段值。
            onParamValuesChange(next ? initialVideoParamValues(config, model, referenceCount, next.fields) : {});
        });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [config, model, referenceCount, isImplementationChannel]);

    // 场景被标记不支持与「读不到字段」是两回事，不能共用一句话。
    const implementationMissing = !isImplementationChannel || !model ? null : blocked ? t("settingsPanels.video.workflowFieldsScenarioUnsupported") : implementation ? null : t("settingsPanels.video.workflowFieldsMissing");

    return (
        <>
            <div className="col-span-2 space-y-1">
                <h2 className="text-sm font-semibold">{t("workbench.groups.defaults")}</h2>
                <p className="text-xs leading-relaxed text-muted-foreground">{t("workbench.groups.defaultsHint")}</p>
            </div>
            <div className="col-span-2 block min-w-0" role="group" aria-label={t("workbench.model")}>
                <span className="mb-2 block text-xs font-medium text-muted-foreground">{t("workbench.model")}</span>
                <ModelPicker config={config} value={model} onChange={(value) => updateConfig("videoModel", value)} capability="video" fullWidth onMissingConfig={() => openConfigDialog(false)} />
            </div>
            <div className="col-span-2 space-y-2">
                {implementation?.fields.length ? <p className="text-xs leading-relaxed text-muted-foreground">{t("workbench.groups.workflowHint")}</p> : null}
                <VideoSettingsPanel
                    config={{ ...config, model }}
                    onConfigChange={(key, value) => updateConfig(key, value)}
                    theme={theme}
                    showTitle={false}
                    className="space-y-4"
                    customFields={implementation?.fields}
                    customFieldValues={paramValues}
                    onCustomFieldChange={(id, value) => onParamValuesChange({ ...paramValues, [id]: value })}
                    implementationMissing={implementationMissing}
                />
            </div>
        </>
    );
}

function ResultVideoCard({ video, onDownload, onSaveAsset }: { video: GeneratedVideo; onDownload: (video: GeneratedVideo) => void; onSaveAsset: (video: GeneratedVideo) => void }) {
    const { t } = useTranslation();
    return (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
            <video src={video.url} controls className="aspect-video w-full bg-black object-contain" />
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border px-3 py-3">
                <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
                    <span>
                        {video.width}x{video.height}
                    </span>
                    <span>{formatBytes(video.bytes)}</span>
                    <span>{formatDuration(video.durationMs)}</span>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2" role="group" aria-label={t("workbench.groups.resultActions")}>
                    <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => onSaveAsset(video)}>
                        {t("common.addToAssets")}
                    </Button>
                    <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(video)}>
                        {t("common.download")}
                    </Button>
                </div>
            </div>
        </div>
    );
}

function PendingVideoCard() {
    const { t } = useTranslation();
    return (
        <div className="relative aspect-video overflow-hidden rounded-lg border border-dashed border-border bg-muted/40">
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="size-6 animate-spin" />
                <span>{t("workbench.generating")}</span>
            </div>
        </div>
    );
}

function FailedVideoCard({ error, onRetry }: { error: string; onRetry: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="overflow-hidden rounded-lg border border-destructive/25 bg-destructive/5">
            <div className="flex aspect-video flex-col items-center justify-center gap-3 p-5 text-center">
                <div className="text-sm font-medium text-destructive">{t("workbench.failed")}</div>
                <Typography.Paragraph ellipsis={{ rows: 4, expandable: true }} className="!mb-0 !text-xs !text-destructive">
                    {error}
                </Typography.Paragraph>
            </div>
            <div className="flex justify-end border-t border-destructive/20 p-3">
                <Button size="small" danger onClick={onRetry}>
                    {t("videoRecovery.newGeneration")}
                </Button>
            </div>
        </div>
    );
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
                <h2 className="text-sm font-semibold">{t("workbench.logs")}</h2>
                <Tag className="m-0">{logs.length}</Tag>
            </div>
            <p className="mb-3 text-xs leading-relaxed text-muted-foreground">{t("workbench.groups.historyHint")}</p>
            <div className="mb-3">
                <Button size="small" block icon={<Plus className="size-3.5" />} onClick={onCreateSession}>
                    {t("workbench.new")}
                </Button>
            </div>
            <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label={t("workbench.groups.historyManagement")}>
                <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!logs.length} onClick={toggleAll}>
                    {allSelected ? t("common.cancel") : t("workbench.selectAll")}
                </Button>
                <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedLogIds.length} onClick={onDeleteSelected}>
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
    return (
        <div className={`relative w-full rounded-lg border p-3 text-left transition-colors ${active ? "border-primary/35 bg-primary/5" : "border-border bg-card hover:border-primary/25 hover:bg-muted/50"}`}>
            <Checkbox aria-label={t("workbench.groups.selectHistory", { title: log.title })} className="absolute left-3 top-3.5 z-10" checked={selected} onChange={(event) => onSelectedChange(event.target.checked)} />
            <button
                type="button"
                aria-label={t("workbench.groups.restoreHistory", { title: log.title })}
                aria-current={active ? "true" : undefined}
                onClick={onClick}
                className="block w-full min-w-0 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 pl-6">
                    <div className="min-w-0">
                        <div className="truncate text-sm font-semibold leading-5">{log.title}</div>
                        <div className="mt-2 flex flex-wrap gap-1">
                            <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.size}</Tag>
                            <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.resolution}p</Tag>
                            <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.seconds}s</Tag>
                        </div>
                    </div>
                    <div className="grid justify-items-end gap-2">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color={videoNeedsVerification(log) ? "warning" : log.status === "success" ? "blue" : log.status === "pending" ? "processing" : "red"}>
                            {videoNeedsVerification(log) ? t("videoRecovery.unknown") : t(`workbench.${log.status === "success" ? "success" : log.status === "pending" ? "generating" : "failed"}`)}
                        </Tag>
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="green">
                            {formatDuration(log.durationMs)}
                        </Tag>
                    </div>
                </div>
            </button>
        </div>
    );
}

async function readStoredLogs() {
    if (typeof window === "undefined") return [];
    return readWorkbenchLogs("video") as Promise<GenerationLog[]>;
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
        <div className="absolute inset-x-1 bottom-1 flex justify-between">
            <Button
                size="small"
                className="!h-6 !w-6 !min-w-6 !rounded-md !border-border !bg-background/90 !p-0 !text-foreground"
                aria-label={t("workbench.groups.moveReferenceEarlier", { count: index + 1 })}
                icon={<ArrowLeft className="size-3" />}
                disabled={index <= 0}
                onClick={() => onMove(-1)}
            />
            <Button
                size="small"
                className="!h-6 !w-6 !min-w-6 !rounded-md !border-border !bg-background/90 !p-0 !text-foreground"
                aria-label={t("workbench.groups.moveReferenceLater", { count: index + 1 })}
                icon={<ArrowRight className="size-3" />}
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
    status,
    task,
    video,
    error,
}: {
    prompt: string;
    model: string;
    config: AiConfig;
    references: ReferenceImage[];
    durationMs: number;
    status: GenerationLog["status"];
    task?: VideoGenerationTask;
    video?: GeneratedVideo;
    error?: string;
}): GenerationLog {
    const logConfig = {
        model: config.model,
        videoModel: config.videoModel,
        size: config.size,
        vquality: normalizeResolution(config.vquality),
        videoSeconds: config.videoSeconds,
        videoGenerateAudio: config.videoGenerateAudio,
        videoWatermark: config.videoWatermark,
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
        // 展示实际输入；配置保留请求意图，重试时不能把 auto 偷换成固定尺寸。
        size: task?.parameters?.size || logConfig.size,
        resolution: task?.parameters?.resolution || logConfig.vquality,
        seconds: task?.parameters?.seconds || logConfig.videoSeconds,
        status,
        task,
        video,
        error,
    };
}

function buildVideoConfig(config: AiConfig, model: string): AiConfig {
    return {
        ...config,
        model,
        videoModel: model,
        size: normalizeVideoSize(config.size),
        videoSeconds: isLocalH3VideoModel(config, model) ? config.videoSeconds : normalizeVideoSeconds(config.videoSeconds),
        vquality: normalizeResolution(config.vquality),
        videoGenerateAudio: String(boolConfig(config.videoGenerateAudio, true)),
        videoWatermark: String(boolConfig(config.videoWatermark, false)),
    };
}

function normalizeVideoSeconds(value: string) {
    if (String(value).trim() === "-1") return "-1";
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(1, Math.min(20, seconds)));
}

function normalizeVideoSize(value: string) {
    return normalizeVideoSizeValue(value);
}

function normalizeResolution(value: string) {
    return normalizeVideoResolutionValue(value);
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
