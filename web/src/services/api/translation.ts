import { request } from "@/services/backend-api";
import localforage from "localforage";

const h3TranslationCache = localforage.createInstance({ name: "infinite-canvas-h3-translation-cache" });
const h3TranslationInFlight = new Map<string, Promise<string>>();
const H3_TRANSLATION_CACHE_VERSION = "h3-en-v2";
const H3_TRANSLATION_BATCH_SIZE = 3;

/** 画布右键翻译：由 Backend 调用设置里选定的文本模型完成。 */
export async function translateText(text: string, target: "zh-CN" | "en", mode?: "h3-prompt") {
    return request<{ ok: boolean; translatedText: string }>("POST", "/translation/text", { text, target, ...(mode ? { mode } : {}) });
}

function protectedH3Markers(text: string) {
    return text.match(/<(?:Subject|Picture|Video|Audio)\s+\d+>|\[Shot\s+\d+\]|<(?:d|\/d|scenetrans|\/scenetrans|cutoff)>|\b\d{2}:\d{2}(?:\.\d{1,3})?\b|\d+(?:\.\d+)?|^[A-Za-z_][\w .-]*:/gim) || [];
}

export type H3PromptTranslation = { sourceHash: string; translatedText: string; cached: boolean };
export type H3PromptBatchItem = { id: string; text: string };
export type H3PromptBatchProgress = { completed: number; total: number };

/** Cache by each exact compiled prompt and translate sequential batches of at most three prompts. */
export async function translateCompiledH3Prompts(items: H3PromptBatchItem[], onProgress?: (progress: H3PromptBatchProgress) => void, options?: { signal?: AbortSignal }): Promise<Array<H3PromptTranslation & { id: string }>> {
    if (!Array.isArray(items) || !items.length) throw new Error("编译提示词列表为空，无法翻译");
    const ids = new Set<string>();
    const rows = await Promise.all(items.map(async item => {
        const id = String(item?.id || ""), text = String(item?.text || "");
        if (!id || ids.has(id)) throw new Error("翻译 Clip 标识为空或重复");
        ids.add(id);
        if (!text.trim()) throw new Error(`Clip ${id} 的编译提示词为空，无法翻译`);
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
        const sourceHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
        return { id, text, sourceHash, key: `${H3_TRANSLATION_CACHE_VERSION}:${sourceHash}` };
    }));
    const byHash = new Map<string, typeof rows[number]>();
    for (const row of rows) if (!byHash.has(row.sourceHash)) byHash.set(row.sourceHash, row);
    const translated = new Map<string, { text: string; cached: boolean }>();
    const uniqueRows = [...byHash.values()];
    while (translated.size < uniqueRows.length) {
        const waiting: Promise<string>[] = [];
        const missing: typeof rows = [];
        const cacheRows = await Promise.all(uniqueRows.filter(row => !translated.has(row.sourceHash)).map(async row => ({
            row,
            cached: await h3TranslationCache.getItem<{ sourceHash: string; translatedText: string }>(row.key),
        })));
        for (const { row, cached } of cacheRows) {
            if (cached?.sourceHash === row.sourceHash && cached.translatedText) translated.set(row.sourceHash, { text: cached.translatedText, cached: true });
            else {
                const pending = h3TranslationInFlight.get(row.key);
                if (pending) waiting.push(pending);
                else missing.push(row);
            }
        }
        onProgress?.({ completed: translated.size, total: uniqueRows.length });
        if (translated.size >= uniqueRows.length) break;
        if (waiting.length) { await Promise.all(waiting); continue; }
        if (!missing.length) throw new Error("没有可处理的翻译批次");

        const batch = missing.slice(0, H3_TRANSLATION_BATCH_SIZE);
        const batchRequest = request<{ ok: boolean; translations: Array<{ id: string; translatedText: string; sourceHash: string; cached: boolean }> }>(
            "POST", "/translation/text", { items: batch.map(row => ({ id: row.sourceHash, text: row.text })), target: "en", mode: "h3-prompt" }, options);
        for (const row of batch) {
            const pending = batchRequest.then(async response => {
                const item = response.translations.find(result => result.id === row.sourceHash);
                if (!item || item.sourceHash !== row.sourceHash || !item.translatedText.trim()) throw new Error("翻译模型未完整返回批次中的提示词");
                const translatedText = item.translatedText.trim();
                if (JSON.stringify(protectedH3Markers(row.text)) !== JSON.stringify(protectedH3Markers(translatedText))) {
                    throw new Error(`Clip ${row.id} 的译文改动了提示词结构、引用标签、时间或数字，未写入 H3`);
                }
                await h3TranslationCache.setItem(row.key, { sourceHash: row.sourceHash, translatedText });
                return translatedText;
            }).finally(() => h3TranslationInFlight.delete(row.key));
            h3TranslationInFlight.set(row.key, pending);
        }
        await Promise.all(batch.map(row => h3TranslationInFlight.get(row.key)!));
        const response = await batchRequest;
        for (const row of batch) {
            const item = response.translations.find(result => result.id === row.sourceHash)!;
            translated.set(row.sourceHash, { text: item.translatedText.trim(), cached: item.cached });
        }
        onProgress?.({ completed: translated.size, total: uniqueRows.length });
    }
    return rows.map(row => {
        const result = translated.get(row.sourceHash);
        if (!result) throw new Error(`Clip ${row.id} 缺少翻译结果`);
        return { id: row.id, sourceHash: row.sourceHash, translatedText: result.text, cached: result.cached };
    });
}

export async function translateCompiledH3Prompt(text: string, options?: { signal?: AbortSignal }): Promise<H3PromptTranslation> {
    const [result] = await translateCompiledH3Prompts([{ id: "prompt", text }], undefined, options);
    return result;
}
