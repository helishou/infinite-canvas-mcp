import { ListRestart, Play, Plus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { splitLoopPromptItems } from "@/components/canvas/canvas-node-generation";
import { resolveLoopInputPlan } from "@/lib/canvas/canvas-loop-execution";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

type CanvasLoopNodeProps = {
    node: CanvasNodeData;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    isRunning: boolean;
    progress?: { current: number; total: number };
    upstreamPromptItems: string[];
    imageCount: number;
    videoCount: number;
    onChange: (patch: Partial<CanvasNodeMetadata>) => void;
    onRun: () => void;
    onStop: () => void;
};

function integer(value: string, fallback: number, min: number, max: number) {
    const parsed = Number(value);
    return Math.min(max, Math.max(min, Math.floor(Number.isFinite(parsed) ? parsed : fallback)));
}

export function CanvasLoopNode({ node, theme, isRunning, progress, upstreamPromptItems, imageCount, videoCount, onChange, onRun, onStop }: CanvasLoopNodeProps) {
    const { t } = useTranslation();
    const metadata = node.metadata || {};
    const plan = resolveLoopInputPlan(metadata, imageCount, videoCount);
    const count = plan.rounds;
    const mode = metadata.loopMode === "parallel" ? "parallel" : "serial";
    const promptEnabled = Boolean(metadata.loopPromptEnabled);
    const imageEnabled = plan.mediaKind === "image";
    const videoEnabled = plan.mediaKind === "video";
    const [activePromptIndex, setActivePromptIndex] = useState(0);
    const promptFields = metadata.loopPrompts !== undefined ? metadata.loopPrompts : splitLoopPromptItems(metadata.loopPrompt || "");
    const visiblePromptFields = promptFields.length ? promptFields : [""];
    const writePromptFields = (fields: string[]) => onChange({ loopPrompts: fields, loopPrompt: fields.filter(Boolean).join("\n") });
    const upstreamPrompt = upstreamPromptItems.length ? upstreamPromptItems[(Math.max(1, metadata.loopStart || 1) - 1) % upstreamPromptItems.length] : "";

    return (
        <div className="flex h-full w-full flex-col gap-2 overflow-y-auto rounded-[inherit] p-4" style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    <ListRestart className="size-5 shrink-0" style={{ color: theme.node.activeStroke }} />
                    <span className="truncate text-sm font-semibold">{t("canvas.loopNode.title")}</span>
                </div>
                <span className="shrink-0 text-xs opacity-60">{isRunning && progress ? t("canvas.loopNode.running", progress) : `${count} ×`}</span>
            </div>

            <div className="flex items-center gap-2">
                <label className="flex min-w-0 flex-1 items-center justify-between gap-2 text-xs opacity-75">
                    <span>{t("canvas.loopNode.count")}</span>
                    <NumberInput
                        min={plan.mediaKind ? 0 : 1}
                        max={100}
                        value={count}
                        disabled={isRunning}
                        className="h-8 w-20 rounded-lg border bg-transparent px-2 text-center text-sm outline-none"
                        borderColor={theme.node.stroke}
                        color={theme.node.text}
                        onChange={(value) => onChange({ loopCount: value, loopCountMode: "manual" })}
                    />
                </label>
                {plan.countMode === "manual" && (imageCount > 0 || videoCount > 0) ? <button type="button" disabled={isRunning} className="text-[11px] opacity-75" onClick={() => onChange({ loopCountMode: "auto" })}>{t("canvas.loopNode.auto")}</button> : null}
                <div className="flex rounded-lg border p-0.5" style={{ borderColor: theme.node.stroke }}>
                    {(["serial", "parallel"] as const).map((value) => (
                        <button
                            key={value}
                            type="button"
                            disabled={isRunning}
                            aria-pressed={mode === value}
                            className="rounded-md px-2 py-1 text-[11px] transition"
                            style={{ background: mode === value ? theme.toolbar.activeBg : "transparent", color: mode === value ? theme.toolbar.activeText : theme.node.muted }}
                            onClick={() => onChange({ loopMode: value })}
                        >
                            {t(`canvas.loopNode.${value}`)}
                        </button>
                    ))}
                </div>
            </div>

            <div className="grid grid-cols-3 gap-1.5">
                <Toggle label={t("canvas.loopNode.prompt")} checked={promptEnabled} disabled={isRunning} theme={theme} onClick={() => {
                    const useDefault = !promptEnabled && !promptFields.some((value) => value.trim()) && !upstreamPromptItems.length;
                    onChange({ loopPromptEnabled: !promptEnabled, ...(useDefault ? { loopPrompt: t("canvas.loopNode.defaultPrompt"), loopPrompts: [t("canvas.loopNode.defaultPrompt")] } : {}) });
                }} />
                <Toggle label={t("canvas.loopNode.image")} checked={imageEnabled} disabled={isRunning} theme={theme} onClick={() => onChange({ loopMediaMode: imageEnabled ? "off" : "image", loopImageEnabled: !imageEnabled, loopVideoEnabled: false })} />
                <Toggle label={t("canvas.loopNode.video")} checked={videoEnabled} disabled={isRunning} theme={theme} onClick={() => onChange({ loopMediaMode: videoEnabled ? "off" : "video", loopVideoEnabled: !videoEnabled, loopImageEnabled: false })} />
            </div>

            {promptEnabled ? (
                <div className="min-h-0 space-y-1.5">
                    {upstreamPrompt ? <div className="rounded-lg border px-2 py-1 text-[11px]" style={{ borderColor: theme.node.stroke }}>
                        <span className="opacity-60">{t("canvas.loopNode.upstreamPrompts", { count: upstreamPromptItems.length })}</span>
                        <div className="truncate">{upstreamPrompt}</div>
                    </div> : null}
                    <div className="max-h-24 space-y-1 overflow-y-auto">
                        {visiblePromptFields.map((value, index) => (
                            <div key={index} className="flex items-center gap-1">
                                <span className="w-4 shrink-0 text-center text-[11px] opacity-60">{index + 1}</span>
                                <input
                                    type="text"
                                    value={value}
                                    disabled={isRunning}
                                    placeholder={t("canvas.loopNode.promptPlaceholder")}
                                    className="h-8 min-w-0 flex-1 rounded-lg border bg-transparent px-2 text-xs outline-none"
                                    style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                                    onFocus={() => setActivePromptIndex(index)}
                                    onChange={(event) => { const next = [...visiblePromptFields]; next[index] = event.target.value; writePromptFields(next); }}
                                />
                                <button type="button" disabled={isRunning || visiblePromptFields.length <= 1} title={t("canvas.loopNode.removePrompt")} aria-label={t("canvas.loopNode.removePrompt")} onClick={() => writePromptFields(visiblePromptFields.filter((_, itemIndex) => itemIndex !== index))}>
                                    <X className="size-3.5" />
                                </button>
                            </div>
                        ))}
                    </div>
                    <div className="flex items-center justify-between gap-1">
                        <button type="button" disabled={isRunning} className="text-[11px] opacity-70" onClick={() => { const index = Math.min(activePromptIndex, visiblePromptFields.length - 1); const next = [...visiblePromptFields]; next[index] = `${next[index]}《计数》`; writePromptFields(next); }}>{t("canvas.loopNode.counterToken")}</button>
                        <button type="button" disabled={isRunning} title={t("canvas.loopNode.addPrompt")} aria-label={t("canvas.loopNode.addPrompt")} onClick={() => { writePromptFields([...visiblePromptFields, ""]); setActivePromptIndex(visiblePromptFields.length); }}><Plus className="size-4" /></button>
                    </div>
                </div>
            ) : null}

            <div className="grid grid-cols-2 gap-2 text-[11px] opacity-75">
                <label className="flex items-center justify-between gap-2">
                    <span>{t("canvas.loopNode.start")}</span>
                    <NumberInput
                        min={1}
                        max={9999}
                        value={metadata.loopStart || 1}
                        disabled={isRunning}
                        className="h-7 w-14 rounded-md border bg-transparent px-1 text-center outline-none"
                        borderColor={theme.node.stroke}
                        color={theme.node.text}
                        onChange={(value) => onChange({ loopStart: value })}
                    />
                </label>
                {imageEnabled ? <BatchInput label={t("canvas.loopNode.image")} value={metadata.loopImageBatchSize || 1} disabled={isRunning} theme={theme} onChange={(value) => onChange({ loopImageBatchSize: value })} /> : null}
                {videoEnabled ? <BatchInput label={t("canvas.loopNode.video")} value={metadata.loopVideoBatchSize || 1} disabled={isRunning} theme={theme} onChange={(value) => onChange({ loopVideoBatchSize: value })} /> : null}
            </div>

            <div className="mt-auto flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-[11px] opacity-55">{t("canvas.loopNode.inputHint")}</span>
                {isRunning ? (
                    <button type="button" className="flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs" style={{ background: theme.node.stroke, color: theme.node.text }} onClick={onStop}>
                        <Square className="size-3" /> {t("canvas.loopNode.stop")}
                    </button>
                ) : (
                    <button type="button" className="flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium" style={{ background: theme.toolbar.activeBg, color: theme.toolbar.activeText }} onClick={onRun}>
                        <Play className="size-3" /> {t("canvas.loopNode.run")}
                    </button>
                )}
            </div>
        </div>
    );
}

function Toggle({ label, checked, disabled, theme, onClick }: { label: string; checked: boolean; disabled: boolean; theme: CanvasLoopNodeProps["theme"]; onClick: () => void }) {
    return (
        <button
            type="button"
            disabled={disabled}
            aria-pressed={checked}
            className="rounded-lg border px-2 py-1.5 text-xs transition"
            style={{ borderColor: theme.node.stroke, background: checked ? theme.toolbar.activeBg : "transparent", color: checked ? theme.toolbar.activeText : theme.node.muted }}
            onClick={onClick}
        >
            {label}
        </button>
    );
}

function BatchInput({ label, value, disabled, theme, onChange }: { label: string; value: number; disabled: boolean; theme: CanvasLoopNodeProps["theme"]; onChange: (value: number) => void }) {
    return (
        <label className="flex items-center justify-between gap-2">
            <span>
                {label} {"×"}
            </span>
            <NumberInput
                min={1}
                max={100}
                value={value}
                disabled={disabled}
                className="h-7 w-14 rounded-md border bg-transparent px-1 text-center outline-none"
                borderColor={theme.node.stroke}
                color={theme.node.text}
                onChange={onChange}
            />
        </label>
    );
}

function NumberInput({ value, min, max, disabled, className, borderColor, color, onChange }: {
    value: number;
    min: number;
    max: number;
    disabled: boolean;
    className: string;
    borderColor: string;
    color: string;
    onChange: (value: number) => void;
}) {
    const [draft, setDraft] = useState(String(value));
    useEffect(() => setDraft(String(value)), [value]);
    const commit = () => {
        const next = draft.trim() ? integer(draft, value, min, max) : value;
        setDraft(String(next));
        if (next !== value) onChange(next);
    };
    return (
        <input
            type="number"
            min={min}
            max={max}
            value={draft}
            disabled={disabled}
            className={className}
            style={{ borderColor, color }}
            onChange={(event) => {
                const next = event.target.value;
                setDraft(next);
                if (/^\d+$/.test(next)) onChange(integer(next, value, min, max));
            }}
            onBlur={commit}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
        />
    );
}

export function isLoopNode(node: CanvasNodeData) {
    return node.type === CanvasNodeType.Loop;
}
