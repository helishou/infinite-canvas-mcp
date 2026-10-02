import type { H3Ref } from "../types";

/** 文本模型识图只能接收图片；音频/视频仍进入 manifest，但不能作为 image_data_url 上传。 */
export function promptEnhanceImagePayload(refs: H3Ref[]) {
    return refs
        .filter((ref) => ref.type === "image")
        .map((ref) => ({
            url: ref.url || "",
            name: ref.name,
            storageKey: ref.storageKey,
            mimeType: ref.mimeType,
        }));
}
