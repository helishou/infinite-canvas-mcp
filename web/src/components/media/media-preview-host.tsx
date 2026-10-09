import { lazy, Suspense, useEffect } from "react";
import { useLocation } from "react-router-dom";

import { useMediaPreviewStore } from "@/stores/use-media-preview-store";

const MediaPreviewModal = lazy(() => import("@/components/canvas/media-preview-modal").then(module => ({ default: module.MediaPreviewModal })));

/**
 * 应用级媒体预览宿主：整个前端只有这一个预览弹窗实例。
 * 画布节点双击、插件 ctx.openMediaPreview、素材库/提示词库/Agent 附件的缩略图点击
 * 都写同一个 store，再由此渲染 MediaPreviewModal。
 *
 * 每个浏览器标签页各自持有一份 store（模块级状态只在当前页面上下文里），
 * 因此多个标签页同时预览不同图片互不影响；这里只保证单页内只有一个弹窗。
 */
export function MediaPreviewHost() {
    const request = useMediaPreviewStore(state => state.request);
    const close = useMediaPreviewStore(state => state.close);
    const { pathname } = useLocation();
    // 路由切换时收起预览，避免弹窗跨页残留（旧实现挂在画布页内，随页面卸载自然关闭）。
    useEffect(() => { close(); }, [pathname, close]);
    if (!request) return <div data-media-preview-host hidden />;
    return <Suspense fallback={null}><MediaPreviewModal item={request.item} onClose={close} projectId={request.projectId} /></Suspense>;
}
