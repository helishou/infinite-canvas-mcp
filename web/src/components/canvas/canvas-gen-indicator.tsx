import React from "react";
import type { CanvasTheme } from "@/lib/canvas-theme";

/**
 * 制作台节点「生成中」指示器（对齐影策 canvas-gen-state 的动感设计）。
 * 影策把动感集中在「conic 彗尾进度环 + 三段进度流动条」，而不是整块节点呼吸——
 * 后者在多节点时会掉帧，本地早期版本就刻意关停了整块呼吸。这里抄的是现状。
 *
 * - 有百分比：三段进度条按真实进度确定填充；
 * - 无百分比：中段用流动光带表示「正在跑」，避免假进度。
 */
export function GenRing({
    theme,
    size = 40,
    progress,
    label,
    compact = false,
}: {
    theme: CanvasTheme;
    size?: number;
    progress?: number;
    label?: string;
    compact?: boolean;
}) {
    const active = progress === undefined;
    const pct = Math.max(0, Math.min(100, Number(progress || 0)));
    const steps = [
        active ? "active" : pct >= 66 ? "done" : pct >= 34 ? "active" : "idle",
        active ? "idle" : pct >= 100 ? "done" : pct >= 34 ? "active" : "idle",
        active ? "idle" : pct >= 100 ? "done" : "idle",
    ];
    return (
        <div className="flex flex-col items-center justify-center gap-3" style={{ color: theme.node.activeStroke }}>
            <div className="canvas-gen-ring-host relative shrink-0 rounded-full" style={{ width: size, height: size }}>
                {/* 底环 */}
                <div className="absolute inset-0 rounded-full border-2" style={{ borderColor: theme.node.stroke }} />
                {/* conic 彗尾：CSS 里 animate-spin，mask 成环；减少动态效果下仍保持转动（加载指示例外） */}
                <div className="canvas-gen-ring absolute inset-0 rounded-full animate-spin" style={{ ["--canvas-gen-accent" as string]: theme.node.activeStroke }} />
                {/* 中心图标：小圆点脉冲表示在跑 */}
                <div className="absolute inset-0 grid place-items-center">
                    <span className="canvas-gen-core-dot" style={{ background: theme.node.activeStroke }} />
                </div>
            </div>
            {label && !compact ? <span className="text-[10px] tracking-[0.2em]">{label}</span> : null}
            {/* 三段进度条：排队 → 生成 → 保存（compact 缩略壳隐藏，避免小节点拥挤） */}
            {compact ? null : (
            <ul className="generation-phase-steps flex w-full max-w-[160px] flex-col gap-1.5" aria-hidden>
                {steps.map((state, index) => (
                    <li key={index} data-state={state} className="generation-phase-step">
                        <span className="generation-phase-steps-track block">
                            <span
                                className="generation-phase-steps-fill block"
                                {...(state === "done" || (!active && state === "active") ? { "data-determinate": true } : {})}
                                style={{
                                    ["--gen-steps-track" as string]: `${theme.node.stroke}33`,
                                    ["--gen-steps-accent" as string]: theme.node.activeStroke,
                                    ...(!active && state === "active" ? { transform: `translateX(-${100 - Math.min(100, (pct - index * 33) / 0.34)}%)` } : {}),
                                }}
                            />
                        </span>
                    </li>
                ))}
            </ul>
            )}
        </div>
    );
}

/** 生成中徽章的状态点（脉冲）——用于节点角落角标，替代静态色点。 */
export function GenPulseDot({ color }: { color: string }) {
    return <span className="canvas-node-status-chip-dot inline-block size-1.5 rounded-full" style={{ background: color }} />;
}
