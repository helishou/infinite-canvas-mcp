import type { CanvasNodeData } from "@/types/canvas";
import { canvasNodePrimaryImage } from "./canvas-image-renderability";

export type CanvasNodeDownloadPlan = { storageKey?: string; url: string; filename: string };

/**
 * 画布节点的下载计划。已归档媒体必须带出 `storageKey`：调用方据此先取 Blob 再保存，
 * 与图片、资产库、制作片段下载保持一致；直接把节点里的原始 URL 交给浏览器下载会依赖
 * 代理链路、跨域探测和浏览器下载策略，容易只留下一条失败的下载记录。
 * 文件名去掉与节点 id 重复的类型前缀：裁剪结果节点 id 形如 `video-canvas-trim-*`。
 */
export function canvasNodeDownloadPlan(node: CanvasNodeData, outputType: string, extension: string): CanvasNodeDownloadPlan | null {
    const image = outputType === "image" ? canvasNodePrimaryImage(node) : null;
    const storageKey = image?.storageKey || node.metadata?.storageKey;
    const url = image?.content || node.metadata?.content || "";
    if (!storageKey && !url) return null;
    const id = node.id.startsWith(`${outputType}-`) ? node.id : `${outputType}-${node.id}`;
    return { storageKey, url, filename: `canvas-${id}.${extension}` };
}
