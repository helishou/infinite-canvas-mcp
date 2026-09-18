import { useCallback, useMemo, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";

import { CanvasNodeOverview } from "@/components/canvas/canvas-node";
import { canvasThemes } from "@/lib/canvas-theme";
import { buildCanvasSpatialIndex, queryCanvasSpatialIndex } from "@/lib/canvas/canvas-spatial-index";
import { viewportRenderPadding } from "@/lib/canvas/canvas-viewport";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData, type ViewportTransform } from "@/types/canvas";

const VIEWPORT = { width: 1280, height: 760 };
const COUNTS = [200, 500, 1000] as const;
const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><linearGradient id="g" x2="1" y2="1"><stop stop-color="#315f94"/><stop offset="1" stop-color="#db805f"/></linearGradient><rect width="100%" height="100%" fill="url(#g)"/></svg>')}`;
const noops = {
    onMouseDown: () => undefined,
    onHoverStart: () => undefined,
    onHoverEnd: () => undefined,
    onConnectStart: () => undefined,
    onResizeStart: () => undefined,
    onResize: () => undefined,
    onResizeEnd: () => undefined,
    onTitleChange: () => undefined,
    onContextMenu: () => undefined,
};

function makeNodes(count: number): CanvasNodeData[] {
    return Array.from({ length: count }, (_, index) => {
        const type = [CanvasNodeType.Image, CanvasNodeType.Character, CanvasNodeType.Text, CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Config, CanvasNodeType.Group, "minimax-h3:video"][index % 8];
        const x = (index % 40) * 340 + Math.floor(index / 160) * 110;
        const y = Math.floor(index / 40) * 260;
        const base = { id: `perf-${index}`, type, title: `${type} ${index + 1}`, position: { x, y }, width: 280, height: 190 };
        if (type === CanvasNodeType.Image) return { ...base, metadata: { content: image, images: [{ id: `image-${index}`, status: "success" as const, content: image, naturalWidth: 640, naturalHeight: 400, bytes: 0, mimeType: "image/svg+xml" }] } };
        if (type === CanvasNodeType.Character)
            return { ...base, metadata: { characterName: `角色 ${index + 1}`, characterImages: [{ url: image, name: "定妆", outfit: "常服", outfitDescription: "", width: 640, height: 400, bytes: 0, mimeType: "image/svg+xml" }] } };
        if (type === CanvasNodeType.Text) return { ...base, metadata: { content: `第 ${index + 1} 个文本节点：用于总览、缩放和裁剪性能基准。` } };
        if (type === CanvasNodeType.Video) return { ...base, metadata: { status: "success" as const } };
        if (type === CanvasNodeType.Audio) return { ...base, metadata: { durationMs: 16_000, status: "success" as const } };
        if (type === CanvasNodeType.Group) return { ...base, metadata: { groupLocked: index % 2 === 0 } };
        if (type === "minimax-h3:video") return { ...base, metadata: { prompt: `H3 Clip ${index + 1}：无输出时仅展示提示词摘要`, segments: [{ id: "clip-1", prompt: `H3 Clip ${index + 1}`, status: "idle" }] } };
        return { ...base, metadata: { smart: true, generationMode: "image", prompt: `智能生成节点 ${index + 1}`, status: "idle" as const } };
    });
}

function percentile(values: number[], ratio: number) {
    if (!values.length) return 0;
    const sorted = values.toSorted((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

export default function CanvasPerformanceFixture() {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [count, setCount] = useState<(typeof COUNTS)[number]>(1000);
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 24, y: 24, k: 0.18 });
    const [metrics, setMetrics] = useState({ fps: 0, p95: 0, mounted: 0 });
    const frameTimesRef = useRef<number[]>([]);
    const runningRef = useRef(false);
    const nodes = useMemo(() => makeNodes(count), [count]);
    const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    const connections = useMemo(() => Array.from({ length: Math.round(count * 1.5) }, (_, index) => ({ id: `connection-${index}`, fromNodeId: `perf-${index % count}`, toNodeId: `perf-${(index * 17 + 71) % count}` })), [count]);
    const index = useMemo(() => buildCanvasSpatialIndex(nodes, (node) => ({ left: node.position.x, top: node.position.y, right: node.position.x + node.width, bottom: node.position.y + node.height })), [nodes]);
    const visibleNodes = useMemo(() => {
        const padding = viewportRenderPadding(viewport.k);
        const left = -viewport.x / viewport.k - padding;
        const top = -viewport.y / viewport.k - padding;
        return queryCanvasSpatialIndex(index, { left, top, right: left + VIEWPORT.width / viewport.k + padding * 2, bottom: top + VIEWPORT.height / viewport.k + padding * 2 });
    }, [index, viewport]);
    const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);

    const sample = useCallback(() => {
        if (runningRef.current) return;
        runningRef.current = true;
        frameTimesRef.current = [];
        let previous = performance.now();
        const until = previous + 3_000;
        const tick = (now: number) => {
            frameTimesRef.current.push(now - previous);
            previous = now;
            if (now < until) requestAnimationFrame(tick);
            else {
                const frames = frameTimesRef.current.filter((value) => value > 0 && value < 1000);
                setMetrics({ fps: Math.round(frames.length / 3), p95: Math.round(percentile(frames, 0.95) * 10) / 10, mounted: visibleNodes.length });
                runningRef.current = false;
            }
        };
        requestAnimationFrame(tick);
    }, [visibleNodes.length]);

    const zoom = (factor: number) => setViewport((current) => ({ ...current, k: Math.max(0.05, Math.min(1, current.k * factor)) }));
    const pan = (x: number, y: number) => setViewport((current) => ({ ...current, x: current.x + x, y: current.y + y }));

    return (
        <main className="flex h-full min-h-0 flex-col gap-3 p-4" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <header className="flex flex-wrap items-center gap-2 text-sm">
                <strong>画布性能基准（只读，不写入项目）</strong>
                {COUNTS.map((value) => (
                    <button key={value} type="button" className="border px-2 py-1" style={{ borderColor: theme.node.stroke, background: value === count ? theme.toolbar.activeBg : "transparent" }} onClick={() => setCount(value)}>
                        {value} 节点
                    </button>
                ))}
                <button type="button" className="border px-2 py-1" style={{ borderColor: theme.node.stroke }} onClick={() => zoom(0.8)} aria-label="缩小">
                    <Minus className="size-4" />
                </button>
                <button type="button" className="border px-2 py-1" style={{ borderColor: theme.node.stroke }} onClick={() => zoom(1.25)} aria-label="放大">
                    <Plus className="size-4" />
                </button>
                <button type="button" className="border px-2 py-1" style={{ borderColor: theme.node.stroke }} onClick={() => pan(-360, 0)}>
                    向右平移
                </button>
                <button type="button" className="border px-2 py-1" style={{ borderColor: theme.node.stroke }} onClick={sample}>
                    采样 3 秒
                </button>
                <span>
                    缩放 {Math.round(viewport.k * 100)}% · 已挂载 {visibleNodes.length} 节点 / {connections.length} 连线 · FPS {metrics.fps || "—"} · P95 {metrics.p95 || "—"}ms
                </span>
            </header>
            <div className="relative overflow-hidden border" style={{ width: VIEWPORT.width, height: VIEWPORT.height, borderColor: theme.node.stroke }}>
                <div className="absolute left-0 top-0 origin-top-left" style={{ width: 15_000, height: 7_000, transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})` }}>
                    <svg className="pointer-events-none absolute left-0 top-0 h-[7000px] w-[15000px] overflow-visible">
                        {connections.map((connection) => {
                            const from = nodeById.get(connection.fromNodeId);
                            const to = nodeById.get(connection.toNodeId);
                            if (!from || !to || (!visibleNodeIds.has(from.id) && !visibleNodeIds.has(to.id))) return null;
                            return (
                                <path key={connection.id} d={`M ${from.position.x + from.width} ${from.position.y + from.height / 2} L ${to.position.x} ${to.position.y + to.height / 2}`} stroke={theme.node.muted} strokeWidth="2" opacity=".45" />
                            );
                        })}
                    </svg>
                    {visibleNodes.map((node) => (
                        <CanvasNodeOverview
                            key={node.id}
                            projectId="canvas-performance-fixture"
                            data={node}
                            theme={theme}
                            scale={viewport.k}
                            isSelected={false}
                            isRelated={false}
                            isFocusRelated={false}
                            isConnectionTarget={false}
                            isConnecting={false}
                            showPanel={false}
                            showImageInfo={false}
                            {...noops}
                        />
                    ))}
                </div>
            </div>
        </main>
    );
}
