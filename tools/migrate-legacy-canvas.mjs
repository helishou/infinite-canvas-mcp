import fs from "node:fs/promises";
import path from "node:path";

const sourceFile = path.resolve(process.argv[2] || "");
const oldRoot = path.resolve(process.argv[3] || "E:/无限画布/Infinite-Canvas");
const configFile = path.join(process.env.USERPROFILE || process.env.HOME || "", ".infinite-canvas", "backend.json");

if (!sourceFile) throw new Error("用法：node tools/migrate-legacy-canvas.mjs <旧画布.json>");
const source = JSON.parse(await fs.readFile(sourceFile, "utf8"));
const config = JSON.parse(await fs.readFile(configFile, "utf8"));
const baseUrl = String(config.url).replace(/\/$/, "");
const headers = { Authorization: `Bearer ${config.token}` };
const rewritten = new Map();
const missing = [];

function mimeFor(file) {
    const ext = path.extname(file).toLowerCase();
    return ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : ext === ".mp4" ? "video/mp4" : ext === ".webm" ? "video/webm" : ext === ".wav" ? "audio/wav" : ext === ".mp3" ? "audio/mpeg" : "application/octet-stream";
}

async function migrateUrl(value) {
    if (typeof value !== "string" || !value.startsWith("/assets/")) return value;
    if (rewritten.has(value)) return rewritten.get(value);
    const relative = decodeURIComponent(value.slice("/assets/".length)).replaceAll("/", path.sep);
    const sourcePath = path.join(oldRoot, "assets", relative);
    try {
        const data = await fs.readFile(sourcePath);
        const category = relative.startsWith(`output${path.sep}`) ? "output" : relative.startsWith(`library${path.sep}`) ? "library" : "input";
        const response = await fetch(`${baseUrl}/media/upload-binary?token=${encodeURIComponent(config.token)}`, {
            method: "POST",
            headers: { ...headers, "content-type": mimeFor(sourcePath), "x-media-name": encodeURIComponent(path.basename(sourcePath)), "x-media-category": category },
            body: data,
        });
        const body = await response.json();
        if (!response.ok || !body.media?.storageKey) throw new Error(body.error || `HTTP ${response.status}`);
        const url = `/media/${encodeURIComponent(body.media.storageKey)}`;
        rewritten.set(value, url);
        return url;
    } catch (error) {
        missing.push({ value, sourcePath, error: error instanceof Error ? error.message : String(error) });
        rewritten.set(value, value);
        return value;
    }
}

async function rewrite(value) {
    if (typeof value === "string") return migrateUrl(value);
    if (Array.isArray(value)) return Promise.all(value.map(rewrite));
    if (!value || typeof value !== "object") return value;
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = await rewrite(item);
    return result;
}

function nodeType(type) {
    if (type === "smart-minimax" || type === "minimax") return "minimax-h3:video";
    if (type === "smart-image") return "image";
    if (type === "smart-group") return "group";
    return "text";
}

function nodeContent(node) {
    const firstImage = Array.isArray(node.images) ? node.images.find((item) => item?.url)?.url : "";
    return String(node.content || firstImage || node.promptDraftText || node.description || node.name || "");
}

const rawNodes = Array.isArray(source.nodes) ? source.nodes : [];
const groupIds = new Set(rawNodes.filter((node) => node.type === "smart-group").map((node) => node.id));
const nodes = [];
for (const node of rawNodes) {
    const type = nodeType(node.type);
    const metadata = { ...node };
    for (const key of ["id", "type", "x", "y", "position", "w", "h", "width", "height", "title"]) delete metadata[key];
    if (type !== "minimax-h3:video") metadata.content = nodeContent(node);
    if (type === "text" && node.type === "smart-prompt") metadata.content = String(node.promptDraftText || node.content || node.prompt || "");
    if (type === "group") delete metadata.items;
    const groupId = rawNodes.find((candidate) => Array.isArray(candidate.items) && candidate.items.includes(node.id))?.id;
    if (groupId && groupIds.has(groupId)) metadata.groupId = groupId;
    nodes.push({ id: String(node.id), type, title: String(node.title || (type === "minimax-h3:video" ? "H3 导演台" : type === "image" ? "图片" : type === "group" ? "分组" : "文本")), position: { x: Number(node.x || 0), y: Number(node.y || 0) }, width: Number(node.w || node.width || 360), height: Number(node.h || node.height || 240), metadata });
}

const migrated = await rewrite({
    id: source.id,
    title: `${source.title || "旧画布"}（导入）`,
    icon: source.icon || "layers",
    kind: source.kind === "smart" ? "classic" : source.kind,
    nodes,
    connections: (Array.isArray(source.connections) ? source.connections : []).map((connection, index) => ({ id: String(connection.id || `connection-${index + 1}`), fromNodeId: String(connection.fromNodeId || connection.from || ""), toNodeId: String(connection.toNodeId || connection.to || "") })).filter((connection) => connection.fromNodeId && connection.toNodeId),
    viewport: { x: Number(source.viewport?.x || 0), y: Number(source.viewport?.y || 0), k: Number(source.viewport?.k || source.viewport?.scale || 1) },
    globalPrompt: String(source.globalPrompt || ""),
    chatSessions: [],
    activeChatId: null,
});

const response = await fetch(`${baseUrl}/canvas/projects`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(migrated) });
const body = await response.json();
if (!response.ok) throw new Error(body.error || `创建新画布失败：HTTP ${response.status}`);
console.log(JSON.stringify({ ok: true, project: body.project || migrated, nodes: nodes.length, connections: migrated.connections.length, media: rewritten.size, missing }, null, 2));
