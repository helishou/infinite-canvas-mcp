import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexAppClient } from "./codex-client.js";
import type { CodexReasoningEffort } from "./codex-protocol.js";

type TextClient = Pick<CodexAppClient, "startTextThread" | "generateSkillDraft" | "interruptCurrentTurn" | "stopProductionClient">;
const schema = { type: "object", additionalProperties: false, properties: { text: { type: "string" } }, required: ["text"] };

/** Isolated from the interactive Agent; it cannot submit canvas or media operations. */
export async function requestCodexText(input: { model: string; prompt: string; images?: string[]; systemPrompt?: string; effort?: string; signal?: AbortSignal }, createClient: () => Promise<TextClient> = () => CodexAppClient.start(() => {}, () => {}, input.signal)) {
    input.signal?.throwIfAborted();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-codex-text-"));
    let client: TextClient | undefined;
    let threadId = "";
    const stop = () => { if (client) { void client.interruptCurrentTurn(threadId || undefined).catch(() => {}); client.stopProductionClient(); } };
    input.signal?.addEventListener("abort", stop, { once: true });
    try {
        const images = await Promise.all((input.images || []).map(async (image, index) => {
            const match = /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/.exec(image);
            if (!match) throw new Error("Codex CLI 参考图必须是已解析的图片 data URL");
            const extension = match[1] === "image/jpeg" ? "jpg" : match[1].split("/")[1].replace(/[^a-z0-9]/gi, "");
            const file = path.join(directory, `${index}.${extension}`);
            await fs.writeFile(file, Buffer.from(match[2], "base64"));
            return file;
        }));
        input.signal?.throwIfAborted();
        client = await createClient();
        input.signal?.throwIfAborted();
        const thread = await client.startTextThread(directory);
        threadId = String(thread.id);
        input.signal?.throwIfAborted();
        const effort = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(input.effort || "") ? input.effort as CodexReasoningEffort : undefined;
        const raw = await client.generateSkillDraft(threadId, [input.systemPrompt, input.prompt].filter(Boolean).join("\n\n"), schema, input.model, effort, images);
        input.signal?.throwIfAborted();
        const value = JSON.parse(raw) as { text?: unknown };
        if (typeof value.text !== "string" || !value.text.trim()) throw new Error("Codex CLI 没有返回完整文本结果");
        return value.text;
    } finally {
        input.signal?.removeEventListener("abort", stop);
        client?.stopProductionClient();
        if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error("临时文件路径超出本次请求目录，保留文件");
        // 清理是尽力而为：目录被占用（如 Windows 上 EBUSY）时不能让 finally 抛错顶掉已经拿到的文本结果。
        await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
}
