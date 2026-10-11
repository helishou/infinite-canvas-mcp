import crypto from "node:crypto";

export type Json = Record<string, any>;
export type LlmProvider = { id: string; model: string; name: string; baseUrl: string; apiKey: string; apiFormat: "openai" | "openai-chat" | "gemini"; systemPrompt: string; kind?: "codex-cli" };
export type LlmPart = { text: string } | { image: string };
export type LlmCall = { id: string; name: string; arguments: string };
export type LlmMessage = { role: "user" | "assistant" | "tool"; parts: LlmPart[]; calls?: LlmCall[]; callId?: string; callName?: string; providerId?: string; providerFormat?: LlmProvider["apiFormat"]; native?: Json[] };
export type LlmTool = { name: string; description?: string; inputSchema: Json };
export type LlmReply = { message: LlmMessage; usage?: { input_tokens: number; output_tokens: number; cached_input_tokens: number } };
const record = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const rows = (value: unknown): Json[] => Array.isArray(value) ? value.map(record) : [];

/** The same channel-qualified identifiers and API formats used by the canvas. */
export function configuredLlmProviders(value: unknown): LlmProvider[] {
    const config = record(value);
    return rows(config.channels).flatMap(channel => {
        if (channel.kind === "comfyui") return [];
        const cli = channel.kind === "codex-cli";
        const apiFormat = cli ? "openai" : channel.apiFormat || config.apiFormat || "openai";
        if (!["openai", "openai-chat", "gemini"].includes(apiFormat)) return [];
        return rows(channel.models).filter(model => model.capability === "text" && !String(model.script || "").trim()).map(model => ({
            id: `${channel.id}::${model.name}`, model: String(model.name), name: `${channel.name || channel.id} / ${model.name}`,
            baseUrl: cli ? "" : String(channel.baseUrl || config.baseUrl || "").trim(), apiKey: cli ? "" : String(channel.apiKey || config.apiKey || "").trim(), apiFormat,
            systemPrompt: String(config.systemPrompt || "").trim(),
            ...(cli ? { kind: "codex-cli" as const } : {}),
        }));
    });
}

export function resolveLlmProvider(config: unknown, id?: string): LlmProvider {
    const providers = configuredLlmProviders(config);
    const selected = id || String(record(config).textModel || "") || providers[0]?.id;
    const provider = providers.find(item => item.id === selected);
    if (!provider) throw new Error(`Agent 文本模型「${selected || "未选择"}」不存在或不能在 Backend 执行，请检查现有渠道配置`);
    if (!provider.baseUrl && provider.kind !== "codex-cli") throw new Error(`模型「${provider.name}」缺少 Base URL，请在渠道配置中填写`);
    return provider;
}

function openAiBase(baseUrl: string) {
    const base = baseUrl.replace(/\/+$/, "");
    return /\/v\d+(?:beta)?$/i.test(base) ? base : `${base}/v1`;
}

/** No automatic paid retry or protocol fallback: the configured protocol is authoritative. */
export async function requestLlm(provider: LlmProvider, instructions: string, messages: LlmMessage[], tools: LlmTool[], signal: AbortSignal, onText: (delta: string) => void = () => {}, effort?: string): Promise<LlmReply> {
    if (provider.kind === "codex-cli") throw new Error("Codex CLI 模型须由原生 Codex 运行时执行，请新建对话");
    const system = [instructions, provider.systemPrompt].filter(Boolean).join("\n\n");
    let url: string;
    let body: Json;
    let headers: Record<string, string>;
    if (provider.apiFormat === "gemini") {
        const base = provider.baseUrl.replace(/\/+$/, "");
        url = `${/\/v1(?:beta)?$/.test(base) ? base : `${base}/v1beta`}/models/${encodeURIComponent(provider.model.replace(/^models\//, ""))}:streamGenerateContent?alt=sse`;
        body = { systemInstruction: { parts: [{ text: system }] }, contents: messages.map(message => {
            if (message.native && message.providerId === provider.id && message.providerFormat === provider.apiFormat) return { role: "model", parts: message.native };
            if (message.role === "tool") return { role: "user", parts: [{ functionResponse: { id: message.callId, name: message.callName, response: { result: textOf(message) } } }] };
            return { role: message.role === "assistant" ? "model" : "user", parts: [...message.parts.map(part => "text" in part ? part : geminiImage(part.image)), ...(message.calls || []).map(call => ({ functionCall: { id: call.id, name: call.name, args: JSON.parse(call.arguments) } }))] };
        }), ...(tools.length ? { tools: [{ functionDeclarations: tools.map(tool => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.inputSchema })) }] } : {}) };
        headers = { "content-type": "application/json", ...(provider.apiKey ? { "x-goog-api-key": provider.apiKey } : {}) };
    } else {
        headers = { "content-type": "application/json", ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}) };
        if (provider.apiFormat === "openai-chat") {
            url = `${openAiBase(provider.baseUrl)}/chat/completions`;
            body = { model: provider.model, stream: true, messages: [{ role: "system", content: system }, ...messages.map(message => ({ role: message.role, content: message.role === "tool" || message.parts.every(part => "text" in part) && message.parts.length ? textOf(message) : message.parts.length ? message.parts.map(part => "text" in part ? { type: "text", text: part.text } : { type: "image_url", image_url: { url: part.image } }) : null, ...(message.calls?.length ? { tool_calls: message.calls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) } : {}), ...(message.callId ? { tool_call_id: message.callId } : {}) }))], ...(tools.length ? { tools: tools.map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) } : {}) };
        } else {
            url = `${openAiBase(provider.baseUrl)}/responses`;
            body = { model: provider.model, stream: true, store: false, instructions: system, input: messages.flatMap(message => {
                if (message.native && message.providerId === provider.id && message.providerFormat === provider.apiFormat) return message.native;
                if (message.role === "tool") return [{ type: "function_call_output", call_id: message.callId, output: textOf(message) }];
                return [...(message.parts.length ? [{ role: message.role, content: message.parts.map(part => "text" in part ? { type: message.role === "assistant" ? "output_text" : "input_text", text: part.text } : { type: "input_image", image_url: part.image }) }] : []), ...(message.calls || []).map(call => ({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments }))];
            }), include: ["reasoning.encrypted_content"], ...(tools.length ? { tools: tools.map(tool => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false })) } : {}), ...(effort && effort !== "auto" ? { reasoning: { effort } } : {}) };
        }
    }
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    if (!response.ok) {
        // Never reflect upstream bodies, which may include credentials or the full request.
        await response.body?.cancel();
        throw new Error(`模型「${provider.name}」请求失败（HTTP ${response.status}），请检查渠道协议、模型能力和凭证`);
    }
    const chunks: Json[] = [];
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
        await readSse(response, value => {
            chunks.push(value);
            const delta = provider.apiFormat === "openai-chat" ? String(value.choices?.[0]?.delta?.content || "") : provider.apiFormat === "openai" && value.type === "response.output_text.delta" ? String(value.delta || "") : provider.apiFormat === "gemini" ? rows(value.candidates?.[0]?.content?.parts).filter(part => !part.thought).map(part => part.text || "").join("") : "";
            if (delta) onText(delta);
        });
    } else chunks.push(await response.json() as Json);
    signal.throwIfAborted();
    const reply = parseLlmReply(provider, chunks);
    if (!reply.message.parts.length && !reply.message.calls?.length) throw new Error(`模型「${provider.name}」没有返回文本或工具调用`);
    return reply;
}

export function textOf(message: LlmMessage) { return message.parts.map(part => "text" in part ? part.text : "").join(""); }

function geminiImage(url: string) {
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
    if (!match) throw new Error("Gemini Agent 图片必须是已解析的 data URL");
    return { inlineData: { mimeType: match[1], data: match[2] } };
}

async function readSse(response: Response, onData: (value: Json) => void) {
    if (!response.body) throw new Error("模型返回了空响应流");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const consume = (block: string) => {
        const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") return;
        const value = JSON.parse(data);
        if (value.error || /(?:failed|error)$/.test(String(value.type || ""))) throw new Error("模型响应流失败，请检查渠道服务");
        onData(value);
    };
    try {
        while (true) {
            const { value, done } = await reader.read();
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            buffer = buffer.replace(/\r\n/g, "\n");
            let index: number;
            while ((index = buffer.indexOf("\n\n")) >= 0) { consume(buffer.slice(0, index)); buffer = buffer.slice(index + 2); }
            if (done) { if (buffer.trim()) consume(buffer); break; }
        }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function parseLlmReply(provider: LlmProvider, chunks: Json[]): LlmReply {
    const latest = chunks.slice().reverse();
    let text = "", calls: LlmCall[] = [], native: Json[] | undefined, usage: Json = {};
    if (provider.apiFormat === "openai") {
        const result = latest.find(chunk => chunk.type === "response.completed")?.response || latest.find(chunk => Array.isArray(chunk.output));
        if (!result || result.status === "incomplete" || result.status === "failed") throw new Error("模型没有完成本次响应，未执行工具");
        native = rows(result.output);
        text = String(result.output_text || native.filter(item => item.type === "message").flatMap(item => rows(item.content)).map(item => item.text || "").join(""));
        calls = native.filter(item => item.type === "function_call").map(item => ({ id: String(item.call_id), name: String(item.name), arguments: String(item.arguments) }));
        usage = result.usage || {};
    } else if (provider.apiFormat === "openai-chat") {
        const callMap = new Map<number, LlmCall>();
        let finished = false;
        for (const chunk of chunks) {
            if (chunk.usage) usage = chunk.usage;
            const choice = chunk.choices?.[0];
            if (!choice) continue;
            finished ||= Boolean(choice.finish_reason || choice.message);
            if (["length", "content_filter"].includes(choice.finish_reason)) throw new Error("模型响应未完整结束，未执行工具");
            const delta = choice.delta || choice.message || {};
            text += String(delta.content || "");
            for (const item of rows(delta.tool_calls)) {
                const index = Number(item.index ?? callMap.size);
                const call = callMap.get(index) || { id: "", name: "", arguments: "" };
                call.id += String(item.id || ""); call.name += String(item.function?.name || ""); call.arguments += String(item.function?.arguments || ""); callMap.set(index, call);
            }
        }
        if (!finished) throw new Error("模型响应流中断，未执行未完成的工具调用");
        calls = [...callMap.values()];
    } else {
        native = chunks.flatMap(chunk => rows(chunk.candidates?.[0]?.content?.parts));
        const finish = latest.find(chunk => chunk.candidates?.[0]?.finishReason)?.candidates?.[0]?.finishReason;
        if (finish !== "STOP") throw new Error(`Gemini 响应未完成（${finish || "流中断"}），未执行工具`);
        text = native.filter(part => !part.thought).map(part => part.text || "").join("");
        calls = native.filter(part => part.functionCall).map(part => ({ id: String(part.functionCall.id || crypto.randomUUID()), name: String(part.functionCall.name), arguments: JSON.stringify(part.functionCall.args || {}) }));
        usage = latest.find(chunk => chunk.usageMetadata)?.usageMetadata || {};
    }
    return { message: { role: "assistant", parts: text ? [{ text }] : [], calls, providerId: provider.id, providerFormat: provider.apiFormat, ...(native ? { native } : {}) }, usage: { input_tokens: Number(usage.input_tokens || usage.prompt_tokens || usage.promptTokenCount || 0), output_tokens: Number(usage.output_tokens || usage.completion_tokens || usage.candidatesTokenCount || 0), cached_input_tokens: Number(usage.input_tokens_details?.cached_tokens || usage.prompt_tokens_details?.cached_tokens || usage.cachedContentTokenCount || 0) } };
}

/** Replay native reasoning/signatures only to their originating model and protocol. */
export function llmHistoryForProvider(messages: LlmMessage[], provider: LlmProvider): LlmMessage[] {
    const foreignCalls = new Set(messages.filter(message => message.role === "assistant" && (message.providerId !== provider.id || message.providerFormat !== provider.apiFormat)).flatMap(message => (message.calls || []).map(call => call.id)));
    return messages.map(message => {
        if (message.role === "assistant" && (message.providerId !== provider.id || message.providerFormat !== provider.apiFormat)) return { role: "assistant", parts: [...message.parts, ...(message.calls?.length ? [{ text: `\n已调用的工具：${JSON.stringify(message.calls)}` }] : [])] };
        if (message.role === "tool" && foreignCalls.has(message.callId || "")) return { role: "user", parts: [{ text: `上一个模型的工具 ${message.callName} 返回：\n${textOf(message)}` }] };
        return message;
    });
}
