/**
 * 首页创作台 / Agent 站点工具提交给 `/canvas/generation` 的图片参考句柄。
 *
 * 后端 CanvasImageDispatcher.prepareReferences 只接受三种可解析句柄：
 *   1. 媒体库里查得到的 storageKey；
 *   2. base64 的 `data:<mime>;base64,...` dataUrl；
 *   3. 能被 fetch 的 url（相对 /media/... 或绝对 http(s)）。
 *
 * 素材库（尤其共享素材里的关键帧）常把 `/media/image%3A...` 这类代理地址放在
 * `dataUrl` 字段里——它不是 base64，按 dataUrl 提交会被判「缺少 Backend 媒体句柄」400。
 * 与后端 image-references.ts／画布助手的构造规范保持一致：只有真正的 data: 才进 dataUrl，
 * 其余地址进 url；storageKey 在时两者都带，后端优先用 storageKey、失效时回落 url。
 */

export type CreativeCommandReference = {
    id: string;
    name: string;
    type: string;
    storageKey?: string;
    dataUrl?: string;
    url?: string;
};

/** 只依赖这两个模块都认识的字段，避免把 store 拉进纯函数。 */
export type CreativeReferenceSource = {
    id?: string;
    title?: string;
    name?: string;
    mimeType?: string;
    dataUrl?: string;
    url?: string;
    storageKey?: string;
};

export function buildCreativeCommandReferences(
    items: readonly CreativeReferenceSource[],
    idFor: (item: CreativeReferenceSource, index: number) => string = (item, index) => item.id || String(index),
): CreativeCommandReference[] {
    return items.map((item, index) => {
        const content = item.dataUrl || item.url || "";
        const name = item.title || item.name || item.id || `reference-${index + 1}`;
        return {
            id: idFor(item, index),
            name: `${name}.png`,
            type: item.mimeType || "image/png",
            ...(item.storageKey ? { storageKey: item.storageKey } : {}),
            ...(content.startsWith("data:") ? { dataUrl: content } : {}),
            ...(content && !content.startsWith("data:") ? { url: content } : {}),
        };
    });
}
