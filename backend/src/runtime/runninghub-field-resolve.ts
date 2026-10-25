/**
 * 把「本地字段」解析到云端图里真正可覆写的位置。
 *
 * 本地配置的字段常写成 `265::prompt`，但云端图里这个输入是**连线**：
 *
 *   265.prompt ← 267 GetNode("提示词") ← 266 SetNode ← 263 Text.text（常量）
 *
 * 连线输入不能直接覆写（平台会拒绝），所以顺着链往上找到那个「值是常量」的输入，
 * 字段实际要改的是 `263::text`。GetNode/SetNode 的变量名只存在于 UI 格式的
 * `widgets_values[0]`（API 格式里丢了），所以要同时带上 UI 原件才能配对。
 */
import type { LocalWorkflowField } from "./runninghub-field-sync.js";

type Json = Record<string, any>;

export type ResolvedFieldTarget = { local: LocalWorkflowField; nodeId: string; fieldName: string };
export type UnresolvedField = { node: string; input: string; name: string; reason: "missing-input" | "link-unresolved" };
export type FieldResolution = { targets: ResolvedFieldTarget[]; unresolved: UnresolvedField[] };

const MAX_DEPTH = 4;
const PREFERRED_TEXT_KEYS = ["text", "value", "prompt", "string", "STRING", "any_input"];

const isLink = (value: unknown): value is [string, number] => Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number";

/** UI 节点上的变量名：SetNode/GetNode 把它放在 widgets_values[0]，也兼容 title。 */
function uiNodeName(ui: Json | undefined, nodeId: string): string {
    const nodes = Array.isArray(ui?.nodes) ? ui.nodes : [];
    const node = nodes.find((item: Json) => String(item?.id) === nodeId);
    if (!node) return "";
    const widgets = node.widgets_values;
    if (Array.isArray(widgets) && typeof widgets[0] === "string") return widgets[0];
    return typeof node.title === "string" ? node.title : "";
}

/** 同名 SetNode 的编号。 */
function setIdByName(ui: Json | undefined, name: string): string {
    const nodes = Array.isArray(ui?.nodes) ? ui.nodes : [];
    const hit = nodes.find((item: Json) => item?.type === "SetNode" && Array.isArray(item.widgets_values) && item.widgets_values[0] === name);
    return hit ? String(hit.id) : "";
}

function pickStringKey(inputs: Json): string {
    for (const key of PREFERRED_TEXT_KEYS) if (typeof inputs[key] === "string") return key;
    for (const [key, value] of Object.entries(inputs)) if (typeof value === "string") return key;
    return "";
}

/** 从一个输入出发，最多追 MAX_DEPTH 跳，返回「值为常量」的节点/输入。 */
function follow(graph: Json, ui: Json | undefined, nodeId: string, fieldName: string, depth = 0, seen = new Set<string>()): { nodeId: string; fieldName: string } | null {
    if (depth > MAX_DEPTH) return null;
    const key = `${nodeId}::${fieldName}`;
    if (seen.has(key)) return null;
    seen.add(key);

    const node = graph[nodeId];
    const inputs = node?.inputs;
    if (!inputs || !Object.hasOwn(inputs, fieldName)) return null;
    const value = inputs[fieldName];
    if (!isLink(value)) return { nodeId, fieldName };

    const sourceId = String(value[0]);
    const source = graph[sourceId];
    if (!source) return null;

    if (source.class_type === "GetNode") {
        const name = uiNodeName(ui, sourceId);
        const setId = name ? setIdByName(ui, name) : "";
        if (!setId) return null;
        const setInputs = graph[setId]?.inputs || {};
        const innerKey = Object.keys(setInputs)[0];
        if (!innerKey) return null;
        return follow(graph, ui, setId, innerKey, depth + 1, seen);
    }

    const nextKey = pickStringKey(source.inputs || {});
    if (!nextKey) return null;
    return follow(graph, ui, sourceId, nextKey, depth + 1, seen);
}

/**
 * 逐个本地字段解析目标位置：直接可写的原样保留，连线输入顺链下钻。
 * 解析不出来的字段单独返回，交给上层提示，而不是静默消失。
 */
export function resolveLocalFieldTargets(graph: Json, uiWorkflow: Json | undefined, localFields: LocalWorkflowField[]): FieldResolution {
    const targets: ResolvedFieldTarget[] = [];
    const unresolved: UnresolvedField[] = [];
    const graphRecord = graph && typeof graph === "object" ? graph : {};

    for (const field of localFields || []) {
        const input = String(field?.input || "").trim();
        const nodeIds = String(field?.node || "").split(",").map((item) => item.trim()).filter(Boolean);
        if (!input || !nodeIds.length) {
            unresolved.push({ node: String(field?.node || ""), input, name: String(field?.name || ""), reason: "missing-input" });
            continue;
        }
        let resolved: { nodeId: string; fieldName: string } | null = null;
        for (const nodeId of nodeIds) {
            resolved = follow(graphRecord, uiWorkflow, nodeId, input);
            if (resolved) break;
        }
        if (resolved) targets.push({ local: field, nodeId: resolved.nodeId, fieldName: resolved.fieldName });
        else unresolved.push({ node: nodeIds.join(","), input, name: String(field?.name || ""), reason: "link-unresolved" });
    }
    return { targets, unresolved };
}
