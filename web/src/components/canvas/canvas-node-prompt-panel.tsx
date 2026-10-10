import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useCanvasRoute } from "@/lib/canvas/canvas-host";
import { getCanvasTextSession } from "@/services/api/canvas-text";
import type { CanvasTextEditorHandle, CanvasTextTarget } from "@/types/canvas-plugin";
import { ArrowUp, Image as ImageIcon, LoaderCircle, Maximize2, MessageSquare, Music2, Square, Video } from "lucide-react";
import { Button, Modal, Segmented, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { defaultConfig, resolveModelForCapability, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { canvasNodeImage } from "@/lib/canvas/canvas-image-renderability";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasGenerationControls } from "./canvas-generation-controls";
import { getNodeImageReferenceCount } from "./canvas-node-image-reference-count";
import { CanvasPromptLibrary } from "./canvas-prompt-library";
import { CanvasCollaborativeText } from "./canvas-collaborative-text";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";
import { resolveCanvasNodePromptField } from "./canvas-node-prompt-field";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";

import { CanvasNodeReferenceBar } from "./canvas-node-reference-bar";

export type CanvasNodeGenerationMode = CanvasGenerationMode;

type CanvasNodePromptPanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => void;
    onGenerate: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => void;
    onStop: (nodeId: string) => void;
    mentionReferences?: CanvasResourceReference[];
    nodes: CanvasNodeData[];
    connectedNodes?: CanvasNodeData[];
    loopInputCount?: number;
    onDisconnectReference?: (fromNodeId: string, toNodeId: string) => void;
    onReorderReference?: (fromNodeId: string, overNodeId: string) => void;
    reorderableSourceNodeIds?: ReadonlySet<string>;
    onStartReferenceSelection?: (nodeId: string) => void;
    onImageSettingsOpenChange?: (open: boolean) => void;
    modeOverride?: CanvasNodeGenerationMode; // Plugin nodes set their generation type through useBuiltinPanel.mode.
};

export function CanvasNodePromptPanel({ node, nodes, isRunning, onConfigChange, onGenerate, onStop, mentionReferences = [], connectedNodes = [], loopInputCount = 0, onDisconnectReference, onReorderReference, reorderableSourceNodeIds, onStartReferenceSelection, onImageSettingsOpenChange, modeOverride }: CanvasNodePromptPanelProps) {
    const { t } = useTranslation();
    const globalConfig = useEffectiveConfig();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const isSmartGenerationNode = node.type === CanvasNodeType.Loop || node.type === CanvasNodeType.Config && node.metadata?.smart === true;
    const mode = modeOverride ?? (isSmartGenerationNode ? node.metadata?.generationMode || "image" : defaultMode(node.type));
    const config = buildNodeConfig(globalConfig, node, mode);
    const hasTextContent = (node.type === CanvasNodeType.Text || (isSmartGenerationNode && mode === "text")) && Boolean(node.metadata?.content?.trim());
    const hasImageContent = mode === "image" && Boolean(canvasNodeImage(node) || (node.type === CanvasNodeType.Loop && node.metadata?.content));
    const isEditingExistingContent = hasTextContent || hasImageContent;
    const { projectId } = useCanvasRoute();
    const field = resolveCanvasNodePromptField(node.type, isEditingExistingContent);
    const target = useMemo<CanvasTextTarget>(() => ({ nodeId: node.id, field }), [node.id, field]);
    const session = useMemo(() => getCanvasTextSession(projectId, target), [projectId, target]);
    const textStatus = useSyncExternalStore(session.subscribe, session.getSnapshot);
    const prompt = textStatus.text;
    const editorRef = useRef<CanvasTextEditorHandle>(null);
    const [expanded, setExpanded] = useState(false);
    const [imagePromptRequired, setImagePromptRequired] = useState(false);
    const promptRequired = mode !== "image" || imagePromptRequired;
    const activeHistoryImage = mode === "image" && node.metadata?.activeImageHistoryExplicit === true && node.metadata?.activeImageHistoryId
        ? node.metadata.images?.find((image) => image.id === node.metadata?.activeImageHistoryId)
        : undefined;
    const historyReferences = activeHistoryImage?.generationSnapshot?.references;
    const visibleHistoryReferences = loopInputCount > 0 ? undefined : historyReferences;
    // 已恢复版本使用快照；实时场景与生成器共用输入解析，@ 候选不是已使用参考。
    const referenceCount = useMemo(() => getNodeImageReferenceCount(
        node, nodes, connectedNodes, prompt, loopInputCount, visibleHistoryReferences?.length,
    ), [node, nodes, connectedNodes, prompt, loopInputCount, visibleHistoryReferences]);
    // 音频场景要按「带了几段参考音频」路由工作流（0 = 纯文本，≥1 = 参考音色克隆），
    // 与图片引用数是两套计数，不能复用 referenceCount。
    const audioReferenceCount = new Set([
        ...connectedNodes.filter((item) => item.type === CanvasNodeType.Audio).map((item) => item.id),
        ...mentionReferences.filter((item) => item.kind === "audio").map((item) => item.nodeId),
    ]).size;
    const clearHistoryReferences = () => onConfigChange(node.id, { activeImageHistoryId: null, activeImageHistoryExplicit: false });

    const updatePrompt = (value: string) => editorRef.current?.replace(value);

    const submit = () => {
        const text = prompt.trim();
        if (!textStatus.ready || textStatus.blocked || isRunning || (promptRequired && !text)) return;
        onGenerate(node.id, mode, text);
    };

    const openExpandedEditor = () => {
        setExpanded(true);
    };

    return (
        <div
            data-canvas-no-zoom
            className="rounded-2xl border p-3 shadow-2xl backdrop-blur"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <CanvasNodeReferenceBar nodeId={node.id} nodes={nodes} connectedNodes={connectedNodes} historyReferences={visibleHistoryReferences} onClearHistoryReferences={clearHistoryReferences} onDisconnect={onDisconnectReference} onReorder={onReorderReference} reorderableSourceNodeIds={reorderableSourceNodeIds} onStartSelection={onStartReferenceSelection} />
            {isSmartGenerationNode ? (
                <Segmented
                    className="mb-2 w-full"
                    size="small"
                    block
                    disabled={isRunning}
                    value={mode}
                    onChange={(value) => onConfigChange(node.id, { generationMode: value as CanvasGenerationMode })}
                    options={[
                        { value: "image", label: <span className="inline-flex items-center gap-1"><ImageIcon className="size-3.5" />{t("canvas.configNode.image")}</span> },
                        { value: "video", label: <span className="inline-flex items-center gap-1"><Video className="size-3.5" />{t("canvas.configNode.video")}</span> },
                        { value: "audio", label: <span className="inline-flex items-center gap-1"><Music2 className="size-3.5" />{t("canvas.configNode.audio")}</span> },
                        { value: "text", label: <span className="inline-flex items-center gap-1"><MessageSquare className="size-3.5" />{t("canvas.configNode.text")}</span> },
                    ]}
                />
            ) : null}
            <CanvasCollaborativeText
                projectId={projectId} target={target} chips dialogue
                references={mentionReferences}
                editorRef={editorRef}
                onSubmit={submit}
                className="thin-scrollbar h-40 w-full cursor-text resize-none rounded-xl px-3 py-2 text-sm leading-5 outline-none"
                style={{ background: "transparent", color: theme.node.text }}
                placeholder={t(`canvas.promptPanel.${mode === "image" && hasImageContent ? "editImage" : mode === "text" && hasTextContent ? "editText" : mode}`)}
            />

            <div className="mt-2 flex min-w-0 items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    <Tooltip title={t("canvas.promptPanel.expandEditor")}>
                        <Button type="text" className="!h-8 !w-8 !min-w-8 shrink-0 !rounded-full !bg-transparent !p-0" style={{ color: theme.node.text }} icon={<Maximize2 className="size-3.5" />} onClick={openExpandedEditor} aria-label={t("canvas.promptPanel.expandEditor")} />
                    </Tooltip>
                    <CanvasPromptLibrary onSelect={updatePrompt} />
                    <CanvasGenerationControls
                        node={node}
                        mode={mode}
                        config={config}
                        onConfigChange={onConfigChange}
                        referenceCounts={{ image: referenceCount, audio: audioReferenceCount }}
                        imageReferenceCount={referenceCount}
                        textCount={node.metadata?.textCount || 1}
                        onTextCountChange={(next: number) => onConfigChange(node.id, { textCount: next })}
                        onImageSettingsOpenChange={onImageSettingsOpenChange}
                        onImagePromptRequiredChange={setImagePromptRequired}
                    />
                </div>
                <Button
                    type="primary"
                    className="!h-10 !min-w-16 shrink-0 !rounded-full !px-3"
                    danger={isRunning}
                    disabled={!isRunning && (!textStatus.ready || textStatus.blocked || (promptRequired && !prompt.trim()))}
                    onClick={() => (isRunning ? onStop(node.id) : submit())}
                    aria-label={t(isRunning ? "canvas.promptPanel.stopGeneration" : "canvas.promptPanel.generate")}
                >
                    <span className="flex items-center gap-1.5">
                        {isRunning ? (
                            <>
                                <LoaderCircle className="size-4 animate-spin" />
                                <Square className="size-3.5 fill-current" />
                                <span className="text-xs font-medium">{t("canvas.promptPanel.stop")}</span>
                            </>
                        ) : (
                            <ArrowUp className="size-4" />
                        )}
                    </span>
                </Button>
            </div>
            <Modal title={t("canvas.promptPanel.editorTitle")} open={expanded} centered width={760} footer={null} onCancel={() => setExpanded(false)} destroyOnHidden>
                <div data-canvas-no-zoom className="pt-2" onWheelCapture={(event) => event.stopPropagation()}>
                    <CanvasNodeReferenceBar nodeId={node.id} nodes={nodes} connectedNodes={connectedNodes} historyReferences={visibleHistoryReferences} onClearHistoryReferences={clearHistoryReferences} onDisconnect={onDisconnectReference} onReorder={onReorderReference} reorderableSourceNodeIds={reorderableSourceNodeIds} onStartSelection={(nodeId) => { setExpanded(false); onStartReferenceSelection?.(nodeId); }} />
                    <CanvasCollaborativeText
                        projectId={projectId} target={target} chips dialogue
                        references={mentionReferences}
                        className="thin-scrollbar h-[52dvh] min-h-80 w-full cursor-text overflow-y-auto rounded-xl border p-4 text-[15px] leading-6 outline-none"
                        style={{ background: "transparent", borderColor: theme.toolbar.border, color: theme.node.text }}
                        placeholder={t(`canvas.promptPanel.${mode === "image" && hasImageContent ? "editImage" : mode === "text" && hasTextContent ? "editText" : mode}`)}
                    />
                </div>
            </Modal>
        </div>
    );
}

function defaultMode(type: CanvasNodeData["type"]): CanvasNodeGenerationMode {
    return type === CanvasNodeType.Text ? "text" : type === CanvasNodeType.Video ? "video" : type === CanvasNodeType.Audio ? "audio" : "image";
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasNodeGenerationMode): AiConfig {
    return {
        ...globalConfig,
        model: resolveModelForCapability(globalConfig, node.metadata?.model, mode),
        reasoningEffort: node.metadata?.reasoningEffort || globalConfig.reasoningEffort || defaultConfig.reasoningEffort,
        quality: node.metadata?.quality || globalConfig.quality || defaultConfig.quality,
        size: node.metadata?.size || globalConfig.size || defaultConfig.size,
        background: node.metadata?.background ?? globalConfig.background ?? defaultConfig.background,
        videoSeconds: node.metadata?.seconds || globalConfig.videoSeconds || defaultConfig.videoSeconds,
        vquality: node.metadata?.vquality || globalConfig.vquality || defaultConfig.vquality,
        videoGenerateAudio: node.metadata?.generateAudio || globalConfig.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node.metadata?.watermark || globalConfig.videoWatermark || defaultConfig.videoWatermark,
        audioVoice: node.metadata?.audioVoice || globalConfig.audioVoice || defaultConfig.audioVoice,
        audioFormat: node.metadata?.audioFormat || globalConfig.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node.metadata?.audioSpeed || globalConfig.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node.metadata?.audioInstructions || globalConfig.audioInstructions || defaultConfig.audioInstructions,
        count: String(node.metadata?.count || (mode === "image" ? globalConfig.count || globalConfig.canvasImageCount : globalConfig.count) || defaultConfig.count),
    };
}

