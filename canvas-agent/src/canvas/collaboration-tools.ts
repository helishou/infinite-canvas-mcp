import crypto from "node:crypto";
import * as Y from "yjs";
import { collaborationSchemas, type CollaborationToolName } from "./collaboration-contract.js";
export { isCollaborationTool } from "./collaboration-contract.js";

type Transport = { get: (path: string) => Promise<unknown>; post: (path: string, body: unknown) => Promise<unknown> };

/** MCP 和 Agent 共用参数校验、增量编码和持久命令入口，不经浏览器转发。 */
export async function executeCollaborationTool(api: Transport, name: CollaborationToolName, raw: unknown, source: { clientId: string; kind: string; label: string }) {
    const parsed = collaborationSchemas[name].parse(raw);
    const path = `/canvas/projects/${encodeURIComponent(parsed.projectId)}`;
    if (name === "canvas_get_collaboration_state") return api.get(path + "/collaboration");
    if (name === "canvas_read_text") {
        const { target } = collaborationSchemas.canvas_read_text.parse(parsed);
        return api.get(path + "/text?" + new URLSearchParams(Object.entries(target).filter((entry): entry is [string, string] => typeof entry[1] === "string")));
    }
    if (name === "canvas_apply_commands") {
        const { projectId: _, ...command } = collaborationSchemas.canvas_apply_commands.parse(parsed);
        return api.post(path + "/ops?response=delta", { ...command, source });
    }
    if (name === "canvas_list_text_suggestions") {
        const { target } = collaborationSchemas.canvas_list_text_suggestions.parse(parsed);
        return api.get(path + "/text-suggestions" + (target ? "?" + new URLSearchParams(Object.entries(target).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : ""));
    }
    if (name === "canvas_save_text_suggestion") {
        const { operationId, suggestion } = collaborationSchemas.canvas_save_text_suggestion.parse(parsed);
        return api.post(path + "/ops?response=delta", { operationId, source, operations: [{ type: "save_text_suggestion", suggestion }] });
    }
    if (name === "canvas_resolve_text_suggestion") {
        const { projectId: _, operationId, ...operation } = collaborationSchemas.canvas_resolve_text_suggestion.parse(parsed);
        if (operation.action === "apply" && (!operation.documentId || operation.expectedText === undefined)) throw new Error("采用候选必须提供 documentId 和 expectedText");
        return api.post(path + "/ops?response=delta", { operationId, source, operations: [{ type: "resolve_text_suggestion", ...operation }] });
    }
    if (name === "canvas_replace_text") {
        const { projectId: _, operationId, ...operation } = collaborationSchemas.canvas_replace_text.parse(parsed);
        return api.post(path + "/ops?response=delta", { operationId, source, operations: [{ type: "text_replace", ...operation }] });
    }
    const { operationId, target, documentId, baseState, edits } = collaborationSchemas.canvas_edit_text.parse(parsed);
    const doc = new Y.Doc();
    try {
        Y.applyUpdate(doc, Buffer.from(baseState, "base64"));
        const usedIds = new Set(Y.decodeStateVector(Y.encodeStateVector(doc)).keys());
        let clientId = crypto.createHash("sha256").update(operationId).digest().readUInt32BE();
        while (usedIds.has(clientId)) clientId = (clientId + 1) >>> 0;
        doc.clientID = clientId;
        const vector = Y.encodeStateVector(doc);
        const text = doc.getText("text");
        doc.transact(() => {
            for (const edit of edits) {
                if (edit.index + edit.deleteCount > text.length) throw new Error("文本编辑范围超出读取时的基线");
                text.delete(edit.index, edit.deleteCount);
                text.insert(edit.index, edit.insert);
            }
        });
        return api.post(path + "/ops?response=delta", { operationId, source, operations: [{ type: "text_update", target, documentId, update: Buffer.from(Y.encodeStateAsUpdate(doc, vector)).toString("base64") }] });
    } finally { doc.destroy(); }
}
