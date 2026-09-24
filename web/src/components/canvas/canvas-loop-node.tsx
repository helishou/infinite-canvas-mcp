import { ListRestart, Play, Square } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

type CanvasLoopNodeProps = {
    node: CanvasNodeData;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    isRunning: boolean;
    progress?: { current: number; total: number };
    onChange: (patch: Partial<CanvasNodeMetadata>) => void;
    onRun: () => void;
    onStop: () => void;
};

function integer(value: string, fallback: number, min: number, max: number) {
    const parsed = Number(value);
    return Math.min(max, Math.max(min, Math.floor(Number.isFinite(parsed) ? parsed : fallback)));
}

export function CanvasLoopNode({ node, theme, isRunning, progress, onChange, onRun, onStop }: CanvasLoopNodeProps) {
    const { t } = useTranslation();
    const metadata = node.metadata || {};
    const count = integer(String(metadata.loopCount || 3), 3, 1, 100);
    const mode = metadata.loopMode === "parallel" ? "parallel" : "serial";
    const promptEnabled = Boolean(metadata.loopPromptEnabled);
    const imageEnabled = Boolean(metadata.loopImageEnabled);
    const videoEnabled = Boolean(metadata.loopVideoEnabled);
    const showBatchSettings = imageEnabled || videoEnabled;

    return (
        <div className="flex h-full w-full flex-col gap-3 overflow-hidden rounded-[inherit] p-4" style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
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
                    <input
                        type="number"
                        min={1}
                        max={100}
                        value={count}
                        disabled={isRunning}
                        className="h-8 w-20 rounded-lg border bg-transparent px-2 text-center text-sm outline-none"
                        style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                        onChange={(event) => onChange({ loopCount: integer(event.target.value, count, 1, 100) })}
                    />
                </label>
                <div className="flex rounded-lg border p-0.5" style={{ borderColor: theme.node.stroke }}>
                    {(["serial", "parallel"] as const).map((value) => (
                        <button
                            key={value}
                            type="button"
                            disabled={isRunning}
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
                <Toggle label={t("canvas.loopNode.prompt")} checked={promptEnabled} disabled={isRunning} theme={theme} onClick={() => onChange({ loopPromptEnabled: !promptEnabled })} />
                <Toggle label={t("canvas.loopNode.image")} checked={imageEnabled} disabled={isRunning} theme={theme} onClick={() => onChange({ loopImageEnabled: !imageEnabled })} />
                <Toggle label={t("canvas.loopNode.video")} checked={videoEnabled} disabled={isRunning} theme={theme} onClick={() => onChange({ loopVideoEnabled: !videoEnabled })} />
            </div>

            {promptEnabled ? (
                <textarea
                    value={metadata.loopPrompt || ""}
                    disabled={isRunning}
                    placeholder={t("canvas.loopNode.promptPlaceholder")}
                    className="min-h-14 resize-none rounded-lg border bg-transparent px-2 py-1.5 text-xs leading-5 outline-none"
                    style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                    onChange={(event) => onChange({ loopPrompt: event.target.value })}
                />
            ) : null}

            {showBatchSettings ? (
                <div className="grid grid-cols-2 gap-2 text-[11px] opacity-75">
                    <label className="flex items-center justify-between gap-2">
                        <span>{t("canvas.loopNode.start")}</span>
                        <input
                            type="number"
                            min={1}
                            max={100}
                            value={metadata.loopStart || 1}
                            disabled={isRunning}
                            className="h-7 w-14 rounded-md border bg-transparent px-1 text-center outline-none"
                            style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                            onChange={(event) => onChange({ loopStart: integer(event.target.value, 1, 1, 100) })}
                        />
                    </label>
                    {imageEnabled ? <BatchInput label={t("canvas.loopNode.image")} value={metadata.loopImageBatchSize || 1} disabled={isRunning} theme={theme} onChange={(value) => onChange({ loopImageBatchSize: value })} /> : null}
                    {videoEnabled ? <BatchInput label={t("canvas.loopNode.video")} value={metadata.loopVideoBatchSize || 1} disabled={isRunning} theme={theme} onChange={(value) => onChange({ loopVideoBatchSize: value })} /> : null}
                </div>
            ) : null}

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
            <input
                type="number"
                min={1}
                max={20}
                value={value}
                disabled={disabled}
                className="h-7 w-14 rounded-md border bg-transparent px-1 text-center outline-none"
                style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                onChange={(event) => onChange(integer(event.target.value, value, 1, 20))}
            />
        </label>
    );
}

export function isLoopNode(node: CanvasNodeData) {
    return node.type === CanvasNodeType.Loop;
}
